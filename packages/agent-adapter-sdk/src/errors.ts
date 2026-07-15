/**
 * Base class for every SDK-level error. Not provider-specific — adapters
 * translate their own agent's errors into `StructuredFailure` events, not
 * into subclasses of this hierarchy. `code` is a stable machine identifier
 * (mirrors the protocol package's `StructuredFailure.code` convention);
 * `message` is for humans. Neither field may contain secrets or raw
 * environment data — messages here only ever reference event types, run
 * IDs, and adapter IDs, never captured process output.
 */
export abstract class SdkError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The adapter (or a run handle) was used in a state that does not permit the requested operation. */
export class InvalidAdapterStateError extends SdkError {
  readonly code = "INVALID_ADAPTER_STATE";

  // Re-declared (not just inherited) to widen SdkError's protected
  // constructor back to public, so this error remains directly `new`-able.
  public constructor(message: string) {
    super(message);
  }
}

/** `startTask` was called again for a run identifier that has already been started. */
export class DuplicateTaskStartError extends SdkError {
  readonly code = "DUPLICATE_TASK_START";

  constructor(runId: string) {
    super(`A run with runId "${runId}" has already been started.`);
  }
}

/**
 * Thrown by the terminal-event guard when any event — terminal or not —
 * is submitted after a run has already reached a terminal state. See
 * `TerminalEventGuard` for the full policy this error enforces.
 */
export class EventAfterTerminationError extends SdkError {
  readonly code = "EVENT_AFTER_TERMINATION";
  readonly attemptedEventType: string;
  readonly terminalEventType: string;

  constructor(attemptedEventType: string, terminalEventType: string) {
    super(
      `Cannot emit "${attemptedEventType}" event: this run already terminated with "${terminalEventType}".`,
    );
    this.attemptedEventType = attemptedEventType;
    this.terminalEventType = terminalEventType;
  }
}

/** A cancellation was requested in a state that does not permit it (e.g. before a run has started). */
export class InvalidCancellationStateError extends SdkError {
  readonly code = "INVALID_CANCELLATION_STATE";

  // Re-declared (not just inherited) to widen SdkError's protected
  // constructor back to public, so this error remains directly `new`-able.
  public constructor(message: string) {
    super(message);
  }
}
