import type { StructuredFailure } from "@hall-of-wisdom/protocol";

/**
 * Stable failure codes this adapter can produce. Every code is
 * UPPER_SNAKE_CASE to satisfy the protocol package's `structuredFailureSchema`
 * `code` pattern. See `docs/architecture/0008-claude-code-adapter.md`,
 * "Failure taxonomy", for what each one means and when it fires.
 */
export const CLAUDE_CLI_NOT_FOUND = "CLAUDE_CLI_NOT_FOUND";
export const CLAUDE_NOT_AUTHENTICATED = "CLAUDE_NOT_AUTHENTICATED";
export const CLAUDE_SUBSCRIPTION_AUTH_UNVERIFIED = "CLAUDE_SUBSCRIPTION_AUTH_UNVERIFIED";
export const CLAUDE_UNSUPPORTED_VERSION = "CLAUDE_UNSUPPORTED_VERSION";
export const CLAUDE_PROCESS_START_FAILED = "CLAUDE_PROCESS_START_FAILED";
export const CLAUDE_PROCESS_EXITED = "CLAUDE_PROCESS_EXITED";
export const CLAUDE_STREAM_INVALID = "CLAUDE_STREAM_INVALID";
export const CLAUDE_STREAM_TRUNCATED = "CLAUDE_STREAM_TRUNCATED";
export const CLAUDE_RESULT_MISSING = "CLAUDE_RESULT_MISSING";
export const CLAUDE_PERMISSION_DENIED = "CLAUDE_PERMISSION_DENIED";
export const CLAUDE_TURN_LIMIT_REACHED = "CLAUDE_TURN_LIMIT_REACHED";
export const CLAUDE_RATE_LIMITED = "CLAUDE_RATE_LIMITED";
export const CLAUDE_EXECUTION_FAILED = "CLAUDE_EXECUTION_FAILED";

const MAX_FAILURE_MESSAGE_LENGTH = 2000;

function boundedMessage(message: string): string {
  return message.length > MAX_FAILURE_MESSAGE_LENGTH
    ? message.slice(0, MAX_FAILURE_MESSAGE_LENGTH)
    : message;
}

/**
 * Builds a `StructuredFailure` with a bounded, safe message and no
 * `details` object — this adapter never puts raw provider output,
 * stderr, or process internals into `details`; see
 * `docs/architecture/0008-claude-code-adapter.md`, "Failure taxonomy",
 * for why bounded primitives (exit code, signal) are the only
 * `details`-shaped data this adapter ever records, and even those only
 * where explicitly noted.
 */
export function buildFailure(
  code: string,
  message: string,
  options: { readonly retryable?: boolean } = {},
): StructuredFailure {
  const failure: StructuredFailure = { code, message: boundedMessage(message) };
  return options.retryable !== undefined ? { ...failure, retryable: options.retryable } : failure;
}
