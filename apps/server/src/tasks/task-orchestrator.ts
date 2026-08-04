import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { validateWorkspace } from "@hall-of-wisdom/hall-runner";
import { isTerminalEventType, RunnerError, runTask } from "@hall-of-wisdom/hall-runner";
import type { RunTaskResult } from "@hall-of-wisdom/hall-runner";
import {
  parseAgentTaskInput,
  type AgentAdapter,
  type AgentTaskInput,
} from "@hall-of-wisdom/agent-adapter-sdk";
import {
  parseHallTask,
  type ExecutionTrust,
  type HallTask,
  type NormalizedAgentEvent,
  type TaskRequirements,
} from "@hall-of-wisdom/protocol";
import {
  AdapterNotFoundError,
  AdapterRequirementsMismatchError,
  AdapterUnavailableError,
  ActiveTaskTransitionDeniedError,
  InternalServerError,
  InvalidManualTransitionError,
  InvalidRequestError,
  NoRoutingCandidateError,
  TaskRequirementsNotSetError,
  TaskStateConflictError,
  WorkspaceValidationFailedError,
} from "../errors/app-error.js";
import {
  isExecutionControlledStatus,
  isManualTransitionAllowed,
  isTerminalTaskStatus,
} from "./task-status-transitions.js";
import type { TaskRecord } from "./task-record.js";
import type { TaskStorePort } from "./task-store-port.js";
import type { NormalizedEventStorePort } from "../events/event-store-port.js";
import type { EventBus } from "../events/event-bus.js";
import { EventStoreError } from "../events/event-store-errors.js";
import {
  buildInfrastructureCancellationEvent,
  buildInfrastructureFailureEvent,
} from "../events/synthetic-events.js";
import {
  assignTaskRequestSchema,
  createTaskRequestSchema,
  type CreateTaskRequest,
  type DeferredCreateTaskRequest,
  type ImmediateCreateTaskRequest,
} from "../schemas/create-task-request.js";
import {
  transitionTaskRequestSchema,
  type TransitionTaskRequest,
} from "../schemas/transition-task-request.js";
import { routingRequestSchema, type RoutingRequest } from "../schemas/routing-request.js";
import { detectRoutingCandidates } from "../routing/candidate-detection.js";
import {
  evaluateCandidateEligibility,
  evaluateRouting,
  type RoutingCandidate,
} from "../routing/routing-policy.js";
import { AgentExecutionOrchestrationError } from "../agent-execution/agent-execution-errors.js";
import type { IsolatedAgentExecutionCoordinator } from "../agent-execution/isolated-agent-execution-coordinator.js";
import type { AgentExecutionArtifactTerminalizer } from "../agent-execution/agent-execution-artifact-terminalizer.js";
import {
  buildAgentExecutionTerminalSnapshot,
  type AgentExecutionTerminalSnapshot,
} from "../agent-execution/agent-execution-terminal-snapshot.js";

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export interface TaskOrchestratorOptions {
  readonly taskStore: TaskStorePort;
  readonly eventStore: NormalizedEventStorePort;
  readonly eventBus: EventBus;
  readonly registry: AgentRegistry;
  /** Canonical, already-validated workspace root — see `server.ts` / `validateWorkspace`. */
  readonly workspaceRoot: string;
  readonly onExecutionError?: ((taskId: string, error: unknown) => void) | undefined;
  readonly executionCoordinator?: IsolatedAgentExecutionCoordinator | undefined;
  readonly artifactTerminalizer?: AgentExecutionArtifactTerminalizer | undefined;
}

export interface CreateTaskResult {
  readonly task: HallTask;
  /** Absent for a deferred (planning-only) task — nothing has started yet. */
  readonly runId?: string;
}

export interface StartTaskResult {
  readonly task: HallTask;
  readonly runId: string;
}

/** Phase 11 — the response shape for `POST .../routing-analysis`. Read-only: never mutates anything. */
export interface RoutingAnalysisResult {
  readonly taskId: string;
  readonly requiredCapabilities: TaskRequirements["requiredCapabilities"];
  readonly allowedExecutionTrust: TaskRequirements["allowedExecutionTrust"];
  readonly candidates: readonly RoutingCandidate[];
  readonly recommendedAdapterId: string | undefined;
  readonly explanation: string;
  readonly generatedAt: string;
}

/** Phase 11 — the response shape for `POST .../route-and-assign`. */
export interface RouteAndAssignResult {
  readonly record: TaskRecord;
  readonly routingExplanation: string;
  readonly generatedAt: string;
}

/**
 * Provider-neutral: never references Mock Agent, `MockAgentAdapter`, or
 * any adapter-specific type. Resolves adapters purely through the
 * injected `AgentRegistry`'s `AgentAdapter` interface, and drives
 * execution purely through Hall Runner's public `runTask()` — the same
 * function `@hall-of-wisdom/hall-runner`'s own CLI uses, just with an
 * `onEvent` sink instead of writing JSON Lines to stdout.
 */
export class TaskOrchestrator {
  readonly #taskStore: TaskStorePort;
  readonly #eventStore: NormalizedEventStorePort;
  readonly #eventBus: EventBus;
  readonly #registry: AgentRegistry;
  readonly #workspaceRoot: string;
  readonly #onExecutionError: ((taskId: string, error: unknown) => void) | undefined;
  readonly #executionCoordinator: IsolatedAgentExecutionCoordinator | undefined;
  readonly #artifactTerminalizer: AgentExecutionArtifactTerminalizer | undefined;

  readonly #activeControllers = new Map<string, AbortController>();
  readonly #activeExecutions = new Map<string, Promise<void>>();

  /**
   * The canonical, absolute working directory validated for a task that
   * has been assigned (or created deferred with one) but not yet started.
   * Deliberately never part of `TaskRecord` — that type is serialized
   * directly as an HTTP response body, and an absolute filesystem path
   * must never reach the browser (see `docs/architecture/0006-kanban-board.md`,
   * "Assignment and Start separation"). Cleared once `startTask()` reads
   * it (the value then lives only inside the `AgentTaskInput` already
   * handed to Hall Runner).
   */
  readonly #pendingWorkingDirectories = new Map<string, string>();

  /**
   * Phase 15.2 — the per-task sequence offset the CURRENT run's events
   * must be shifted by before reaching `EventStore`. Every adapter's
   * `EventFactory` (see `@hall-of-wisdom/agent-adapter-sdk`) always
   * starts its own sequence counter at `0` for whatever run it was
   * given — it has no notion of "this is attempt 2, start at 2," and
   * changing that contract would mean threading a starting offset
   * through every adapter package, which this class deliberately does
   * not require. Instead, `startTask()` captures
   * `eventStore.nextSequence(taskId)` once, right before the adapter is
   * invoked, and `#handleEvent()` adds it to every event's own
   * adapter-local `sequence` before storing/publishing — so `EventStore`
   * still sees one continuous, ever-increasing per-task sequence
   * (attempt 1's events at 0..N, attempt 2's at N+1..M, ...) while the
   * adapter itself only ever has to know how to number ITS OWN run.
   * Absent (defaults to `0` at every read site) for a task's first-ever
   * run, and for any run whose orchestrator instance was freshly
   * constructed (e.g. after a restart) — `startTask()` always
   * re-establishes it fresh before that run's first event can arrive, so
   * a missing entry here is never itself a source of drift.
   */
  readonly #runSequenceBase = new Map<string, number>();

