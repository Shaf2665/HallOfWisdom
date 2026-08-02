import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import {
  ceoPlanExecutionEventSchema,
  type CeoPlanExecutionEvent,
  type CeoPlanRun,
} from "@hall-of-wisdom/protocol";
import {
  configureCeoPlanRunRequestSchema,
  runMutationTokenRequestSchema,
} from "../schemas/ceo-plan-execution-request.js";
import {
  CeoPlanExecutionNotEligibleError,
  CeoPlanExecutionStepRetryNotEligibleError,
  CeoPlanRunNotFoundError,
  CeoPlanRunTokenInvalidError,
  InvalidRequestError,
} from "../errors/app-error.js";
import type { CeoPlanOrchestrator } from "../ceo-plans/ceo-plan-orchestrator.js";
import type { CeoPlanExecutionComposition } from "../ceo-execution/ceo-plan-execution-composition.js";
import { parseWebOrigin } from "../config/web-origin.js";

export interface CeoPlanRunRoutesDeps {
  readonly ceoPlanOrchestrator: CeoPlanOrchestrator;
  readonly ceoExecution: CeoPlanExecutionComposition;
}

interface PlanIdParams {
  readonly planId: string;
}
interface RunIdParams {
  readonly runId: string;
}
interface RunStepParams {
  readonly runId: string;
  readonly stepId: string;
}
const RETRY_ELIGIBLE_STEP_STATUSES = new Set(["failed", "awaiting_intervention"]);
interface EventsQuery {
  readonly afterSequence?: string;
}

function invalidBody(
  zodResult: { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } },
  subject: string,
): never {
  const details = zodResult.error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
  throw new InvalidRequestError(`${subject} failed validation.`, details);
}

function parseAfterSequenceQuery(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidRequestError("afterSequence must be a non-negative integer.");
  }
  return parsed;
}

/**
 * `run.activeGeneration` — not a separate per-run revision counter — is
 * this route file's "revision" for the opaque mutation token. It changes
 * exactly at the safety-relevant boundaries (resume, cancel, recovery
 * pause), which is sufficient to prevent a stale browser tab from acting
 * on a generation the scheduler has already moved past. It deliberately
 * does NOT change on every single mutation (e.g. `pause` does not bump
 * it) — those transitions are instead protected by the store's own
 * status-machine guard (`CeoPlanRunStateConflictError`, 409), which is an
 * equally real, independently-enforced form of optimistic concurrency: a
 * second concurrent "pause" against an already-paused run fails on status
 * alone, token or no token.
 */
function issueRunToken(deps: CeoPlanRunRoutesDeps, run: CeoPlanRun): string {
  return deps.ceoExecution.tokenIssuer.issue(run.id, run.activeGeneration);
}

function verifyRunToken(deps: CeoPlanRunRoutesDeps, run: CeoPlanRun, token: string): void {
  if (!deps.ceoExecution.tokenIssuer.verify(run.id, run.activeGeneration, token)) {
    throw new CeoPlanRunTokenInvalidError(run.id);
  }
}

function getRunOrThrow(deps: CeoPlanRunRoutesDeps, runId: string): CeoPlanRun {
  const run = deps.ceoExecution.planRunStore.findRun(runId);
  if (!run) throw new CeoPlanRunNotFoundError(runId);
  return run;
}

function appendLifecycleEvent(
  deps: CeoPlanRunRoutesDeps,
  runId: string,
  type:
    | "ceo.execution.configured"
    | "ceo.execution.started"
    | "ceo.execution.paused"
    | "ceo.execution.resumed"
    | "ceo.execution.cancelled",
): void {
  const event = deps.ceoExecution.planRunStore.appendEvent({
    runId,
    type,
    actor: "human:local-operator",
    payload: {},
    now: new Date().toISOString(),
  });
  deps.ceoExecution.planRunEventBus.publish(runId, event);
}

/**
 * Phase 15 — the browser-facing surface for autonomous plan execution.
 * Every mutating route here does exactly one thing: `.../configure`
 * creates a run (never a task run — see the kickoff's "Configuration
 * creates no task run"), `.../start` is the one and only route that lets
 * the scheduler begin claiming signals for this run (manual mode remains
 * inert even after start — `CeoPlanExecutionScheduler.tick()`'s own
 * `executionMode === "autonomous"` filter, not anything enforced here).
 * No route ever inserts or claims an execution signal directly, and no
 * route ever accepts an actor identity from the request body — every
 * event this file appends uses the fixed `"human:local-operator"` actor,
 * matching the kickoff's "no browser-controlled actor identity."
 */
