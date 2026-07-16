import { HallCoreError } from "../errors/app-error.js";

/**
 * Common base for every `EventStore.append()` invariant violation. All of
 * these represent an adapter (or Hall Runner) violating the
 * normalized-event contract — not a client request problem — and none of
 * them are ever thrown from inside an HTTP request handler (`append()` is
 * only ever called from `TaskOrchestrator`'s background execution path).
 * Sharing this base lets `TaskOrchestrator` catch exactly this family with
 * a single `instanceof` check (see `#handleEventStoreFailure`), distinct
 * from an unrelated bug elsewhere, and turn it into a deterministic task
 * failure rather than an unhandled rejection or a stuck task. In practice
 * these are defense-in-depth: Mock Agent's own `TerminalEventGuard` and
 * `EventFactory` (in `@hall-of-wisdom/agent-adapter-sdk`) already prevent
 * all of these cases from occurring for a well-behaved adapter — except
 * `EventCapacityReachedError`, which a well-behaved adapter can trigger
 * legitimately just by running long enough.
 */
export abstract class EventStoreError extends HallCoreError {}

export class EventSequenceGapError extends EventStoreError {
  readonly code = "EVENT_SEQUENCE_GAP";
  readonly statusCode = 500;

  constructor(taskId: string, receivedSequence: number, expectedSequence: number) {
    super(
      `Sequence gap for task "${taskId}": expected sequence ${String(expectedSequence)}, received ${String(receivedSequence)}.`,
    );
  }
}

export class EventSequenceConflictError extends EventStoreError {
  readonly code = "EVENT_SEQUENCE_CONFLICT";
  readonly statusCode = 500;

  constructor(taskId: string, sequence: number) {
    super(
      `Conflicting event at sequence ${String(sequence)} for task "${taskId}": a different event already occupies this sequence number.`,
    );
  }
}

export class EventAfterTerminalError extends EventStoreError {
  readonly code = "EVENT_AFTER_TERMINAL";
  readonly statusCode = 500;

  constructor(taskId: string, sequence: number, terminalSequence: number) {
    super(
      `Event at sequence ${String(sequence)} for task "${taskId}" arrived after the terminal event at sequence ${String(terminalSequence)}.`,
    );
  }
}

export class EventIdentityMismatchError extends EventStoreError {
  readonly code = "EVENT_IDENTITY_MISMATCH";
  readonly statusCode = 500;

  constructor(
    taskId: string,
    field: "runId" | "taskId" | "agentId",
    expected: string,
    actual: string,
  ) {
    super(
      `Event ${field} mismatch for task "${taskId}": expected "${expected}", received "${actual}".`,
    );
  }
}

export class EventCapacityReachedError extends EventStoreError {
  readonly code = "EVENT_CAPACITY_REACHED";
  readonly statusCode = 429;

  constructor(taskId: string, limit: number) {
    super(`Task "${taskId}" has reached its configured event capacity (${String(limit)}).`);
  }
}