  constructor(options: TaskOrchestratorOptions) {
    this.#taskStore = options.taskStore;
    this.#eventStore = options.eventStore;
    this.#eventBus = options.eventBus;
    this.#registry = options.registry;
    this.#workspaceRoot = options.workspaceRoot;
    this.#onExecutionError = options.onExecutionError;
    this.#executionCoordinator = options.executionCoordinator;
    this.#artifactTerminalizer = options.artifactTerminalizer;
  }

  createTask(rawRequest: unknown): CreateTaskResult {
    const parsedRequest = this.#parseCreateRequest(rawRequest);
    return parsedRequest.executionMode === "deferred"
      ? this.#createDeferredTask(parsedRequest)
      : this.#createImmediateTask(parsedRequest);
  }

  /**
   * Assigns (or reassigns, before start) an adapter to a planning task.
   * Async only because of the `adapter.detect()` availability check — no
   * run is created, no status other than `ready -> assigned` (on first
   * assignment) is touched, and reassignment of an already-`assigned`,
   * not-yet-started task leaves status untouched.
   *
   * The eligibility check below (before `adapter.detect()`) is only a
   * fast-fail: it lets an obviously-ineligible request skip the
   * potentially-slow `detect()` call entirely, and preserves this
   * method's existing 409-on-a-backlog-task behavior without waiting on
   * I/O. It is NOT what makes this method race-safe — `assignTask()` reads
   * a snapshot, then `await`s, and Node can run arbitrary other code
   * (another request's handler) during that `await`. The snapshot taken
   * here — including `taskStore.getRevision(taskId)` — could be stale by
   * the time `detect()` resolves.
   *
   * `TaskStore.assignIfEligible()` is what actually closes that race,
   * including the ABA case a plain four-field compare cannot (Ready ->
   * Blocked -> Ready while this request was awaiting `adapter.detect()`,
   * which restores every one of those four fields to what this request
   * originally observed): it re-validates `expectedRevision` — captured
   * here, before the `await` — against the task's CURRENT live revision,
   * plus the same four-field snapshot as defense-in-depth, and applies the
   * assignment in one synchronous call with no `await` in between. See its
   * own doc comment for the full policy. If the task's lifecycle moved on
   * at all while this request was awaiting `adapter.detect()` — blocked,
   * cancelled, started, reassigned, or any round trip back to an
   * outwardly identical state — this throws `TaskStateConflictError` (409)
   * instead of silently overwriting whatever the task's current state
   * actually is.
   *
   * Phase 11.1 — **requirements are an assignment invariant, not merely a
   * routing input**: if the task carries `requirements` (from a prior
   * routing decision, or set directly), the selected adapter must satisfy
   * them or this throws `AdapterRequirementsMismatchError` (409,
   * `ADAPTER_REQUIREMENTS_MISMATCH`) before ever reaching
   * `assignIfEligible`. The compatibility check reuses
   * `evaluateCandidateEligibility` — the exact same function
   * `routing-analysis`/`route-and-assign` use — never a second,
   * independent capability-matching algorithm. A task with no
   * `requirements` is completely unaffected (the check is skipped
   * entirely), preserving the exact pre-11.1 assignment behavior for
   * every task that has never gone through routing. `requirements` is
   * read from `preCheck` (the same pre-`await` snapshot the four-field
   * compare already uses), not re-fetched after `detect()` resolves — if
   * a competing request changed `requirements` in the meantime, that
   * always happens through `TaskStore.assignIfEligible()`, which always
   * bumps the task's revision, so a stale `requirements` read here is
   * still caught by the existing revision check below (as
   * `TaskStateConflictError`, a different case from a requirements
   * mismatch against an accurately-read snapshot).
   */
  async assignTask(taskId: string, rawRequest: unknown): Promise<TaskRecord> {
    const parsed = this.#parseAssignRequest(rawRequest);
    const preCheck = this.#taskStore.get(taskId);
    const expectedRevision = this.#taskStore.getRevision(taskId);

    const isFirstAssignment = preCheck.task.status === "ready";
    const isReassignment = preCheck.task.status === "assigned" && preCheck.runId === undefined;
    if (!isFirstAssignment && !isReassignment) {
      throw new TaskStateConflictError(taskId, preCheck.task.status, "assigned");
    }

    const adapter = this.#resolveAdapter(parsed.adapterId);
    const detection = await adapter.detect();
    if (detection.availability !== "available") {
      throw new AdapterUnavailableError(parsed.adapterId, detection.availability);
    }
    const executionTrust: ExecutionTrust = detection.executionTrust ?? "unavailable";

    if (preCheck.task.requirements !== undefined) {
      const eligibility = evaluateCandidateEligibility(preCheck.task.requirements, {
        adapterId: parsed.adapterId,
        displayName: adapter.descriptor.displayName,
        integrationLevel: adapter.descriptor.integrationLevel,
        availability: detection.availability,
        executionTrust,
        capabilityObservations: detection.capabilityObservations ?? [],
      });
      if (!eligibility.eligible) {
        throw new AdapterRequirementsMismatchError();
      }
    }

    const canonicalWorkingDirectory =
      parsed.workingDirectory !== undefined
        ? this.#resolveWorkingDirectory(parsed.workingDirectory)
        : (this.#pendingWorkingDirectories.get(taskId) ?? this.#resolveWorkingDirectory(undefined));

    // Atomic commit — see TaskStore.assignIfEligible()'s doc comment. No
    // `await` occurs between this call and the fast-fail check above other
    // than the already-completed `adapter.detect()`.
    const record = this.#taskStore.assignIfEligible(
      taskId,
      expectedRevision,
      {
        status: preCheck.task.status,
        runId: preCheck.runId,
        adapterId: preCheck.adapterId,
        agentId: preCheck.agentId,
      },
      {
        adapterId: parsed.adapterId,
        agentId: adapter.descriptor.supportedAgent.agentId,
        executionTrust,
      },
    );

    // Only cache the resolved working directory once the assignment this
    // request made has actually been committed — a losing request must
    // never overwrite the winner's working directory.
    this.#pendingWorkingDirectories.set(taskId, canonicalWorkingDirectory);

    return record;
  }

