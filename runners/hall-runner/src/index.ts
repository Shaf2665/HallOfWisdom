export { AgentRegistry } from "./agent-registry.js";

export { isContainedPath } from "./path-containment.js";
export type { ContainmentOptions, PathModule } from "./path-containment.js";

export { validateWorkspace } from "./workspace-validation.js";
export type { WorkspaceValidationInput, ValidatedWorkspace } from "./workspace-validation.js";

export { runTask } from "./runner-service.js";
export type { RunTaskRequest, RunTaskResult } from "./runner-service.js";

export { installSignalCancellation } from "./signal-cancellation.js";
export type {
  SignalCancellationHandlers,
  SignalCancellationHandle,
} from "./signal-cancellation.js";

export { EXIT_CODES, exitCodeForTerminalEvent, isTerminalEventType } from "./exit-codes.js";
export type { ExitCode, TerminalEventType } from "./exit-codes.js";

export {
  RunnerError,
  DuplicateAdapterError,
  UnknownAdapterError,
  InvalidCliInputError,
  InvalidWorkspaceRootError,
  InvalidWorkingDirectoryError,
  WorkingDirectoryOutsideWorkspaceError,
  RunnerAlreadyStartedError,
  NoTerminalEventError,
  UnexpectedRunnerStateError,
} from "./errors.js";
