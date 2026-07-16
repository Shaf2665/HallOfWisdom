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

export { createTaskRequestSchema } from "./schemas/create-task-request.js";
export type { CreateTaskRequest } from "./schemas/create-task-request.js";

export {
  DEFAULT_LIMITS,
  DEFAULT_PORT,
  LOCAL_ONLY_HOST,
  SHUTDOWN_TIMEOUT_MS,
} from "./config/server-config.js";
export type { ServerLimits } from "./config/server-config.js";

export {
  AdapterNotFoundError,
  DuplicateTaskError,
  HallCoreError,
  InternalServerError,
  InvalidRequestError,
  InvalidTaskTransitionError,
  TaskCapacityReachedError,
  TaskNotFoundError,
  TaskStateConflictError,
  WorkspaceValidationFailedError,
} from "./errors/app-error.js";
export type { RequestValidationIssue } from "./errors/app-error.js";