export function registerCeoPlanRunRoutes(app: FastifyInstance, deps: CeoPlanRunRoutesDeps): void {
  app.post<{ Params: PlanIdParams }>(
    "/api/v1/ceo-plans/:planId/execution/configure",
    async (request, reply) => {
      const parsed = configureCeoPlanRunRequestSchema.safeParse(request.body);
      if (!parsed.success) invalidBody(parsed, "ConfigureCeoPlanRunRequest");
      const { planId } = request.params;

      const plan = deps.ceoPlanOrchestrator.getPlan(planId);
      if (plan.status !== "delegated") {
        throw new CeoPlanExecutionNotEligibleError(
          planId,
          `plan status is "${plan.status}", not "delegated"`,
        );
      }
      const links = deps.ceoPlanOrchestrator.listDelegationLinks(planId);
      if (links.length === 0) {
        throw new CeoPlanExecutionNotEligibleError(planId, "no delegation links exist");
      }
      const planVersion = links[0]?.planVersion;
      if (planVersion === undefined) {
        throw new CeoPlanExecutionNotEligibleError(planId, "no delegation links exist");
      }
      const version = deps.ceoPlanOrchestrator.getVersion(planId, planVersion);

      const runId = randomUUID();
      const now = new Date().toISOString();
      const steps = links.map((link) => {
        const step = version.steps.find((s) => s.id === link.stepId);
        return {
          stepId: link.stepId,
          childTaskId: link.childTaskId,
          dependencyStepIds: step?.dependencies ?? [],
        };
      });

      const run = deps.ceoExecution.runAtomicUnit(() => {
        const configured = deps.ceoExecution.planRunStore.configureRun({
          runId,
          planId,
          planVersion,
          executionMode: parsed.data.executionMode,
          policy: parsed.data.policy,
          now,
          steps,
        });
        deps.ceoExecution.scheduler.registerDependencyIndex(
          runId,
          steps.map((step) => ({ id: step.stepId, dependencies: step.dependencyStepIds })),
        );
        return configured;
      });
      appendLifecycleEvent(deps, runId, "ceo.execution.configured");

      await reply.status(201).send({
        run,
        mutationToken: issueRunToken(deps, deps.ceoExecution.planRunStore.getRun(runId)),
      });
    },
  );

  app.get("/api/v1/ceo-plan-runs", () => {
    return { runs: deps.ceoExecution.planRunStore.listRuns() };
  });

  app.get<{ Params: RunIdParams }>("/api/v1/ceo-plan-runs/:runId", (request) => {
    const run = getRunOrThrow(deps, request.params.runId);
    const stepExecutions = deps.ceoExecution.planRunStore.listStepExecutions(run.id);
    const attempts = deps.ceoExecution.planRunStore.listAttempts(run.id);
    const circuit = deps.ceoExecution.planRunStore.getCircuitState(run.id);
    const interventions = deps.ceoExecution.planRunStore.listInterventions(run.id);
    return {
      run,
      stepExecutions,
      attempts,
      circuit,
      interventions,
      mutationToken: issueRunToken(deps, run),
    };
  });

  app.get<{ Params: RunIdParams; Querystring: EventsQuery }>(
    "/api/v1/ceo-plan-runs/:runId/events",
    (request) => {
      const run = getRunOrThrow(deps, request.params.runId);
      const afterSequence = parseAfterSequenceQuery(request.query.afterSequence);
      return { events: deps.ceoExecution.planRunStore.listEvents(run.id, afterSequence) };
    },
  );

  app.get<{ Params: RunIdParams }>("/api/v1/ceo-plan-runs/:runId/scheduler-status", (request) => {
    const run = getRunOrThrow(deps, request.params.runId);
    const steps = deps.ceoExecution.planRunStore.listStepExecutions(run.id);
    const attempts = deps.ceoExecution.planRunStore.listAttempts(run.id);
    const circuit = deps.ceoExecution.planRunStore.getCircuitState(run.id);
    return {
      state: run.status === "running" ? "active" : run.status === "paused" ? "paused" : "idle",
      pendingSignalCount: deps.ceoExecution.signalStore.countByState().pending,
      claimedSignalCount: deps.ceoExecution.signalStore.countByState().claimed,
      runningStepCount: steps.filter((s) => s.status === "running").length,
      waitingForDependencyCount: steps.filter((s) => s.status === "waiting_for_dependencies")
        .length,
      retryWaitingCount: steps.filter((s) => s.status === "retry_wait").length,
      circuitState: circuit.state,
      activeAttemptCount: attempts.filter((a) =>
        ["claimed", "starting", "running"].includes(a.status),
      ).length,
      lastDecisionAt: run.lastSchedulerDecisionAt,
    };
  });

  app.post<{ Params: RunIdParams }>("/api/v1/ceo-plan-runs/:runId/start", async (request) => {
    const parsed = runMutationTokenRequestSchema.safeParse(request.body);
    if (!parsed.success) invalidBody(parsed, "RunMutationTokenRequest");
    const run = getRunOrThrow(deps, request.params.runId);
    verifyRunToken(deps, run, parsed.data.expectedMutationToken);
    const started = deps.ceoExecution.planRunStore.startRun({
      runId: run.id,
      now: new Date().toISOString(),
    });
    appendLifecycleEvent(deps, run.id, "ceo.execution.started");
    await deps.ceoExecution.scheduler.enqueueSignal({
      planRunId: run.id,
      reason: "execution_started",
    });
    return {
      run: deps.ceoExecution.planRunStore.getRun(started.id),
      mutationToken: issueRunToken(deps, deps.ceoExecution.planRunStore.getRun(started.id)),
    };
  });

  app.post<{ Params: RunIdParams }>("/api/v1/ceo-plan-runs/:runId/pause", (request) => {
    const parsed = runMutationTokenRequestSchema.safeParse(request.body);
    if (!parsed.success) invalidBody(parsed, "RunMutationTokenRequest");
    const run = getRunOrThrow(deps, request.params.runId);
    verifyRunToken(deps, run, parsed.data.expectedMutationToken);
    deps.ceoExecution.runAtomicUnit(() => {
      deps.ceoExecution.planRunStore.pauseRun({ runId: run.id, now: new Date().toISOString() });
      deps.ceoExecution.signalStore.cancelSignalsForRun(run.id, new Date().toISOString());
    });
    appendLifecycleEvent(deps, run.id, "ceo.execution.paused");
    const updated = deps.ceoExecution.planRunStore.getRun(run.id);
    return { run: updated, mutationToken: issueRunToken(deps, updated) };
  });

  app.post<{ Params: RunIdParams }>("/api/v1/ceo-plan-runs/:runId/resume", async (request) => {
    const parsed = runMutationTokenRequestSchema.safeParse(request.body);
    if (!parsed.success) invalidBody(parsed, "RunMutationTokenRequest");
    const run = getRunOrThrow(deps, request.params.runId);
    verifyRunToken(deps, run, parsed.data.expectedMutationToken);
    const resumed = deps.ceoExecution.planRunStore.resumeRun({
      runId: run.id,
      now: new Date().toISOString(),
    });
    // Phase 15.6 — `registerDependencyIndex`'s own doc comment already
    // says "whenever a run is configured/resumed/recovered," but no call
    // site here ever actually did it on resume: the scheduler's
    // `#dependencyIndexes` map is in-memory only, and after a genuine
    // cross-process unclean restart (a different Hall Core process than
    // the one that configured this run) it is empty for this run even
    // though the run itself is durably resumable. Rebuilding it here,
    // unconditionally, is idempotent and cheap (an in-memory Map
    // overwrite) whether or not it was already present — matching exactly
    // what the clean-restart recovery branch already does for a
    // still-`"running"` run. Without this, `retryAbandonedStep` below
    // would enqueue a signal `#processSignal` silently drops at its own
    // `if (!index)` guard. Deliberately lets `getVersion` throw
    // naturally — the run's own approved plan version being unresolvable
    // here would mean something is already catastrophically wrong,
    // structurally impossible for a genuinely delegated, previously
    // `"running"` run.
    const version = deps.ceoPlanOrchestrator.getVersion(resumed.planId, resumed.planVersion);
    deps.ceoExecution.scheduler.registerDependencyIndex(
      resumed.id,
      version.steps.map((step) => ({ id: step.id, dependencies: step.dependencies })),
    );
    appendLifecycleEvent(deps, run.id, "ceo.execution.resumed");
    await deps.ceoExecution.scheduler.enqueueSignal({
      planRunId: run.id,
      reason: "operator_resumed",
    });
    const updated = deps.ceoExecution.planRunStore.getRun(resumed.id);
    return { run: updated, mutationToken: issueRunToken(deps, updated) };
  });

  app.post<{ Params: RunIdParams }>("/api/v1/ceo-plan-runs/:runId/cancel", (request) => {
    const parsed = runMutationTokenRequestSchema.safeParse(request.body);
    if (!parsed.success) invalidBody(parsed, "RunMutationTokenRequest");
    const run = getRunOrThrow(deps, request.params.runId);
    verifyRunToken(deps, run, parsed.data.expectedMutationToken);
    deps.ceoExecution.runAtomicUnit(() => {
      deps.ceoExecution.planRunStore.cancelRun({ runId: run.id, now: new Date().toISOString() });
      deps.ceoExecution.signalStore.cancelSignalsForRun(run.id, new Date().toISOString());
    });
    appendLifecycleEvent(deps, run.id, "ceo.execution.cancelled");
    const updated = deps.ceoExecution.planRunStore.getRun(run.id);
    return { run: updated, mutationToken: issueRunToken(deps, updated) };
  });

  app.post<{ Params: RunIdParams }>(
    "/api/v1/ceo-plan-runs/:runId/emergency-stop",
    async (request, reply) => {
      const parsed = runMutationTokenRequestSchema.safeParse(request.body);
      if (!parsed.success) invalidBody(parsed, "RunMutationTokenRequest");
      const run = getRunOrThrow(deps, request.params.runId);
      verifyRunToken(deps, run, parsed.data.expectedMutationToken);
      const result = deps.ceoExecution.scheduler.emergencyStop(run.id);
      const updated = deps.ceoExecution.planRunStore.getRun(run.id);
      await reply.status(202).send({
        result,
        run: updated,
        mutationToken: issueRunToken(deps, updated),
      });
    },
  );

  app.post<{ Params: RunStepParams }>(
    "/api/v1/ceo-plan-runs/:runId/steps/:stepId/retry",
    async (request) => {
      const parsed = runMutationTokenRequestSchema.safeParse(request.body);
      if (!parsed.success) invalidBody(parsed, "RunMutationTokenRequest");
      const { runId, stepId } = request.params;
      const run = getRunOrThrow(deps, runId);
      verifyRunToken(deps, run, parsed.data.expectedMutationToken);

      const step = deps.ceoExecution.planRunStore.getStepExecution(run.id, stepId);
      if (!RETRY_ELIGIBLE_STEP_STATUSES.has(step.status)) {
        throw new CeoPlanExecutionStepRetryNotEligibleError(run.id, stepId, step.status);
      }

      // Phase 15.6 — a step whose LATEST attempt is genuinely "abandoned"
      // (the one status only unclean-restart recovery ever sets — see
      // `ceo-plan-execution-recovery.ts`) can never be relaunched by the
      // ordinary `operator_manual_retry` signal path below: the
      // underlying child task is `"failed"` with
      // `HALL_RESTART_INTERRUPTED_RUN`, and nothing in `#tryAdvanceStep`
      // ever resets a restart-interrupted task back to `"assigned"` —
      // `#prepareTaskRetryIfEligible` explicitly excludes that failure
      // code by design. `scheduler.retryAbandonedStep()` is the one
      // narrow, explicit-operator-only path that does. Every other
      // retry-eligible step (an ordinary terminal `"failed"`, or
      // `"awaiting_intervention"` off a non-abandoned attempt) keeps the
      // exact previous behavior, unchanged.
      const attempts = deps.ceoExecution.planRunStore.listAttempts(run.id, stepId);
      const latestAttempt = attempts[attempts.length - 1];
      if (latestAttempt?.status === "abandoned") {
        await deps.ceoExecution.scheduler.retryAbandonedStep(run.id, stepId);
        deps.ceoExecution.planRunStore.recordIntervention({
          interventionId: randomUUID(),
          runId: run.id,
          type: "retry_step",
          note: undefined,
          now: new Date().toISOString(),
        });
      } else {
        deps.ceoExecution.planRunStore.recordIntervention({
          interventionId: randomUUID(),
          runId: run.id,
          type: "retry_step",
          note: undefined,
          now: new Date().toISOString(),
        });
        await deps.ceoExecution.scheduler.enqueueSignal({
          planRunId: run.id,
          planStepId: stepId,
          reason: "operator_manual_retry",
        });
      }

      const updatedRun = deps.ceoExecution.planRunStore.getRun(run.id);
      return {
        run: updatedRun,
        step: deps.ceoExecution.planRunStore.getStepExecution(run.id, stepId),
        mutationToken: issueRunToken(deps, updatedRun),
      };
    },
  );
}

