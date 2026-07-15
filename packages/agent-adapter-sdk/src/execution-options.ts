/**
 * Options Hall Runner may pass when starting a task. `signal` is the
 * standard `AbortSignal`, used for Hall-provided cancellation (e.g. a
 * process-level shutdown or timeout) as distinct from cancellation
 * requested explicitly through the returned `AgentRunHandle.cancel()`.
 */
export interface AgentExecutionOptions {
  readonly signal?: AbortSignal;
}
