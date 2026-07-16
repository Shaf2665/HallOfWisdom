/**
 * Base class for every Hall Core application error. Carries a stable
 * machine `code` and an HTTP `statusCode` so the centralized error handler
 * (`errors/error-handler.ts`) can map any `HallCoreError` to a safe,
 * bounded JSON response without ever inspecting a generic `Error`'s
 * message or stack. Messages here reference task IDs, adapter IDs, and
 * (already-validated, non-secret) paths only — never raw environment
 * data, credentials, or unrestricted adapter output.
 */
export abstract class HallCoreError extends Error {
  abstract readonly code: string;
  abstract readonly statusCode: number;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface RequestValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class InvalidRequestError extends HallCoreError {
  readonly code = "INVALID_REQUEST";
  readonly statusCode = 400;
  readonly details?: readonly RequestValidationIssue[] | undefined;

  constructor(message: string, details?: readonly RequestValidationIssue[]) {
    super(message);
    this.details = details;
  }
}

export class TaskNotFoundError extends HallCoreError {
  readonly code = "TASK_NOT_FOUND";
  readonly statusCode = 404;

  constructor(taskId: string) {
    super(`No task found with taskId "${taskId}".`);
  }
}

export class AdapterNotFoundError extends HallCoreError {
  readonly code = "ADAPTER_NOT_FOUND";
  readonly statusCode = 404;

  constructor(adapterId: string) {
    super(`No adapter is registered with adapterId "${adapterId}".`);
  }
}

export class TaskStateConflictError extends HallCoreError {
  readonly code = "TASK_STATE_CONFLICT";
  readonly statusCode = 409;

  constructor(taskId: string, currentStatus: string, attemptedAction: string) {
    super(`Task "${taskId}" cannot be ${attemptedAction} while in status "${currentStatus}".`);
  }
}

export class WorkspaceValidationFailedError extends HallCoreError {
  readonly code = "WORKSPACE_VALIDATION_FAILED";
  readonly statusCode = 400;

  // Re-declared (not just inherited) to widen HallCoreError's protected
  // constructor back to public, so this error remains directly `new`-able.
  public constructor(message: string) {
    super(message);
  }
}

export class TaskCapacityReachedError extends HallCoreError {
  readonly code = "TASK_CAPACITY_REACHED";
  readonly statusCode = 429;

  constructor(limit: number) {
    super(`The server has reached its configured task capacity (${String(limit)}).`);
  }
}

/** Should be unreachable in practice (task IDs are freshly generated UUIDs); guards the store's own invariant. */
export class DuplicateTaskError extends HallCoreError {
  readonly code = "INTERNAL_ERROR";
  readonly statusCode = 500;

  constructor(taskId: string) {
    super(`A task with taskId "${taskId}" already exists.`);
  }
}

/** Guards the store's own status-transition invariant; a bug elsewhere, not a client input problem. */
export class InvalidTaskTransitionError extends HallCoreError {
  readonly code = "INTERNAL_ERROR";
  readonly statusCode = 500;

  constructor(taskId: string, from: string, to: string) {
    super(`Invalid task status transition for task "${taskId}": "${from}" -> "${to}".`);
  }
}

export class InternalServerError extends HallCoreError {
  readonly code = "INTERNAL_ERROR";
  readonly statusCode = 500;

  constructor(message = "An unexpected internal error occurred.") {
    super(message);
  }
}