  /**
   * Phase 15.2 — starts execution for a task already assigned via
   * `assignTask()`. This is the single authoritative launch boundary:
   * every caller (manual `POST .../start`, the CEO autonomous execution
   * scheduler, and any future caller) goes through this one method, and
   * no provider process may start before every check below passes. It is
   * deliberately structured exactly like `assignTask()` (see that
   * method's doc comment) rather than the old claim-then-detect ordering,
   * because assignment-time eligibility can silently go stale by the time
   * a task actually launches — an adapter can go unavailable, a
   * capability/execution-trust observation can degrade, or `requirements`
   * can change, all while this task sat `assigned` (possibly for a long
   * time, e.g. queued behind other autonomous work).
   *
   * Order of operations, matching the numbered steps in
   * `docs/architecture/0015-autonomous-plan-execution-and-scheduling.md`,
   * "Authoritative launch-time eligibility":
   *
   * 1. Load the current record and snapshot `expectedRevision` plus the
   *    four-field ABA-detection struct (`status`/`runId`/`adapterId`/
   *    `agentId`) — BEFORE any `await` below.
   * 2. Resolve the assigned adapter and re-run `detect()` — the exact same
   *    fresh capability/availability/execution-trust read `assignTask()`
   *    performs, never a cached or assignment-time value.
   * 3. Re-run `evaluateCandidateEligibility()` against the task's CURRENT
   *    `requirements` (read from this same pre-`await` snapshot — any
   *    concurrent change to `requirements` always goes through
   *    `assignIfEligible()`, which always bumps revision, so a stale read
   *    here is still caught by step 5's revision check) using the
   *    just-detected capabilities/execution-trust — the identical
   *    eligibility function routing analysis and assignment already use,
   *    never a second, independent capability-matching algorithm.
   * 4. Resolve the working directory (synchronous, no `await` gap before
   *    the atomic commit).
   * 5. Atomically commit the launch reservation via
   *    `TaskStore.startIfEligible()`, which independently re-validates
   *    the revision + four-field snapshot against the store's CURRENT
   *    live state and throws `TaskStateConflictError` on any drift
   *    (revision changed, status changed, assignment changed, another run
   *    ID appeared) — see its own doc comment for why revision, not a
   *    plain field compare, is what closes the ABA race.
   * 6. Only after that commit succeeds does the adapter actually get
   *    invoked (`#beginExecution`).
   *
   * Every rejection path throws one of the same, already-safe error types
   * `assignTask()` uses (`AdapterUnavailableError`,
   * `AdapterRequirementsMismatchError`, `TaskStateConflictError`,
   * `WorkspaceValidationFailedError`) — never raw detection output, and
   * never a silent fallback to a different adapter.
   */
  async startTask(taskId: string): Promise<StartTaskResult> {
    const preCheck = this.#taskStore.get(taskId);
    const expectedRevision = this.#taskStore.getRevision(taskId);

    if (preCheck.task.status !== "assigned" || preCheck.runId !== undefined) {
      throw new TaskStateConflictError(taskId, preCheck.task.status, "started");
    }
    if (preCheck.adapterId === undefined) {
      throw new InternalServerError(`Task "${taskId}" is assigned but has no adapterId recorded.`);
    }

    const adapter = this.#resolveAdapter(preCheck.adapterId);
    const detection = await adapter.detect();
    if (detection.availability !== "available") {
      throw new AdapterUnavailableError(preCheck.adapterId, detection.availability);
    }
    const executionTrust: ExecutionTrust = detection.executionTrust ?? "unavailable";

    if (preCheck.task.requirements !== undefined) {
      const eligibility = evaluateCandidateEligibility(preCheck.task.requirements, {
        adapterId: preCheck.adapterId,
        displayName: adapter.descriptor.displayName,
        integrationLevel: adapter.descriptor.integrationLevel,
        availability: detection.availability,
        executionTrust,
        capabilityObservations: detection.capabilityObservations ?? [],
      });
      if (!eligibility.eligible) {
        throw new AdapterRequirementsMismatchError();
      }
    }

    const runId = randomUUID();
    const workingDirectory =
      this.#pendingWorkingDirectories.get(taskId) ?? this.#resolveWorkingDirectory(undefined);

    // Atomic commit — see TaskStore.startIfEligible()'s doc comment. No
    // `await` occurs between this call and the eligibility checks above
    // other than the already-completed `adapter.detect()`.
    const record = this.#taskStore.startIfEligible(
      taskId,
      expectedRevision,
      {
        status: preCheck.task.status,
        runId: preCheck.runId,
        adapterId: preCheck.adapterId,
        agentId: preCheck.agentId,
      },
      runId,
    );

    // Only consume the cached working directory once THIS request's start
    // has actually been committed — a losing concurrent request (rejected
    // by `startIfEligible` above) must never delete the winner's cached
    // working directory. Mirrors `assignTask()`'s "only cache once
    // committed" ordering, for consumption instead of caching.
    this.#pendingWorkingDirectories.delete(taskId);

    const taskInput = parseAgentTaskInput({
      hallTask: record.task,
      agentIdentity: adapter.descriptor.supportedAgent,
      runId,
      workingDirectory,
    });

    // Phase 15.2 — establish this run's sequence offset BEFORE the
    // adapter can produce a single event: see `#runSequenceBase`'s doc
    // comment. `eventStore.nextSequence(taskId)` is exactly "how many
    // events this task already has" — 0 for a first-ever run, or
    // continuing past a prior attempt's events for a governed retry.
    this.#runSequenceBase.set(taskId, this.#eventStore.nextSequence(taskId));

    this.#beginExecution(taskId, adapter.descriptor.adapterId, taskInput, workingDirectory);