export const CEO_PLAN_RUN_EVENTS_CLOSE_CODE_UNKNOWN_RUN = 4404;
export const CEO_PLAN_RUN_EVENTS_CLOSE_CODE_INVALID_QUERY = 4400;
export const CEO_PLAN_RUN_EVENTS_CLOSE_CODE_SUBSCRIBER_LIMIT = 4503;
export const CEO_PLAN_RUN_EVENTS_CLOSE_CODE_ORIGIN_NOT_ALLOWED = 4403;
export const CEO_PLAN_RUN_EVENTS_CLOSE_CODE_UNSUPPORTED_DATA = 1003;

export interface CeoPlanRunEventsSocket {
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message" | "close" | "error", listener: () => void): unknown;
}

function isOriginAllowed(originRaw: string | undefined, allowedOrigin: string): boolean {
  if (originRaw === undefined) return true;
  try {
    return parseWebOrigin(originRaw) === allowedOrigin;
  } catch {
    return false;
  }
}

/**
 * Mirrors `routes/ceo-plans.ts`'s `handleCeoPlanEventsConnection` exactly:
 * live subscription registered before replay, one monotonically
 * increasing `lastDelivered` sequence gates both replay and live delivery
 * so the two paths can never double-deliver, every outgoing frame is
 * re-validated through `ceoPlanExecutionEventSchema` immediately before
 * `send()`. A dedicated stream (`PlanRunEventBus`) — never mixed with
 * task/comparison/plan-definition events or Board messages.
 */
