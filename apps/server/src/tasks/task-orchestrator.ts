import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { validateWorkspace } from "@hall-of-wisdom/hall-runner";
import { RunnerError, runTask } from "@hall-of-wisdom/hall-runner";
import { parseAgentTaskInput, type AgentAdapter } from "@hall-of-wisdom/agent-adapter-sdk";
import { parseHallTask, type HallTask, type NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import {
  AdapterNotFoundError,
  AdapterUnavailableError,
  ActiveTaskTransitionDeniedError,
  InternalServerError,
  InvalidManualTransitionError,
  InvalidRequestError,
  TaskStateConflictError,
  WorkspaceValidationFailedError,
} from "../errors/app-error.js";
import {
  isExecutionControlledStatus,
  isManualTransitionAllowed,
  isTerminalTaskStatus,
} from "./task-status-transitions.js";
import type { TaskRecord } from "./task-record.js";
import type { TaskStore } from "./task-store.js";
import type { EventStore } from "../events/event-store.js";
import type { EventBus } from "../events/event-bus.js";
import { EventStoreError } from "../events/event-store-errors.js";
import { buildInfrastructureFailureEvent } from "../events/synthetic-events.js";
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

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export interface TaskOrchestratorOptions {
  readonly taskStore: TaskStore;
  readonly eventStore: EventStore;
  readonly eventBus: EventBus;
  readonly registry: AgentRegistry;
  /** Canonical, already-validated workspace root — see `server.ts` / `validateWorkspace`. */
  readonly workspaceRoot: string;
  readonly onExecutionError?: ((taskId: string, error: unknown) => void) | undefined;
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

/**
 * Provider-neutral: never references Mock Agent, `MockAgentAdapter`, or
 * any adapter-specific type. Resolves adapters purely through the
 * injected `AgentRegistry`'s `AgentAdapter` interface, and drives
 * execution purely through Hall Runner's public `runTask()` — the same
 * function `@hall-of-wisdom/hall-runner`'s own CLI uses, just with an
 * `onEvent` sink instead of writing JSON Lines to stdout.
 */
export class TaskOrchestrator {
  readonly #taskStore: TaskStore;
  readonly #eventStore: EventStore;
  readonly #eventBus: EventBus;
  readonly #registry: AgentRegistry;
  readonly #workspaceRoot: string;
  readonly #onExecutionError: ((taskId: string, error: unknown) => void) | undefined;

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

  constructor(options: TaskOrchestratorOptions) {
    this.#taskStore = options.taskStore;
    this.#eventStore = options.eventStore;
    this.#eventBus = options.eventBus;
    this.#registry = options.registry;
    this.#workspaceRoot = options.workspaceRoot;
    this.#onExecutionError = options.onExecutionError;
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
   * here could be stale by the time `detect()` resolves.
   *
   * `TaskStore.assignIfEligible()` is what actually closes that race: it
   * re-validates the exact same four-field snapshot (`status`, `runId`,
   * `adapterId`, `agentId`) against the task's CURRENT live state and
   * applies the assignment in one synchronous call with no `await` in
   * between — see its own doc comment for the full policy. If the task's
   * lifecycle moved on while this request was awaiting `adapter.detect()`
   * (blocked, cancelled, started, or already committed by a racing
   * assignment), this throws `TaskStateConflictError` (409) instead of
   * silently overwriting whatever the task's current state actually is.
   */
  async assignTask(taskId: string, rawRequest: unknown): Promise<TaskRecord> {
    const parsed = this.#parseAssignRequest(rawRequest);
    const preCheck = this.#taskStore.get(taskId);

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

    const canonicalWorkingDirectory =
      parsed.workingDirectory !== undefined
        ? this.#resolveWorkingDirectory(parsed.workingDirectory)
        : (this.#pendingWorkingDirectories.get(taskId) ?? this.#resolveWorkingDirectory(undefined));

    // Atomic commit — see TaskStore.assignIfEligible()'s doc comment. No
    // `await` occurs between this call and the fast-fail check above other
    // than the already-completed `adapter.detect()`.
    const record = this.#taskStore.assignIfEligible(
      taskId,
      {
        status: preCheck.task.status,
        runId: preCheck.runId,
        adapterId: preCheck.adapterId,
        agentId: preCheck.agentId,
      },
      { adapterId: parsed.adapterId, agentId: adapter.descriptor.supportedAgent.agentId },
    );

    // Only cache the resolved working directory once the assignment this
    // request made has actually been committed — a losing request must
    // never overwrite the winner's working directory.
    this.#pendingWorkingDirectories.set(taskId, canonicalWorkingDirectory);

    return record;
  }

  /**
   * Starts execution for a task already assigned via `assignTask()`.
   * Claims `runId` synchronously (no `await` between reading the task's
   * current state and calling `TaskStore.setRunId()`) so two concurrent
   * `POST .../start` calls for the same task can never both begin a run —
   * see `TaskStore.setRunId()`'s own doc comment for why this ordering is
   * what actually closes the race, not any lock or queue.
   */
  async startTask(taskId: string): Promise<StartTaskResult> {
    const record = this.#taskStore.get(taskId);
    if (record.task.status !== "assigned") {
      throw new TaskStateConflictError(taskId, record.task.status, "started");
    }
    if (record.runId !== undefined) {
      throw new TaskStateConflictError(taskId, record.task.status, "started");
    }
    if (record.adapterId === undefined) {
      throw new InternalServerError(`Task "${taskId}" is assigned but has no adapterId recorded.`);
    }

    const adapter = this.#resolveAdapter(record.adapterId);
    const runId = randomUUID();
    // Atomic claim — see the doc comment above and on `TaskStore.setRunId()`.
    this.#taskStore.setRunId(taskId, runId);

    const detection = await adapter.detect();
    if (detection.availability !== "available") {
      this.#taskStore.clearRunId(taskId);
      throw new AdapterUnavailableError(record.adapterId, detection.availability);
    }

    const workingDirectory =
      this.#pendingWorkingDirectories.get(taskId) ?? this.#resolveWorkingDirectory(undefined);
    this.#pendingWorkingDirectories.delete(taskId);

    const taskInput = parseAgentTaskInput({
      hallTask: record.task,
      agentIdentity: adapter.descriptor.supportedAgent,
      runId,
      workingDirectory,
    });

    this.#beginExecution(taskId, adapter.descriptor.adapterId, taskInput);

    return { task: this.#taskStore.get(taskId).task, runId };
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
    };

    this.#taskStore.add(record);

    const taskInput = parseAgentTaskInput({
      hallTask,
      agentIdentity: adapter.descriptor.supportedAgent,
      runId,
      workingDirectory: resolvedWorkingDirectory,
    });

    this.#beginExecution(taskId, adapter.descriptor.adapterId, taskInput);

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
    };

    this.#taskStore.add(record);

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
    taskInput: Parameters<typeof runTask>[0]["taskInput"],
  ): void {
    const controller = new AbortController();
    this.#activeControllers.set(taskId, controller);

    const execution = this.#execute(taskId, adapterId, taskInput, controller.signal)
      .catch((error: unknown) => {
        this.#onExecutionError?.(taskId, error);
        this.#failTaskOnUnhandledExecutionError(taskId, error);
      })
      .finally(() => {
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
    taskInput: Parameters<typeof runTask>[0]["taskInput"],
    signal: AbortSignal,
  ): Promise<void> {
    await runTask({
      registry: this.#registry,
      adapterId,
      taskInput,
      options: { signal },
      onEvent: (event) => {
        this.#handleEvent(taskId, event);
      },
    });
  }

  #handleEvent(taskId: string, event: NormalizedAgentEvent): void {
    const record = this.#taskStore.get(taskId);
    if (record.runId === undefined || record.agentId === undefined) {
      // Defense in depth: `#handleEvent` is only ever wired up from
      // `#execute`, which only ever runs after `runId`/`agentId` are set
      // (immediate creation, or `startTask()`) — this should be
      // unreachable, and is not a client-facing condition.
      console.error(`Received an event for task "${taskId}" with no run recorded; ignoring.`);
      return;
    }

    let appendResult;
    try {
      appendResult = this.#eventStore.append(taskId, event, {
        runId: record.runId,
        taskId,
        agentId: record.agentId,
      });
    } catch (error) {
      if (error instanceof EventStoreError) {
        this.#handleEventStoreFailure(taskId, error);
        return;
      }
      throw error;
    }
    if (appendResult.duplicate) return;

    this.#eventBus.publish(taskId, event);
    this.#taskStore.recordEventMeta(taskId, event.sequence);

    switch (event.type) {
      case "run.started":
        this.#taskStore.updateStatus(taskId, "running");
        this.#taskStore.setStarted(taskId, event.timestamp);
        break;
      case "run.completed":
        this.#taskStore.updateStatus(taskId, "completed");
        this.#taskStore.setCompleted(taskId, event.timestamp, "run.completed");
        break;
      case "run.failed":
        this.#taskStore.updateStatus(taskId, "failed");
        this.#taskStore.setCompleted(taskId, event.timestamp, "run.failed", event.payload.failure);
        break;
      case "run.cancelled":
        this.#taskStore.updateStatus(taskId, "cancelled");
        this.#taskStore.setCompleted(taskId, event.timestamp, "run.cancelled");
        break;
      default:
        break;
    }
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
  #handleEventStoreFailure(taskId: string, error: EventStoreError): void {
    try {
      const record = this.#taskStore.get(taskId);
      if (isTerminalTaskStatus(record.task.status)) return;
      this.#failTaskWithInfrastructureFailure(
        taskId,
        record,
        error.code,
        error.message,
        error.message,
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
  #failTaskOnUnhandledExecutionError(taskId: string, error: unknown): void {
    try {
      const record = this.#taskStore.get(taskId);
      if (isTerminalTaskStatus(record.task.status)) return;
      this.#failTaskWithInfrastructureFailure(
        taskId,
        record,
        "TASK_EXECUTION_FAILED",
        "Hall Core could not complete this task due to an unexpected internal error.",
        formatUnknownError(error),
      );
    } catch (unexpected) {
      console.error(
        `Hall Core failed to finalize task "${taskId}" after an unhandled execution error: ${formatUnknownError(unexpected)}`,
      );
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
  ): void {
    if (record.runId === undefined || record.agentId === undefined) {
      console.error(
        `Hall Core cannot record an infrastructure failure for task "${taskId}": it has no run recorded.`,
      );
      return;
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

    this.#taskStore.updateStatus(taskId, "failed");
    this.#taskStore.setCompleted(
      taskId,
      failureEvent.timestamp,
      "run.failed",
      failureEvent.payload.failure,
    );
  }
}
