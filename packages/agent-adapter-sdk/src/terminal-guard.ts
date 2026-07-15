import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { EventAfterTerminationError } from "./errors.js";

const TERMINAL_EVENT_TYPES: ReadonlySet<NormalizedAgentEvent["type"]> = new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

function isTerminalEvent(event: NormalizedAgentEvent): boolean {
  return TERMINAL_EVENT_TYPES.has(event.type);
}

/**
 * Enforces the one rule every run's event stream must obey: **at most one
 * terminal event, ever, and nothing after it.**
 *
 * Policy (deliberately a single uniform rule rather than one case per
 * terminal-vs-terminal combination): the first terminal event
 * (`run.completed`, `run.failed`, or `run.cancelled`) passed to
 * `guardEvent` is recorded and returned. Every event submitted afterwards
 * — terminal or not — throws `EventAfterTerminationError` instead of
 * being accepted. This single rule is exactly equivalent to every
 * individual guarantee the SDK contract requires: completion cannot be
 * replaced by cancellation, cancellation cannot be replaced by failure,
 * failure cannot be replaced by completion, and no non-terminal event can
 * sneak out after any of them, because *all* of those are just "an event
 * arrived after the terminal event was already recorded".
 *
 * Throwing (rather than silently ignoring) is the chosen policy: a
 * duplicate/late event usually indicates a real bug in the adapter driving
 * this guard, and silent handling would hide it. Callers that need
 * idempotent behavior for a *legitimate* case — such as cancel() being
 * called twice — must catch `EventAfterTerminationError` at that specific
 * call site and treat it as a no-op; `MockAgentRun` in `@hall-of-wisdom/mock-agent`
 * does exactly this.
 */
export class TerminalEventGuard {
  #terminalEvent: NormalizedAgentEvent | undefined;

  get isTerminated(): boolean {
    return this.#terminalEvent !== undefined;
  }

  get terminalEvent(): NormalizedAgentEvent | undefined {
    return this.#terminalEvent;
  }

  guardEvent<T extends NormalizedAgentEvent>(event: T): T {
    if (this.#terminalEvent) {
      throw new EventAfterTerminationError(event.type, this.#terminalEvent.type);
    }
    if (isTerminalEvent(event)) {
      this.#terminalEvent = event;
    }
    return event;
  }
}