export function handleCeoPlanRunEventsConnection(
  socket: CeoPlanRunEventsSocket,
  params: {
    readonly runId: string;
    readonly afterSequenceRaw: string | undefined;
  },
  deps: CeoPlanRunRoutesDeps,
): void {
  const { runId } = params;

  if (!deps.ceoExecution.planRunStore.findRun(runId)) {
    socket.close(CEO_PLAN_RUN_EVENTS_CLOSE_CODE_UNKNOWN_RUN, "unknown run");
    return;
  }

  const afterSequenceRaw = params.afterSequenceRaw;
  let afterSequence: number | undefined;
  if (afterSequenceRaw !== undefined) {
    const parsedSeq = Number(afterSequenceRaw);
    if (!Number.isInteger(parsedSeq) || parsedSeq < 0) {
      socket.close(
        CEO_PLAN_RUN_EVENTS_CLOSE_CODE_INVALID_QUERY,
        "afterSequence must be a non-negative integer",
      );
      return;
    }
    afterSequence = parsedSeq;
  }

  let lastDelivered = afterSequence ?? -1;
  let finished = false;
  let unsubscribe: (() => void) | undefined;

  const send = (event: CeoPlanExecutionEvent): void => {
    if (finished || event.sequence <= lastDelivered) return;
    const validated = ceoPlanExecutionEventSchema.safeParse(event);
    if (!validated.success) return;
    try {
      socket.send(JSON.stringify(validated.data));
    } catch {
      // A send failure must not crash the server.
    }
    lastDelivered = validated.data.sequence;
  };

  try {
    unsubscribe = deps.ceoExecution.planRunEventBus.subscribe(runId, send);
  } catch {
    socket.close(CEO_PLAN_RUN_EVENTS_CLOSE_CODE_SUBSCRIBER_LIMIT, "subscriber limit reached");
    return;
  }

  for (const event of deps.ceoExecution.planRunStore.listEvents(runId, afterSequence)) {
    send(event);
  }

  socket.on("message", () => {
    finished = true;
    unsubscribe();
    socket.close(
      CEO_PLAN_RUN_EVENTS_CLOSE_CODE_UNSUPPORTED_DATA,
      "this endpoint does not accept client messages",
    );
  });

  const cleanup = (): void => {
    finished = true;
    unsubscribe();
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
}

export function registerCeoPlanRunEventsRoute(
  app: FastifyInstance,
  deps: CeoPlanRunRoutesDeps,
  options: { readonly allowedOrigin: string },
): void {
  app.get<{ Params: RunIdParams; Querystring: EventsQuery }>(
    "/api/v1/ceo-plan-runs/:runId/events/live",
    { websocket: true },
    (socket: WebSocket, request) => {
      if (!isOriginAllowed(request.headers.origin, options.allowedOrigin)) {
        socket.close(CEO_PLAN_RUN_EVENTS_CLOSE_CODE_ORIGIN_NOT_ALLOWED, "origin not allowed");
        return;
      }
      handleCeoPlanRunEventsConnection(
        socket,
        {
          runId: request.params.runId,
          afterSequenceRaw: request.query.afterSequence,
        },
        deps,
      );
    },
  );
}
