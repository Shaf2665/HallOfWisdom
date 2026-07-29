import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { isTerminalEventType } from "@hall-of-wisdom/hall-runner";
import type { NormalizedEventStorePort } from "./event-store-port.js";
import {
  EventAfterTerminalError,
  EventCapacityReachedError,
  EventIdentityMismatchError,
  EventSequenceConflictError,
  EventSequenceGapError,
} from "./event-store-errors.js";

export interface EventStoreOptions {
  readonly maxEventsPerTask: number;
}

export interface ExpectedEventIdentity {
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
}

export interface AppendResult {
  readonly stored: boolean;
  readonly duplicate: boolean;
}

/**
 * The smallest `maxEventsPerTask` this store accepts. A task's smallest
 * possible non-abort lifecycle is `run.started` + one terminal event (two
 * events); an immediate-abort lifecycle is a single `run.cancelled`. `2`
 * is the smallest limit that can hold the former without ever starving a
 * task of the one non-terminal event (`run.started`) every normal run
 * needs before it can reach a terminal state at all. See "Reserved
 * terminal capacity" below for why this specific number matters.
 */
export const MIN_EVENTS_PER_TASK = 2;

/** Thrown by `EventStore`'s constructor for a `maxEventsPerTask` too small to be usable — a configuration bug, never a per-request error. */
export class EventStoreConfigError extends Error {
  constructor(maxEventsPerTask: number) {
    super(
      `maxEventsPerTask must be at least ${String(MIN_EVENTS_PER_TASK)} (to hold a minimal run.started + terminal-event lifecycle), got ${String(maxEventsPerTask)}.`,
    );
    this.name = "EventStoreConfigError";
  }
}

/**
 * In-memory, per-task, sequence-ordered event log. Duplicate/conflict/gap
 * policy (documented in `docs/architecture/0004-hall-core-server.md`
 * "Event sequencing and duplicate policy"):
 *
 * - An event whose `sequence` equals the next expected slot (the current
 *   array length) is appended.
 * - An event whose `sequence` is already occupied, with the *same*
 *   `eventId`, is an idempotent duplicate: accepted as a no-op, not
 *   re-stored, not re-published.
 * - An event whose `sequence` is already occupied, with a *different*
 *   `eventId`, is a conflict: rejected.
 * - An event whose `sequence` is greater than the next expected slot is a
 *   gap: rejected (events are never reordered to fill a gap).
 * - Any event submitted once a terminal event has already been recorded
 *   for that task is rejected, even if its sequence number would
 *   otherwise be the "next" one — a terminal event is the true end of a
 *   task's event log.
 *
 * Because events are only ever appended at the current array length (or
 * detected as an exact duplicate of an existing slot), the backing array
 * is always already in ascending sequence order — `list()` needs no
 * separate sort.
 *
 * **Reserved terminal capacity.** `maxEventsPerTask` reserves its last
 * slot for a terminal event: a *non-terminal* event is rejected once
 * `events.length` reaches `maxEventsPerTask - 1`, while a *terminal*
 * event is still accepted up to `events.length === maxEventsPerTask - 1`
 * (i.e. it may always take the final slot). This guarantees a task can
 * always end deterministically — `TaskOrchestrator` relies on there
 * always being room for one more (possibly Hall-Core-synthesized) terminal
 * event once a non-terminal event is rejected for capacity, so a task
 * never gets stuck without a stored terminal outcome purely because an
 * agent produced too many progress events. See
 * `docs/architecture/0004-hall-core-server.md`, "Event-capacity terminal
 * handling".
 */
export class EventStore implements NormalizedEventStorePort {
  readonly #eventsByTaskId = new Map<string, NormalizedAgentEvent[]>();
  readonly #terminalSequenceByTaskId = new Map<string, number>();
  readonly #maxEventsPerTask: number;

  constructor(options: EventStoreOptions) {
    if (options.maxEventsPerTask < MIN_EVENTS_PER_TASK) {
      throw new EventStoreConfigError(options.maxEventsPerTask);
    }
    this.#maxEventsPerTask = options.maxEventsPerTask;
  }

  append(
    taskId: string,
    event: NormalizedAgentEvent,
    expected: ExpectedEventIdentity,
  ): AppendResult {
    if (event.runId !== expected.runId) {
      throw new EventIdentityMismatchError(taskId, "runId", expected.runId, event.runId);
    }
    if (event.taskId !== expected.taskId) {
      throw new EventIdentityMismatchError(taskId, "taskId", expected.taskId, event.taskId);
    }
    if (event.agentId !== expected.agentId) {
      throw new EventIdentityMismatchError(taskId, "agentId", expected.agentId, event.agentId);
    }

    const events = this.#eventsByTaskId.get(taskId) ?? [];

    if (event.sequence < events.length) {
      const existing = events[event.sequence];
      if (existing?.eventId === event.eventId) {
        return { stored: false, duplicate: true };
      }
      throw new EventSequenceConflictError(taskId, event.sequence);
    }

    if (event.sequence > events.length) {
      throw new EventSequenceGapError(taskId, event.sequence, events.length);
    }

    if (this.#terminalSequenceByTaskId.has(taskId)) {
      const terminalSequence = this.#terminalSequenceByTaskId.get(taskId);
      throw new EventAfterTerminalError(taskId, event.sequence, terminalSequence ?? -1);
    }

    const isTerminal = isTerminalEventType(event.type);
    const capacityLimit = isTerminal ? this.#maxEventsPerTask : this.#maxEventsPerTask - 1;
    if (events.length >= capacityLimit) {
      throw new EventCapacityReachedError(taskId, this.#maxEventsPerTask);
    }

    events.push(event);
    this.#eventsByTaskId.set(taskId, events);
    if (isTerminal) {
      this.#terminalSequenceByTaskId.set(taskId, event.sequence);
    }
    return { stored: true, duplicate: false };
  }

  list(taskId: string, afterSequence?: number): NormalizedAgentEvent[] {
    const events = this.#eventsByTaskId.get(taskId) ?? [];
    if (afterSequence === undefined) {
      return [...events];
    }
    return events.filter((event) => event.sequence > afterSequence);
  }

  /** The sequence number the next appended event for this task must use — equivalently, how many events are already stored. */
  nextSequence(taskId: string): number {
    return this.#eventsByTaskId.get(taskId)?.length ?? 0;
  }
}
