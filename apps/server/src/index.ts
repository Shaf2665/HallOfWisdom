export { createHallCoreApp } from "./app.js";
export type { CreateHallCoreAppOptions } from "./app.js";

export { TaskOrchestrator } from "./tasks/task-orchestrator.js";
export type { TaskOrchestratorOptions, CreateTaskResult } from "./tasks/task-orchestrator.js";

export { TaskStore } from "./tasks/task-store.js";
export type { TaskStoreOptions } from "./tasks/task-store.js";
export type { TaskRecord } from "./tasks/task-record.js";
export { isValidTaskTransition, isTerminalTaskStatus } from "./tasks/task-status-transitions.js";

export { EventStore, EventStoreConfigError, MIN_EVENTS_PER_TASK } from "./events/event-store.js";
export type {
  EventStoreOptions,
  ExpectedEventIdentity,
  AppendResult,
} from "./events/event-store.js";
export {
  EventStoreError,
  EventAfterTerminalError,
  EventCapacityReachedError as EventStoreCapacityReachedError,
  EventIdentityMismatchError,
  EventSequenceConflictError,
  EventSequenceGapError,
} from "./events/event-store-errors.js";

export { EventBus, SubscriberLimitReachedError } from "./events/event-bus.js";
export type { EventBusOptions, EventListener } from "./events/event-bus.js";

export { BoardStore, GENERAL_BOARD_ID, taskBoardId } from "./boards/board-store.js";
export type { BoardStoreOptions, EnsureTaskBoardResult } from "./boards/board-store.js";

export { MessageStore } from "./boards/message-store.js";
export type { MessageStoreOptions, AppendMessageInput } from "./boards/message-store.js";

export { MessageBus, MessageSubscriberLimitReachedError } from "./boards/message-bus.js";
export type { MessageBusOptions, MessageListener } from "./boards/message-bus.js";

export { createTaskRequestSchema } from "./schemas/create-task-request.js";
export type { CreateTaskRequest } from "./schemas/create-task-request.js";

export { createMessageRequestSchema } from "./schemas/create-message-request.js";
export type { CreateMessageRequest } from "./schemas/create-message-request.js";

export {
  DEFAULT_LIMITS,
  DEFAULT_PORT,
  LOCAL_ONLY_HOST,
  SHUTDOWN_TIMEOUT_MS,
} from "./config/server-config.js";
export type { ServerLimits } from "./config/server-config.js";

export {
  AdapterNotFoundError,
  BoardCapacityReachedError,
  BoardNotFoundError,
  ComparisonAdapterNotFoundError,
  ComparisonCandidateNotEligibleError,
  ComparisonCandidateNotFoundError,
  ComparisonCapacityReachedError,
  ComparisonNotFoundError,
  ComparisonSourceTaskNotFoundError,
  ComparisonStateConflictError,
  DuplicateComparisonError,
  DuplicateTaskError,
  HallCoreError,
  InternalServerError,
  InvalidMessageError,
  InvalidRequestError,
  InvalidTaskTransitionError,
  MessageBoardIdentityMismatchError,
  MessageCapacityReachedError,
  TaskCapacityReachedError,
  TaskNotFoundError,
  TaskStateConflictError,
  WorkspaceValidationFailedError,
} from "./errors/app-error.js";
export type { RequestValidationIssue } from "./errors/app-error.js";

export { createComparisonComposition } from "./composition/comparison-composition-root.js";
export type {
  ComparisonComposition,
  ComparisonCompositionOptions,
} from "./composition/comparison-composition-root.js";

export { ComparisonStore } from "./comparisons/comparison-store.js";
export type { ComparisonStoreOptions } from "./comparisons/comparison-store.js";
export type {
  AgentComparisonRecord,
  CandidateResultEvidence,
  ChangedFileEntry,
  CleanupStatus,
  ComparisonCandidateRecord,
  ComparisonPreference,
  ComparisonStatus,
  CandidateStatus,
} from "./comparisons/comparison-record.js";

export { ComparisonOrchestrator } from "./comparisons/comparison-orchestrator.js";
export type { ComparisonOrchestratorOptions } from "./comparisons/comparison-orchestrator.js";

export { GitWorktreeManager } from "./comparisons/git-worktree-manager.js";
export type {
  GitWorktreeManagerOptions,
  CreateWorktreeInput,
  CreatedWorktree,
} from "./comparisons/git-worktree-manager.js";

export { nodeProcessSpawner } from "./comparisons/process-spawner.js";
export type { ProcessSpawner } from "./comparisons/process-spawner.js";
