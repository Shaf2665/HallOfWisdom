import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { ceoPlanEventSchema, type CeoPlanEvent } from "@hall-of-wisdom/protocol";
import {
  createCeoPlanRequestSchema,
  createCeoPlanVersionRequestSchema,
  decideCeoPlanApprovalRequestSchema,
  mutationTokenRequestSchema,
} from "../schemas/ceo-plan-request.js";
import { InvalidRequestError } from "../errors/app-error.js";
import type { CeoPlanOrchestrator } from "../ceo-plans/ceo-plan-orchestrator.js";
import { parseWebOrigin } from "../config/web-origin.js";

export interface CeoPlanRoutesDeps {
  readonly orchestrator: CeoPlanOrchestrator;
}

interface TaskIdParams {
  readonly taskId: string;
}
interface PlanIdParams {
  readonly planId: string;
}
interface PlanVersionParams extends PlanIdParams {
  readonly version: string;
}
interface EventsQuery {
  readonly afterSequence?: string;
}

function parseAfterSequenceQuery(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidRequestError("afterSequence must be a non-negative integer.");
  }
  return parsed;
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

/**
 * Phase 14 — CEO Agent planning, approval-gated delegation, and plan
 * tracking. Every mutating route below does exactly one thing and no
 * more: `POST .../ceo-plans` only ever generates a draft (never a child
 * task, never an adapter assignment — see `CeoPlanOrchestrator.createPlan`'s
 * doc comment), `.../approve` only ever records a decision, and
 * `.../delegate` is the one and only route that creates child tasks.
 * See `docs/architecture/0014-ceo-planning-approval-and-delegation.md`.
 */
