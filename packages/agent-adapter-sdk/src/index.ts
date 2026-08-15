export {
  integrationLevelSchema,
  operatingSystemSchema,
  agentAdapterDescriptorSchema,
  parseAgentAdapterDescriptor,
} from "./descriptor.js";
export type { IntegrationLevel, OperatingSystem, AgentAdapterDescriptor } from "./descriptor.js";

export {
  availabilityStatusSchema,
  agentDetectionResultSchema,
  parseAgentDetectionResult,
} from "./detection.js";
export type { AvailabilityStatus, AgentDetectionResult } from "./detection.js";

export {
  agentTaskInputSchema,
  parseAgentTaskInput,
  taskAttachmentManifestEntrySchema,
  MAX_TASK_ATTACHMENTS,
  MAX_TASK_ATTACHMENTS_TOTAL_BYTES,
} from "./task-input.js";
export type { AgentTaskInput, TaskAttachmentManifestEntry } from "./task-input.js";

export type { AgentExecutionOptions } from "./execution-options.js";
export type { AgentRunHandle, RunTerminalState } from "./run-handle.js";
export type { AgentAdapter } from "./adapter.js";

export { EventFactory } from "./event-factory.js";
export type { EventFactoryContext } from "./event-factory.js";

export { TerminalEventGuard } from "./terminal-guard.js";

export {
  SdkError,
  InvalidAdapterStateError,
  DuplicateTaskStartError,
  EventAfterTerminationError,
  InvalidCancellationStateError,
} from "./errors.js";
