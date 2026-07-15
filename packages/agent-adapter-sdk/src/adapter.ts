import type { AgentAdapterDescriptor } from "./descriptor.js";
import type { AgentDetectionResult } from "./detection.js";
import type { AgentExecutionOptions } from "./execution-options.js";
import type { AgentRunHandle } from "./run-handle.js";
import type { AgentTaskInput } from "./task-input.js";

/**
 * The contract every coding-agent integration implements. Concrete
 * adapters (Mock Agent, and later Claude Code, Codex, etc.) implement
 * this directly; Hall Runner depends only on this interface, never on a
 * specific adapter's internals.
 */
export interface AgentAdapter {
  readonly descriptor: AgentAdapterDescriptor;

  detect(): Promise<AgentDetectionResult>;

  startTask(input: AgentTaskInput, options?: AgentExecutionOptions): Promise<AgentRunHandle>;
}