export function registerCeoPlanRoutes(app: FastifyInstance, deps: CeoPlanRoutesDeps): void {
  app.post<{ Params: TaskIdParams }>("/api/v1/tasks/:taskId/ceo-plans", async (request, reply) => {
    const parsed = createCeoPlanRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) invalidBody(parsed, "CreateCeoPlanRequest");
    const { plan, version } = await deps.orchestrator.createPlan(
      request.params.taskId,
      parsed.data.planningInstructions,
    );
    await reply.status(201).send({ plan, version });
  });

  app.get("/api/v1/ceo-plans", () => {
    return { plans: deps.orchestrator.listPlans() };
  });

  app.get<{ Params: PlanIdParams }>("/api/v1/ceo-plans/:planId", (request) => {
    // Phase 14.1 — pure read, no store write: see
    // `CeoPlanOrchestrator.getPlanWithProgress`'s doc comment.
    const { plan, progress } = deps.orchestrator.getPlanWithProgress(request.params.planId);
    const links = deps.orchestrator.listDelegationLinks(request.params.planId);
    // `mutationToken` is the opaque optimistic-concurrency token every
    // mutating route below requires as `expectedMutationToken` — exposed
    // only here so a browser that lands cold on a plan's detail page can
    // learn the value it must echo back. Never the plan's internal
    // revision integer itself, and never a `CeoPlanVersion`'s private
    // `internalRevision` either. See `CeoPlanOrchestrator.getMutationToken`'s
    // doc comment.
    const mutationToken = deps.orchestrator.getMutationToken(request.params.planId);
    return { plan, progress, links, mutationToken };
  });

  app.get<{ Params: PlanIdParams }>("/api/v1/ceo-plans/:planId/versions", (request) => {
    return { versions: deps.orchestrator.listVersions(request.params.planId) };
  });

  app.get<{ Params: PlanVersionParams }>(
    "/api/v1/ceo-plans/:planId/versions/:version",
    (request) => {
      const version = Number(request.params.version);
      if (!Number.isInteger(version) || version < 1) {
        throw new InvalidRequestError("version must be a positive integer.");
      }
      return deps.orchestrator.getVersion(request.params.planId, version);
    },
  );

  app.get<{ Params: PlanIdParams }>("/api/v1/ceo-plans/:planId/approvals", (request) => {
    return { approvals: deps.orchestrator.listApprovals(request.params.planId) };
  });

  app.get<{ Params: PlanIdParams; Querystring: EventsQuery }>(
    "/api/v1/ceo-plans/:planId/events",
    (request) => {
      const afterSequence = parseAfterSequenceQuery(request.query.afterSequence);
      return { events: deps.orchestrator.listEvents(request.params.planId, afterSequence) };
    },
  );

  app.post<{ Params: PlanIdParams }>(
    "/api/v1/ceo-plans/:planId/versions",
    async (request, reply) => {
      const parsed = createCeoPlanVersionRequestSchema.safeParse(request.body);
      if (!parsed.success) invalidBody(parsed, "CreateCeoPlanVersionRequest");
      const { plan, version } = await deps.orchestrator.createVersion(
        request.params.planId,
        parsed.data.expectedMutationToken,
        {
          objective: parsed.data.objective,
          summary: parsed.data.summary,
          assumptions: parsed.data.assumptions,
          constraints: parsed.data.constraints,
          steps: parsed.data.steps.map((step) => ({
            id: step.id,
            position: step.position,
            title: step.title,
            objective: step.objective,
            boundedInstructions: step.boundedInstructions,
            acceptanceCriteria: step.acceptanceCriteria,
            dependencies: step.dependencies,
            ...(step.requirements !== undefined ? { requirements: step.requirements } : {}),
            ...(step.selectedAdapterId !== undefined
              ? { selectedAdapterId: step.selectedAdapterId }
              : {}),
          })),
        },
        "operator",
      );
      await reply.status(201).send({ plan, version });
    },
  );

  app.post<{ Params: PlanIdParams }>("/api/v1/ceo-plans/:planId/submit", async (request) => {
    const parsed = mutationTokenRequestSchema.safeParse(request.body);
    if (!parsed.success) invalidBody(parsed, "MutationTokenRequest");
    return deps.orchestrator.submit(request.params.planId, parsed.data.expectedMutationToken);
  });

  app.post<{ Params: PlanIdParams }>("/api/v1/ceo-plans/:planId/approve", async (request) => {
    const parsed = decideCeoPlanApprovalRequestSchema.safeParse(request.body);
    if (!parsed.success) invalidBody(parsed, "DecideCeoPlanApprovalRequest");
    return deps.orchestrator.decideApproval(
      request.params.planId,
      parsed.data.expectedMutationToken,
      parsed.data.planVersion,
      parsed.data.contentHash,
      "approve",
      parsed.data.operatorNote,
    );
  });

  app.post<{ Params: PlanIdParams }>("/api/v1/ceo-plans/:planId/reject", async (request) => {
    const parsed = decideCeoPlanApprovalRequestSchema.safeParse(request.body);
    if (!parsed.success) invalidBody(parsed, "DecideCeoPlanApprovalRequest");
    return deps.orchestrator.decideApproval(
      request.params.planId,
      parsed.data.expectedMutationToken,
      parsed.data.planVersion,
      parsed.data.contentHash,
      "reject",
      parsed.data.operatorNote,
    );
  });

  app.post<{ Params: PlanIdParams }>(
    "/api/v1/ceo-plans/:planId/delegate",
    async (request, reply) => {
      const parsed = mutationTokenRequestSchema.safeParse(request.body);
      if (!parsed.success) invalidBody(parsed, "MutationTokenRequest");
      const result = await deps.orchestrator.delegate(
        request.params.planId,
        parsed.data.expectedMutationToken,
      );
      await reply.status(202).send(result);
    },
  );

  app.post<{ Params: PlanIdParams }>("/api/v1/ceo-plans/:planId/cancel", async (request) => {
    const parsed = mutationTokenRequestSchema.safeParse(request.body);
    if (!parsed.success) invalidBody(parsed, "MutationTokenRequest");
    return deps.orchestrator.cancel(request.params.planId, parsed.data.expectedMutationToken);
  });
}

export interface CeoPlanEventsSocket {
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message" | "close" | "error", listener: () => void): unknown;
}

