import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";

/**
 * Stable prototype exit-code policy. `0` is reserved exclusively for a
 * confirmed `run.completed` — the runner never reports success for any
 * other reason, including an empty or missing terminal event.
 */
export const EXIT_CODES = {
  completed: 0,
  failed: 1,
  invalidInput: 2,
  internalError: 3,
  cancelled: 130,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export type TerminalEventType = "run.completed" | "run.failed" | "run.cancelled";

const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

export function isTerminalEventType(type: string): type is TerminalEventType {
  return TERMINAL_EVENT_TYPES.has(type);
}

export function exitCodeForTerminalEvent(event: NormalizedAgentEvent): ExitCode {
  switch (event.type) {
    case "run.completed":
      return EXIT_CODES.completed;
    case "run.failed":
      return EXIT_CODES.failed;
    case "run.cancelled":
      return EXIT_CODES.cancelled;
    default:
      throw new Error(`"${event.type}" is not a terminal event type`);
  }
}
