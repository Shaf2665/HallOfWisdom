import type { StructuredFailure, TaskStatus } from "@hall-of-wisdom/protocol";
import type { TerminalEventType } from "@hall-of-wisdom/hall-runner";
import {
  DuplicateTaskError,
  InvalidTaskTransitionError,
  TaskCapacityReachedError,
  TaskNotFoundError,
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

  #mustGetLive(taskId: string): TaskRecord {
    const record = this.#records.get(taskId);
    if (!record) {
      throw new TaskNotFoundError(taskId);
    }
    return record;
  }
}
