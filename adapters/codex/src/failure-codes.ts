import type { StructuredFailure } from "@hall-of-wisdom/protocol";

/**
 * Stable failure codes this adapter can produce. Every code is
 * UPPER_SNAKE_CASE to satisfy the protocol package's `structuredFailureSchema`
 * `code` pattern. See `docs/architecture/0009-codex-adapter.md`, "Failure
 * taxonomy", for what each one means and when it fires.
 */
export const CODEX_CLI_NOT_FOUND = "CODEX_CLI_NOT_FOUND";
export const CODEX_NOT_AUTHENTICATED = "CODEX_NOT_AUTHENTICATED";
export const CODEX_CHATGPT_AUTH_UNVERIFIED = "CODEX_CHATGPT_AUTH_UNVERIFIED";
export const CODEX_API_KEY_AUTH_REJECTED = "CODEX_API_KEY_AUTH_REJECTED";
export const CODEX_ACCESS_TOKEN_AUTH_REJECTED = "CODEX_ACCESS_TOKEN_AUTH_REJECTED";
export const CODEX_UNSUPPORTED_VERSION = "CODEX_UNSUPPORTED_VERSION";
export const CODEX_ISOLATION_UNSUPPORTED = "CODEX_ISOLATION_UNSUPPORTED";
export const CODEX_GIT_REPOSITORY_REQUIRED = "CODEX_GIT_REPOSITORY_REQUIRED";
export const CODEX_WORKTREE_VALIDATION_FAILED = "CODEX_WORKTREE_VALIDATION_FAILED";
/** Phase 10.2 — trusted-local mode's own writability preflight; never fires in strict mode. */
export const CODEX_WORKSPACE_NOT_WRITABLE = "CODEX_WORKSPACE_NOT_WRITABLE";
export const CODEX_PROCESS_START_FAILED = "CODEX_PROCESS_START_FAILED";
export const CODEX_PROCESS_EXITED = "CODEX_PROCESS_EXITED";
export const CODEX_STREAM_INVALID = "CODEX_STREAM_INVALID";
export const CODEX_STREAM_TRUNCATED = "CODEX_STREAM_TRUNCATED";
export const CODEX_RESULT_MISSING = "CODEX_RESULT_MISSING";
/** Phase 10.2 — no stdout/stderr chunk arrived for longer than the bounded inactivity timeout. */
export const CODEX_OUTPUT_INACTIVITY_TIMEOUT = "CODEX_OUTPUT_INACTIVITY_TIMEOUT";
export const CODEX_SANDBOX_DENIED = "CODEX_SANDBOX_DENIED";
export const CODEX_APPROVAL_REQUIRED = "CODEX_APPROVAL_REQUIRED";
export const CODEX_RATE_LIMITED = "CODEX_RATE_LIMITED";
export const CODEX_USAGE_LIMIT_REACHED = "CODEX_USAGE_LIMIT_REACHED";
export const CODEX_EXECUTION_FAILED = "CODEX_EXECUTION_FAILED";

const MAX_FAILURE_MESSAGE_LENGTH = 2000;

function boundedMessage(message: string): string {
  return message.length > MAX_FAILURE_MESSAGE_LENGTH
    ? message.slice(0, MAX_FAILURE_MESSAGE_LENGTH)
    : message;
}

/**
 * Builds a `StructuredFailure` with a bounded, safe message and no
 * `details` object — this adapter never puts raw provider output, stderr,
 * account/thread identifiers, or process internals into `details`. See
 * `docs/architecture/0009-codex-adapter.md`, "Failure taxonomy".
 */
export function buildFailure(
  code: string,
  message: string,
  options: { readonly retryable?: boolean } = {},
): StructuredFailure {
  const failure: StructuredFailure = { code, message: boundedMessage(message) };
  return options.retryable !== undefined ? { ...failure, retryable: options.retryable } : failure;
}