    return { task: record.task, runId };
  }

  /**
   * Phase 15.2 — prepares a genuinely terminal `"failed"` task for a
   * governed retry: atomically resets it back to `"assigned"` and
   * reopens its event stream so a fresh `startTask()` can claim a new
   * run. This is deliberately the ONLY place that ever reverses a task
   * out of a terminal status, and it is deliberately narrow — it never
   * decides WHETHER a retry is eligible (that is entirely
   * `CeoPlanExecutionScheduler`'s job: attempt/policy/circuit/generation/
   * classification/run-status checks, none of which this class knows
   * about), and it never re-runs adapter detection or eligibility itself
   * — `startTask()` (called by the scheduler immediately after this
   * succeeds) is the sole authority for "is this still launchable right
   * now," exactly the same authority it is for a task's first launch.
   * Duplicating that check here would only add an extra `await` gap
   * between two atomic commits, reopening exactly the kind of race
   * Section 1 closed.
   *
   * Synchronous — no `await` anywhere in this method — so its own
   * TaskStore commit and the caller's surrounding checks never straddle
   * an await gap.
   *
   * Two-store span, deliberately ordered: `TaskStore.
   * prepareRetryIfEligible()` first (the rollback-covered, revision-
   * checked commit — if this throws, nothing happened) THEN
   * `EventStore.reopenForRetry()` second (not itself rollback-covered,
   * but idempotent-shaped and safe to fail after: if it somehow returned
   * `false` here despite the precondition above, the task would be left
   * `"assigned"` with its stream still capped at the old terminal
   * sequence — the very next `startTask()` attempt would then fail
   * closed with a clear, bounded infrastructure error
   * (`EventAfterTerminalError` -> `#handleEventStoreFailure`) rather than
   * silently corrupting or duplicating anything). This mirrors the
   * project's existing "un-rollbackable step goes last, and stays safe
   * even if it fails" discipline.
   *
   * Throws `TaskStateConflictError` if the live task is not genuinely
   * `"failed"` with no run claimed (the same error a losing concurrent
   * caller gets — treat it as "someone else already prepared this retry
   * or the task moved on," never a reason to retry the call).
   */
  prepareRetry(taskId: string): TaskRecord {
    const preCheck = this.#taskStore.get(taskId);
    const expectedRevision = this.#taskStore.getRevision(taskId);

    if (preCheck.task.status !== "failed") {
      throw new TaskStateConflictError(taskId, preCheck.task.status, "assigned");
    }

    const record = this.#taskStore.prepareRetryIfEligible(taskId, expectedRevision, {
      status: preCheck.task.status,
      runId: preCheck.runId,
      adapterId: preCheck.adapterId,
      agentId: preCheck.agentId,
    });

    if (preCheck.lastSequence !== undefined) {
      const reopened = this.#eventStore.reopenForRetry(taskId, preCheck.lastSequence);
      if (!reopened) {
        throw new TaskStateConflictError(taskId, "failed", "assigned");
      }
    }

    return record;
  }

  /**
   * Phase 11 — read-only capability/trust routing analysis. Never mutates
   * `TaskStore`, never emits an event, never starts or assigns anything —
   * `rawRequest`'s optional `requirements` override (if supplied) is used
   * only for this one call and is never persisted; when omitted, the
   * task's own persisted `task.requirements` is used instead. Throws
   * `TaskRequirementsNotSetError` if neither exists. Runs a fresh
   * `detect()` across every registered adapter (via
   * `detectRoutingCandidates`) so the analysis always reflects the current
   * machine state, not a cached prior result.
   */
  async routingAnalysis(taskId: string, rawRequest: unknown): Promise<RoutingAnalysisResult> {
    const parsed = this.#parseRoutingRequest(rawRequest);
    const { task } = this.#taskStore.get(taskId);
    const requirements = parsed.requirements ?? task.requirements;
    if (requirements === undefined) {
      throw new TaskRequirementsNotSetError(taskId);
    }

    const candidates = await detectRoutingCandidates(this.#registry);
    const routing = evaluateRouting(requirements, candidates);

    return {
      taskId,
      requiredCapabilities: requirements.requiredCapabilities,
      allowedExecutionTrust: requirements.allowedExecutionTrust,
      candidates: routing.candidates,
      recommendedAdapterId: routing.recommendedAdapterId,
      explanation: routing.explanation,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Phase 11 — explicit-operator "route and assign" action: runs the same
   * fresh detection and deterministic policy as `routingAnalysis()`, then
   * atomically assigns the recommended adapter — assignment only, exactly
   * like `assignTask()`; never starts execution, never creates a run.
   * Mirrors `assignTask()`'s concurrency structure precisely: snapshot
   * `expectedRevision` before any `await`, fast-fail the obviously
   * ineligible case before the slow work, and commit through
   * `TaskStore.assignIfEligible()` with no `await` between the read and
   * the write — see that method's doc comment for why this is what
   * actually closes the race, not this method's own pre-check. Persists
   * whatever `requirements` this call actually routed against onto the
   * task at commit time (including a body-supplied override that was
   * never previously on the task), and a snapshot of the winning
   * adapter's `executionTrust`, in the same atomic commit as the
   * assignment — see `TaskStore.assignIfEligible()`'s doc comment.
   */
  async routeAndAssign(taskId: string, rawRequest: unknown): Promise<RouteAndAssignResult> {
    const parsed = this.#parseRoutingRequest(rawRequest);
    const preCheck = this.#taskStore.get(taskId);
    const expectedRevision = this.#taskStore.getRevision(taskId);

    const isFirstAssignment = preCheck.task.status === "ready";
    const isReassignment = preCheck.task.status === "assigned" && preCheck.runId === undefined;
    if (!isFirstAssignment && !isReassignment) {
      throw new TaskStateConflictError(taskId, preCheck.task.status, "assigned");
    }

    const requirements = parsed.requirements ?? preCheck.task.requirements;
    if (requirements === undefined) {
      throw new TaskRequirementsNotSetError(taskId);
    }

    const candidates = await detectRoutingCandidates(this.#registry);
    const routing = evaluateRouting(requirements, candidates);
    if (routing.recommendedAdapterId === undefined) {
      throw new NoRoutingCandidateError(taskId, routing.explanation);
    }
    const recommendedAdapterId = routing.recommendedAdapterId;

    const adapter = this.#resolveAdapter(recommendedAdapterId);
    const winningCandidate = candidates.find(
      (candidate) => candidate.adapterId === recommendedAdapterId,
    );
    const executionTrust: ExecutionTrust = winningCandidate?.executionTrust ?? "unavailable";

    const canonicalWorkingDirectory =
      this.#pendingWorkingDirectories.get(taskId) ?? this.#resolveWorkingDirectory(undefined);

    // Atomic commit — see TaskStore.assignIfEligible()'s doc comment. No
    // `await` occurs between this call and the fast-fail check above other
    // than the already-completed detection/policy evaluation.
    const record = this.#taskStore.assignIfEligible(
      taskId,
      expectedRevision,
      {
        status: preCheck.task.status,
        runId: preCheck.runId,
        adapterId: preCheck.adapterId,
        agentId: preCheck.agentId,
      },
      {
        adapterId: recommendedAdapterId,
        agentId: adapter.descriptor.supportedAgent.agentId,
        executionTrust,
        requirements,
      },
    );

    this.#pendingWorkingDirectories.set(taskId, canonicalWorkingDirectory);

    return {
      record,
      routingExplanation: routing.explanation,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * A manual planning-state transition (`POST .../transition`). Never
   * touches `EventStore`/`EventBus` and never emits a synthetic
   * `run.cancelled` — cancelling a planning task that has no run is
   * purely a `TaskStore` status change, not an execution outcome.
   */
  transitionTask(taskId: string, rawRequest: unknown): TaskRecord {
    const parsed = this.#parseTransitionRequest(rawRequest);
    const record = this.#taskStore.get(taskId);
    const currentStatus = record.task.status;

    const activelyExecuting =
      isExecutionControlledStatus(currentStatus) ||
      (currentStatus === "assigned" && record.runId !== undefined);
    if (activelyExecuting) {
      throw new ActiveTaskTransitionDeniedError(taskId, currentStatus);
    }
    if (isTerminalTaskStatus(currentStatus)) {
      throw new TaskStateConflictError(taskId, currentStatus, "moved");
    }
    if (!isManualTransitionAllowed(currentStatus, parsed.targetStatus)) {
      throw new InvalidManualTransitionError(taskId, currentStatus, parsed.targetStatus);
    }

    this.#taskStore.updateStatus(taskId, parsed.targetStatus);
    // Un-assigning: a task leaving `assigned` for a planning column no
    // longer has a meaningful adapter/agent selection.
    if (
      currentStatus === "assigned" &&
      (parsed.targetStatus === "ready" || parsed.targetStatus === "blocked")
    ) {
      this.#taskStore.clearAssignment(taskId);
      this.#pendingWorkingDirectories.delete(taskId);
    }

    return this.#taskStore.get(taskId);
  }

  requestCancellation(taskId: string): { alreadyRequested: boolean } {
    const record = this.#taskStore.get(taskId);
    if (isTerminalTaskStatus(record.task.status)) {
      throw new TaskStateConflictError(taskId, record.task.status, "cancelled");
    }
    if (record.cancellationRequested) {
      return { alreadyRequested: true };
    }
    this.#taskStore.setCancellationRequested(taskId);
    this.#activeControllers.get(taskId)?.abort("cancellation requested via REST API");
    return { alreadyRequested: false };
  }

  /** Aborts every active run and waits (bounded by `timeoutMs`) for them to reach a terminal state. */
  async shutdown(timeoutMs: number): Promise<void> {
    for (const controller of this.#activeControllers.values()) {
      controller.abort("server shutting down");
    }
    const pending = Array.from(this.#activeExecutions.values());
    if (pending.length === 0) return;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs);
      }),
    ]);
  }

  #createImmediateTask(parsedRequest: ImmediateCreateTaskRequest): CreateTaskResult {
    const adapter = this.#resolveAdapter(parsedRequest.adapterId);
    const resolvedWorkingDirectory = this.#resolveWorkingDirectory(parsedRequest.workingDirectory);

    const taskId = randomUUID();
    const runId = randomUUID();
    const now = new Date().toISOString();

    const hallTask = parseHallTask({
      taskId,
      projectId: parsedRequest.projectId,
      title: parsedRequest.title,
      description: parsedRequest.description ?? "",
      priority: parsedRequest.priority ?? "normal",
      status: "assigned",
      dependencyTaskIds: [],
      createdAt: now,
      updatedAt: now,
    });

    const record: TaskRecord = {
      task: hallTask,
      runId,
      adapterId: parsedRequest.adapterId,
      agentId: adapter.descriptor.supportedAgent.agentId,
      eventCount: 0,
      lastSequence: undefined,
      terminalEventType: undefined,
      failure: undefined,
      cancellationRequested: false,
      createdAt: now,
      startedAt: undefined,
      completedAt: undefined,
      assignedExecutionTrust: undefined,
    };

    this.#taskStore.add(record);
    this.#taskStore.setWorkingDirectory(taskId, parsedRequest.workingDirectory);

    const taskInput = parseAgentTaskInput({
      hallTask,
      agentIdentity: adapter.descriptor.supportedAgent,
      runId,
      workingDirectory: resolvedWorkingDirectory,
    });

    this.#beginExecution(taskId, adapter.descriptor.adapterId, taskInput, resolvedWorkingDirectory);

    return { task: hallTask, runId };
  }

  /**
   * Creates a planning-only task: `status: "backlog"`, no adapter, no
   * run, no execution started. `workingDirectory`, if supplied, is
   * validated (relative, within the workspace root) and its canonical
   * form cached in `#pendingWorkingDirectories` so `assignTask()`/
   * `startTask()` don't need it re-entered — but is never written into
   * `TaskRecord` itself.
   */
  #createDeferredTask(parsedRequest: DeferredCreateTaskRequest): CreateTaskResult {
    const taskId = randomUUID();
    const now = new Date().toISOString();

    const hallTask = parseHallTask({
      taskId,
      projectId: parsedRequest.projectId,
      title: parsedRequest.title,
      description: parsedRequest.description ?? "",
      priority: parsedRequest.priority ?? "normal",
      status: "backlog",
      dependencyTaskIds: [],
      createdAt: now,
      updatedAt: now,
      ...(parsedRequest.requirements !== undefined
        ? { requirements: parsedRequest.requirements }
        : {}),
    });

    const record: TaskRecord = {
      task: hallTask,
      runId: undefined,
      adapterId: undefined,
      agentId: undefined,
      eventCount: 0,
      lastSequence: undefined,
      terminalEventType: undefined,
      failure: undefined,
      cancellationRequested: false,
      createdAt: now,
      startedAt: undefined,
      completedAt: undefined,
      assignedExecutionTrust: undefined,
    };

    this.#taskStore.add(record);
    this.#taskStore.setWorkingDirectory(taskId, parsedRequest.workingDirectory);

    if (parsedRequest.workingDirectory !== undefined) {
      this.#pendingWorkingDirectories.set(
        taskId,
        this.#resolveWorkingDirectory(parsedRequest.workingDirectory),
      );
    }

    return { task: hallTask };
  }

  /**
   * The shared execution-kickoff tail used by both an immediate task's
   * creation and a deferred task's `startTask()`: tracks an
   * `AbortController`, starts `#execute()` without awaiting it (the
   * caller's HTTP handler must return promptly), and cleans up active-run
   * tracking once the run settles.
   */
  #beginExecution(
    taskId: string,
    adapterId: string,
    taskInput: AgentTaskInput,
    approvedSourceWorkingDirectory: string,
  ): void {
    const controller = new AbortController();
    this.#activeControllers.set(taskId, controller);

    const execution = this.#execute(
      taskId,
      adapterId,
      taskInput,
      approvedSourceWorkingDirectory,
      controller.signal,
    ).finally(() => {
      this.#activeControllers.delete(taskId);
      this.#activeExecutions.delete(taskId);
    });
    this.#activeExecutions.set(taskId, execution);
  }

  #parseCreateRequest(rawRequest: unknown): CreateTaskRequest {
    const result = createTaskRequestSchema.safeParse(rawRequest);
    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      throw new InvalidRequestError("Invalid create-task request.", issues);
    }
    return result.data;
  }

  #parseAssignRequest(rawRequest: unknown): ReturnType<typeof assignTaskRequestSchema.parse> {
    const result = assignTaskRequestSchema.safeParse(rawRequest);
    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      throw new InvalidRequestError("Invalid assign-task request.", issues);
    }
    return result.data;
  }

  #parseTransitionRequest(rawRequest: unknown): TransitionTaskRequest {
    const result = transitionTaskRequestSchema.safeParse(rawRequest);
    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      throw new InvalidRequestError("Invalid transition-task request.", issues);
    }
    return result.data;
  }

  /**
   * Phase 11 — `rawRequest` is entirely optional (`POST
   * .../routing-analysis` and `.../route-and-assign` may be called with no
   * body at all), so `undefined`/`null` is treated the same as `{}` before
   * validation, rather than rejected as an invalid request shape.
   */
  #parseRoutingRequest(rawRequest: unknown): RoutingRequest {
    const input = rawRequest ?? {};
    const result = routingRequestSchema.safeParse(input);
    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      throw new InvalidRequestError("Invalid routing request.", issues);
    }
    return result.data;
  }

  #resolveAdapter(adapterId: string): AgentAdapter {
    try {
      return this.#registry.resolve(adapterId);
    } catch {
      throw new AdapterNotFoundError(adapterId);
    }
  }

  #resolveWorkingDirectory(rawWorkingDirectory: string | undefined): string {
    const relative = rawWorkingDirectory ?? ".";
    if (path.isAbsolute(relative)) {
      throw new WorkspaceValidationFailedError(
        `workingDirectory must be relative to the configured workspace root, got an absolute path: "${relative}"`,
      );
    }
    const resolved = path.resolve(this.#workspaceRoot, relative);
    try {
      return validateWorkspace({ workspaceRoot: this.#workspaceRoot, workingDirectory: resolved })
        .workingDirectory;
    } catch (error) {
      if (error instanceof RunnerError) {
        // Deliberately does not forward `error.message` to the client: it embeds the
        // canonicalized absolute workspace root and resolved path, which must not leak
        // into an HTTP response (see docs/architecture/0004-hall-core-server.md, "Safe
        // API error policy"). The detail is still useful for local debugging.
        console.error(`workspace validation failed for taskId-pending request: ${error.message}`);
        throw new WorkspaceValidationFailedError(
          "workingDirectory must resolve to the configured workspace root or a descendant of it.",
        );
      }
      throw error;
    }
  }

  async #execute(
    taskId: string,
    adapterId: string,
    taskInput: AgentTaskInput,
    approvedSourceWorkingDirectory: string,
    signal: AbortSignal,
  ): Promise<void> {
    let preparedWorktreeId: string | undefined;
    let terminalEvent: NormalizedAgentEvent | undefined;
    let terminalSnapshot: AgentExecutionTerminalSnapshot | undefined;
    try {
      if (this.#isCancellationRequested(taskId)) {
        terminalSnapshot = this.#cancelTaskBeforeAdapterRun(
          taskId,
          "Task execution was cancelled before provider launch.",
        );
        await this.#terminalizeExecution({ taskId, snapshot: terminalSnapshot });
        return;
      }
      await this.#preflightExecution(adapterId, taskInput);
      if (this.#isCancellationRequested(taskId)) {
        terminalSnapshot = this.#cancelTaskBeforeAdapterRun(
          taskId,
          "Task execution was cancelled before isolated worktree preparation.",
        );
        await this.#terminalizeExecution({ taskId, snapshot: terminalSnapshot });
        return;
      }
      const prepared = await this.#prepareExecution(
        adapterId,
        taskInput,
        approvedSourceWorkingDirectory,
        signal,
      );
      preparedWorktreeId = prepared.worktreeId;
      if (this.#isCancellationRequested(taskId)) {
        terminalSnapshot = this.#cancelTaskBeforeAdapterRun(
          taskId,
          "Task execution was cancelled before provider launch.",
          preparedWorktreeId,
        );
        await this.#terminalizeExecution({ taskId, snapshot: terminalSnapshot });
        return;
      }
      const runResult = await runTask({
        registry: this.#registry,
        adapterId,
        taskInput: prepared.taskInput,
        options: { signal },
        onEvent: (event) => {
          const snapshot = this.#handleEvent(taskId, event, adapterId, preparedWorktreeId);
          if (snapshot !== undefined) {
            terminalSnapshot = snapshot;
          }
          if (isTerminalEventType(event.type)) {
            terminalEvent = event;
          }
        },
      });
      if (
        terminalSnapshot === undefined &&
        terminalEvent === undefined &&
        runResult.terminalEventType === "run.failed"
      ) {
        terminalSnapshot = this.#failTaskWithInfrastructureFailure(
          taskId,
          this.#taskStore.get(taskId),
          runResult.failure?.code ?? "TASK_EXECUTION_FAILED",
          runResult.failure?.message ??
            "Hall Core could not complete this task due to an unexpected internal error.",
          "Hall Runner returned a failed result without a normalized terminal event.",
          preparedWorktreeId,
        );
        terminalEvent = undefined;
      }
      await this.#terminalizeExecution({
        taskId,
        snapshot: terminalSnapshot,
        runResult:
          terminalSnapshot?.terminalEvent.type === runResult.terminalEventType
            ? runResult
            : undefined,
      });
    } catch (error) {
      this.#onExecutionError?.(taskId, error);
      const syntheticTerminalSnapshot = this.#failTaskOnUnhandledExecutionError(
        taskId,
        error,
        preparedWorktreeId,
      );
      await this.#terminalizeExecution({
        taskId,
        snapshot: terminalSnapshot ?? syntheticTerminalSnapshot,
      });
    }
  }

  async #preflightExecution(adapterId: string, taskInput: AgentTaskInput): Promise<void> {
    const adapter = this.#resolveAdapter(adapterId);
    const detection = await adapter.detect();
    if (detection.availability !== "available") {
      throw new AdapterUnavailableError(adapterId, detection.availability);
    }
    const taskRecord = this.#taskStore.get(taskInput.hallTask.taskId);
    if (
      taskRecord.runId !== taskInput.runId ||
      taskRecord.adapterId !== adapterId ||
      taskRecord.agentId !== taskInput.agentIdentity.agentId
    ) {
      throw new TaskStateConflictError(
        taskInput.hallTask.taskId,
        taskRecord.task.status,
        "started",
      );
    }
    if (taskRecord.task.requirements === undefined) return;
    const executionTrust: ExecutionTrust = detection.executionTrust ?? "unavailable";
    const eligibility = evaluateCandidateEligibility(taskRecord.task.requirements, {
      adapterId,
      displayName: adapter.descriptor.displayName,
      integrationLevel: adapter.descriptor.integrationLevel,
      availability: detection.availability,
      executionTrust,
      capabilityObservations: detection.capabilityObservations ?? [],
    });
    if (!eligibility.eligible) {
      throw new AdapterRequirementsMismatchError();
    }
  }

  #isCancellationRequested(taskId: string): boolean {
    return this.#taskStore.get(taskId).cancellationRequested;
  }

  async #prepareExecution(
    adapterId: string,
    taskInput: AgentTaskInput,
    approvedSourceWorkingDirectory: string,
    signal: AbortSignal,
  ): Promise<{ readonly taskInput: AgentTaskInput; readonly worktreeId: string | undefined }> {
    if (this.#executionCoordinator === undefined) {
      return { taskInput, worktreeId: undefined };
    }
    const prepared = await this.#executionCoordinator.prepare({
      taskInput,
      adapterId,
      approvedSourceWorkingDirectory,
      signal,
    });
    return { taskInput: prepared.taskInput, worktreeId: prepared.worktreeId };
  }

  async #terminalizeExecution(input: {
    readonly taskId: string;
    readonly snapshot: AgentExecutionTerminalSnapshot | undefined;
    readonly runResult?: RunTaskResult | undefined;
  }): Promise<void> {
    if (this.#artifactTerminalizer === undefined) return;
    if (input.snapshot === undefined) return;
    try {
      await this.#artifactTerminalizer.terminalize({
        snapshot: input.snapshot,
        runResult: input.runResult,
      });
    } catch (error) {
      this.#onExecutionError?.(input.taskId, error);
      console.error(
        `Task "${input.taskId}": artifact terminalization failed after authoritative terminal state was recorded: ${formatUnknownError(error)}`,
      );
    }
  }

  #handleEvent(
    taskId: string,
    rawEvent: NormalizedAgentEvent,
    adapterId: string,
    worktreeId: string | undefined,
  ): AgentExecutionTerminalSnapshot | undefined {
    const record = this.#taskStore.get(taskId);
    if (record.runId === undefined || record.agentId === undefined) {
      // Defense in depth: `#handleEvent` is only ever wired up from
      // `#execute`, which only ever runs after `runId`/`agentId` are set
      // (immediate creation, or `startTask()`) — this should be
      // unreachable, and is not a client-facing condition.
      console.error(`Received an event for task "${taskId}" with no run recorded; ignoring.`);
      return undefined;
    }

    // Phase 15.2 — translate this run's own adapter-local sequence
    // (always 0-based per run; see `#runSequenceBase`'s doc comment)
    // into the task's continuous, ever-increasing sequence space before
    // it ever reaches `EventStore`. `eventId`/`type`/`payload`/etc. are
    // untouched — only `sequence` differs from what the adapter itself
    // produced, so a genuine redelivery of the same adapter event still
    // maps to the same adjusted sequence and is still correctly detected
    // as a duplicate by `EventStore.append()`.
    const sequenceBase = this.#runSequenceBase.get(taskId) ?? 0;
    const event: NormalizedAgentEvent =
      sequenceBase === 0 ? rawEvent : { ...rawEvent, sequence: rawEvent.sequence + sequenceBase };

    let appendResult;
    try {
      appendResult = this.#eventStore.append(taskId, event, {
        runId: record.runId,
        taskId,
        agentId: record.agentId,
      });
    } catch (error) {
      if (error instanceof EventStoreError) {
        return this.#handleEventStoreFailure(taskId, error);
      }
      throw error;
    }
    if (appendResult.duplicate) return undefined;

    this.#eventBus.publish(taskId, event);
    this.#taskStore.recordEventMeta(taskId, event.sequence);
    const terminalSnapshot = isTerminalEventType(event.type)
      ? buildAgentExecutionTerminalSnapshot({
          preTerminalRecord: record,
          adapterId,
          event,
          worktreeId,
        })
      : undefined;

    switch (event.type) {
      case "run.started":
        this.#taskStore.updateStatus(taskId, "running");
        this.#taskStore.setStarted(taskId, event.timestamp);
        break;
      case "run.completed":
        // `setCompleted` before `updateStatus` — deliberately, not
        // incidentally. `wrapTaskStoreWithMutationHook` notifies after
        // EVERY status-changing call independently, and a real listener
        // (the CEO-execution mutation-hook bridge) only forwards a
        // notification once `isTerminalTaskStatus(record.task.status)` is
        // true. Calling `updateStatus` first used to fire that "now
        // terminal" notification a full call BEFORE `setCompleted` had
        // recorded `completedAt`/`terminalEventType`/`failure` — and
        // `onChildTaskMutated`'s own idempotency guard (never reprocess a
        // step already resolved) then silently discarded the SECOND,
        // fully-populated notification. For "run.failed" specifically,
        // this made every real transient failure classify as "permanent"
        // (`taskRecord.failure` read as `undefined`, falling back to
        // `retryable: false`) — a real, reproducible defect found via a
        // genuine browser-driven Playwright run, invisible to the unit
        // test harness because it never wires this hook and only ever
        // calls `onChildTaskMutated` once, well after both store calls
        // have already settled. Setting the terminal fields first means
        // that premature notification now fires while `record.task.status`
        // is still non-terminal (correctly ignored by the bridge), and the
        // ONE notification that matters — from `updateStatus` — arrives
        // with every terminal field already populated.
        this.#taskStore.setCompleted(taskId, event.timestamp, "run.completed");
        this.#taskStore.updateStatus(taskId, "completed");
        break;
      case "run.failed":
        this.#taskStore.setCompleted(taskId, event.timestamp, "run.failed", event.payload.failure);
        this.#taskStore.updateStatus(taskId, "failed");
        break;
      case "run.cancelled":
        this.#taskStore.setCompleted(taskId, event.timestamp, "run.cancelled");
        this.#taskStore.updateStatus(taskId, "cancelled");
        break;
      default:
        break;
    }
    return terminalSnapshot;
  }

  /**
   * `EventStore.append()` rejected this event because it (or a prior
   * sibling call in the same tick) violated one of the store's own
   * invariants — most commonly `EventCapacityReachedError` (the adapter
   * produced more non-terminal events than the configured
   * `maxEventsPerTask` reserves room for). Two cases:
   *
   * - The task has already reached a terminal status. That only happens
   *   if an earlier event for this same task already triggered this exact
   *   method (or a real adapter terminal event already landed), which
   *   already stopped the run and stored a terminal outcome. This event is
   *   a late arrival racing an abort signal the adapter hasn't honored
   *   yet — the first terminal outcome wins, so it is ignored, not
   *   double-processed.
   * - The task is not yet terminal: this *is* the first infrastructure
   *   failure for this task, so it drives the deterministic
   *   capacity/invariant-failure workflow below.
   */
  #handleEventStoreFailure(
    taskId: string,
    error: EventStoreError,
  ): AgentExecutionTerminalSnapshot | undefined {
    try {
      const record = this.#taskStore.get(taskId);
      if (isTerminalTaskStatus(record.task.status)) return;
      return this.#failTaskWithInfrastructureFailure(
        taskId,
        record,
        error.code,
        error.message,
        error.message,
        undefined,
      );
    } catch (unexpected) {
      // Must never throw back into the adapter's event-delivery path (see
      // #execute/runTask's `onEvent` callback) — if something here itself
      // breaks, log loudly server-side and leave whatever partial state
      // was reached rather than crash task execution or produce an
      // unhandled rejection.
      console.error(
        `Hall Core failed to finalize task "${taskId}" after an event-store error: ${formatUnknownError(unexpected)}`,
      );
      return undefined;
    }
  }

  /**
   * `runTask()` itself rejected for a reason that never went through
   * `#handleEvent` at all (e.g. `adapter.detect()`/`startTask()` throwing,
   * or Hall Runner's own contract-violation errors). Without this, a task
   * could be left in `assigned`/`running` forever purely because the
   * *only* place that ever marks a task terminal is event-driven. If
   * `#handleEvent` already finalized this task (including via
   * `#handleEventStoreFailure` above) before `runTask()`'s promise
   * settled, this is a no-op — the first terminal outcome still wins.
   */
  #failTaskOnUnhandledExecutionError(
    taskId: string,
    error: unknown,
    worktreeId: string | undefined,
  ): AgentExecutionTerminalSnapshot | undefined {
    try {
      const record = this.#taskStore.get(taskId);
      if (isTerminalTaskStatus(record.task.status)) return undefined;
      const failure = infrastructureFailureFromError(error);
      return this.#failTaskWithInfrastructureFailure(
        taskId,
        record,
        failure.code,
        failure.clientSafeMessage,
        formatUnknownError(error),
        worktreeId,
      );
    } catch (unexpected) {
      console.error(
        `Hall Core failed to finalize task "${taskId}" after an unhandled execution error: ${formatUnknownError(unexpected)}`,
      );
      return undefined;
    }
  }

  /**
   * The deterministic Hall Core infrastructure-failure workflow (see
   * `docs/architecture/0004-hall-core-server.md`, "Event-capacity terminal
   * handling"): stop the adapter, synthesize and store exactly one
   * `run.failed` event carrying a stable, safe `code`, and drive the task
   * to `failed`. `clientSafeMessage` is what ends up in the stored event's
   * (client-visible) failure payload — callers are responsible for never
   * passing raw exception text, a stack trace, or a filesystem path here;
   * `serverLogDetail` (which may safely be more revealing) is logged
   * server-side only.
   */
  #failTaskWithInfrastructureFailure(
    taskId: string,
    record: TaskRecord,
    code: string,
    clientSafeMessage: string,
    serverLogDetail: string,
    worktreeId: string | undefined,
  ): AgentExecutionTerminalSnapshot | undefined {
    if (
      record.runId === undefined ||
      record.agentId === undefined ||
      record.adapterId === undefined
    ) {
      console.error(
        `Hall Core cannot record an infrastructure failure for task "${taskId}": it has no run recorded.`,
      );
      return undefined;
    }

    // Stop accepting normal events for this task and signal the adapter to
    // stop, before this task's terminal outcome is recorded — an adapter
    // that keeps running after this point cannot replace this result (any
    // further event it produces will be rejected once the terminal event
    // below is stored).
    this.#activeControllers.get(taskId)?.abort(`Hall Core infrastructure failure: ${code}`);

    console.error(
      `Task "${taskId}" failed at the Hall Core infrastructure level (${code}): ${serverLogDetail}`,
    );

    const failureEvent = buildInfrastructureFailureEvent({
      runId: record.runId,
      taskId,
      agentId: record.agentId,
      sequence: this.#eventStore.nextSequence(taskId),
      code,
      message: clientSafeMessage,
    });

    try {
      const result = this.#eventStore.append(taskId, failureEvent, {
        runId: record.runId,
        taskId,
        agentId: record.agentId,
      });
      if (result.stored) {
        this.#eventBus.publish(taskId, failureEvent);
        this.#taskStore.recordEventMeta(taskId, failureEvent.sequence);
      }
    } catch (storeError) {
      // Even if the synthetic terminal event itself couldn't be stored
      // (defense-in-depth; reserved-capacity accounting makes this
      // unreachable in practice), the task record below must still land
      // in a terminal state — a client-visible task status that is
      // accurate is more important than a perfectly complete event log.
      console.error(
        `Task "${taskId}": could not store the synthetic infrastructure-failure event: ${formatUnknownError(storeError)}`,
      );
    }

    this.#taskStore.setCompleted(
      taskId,
      failureEvent.timestamp,
      "run.failed",
      failureEvent.payload.failure,
    );
    this.#taskStore.updateStatus(taskId, "failed");
    return buildAgentExecutionTerminalSnapshot({
      preTerminalRecord: record,
      adapterId: record.adapterId,
      event: failureEvent,
      worktreeId,
    });
  }

  #cancelTaskBeforeAdapterRun(
    taskId: string,
    reason: string,
    worktreeId?: string,
  ): AgentExecutionTerminalSnapshot | undefined {
    const record = this.#taskStore.get(taskId);
    if (isTerminalTaskStatus(record.task.status)) return undefined;
    if (
      record.runId === undefined ||
      record.agentId === undefined ||
      record.adapterId === undefined
    ) {
      console.error(
        `Hall Core cannot record cancellation for task "${taskId}": it has no run recorded.`,
      );
      return undefined;
    }
    const cancellationEvent = buildInfrastructureCancellationEvent({
      runId: record.runId,
      taskId,
      agentId: record.agentId,
      sequence: this.#eventStore.nextSequence(taskId),
      cancelledBy: "orchestrator",
      reason,
    });
    try {
      const result = this.#eventStore.append(taskId, cancellationEvent, {
        runId: record.runId,
        taskId,
        agentId: record.agentId,
      });
      if (result.stored) {
        this.#eventBus.publish(taskId, cancellationEvent);
        this.#taskStore.recordEventMeta(taskId, cancellationEvent.sequence);
      }
    } catch (storeError) {
      console.error(
        `Task "${taskId}": could not store the synthetic cancellation event: ${formatUnknownError(storeError)}`,
      );
    }
    this.#taskStore.setCompleted(taskId, cancellationEvent.timestamp, "run.cancelled");
    this.#taskStore.updateStatus(taskId, "cancelled");
    return buildAgentExecutionTerminalSnapshot({
      preTerminalRecord: record,
      adapterId: record.adapterId,
      event: cancellationEvent,
      worktreeId,
    });
  }
}

function infrastructureFailureFromError(error: unknown): {
  readonly code: string;
  readonly clientSafeMessage: string;
} {
  if (error instanceof AgentExecutionOrchestrationError) {
    return { code: error.safeFailureCode, clientSafeMessage: error.safeFailureSummary };
  }
  if (error instanceof AdapterUnavailableError) {
    return { code: "ADAPTER_UNAVAILABLE", clientSafeMessage: error.message };
  }
  if (error instanceof AdapterRequirementsMismatchError) {
    return { code: "ADAPTER_REQUIREMENTS_MISMATCH", clientSafeMessage: error.message };
  }
  return {
    code: "TASK_EXECUTION_FAILED",
    clientSafeMessage:
      "Hall Core could not complete this task due to an unexpected internal error.",
  };
}
