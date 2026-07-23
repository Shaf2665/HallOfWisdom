export { PROTOCOL_VERSION, protocolVersionSchema } from "./version.js";
export type { ProtocolVersion } from "./version.js";

export { nonEmptyIdSchema, isoTimestampSchema, boundedNonBlankString } from "./ids.js";

export {
  ProtocolValidationError,
  parseWithSchema,
  safeDetailsSchema,
  structuredFailureSchema,
} from "./errors.js";
export type { ProtocolValidationIssue, SafeDetails, StructuredFailure } from "./errors.js";

export { agentIdentitySchema, parseAgentIdentity } from "./agent-identity.js";
export type { AgentIdentity } from "./agent-identity.js";

export { agentCapabilitiesSchema, parseAgentCapabilities } from "./agent-capabilities.js";
export type { AgentCapabilities } from "./agent-capabilities.js";

export { taskPrioritySchema, taskStatusSchema, hallTaskSchema, parseHallTask } from "./task.js";
export type { TaskPriority, TaskStatus, HallTask } from "./task.js";

export {
  capabilityIdSchema,
  capabilityStatusSchema,
  executionTrustSchema,
  capabilityEvidenceCategorySchema,
  capabilityObservationSchema,
  parseCapabilityObservation,
  taskRequirementsSchema,
  parseTaskRequirements,
  dedupedCapabilityArray,
} from "./capability.js";
export type {
  CapabilityId,
  CapabilityStatus,
  ExecutionTrust,
  CapabilityEvidenceCategory,
  CapabilityObservation,
  TaskRequirements,
} from "./capability.js";

export { runStatusSchema, agentRunSchema, parseAgentRun } from "./agent-run.js";
export type { RunStatus, AgentRun } from "./agent-run.js";

export {
  communicationBoardKindSchema,
  communicationAuthorSchema,
  communicationBoardSchema,
  parseCommunicationBoard,
  MAX_COMMUNICATION_MESSAGE_TEXT_LENGTH,
  communicationMessageTextSchema,
  communicationMessageSchema,
  parseCommunicationMessage,
} from "./communication.js";
export type {
  CommunicationBoardKind,
  CommunicationAuthor,
  CommunicationBoard,
  CommunicationMessage,
} from "./communication.js";

export {
  fileChangeOperationSchema,
  approvalRiskLevelSchema,
  cancelledBySchema,
  runStartedEventSchema,
  messageDeltaEventSchema,
  toolStartedEventSchema,
  toolCompletedEventSchema,
  fileChangedEventSchema,
  approvalRequiredEventSchema,
  runCompletedEventSchema,
  runFailedEventSchema,
  runCancelledEventSchema,
  normalizedAgentEventSchema,
  parseNormalizedAgentEvent,
  parseRunStartedEvent,
  parseMessageDeltaEvent,
  parseToolStartedEvent,
  parseToolCompletedEvent,
  parseFileChangedEvent,
  parseApprovalRequiredEvent,
  parseRunCompletedEvent,
  parseRunFailedEvent,
  parseRunCancelledEvent,
} from "./events.js";
export type {
  FileChangeOperation,
  ApprovalRiskLevel,
  CancelledBy,
  RunStartedEvent,
  MessageDeltaEvent,
  ToolStartedEvent,
  ToolCompletedEvent,
  FileChangedEvent,
  ApprovalRequiredEvent,
  RunCompletedEvent,
  RunFailedEvent,
  RunCancelledEvent,
  NormalizedAgentEvent,
} from "./events.js";