export const CEO_PLAN_EVENTS_CLOSE_CODE_UNKNOWN_PLAN = 4404;
export const CEO_PLAN_EVENTS_CLOSE_CODE_INVALID_QUERY = 4400;
export const CEO_PLAN_EVENTS_CLOSE_CODE_SUBSCRIBER_LIMIT = 4503;
export const CEO_PLAN_EVENTS_CLOSE_CODE_ORIGIN_NOT_ALLOWED = 4403;
export const CEO_PLAN_EVENTS_CLOSE_CODE_UNSUPPORTED_DATA = 1003;

function isOriginAllowed(originRaw: string | undefined, allowedOrigin: string): boolean {
  if (originRaw === undefined) return true;
  try {
    return parseWebOrigin(originRaw) === allowedOrigin;
  } catch {
    return false;
  }
}

/**
 * Mirrors `routes/task-events.ts`/`routes/board-messages.ts` exactly:
 * live subscription registered before replay, one monotonically
 * increasing `lastDelivered` sequence gates both replay and live
 * delivery so the two paths can never double-deliver, and every
 * outgoing frame is re-validated through `ceoPlanEventSchema`
 * immediately before `send()`. A CEO plan's event stream, like a
 * board's, has no terminal concept — it stays open until the client
 * disconnects or the server shuts down.
 */
/**
 * Origin validation happens once, in `registerCeoPlanEventsRoute`, before
 * this function is ever called — kept out of this function (unlike
 * `task-events.ts`'s single-function design) purely so it can be unit
 * tested directly against a fake socket without needing a real Fastify
 * request object with headers.
 */
export function handleCeoPlanEventsConnection(
  socket: CeoPlanEventsSocket,
  params: {
    readonly planId: string;
    readonly afterSequenceRaw: string | undefined;
  },
  deps: CeoPlanRoutesDeps,
): void {
  const { planId } = params;

  try {
    deps.orchestrator.getPlan(planId);
  } catch {
    socket.close(CEO_PLAN_EVENTS_CLOSE_CODE_UNKNOWN_PLAN, "unknown plan");
    return;
  }

  const afterSequenceRaw = params.afterSequenceRaw;
  let afterSequence: number | undefined;
  if (afterSequenceRaw !== undefined) {
    const parsed = Number(afterSequenceRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      socket.close(
        CEO_PLAN_EVENTS_CLOSE_CODE_INVALID_QUERY,
        "afterSequence must be a non-negative integer",
      );
      return;
    }
    afterSequence = parsed;
  }

  let lastDelivered = afterSequence ?? -1;
  let finished = false;
  let unsubscribe: (() => void) | undefined;

  const send = (event: CeoPlanEvent): void => {
    if (finished || event.sequence <= lastDelivered) return;
    const validated = ceoPlanEventSchema.safeParse(event);
    if (!validated.success) return;
    try {
      socket.send(JSON.stringify(validated.data));
    } catch {
      // A send failure must not crash the server.
    }
    lastDelivered = validated.data.sequence;
  };

  try {
    unsubscribe = deps.orchestrator.subscribeToPlanEvents(planId, send);
  } catch {
    socket.close(CEO_PLAN_EVENTS_CLOSE_CODE_SUBSCRIBER_LIMIT, "subscriber limit reached");
    return;
  }

  for (const event of deps.orchestrator.listEvents(planId, afterSequence)) {
    send(event);
  }

  socket.on("message", () => {
    finished = true;
    unsubscribe();
    socket.close(
      CEO_PLAN_EVENTS_CLOSE_CODE_UNSUPPORTED_DATA,
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

export function registerCeoPlanEventsRoute(
  app: FastifyInstance,
  deps: CeoPlanRoutesDeps,
  options: { readonly allowedOrigin: string },
): void {
  app.get<{ Params: PlanIdParams; Querystring: EventsQuery }>(
    "/api/v1/ceo-plans/:planId/events/live",
    { websocket: true },
    (socket: WebSocket, request) => {
      if (!isOriginAllowed(request.headers.origin, options.allowedOrigin)) {
        socket.close(CEO_PLAN_EVENTS_CLOSE_CODE_ORIGIN_NOT_ALLOWED, "origin not allowed");
        return;
      }
      handleCeoPlanEventsConnection(
        socket,
        {
          planId: request.params.planId,
          afterSequenceRaw: request.query.afterSequence,
        },
        deps,
      );
    },
  );
}
