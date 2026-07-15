/**
 * Base class for every Hall Runner error. Mirrors the SDK's `SdkError`
 * convention: a stable machine `code` plus a human `message`. Messages
 * here reference adapter IDs, run IDs, and (sanitized) paths only — never
 * environment variables, credentials, or unrestricted command output.
 */
export abstract class RunnerError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class DuplicateAdapterError extends RunnerError {
  readonly code = "DUPLICATE_ADAPTER";

  public constructor(adapterId: string) {
    super(`An adapter with adapterId "${adapterId}" is already registered.`);
  }
}

export class UnknownAdapterError extends RunnerError {
  readonly code = "UNKNOWN_ADAPTER";

  public constructor(adapterId: string) {
    super(`No adapter is registered with adapterId "${adapterId}".`);
  }
}

export class InvalidCliInputError extends RunnerError {
  readonly code = "INVALID_CLI_INPUT";

  public constructor(message: string) {
    super(message);
  }
}

export class InvalidWorkspaceRootError extends RunnerError {
  readonly code = "INVALID_WORKSPACE_ROOT";

  public constructor(message: string) {
    super(message);
  }
}

export class InvalidWorkingDirectoryError extends RunnerError {
  readonly code = "INVALID_WORKING_DIRECTORY";

  public constructor(message: string) {
    super(message);
  }
}

export class WorkingDirectoryOutsideWorkspaceError extends RunnerError {
  readonly code = "WORKING_DIRECTORY_OUTSIDE_WORKSPACE";

  public constructor(workspaceRoot: string, workingDirectory: string) {
    super(
      `Working directory "${workingDirectory}" is not the workspace root "${workspaceRoot}" or a descendant of it.`,
    );
  }
}

export class RunnerAlreadyStartedError extends RunnerError {
  readonly code = "RUNNER_ALREADY_STARTED";

  public constructor(runId: string) {
    super(`A run with runId "${runId}" has already been started by this runner service call.`);
  }
}

export class NoTerminalEventError extends RunnerError {
  readonly code = "NO_TERMINAL_EVENT";

  public constructor(runId: string) {
    super(`Adapter event stream for runId "${runId}" ended without emitting a terminal event.`);
  }
}

export class UnexpectedRunnerStateError extends RunnerError {
  readonly code = "UNEXPECTED_RUNNER_STATE";

  public constructor(message: string) {
    super(message);
  }
}
