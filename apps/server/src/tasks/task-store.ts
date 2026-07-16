import type { StructuredFailure, TaskStatus } from "@hall-of-wisdom/protocol";
import type { TerminalEventType } from "@hall-of-wisdom/hall-runner";
import {
  DuplicateTaskError,
  InvalidTaskTransitionError,
  TaskCapacityReachedError,
  TaskNotFoundError,
  TaskStateConflictError,
} from "../errors/app-error.js";
import { isValidTaskTransition } from "./task-status-transitions.js";
import type { TaskRecord } from "./task-record.js";

export interface TaskStoreOptions {
  readonly maxTasks: number;
}

/**
 * In-memory task storage. `get`/`list` always return `structuredClone`d
 * copies — callers (routes, tests) can freely read or even mutate what
 * they get back without corrupting the store's internal state, and
 * without the store ever handing out a live reference to something an
 * external caller could use to bypass `updateStatus`'s transition checks.
 */
export class TaskStore {
  readonly #records = new Map<string, TaskRecord>();
  readonly #maxTasks: number;

  constructor(options: TaskStoreOptions) {
    this.#maxTasks = options.maxTasks;
  }

  add(record: TaskRecord): void {
    if (this.#records.has(record.task.taskId)) {
      throw new DuplicateTaskError(record.task.taskId);
    }
    if (this.#records.size >= this.#maxTasks) {
      throw new TaskCapacityReachedError(this.#maxTasks);
    }
    this.#records.set(record.task.taskId, record);
  }

  get(taskId: string): TaskRecord {
    const record = this.#records.get(taskId);
    if (!record) {
      throw new TaskNotFoundError(taskId);
    }
    return structuredClone(record);
  }

  /** Deterministic insertion order — a `Map` preserves insertion order in JavaScript. */
  list(): TaskRecord[] {
    return Array.from(this.#records.values(), (record) => structuredClone(record));
  }

  updateStatus(taskId: string, nextStatus: TaskStatus): void {
    const record = this.#mustGetLive(taskId);
    if (!isValidTaskTransition(record.task.status, nextStatus)) {
      throw new InvalidTaskTransitionError(taskId, record.task.status, nextStatus);
    }
    record.task = { ...record.task, status: nextStatus, updatedAt: new Date().toISOString() };
  }

  recordEventMeta(taskId: string, sequence: number): void {
    const record = this.#mustGetLive(taskId);
    record.eventCount += 1;
    record.lastSequence = sequence;
  }

  setStarted(taskId: string, startedAt: string): void {
    this.#mustGetLive(taskId).startedAt = startedAt;
  }

  setCompleted(
    taskId: string,
    completedAt: string,
    terminalEventType: TerminalEventType,
    failure?: StructuredFailure,
  ): void {
    const record = this.#mustGetLive(taskId);
    record.completedAt = completedAt;
    record.terminalEventType = terminalEventType;
    record.failure = failure;
  }

  setCancellationRequested(taskId: string): void {
    this.#mustGetLive(taskId).cancellationRequested = true;
  }

  /**
   * Atomically re-validates and commits an assignment against the task's
   * CURRENT live state — this is what actually closes the check-then-act
   * race described in `docs/architecture/0006-kanban-board.md` ("Assignment
   * concurrency policy"): `TaskOrchestrator.assignTask()` reads a snapshot,
   * `await`s `adapter.detect()`, and only then calls this method with no
   * further `await` before it runs. JavaScript's single-threaded execution
   * means nothing else can run between this method's read and write, so
   * whatever eligibility this method observes is still true at the moment
   * it writes.
   *
   * `expected` is the exact eligibility-relevant snapshot the caller
   * observed and was authorized to act on (`status`, `runId`, `adapterId`,
   * `agentId` — the same four fields `assignTask()` read before its
   * `await`). The commit proceeds only if:
   *
   * 1. The task still exists (`#mustGetLive` throws `TaskNotFoundError`
   *    otherwise).
   * 2. The live record's `status`/`runId`/`adapterId`/`agentId` still
   *    exactly match `expected` — i.e. nothing about assignment eligibility
   *    changed while this caller was awaiting `adapter.detect()`.
   * 3. The live status is independently still `"ready"` (first assignment)
   *    or `"assigned"` with no run (pre-start reassignment) — re-derived
   *    from the live record, not trusted from the caller, so this method
   *    is self-contained and correct even if a future caller skips
   *    `assignTask()`'s own fast-fail pre-check.
   *
   * Comparing the full four-field snapshot (not just `status`) is
   * deliberate: it also closes the narrower race between two concurrent
   * *reassignments* of an already-assigned, not-yet-started task (the
   * second reassignment's `expected.adapterId`/`agentId` would no longer
   * match after the first one committed), not only the Ready -> Assigned
   * race the security review originally found.
   *
   * Any mismatch throws `TaskStateConflictError` (409, reused rather than
   * a new dedicated code — see the ADR) — never last-write-wins.
   */
  assignIfEligible(
    taskId: string,
    expected: {
      readonly status: TaskStatus;
      readonly runId: string | undefined;
      readonly adapterId: string | undefined;
      readonly agentId: string | undefined;
    },
    assignment: { readonly adapterId: string; readonly agentId: string },
  ): TaskRecord {
    const record = this.#mustGetLive(taskId);

    const isFirstAssignment = record.task.status === "ready";
    const isReassignment = record.task.status === "assigned" && record.runId === undefined;
    const stillMatchesExpectation =
      record.task.status === expected.status &&
      record.runId === expected.runId &&
      record.adapterId === expected.adapterId &&
      record.agentId === expected.agentId;

    if ((!isFirstAssignment && !isReassignment) || !stillMatchesExpectation) {
      throw new TaskStateConflictError(taskId, record.task.status, "assigned");
    }

    const now = new Date().toISOString();
    record.adapterId = assignment.adapterId;
    record.agentId = assignment.agentId;
    record.task = isFirstAssignment
      ? { ...record.task, status: "assigned", updatedAt: now }
      : { ...record.task, updatedAt: now };

    return structuredClone(record);
  }

  /** Clears a planning task's assignment (used when a manual transition moves an assigned task back to ready/blocked). */
  clearAssignment(taskId: string): void {
    const record = this.#mustGetLive(taskId);
    record.adapterId = undefined;
    record.agentId = undefined;
  }

  /**
   * Atomically claims `runId` for a task about to start execution:
   * operates on the live record (not a clone) and throws if a run was
   * already claimed, so two concurrent `POST .../start` calls for the
   * same task can never both succeed — see `TaskOrchestrator.startTask()`
   * for why this must run with no `await` between the read and the write.
   */
  setRunId(taskId: string, runId: string): void {
    const record = this.#mustGetLive(taskId);
    if (record.runId !== undefined) {
      throw new TaskStateConflictError(taskId, record.task.status, "started");
    }
    record.runId = runId;
  }

  /** Rolls back a `setRunId()` claim when starting execution fails before any event was ever produced. */
  clearRunId(taskId: string): void {
    this.#mustGetLive(taskId).runId = undefined;
  }

  #mustGetLive(taskId: string): TaskRecord {
    const record = this.#records.get(taskId);
    if (!record) {
      throw new TaskNotFoundError(taskId);
    }
    return record;
  }
}
