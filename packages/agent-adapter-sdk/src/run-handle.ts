import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";

/**
 * The run's terminal state as observed synchronously, where practical,
 * without awaiting `completion`. `"running"` covers every pre-terminal
 * state (queued, starting, executing) — this SDK does not require a
 * handle to distinguish those finer states synchronously.
 */
export type RunTerminalState = "running" | "completed" | "failed" | "cancelled";

/**
 * Returned by `AgentAdapter.startTask`. `events` is the single source of
 * truth for what happened during the run — iterating it is what drives
 * execution forward (see the adapter SDK architecture doc for why this
 * package prefers `AsyncIterable` over a callback-based push API).
 *
 * `completion` resolves with the run's terminal event as a side effect of
 * `events` being iterated to that point; it is a convenience for callers
 * that only care about the final outcome, not a separate execution path.
 */
export interface AgentRunHandle {
  readonly runId: string;
  readonly events: AsyncIterable<NormalizedAgentEvent>;
  readonly completion: Promise<NormalizedAgentEvent>;
  readonly currentState: RunTerminalState;

  /**
   * Requests cancellation. Idempotent: calling this more than once, or
   * calling it after the run has already reached a terminal state, must
   * never produce more than the one `run.cancelled` event a first,
   * in-time call would produce, and must never replace an
   * already-recorded `run.completed` or `run.failed`.
   */
  cancel(reason?: string): void;
}
