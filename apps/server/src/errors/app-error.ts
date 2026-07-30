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

/**
 * A client requested a manual planning transition (`POST
 * /api/v1/tasks/:taskId/transition`) whose target status is not a
 * permitted manual destination from the task's current status — distinct
 * from `InvalidTaskTransitionError` above, which guards an internal
 * invariant and should never be reachable from client input.
 */
export class InvalidManualTransitionError extends HallCoreError {
  readonly code = "INVALID_TASK_TRANSITION";
  readonly statusCode = 409;

  constructor(taskId: string, from: string, to: string) {
    super(`Task "${taskId}" cannot be manually moved from "${from}" to "${to}".`);
  }
}

/**
 * A client attempted a manual planning transition on a task that is
 * currently under execution control (running, reviewing,
 * waiting_for_approval, or assigned with a run already started) —
 * planning-endpoint moves are only ever valid before or between runs.
 */
export class ActiveTaskTransitionDeniedError extends HallCoreError {
  readonly code = "ACTIVE_TASK_TRANSITION_DENIED";
  readonly statusCode = 409;

  constructor(taskId: string, status: string) {
    super(
      `Task "${taskId}" is under execution control (status "${status}") and cannot be manually moved.`,
    );
  }
}

/** The adapter chosen for assignment exists but did not report itself available. */
export class AdapterUnavailableError extends HallCoreError {
  readonly code = "ADAPTER_UNAVAILABLE";
  readonly statusCode = 409;

  constructor(adapterId: string, availability: string) {
    super(`Adapter "${adapterId}" is not available (status "${availability}").`);
  }
}

/**
 * Phase 11 — thrown by `POST .../routing-analysis` and `POST
 * .../route-and-assign` when the task has no persisted `requirements` and
 * the request supplied no override either — there is nothing to route
 * against.
 */
export class TaskRequirementsNotSetError extends HallCoreError {
  readonly code = "TASK_REQUIREMENTS_NOT_SET";
  readonly statusCode = 400;

  constructor(taskId: string) {
    super(
      `Task "${taskId}" has no capability requirements set. Select a requirement profile before routing.`,
    );
  }
}

/**
 * Phase 11 — thrown by `POST .../route-and-assign` when the deterministic
 * routing policy found no eligible adapter. Never lowers or retries with
 * relaxed requirements — the caller must change the task's requirements
 * (or the machine's adapter state) and try again.
 */
export class NoRoutingCandidateError extends HallCoreError {
  readonly code = "NO_ROUTING_CANDIDATE";
  readonly statusCode = 409;

  constructor(taskId: string, explanation: string) {
    super(`No adapter qualifies to be routed to task "${taskId}": ${explanation}`);
  }
}

/**
 * Phase 11.1 — thrown by manual `POST .../assign` when the task carries
 * `requirements` and the selected adapter does not currently satisfy them
 * (a missing/unverified/restricted required capability, or an execution
 * trust not in the task's allowed list). Reuses the exact same
 * `evaluateCandidateEligibility` check `routing-analysis`/`route-and-assign`
 * already use — never a second, divergent compatibility algorithm. The
 * message is a fixed, safe sentence; the underlying capability/trust
 * evaluation that produced this rejection is never included in the
 * response body.
 */
export class AdapterRequirementsMismatchError extends HallCoreError {
  readonly code = "ADAPTER_REQUIREMENTS_MISMATCH";
  readonly statusCode = 409;

  constructor() {
    super("The selected adapter does not satisfy this task's requirements.");
  }
}

export class InternalServerError extends HallCoreError {
  readonly code = "INTERNAL_ERROR";
  readonly statusCode = 500;

  constructor(message = "An unexpected internal error occurred.") {
    super(message);
  }
}

export class BoardNotFoundError extends HallCoreError {
  readonly code = "BOARD_NOT_FOUND";
  readonly statusCode = 404;

  constructor(boardId: string) {
    super(`No board found with boardId "${boardId}".`);
  }
}

export class BoardCapacityReachedError extends HallCoreError {
  readonly code = "BOARD_CAPACITY_REACHED";
  readonly statusCode = 429;

  constructor(limit: number) {
    super(`The server has reached its configured board capacity (${String(limit)}).`);
  }
}

export class MessageCapacityReachedError extends HallCoreError {
  readonly code = "MESSAGE_CAPACITY_REACHED";
  readonly statusCode = 429;

  constructor(boardId: string, limit: number) {
    super(`Board "${boardId}" has reached its configured message capacity (${String(limit)}).`);
  }
}

/** A request body failed communication-message validation (blank, oversized, NUL character, unknown field). Distinct code from `InvalidRequestError` so clients can react specifically to a rejected message body. */
export class InvalidMessageError extends HallCoreError {
  readonly code = "INVALID_MESSAGE";
  readonly statusCode = 400;
  readonly details?: readonly RequestValidationIssue[] | undefined;

  constructor(message: string, details?: readonly RequestValidationIssue[]) {
    super(message);
    this.details = details;
  }
}

/**
 * Guards `MessageStore.append()`'s internal invariant that a caller-supplied
 * message's own `boardId` field matches the `boardId` the append is
 * targeting — should be unreachable in practice (Hall Core always
 * constructs both from the same value), the same defense-in-depth reasoning
 * as `EventIdentityMismatchError` for `EventStore.append()`.
 */
export class MessageBoardIdentityMismatchError extends HallCoreError {
  readonly code = "INTERNAL_ERROR";
  readonly statusCode = 500;

  constructor(expectedBoardId: string, actualBoardId: string) {
    super(`Message boardId mismatch: expected "${expectedBoardId}", received "${actualBoardId}".`);
  }
}

/** Phase 12 — controlled multi-agent execution comparison. */
export class ComparisonNotFoundError extends HallCoreError {
  readonly code = "COMPARISON_NOT_FOUND";
  readonly statusCode = 404;

  constructor(comparisonId: string) {
    super(`No comparison found with comparisonId "${comparisonId}".`);
  }
}

export class ComparisonCandidateNotFoundError extends HallCoreError {
  readonly code = "COMPARISON_CANDIDATE_NOT_FOUND";
  readonly statusCode = 404;

  constructor(comparisonId: string, candidateId: string) {
    super(`No candidate "${candidateId}" found on comparison "${comparisonId}".`);
  }
}

export class ComparisonStateConflictError extends HallCoreError {
  readonly code = "COMPARISON_STATE_CONFLICT";
  readonly statusCode = 409;

  constructor(comparisonId: string, currentStatus: string, attemptedAction: string) {
    super(
      `Comparison "${comparisonId}" cannot be ${attemptedAction} while in status "${currentStatus}".`,
    );
  }
}

export class ComparisonCapacityReachedError extends HallCoreError {
  readonly code = "COMPARISON_CAPACITY_REACHED";
  readonly statusCode = 429;

  constructor(limit: number) {
    super(`The server has reached its configured comparison capacity (${String(limit)}).`);
  }
}

/** Should be unreachable in practice (comparison IDs are freshly generated UUIDs); guards the store's own invariant. */
export class DuplicateComparisonError extends HallCoreError {
  readonly code = "INTERNAL_ERROR";
  readonly statusCode = 500;

  constructor(comparisonId: string) {
    super(`A comparison with comparisonId "${comparisonId}" already exists.`);
  }
}

/** The source task referenced by a comparison-create request does not exist. Distinct from `TaskNotFoundError` for clarity in comparison-specific error handling, but same HTTP semantics. */
export class ComparisonSourceTaskNotFoundError extends HallCoreError {
  readonly code = "COMPARISON_SOURCE_TASK_NOT_FOUND";
  readonly statusCode = 404;

  constructor(taskId: string) {
    super(`No task found with taskId "${taskId}" to compare against.`);
  }
}

export class ComparisonAdapterNotFoundError extends HallCoreError {
  readonly code = "COMPARISON_ADAPTER_NOT_FOUND";
  readonly statusCode = 404;

  constructor(adapterId: string) {
    super(`No adapter is registered with adapterId "${adapterId}".`);
  }
}

/** The candidate's adapter did not report itself available, or no longer satisfies the comparison's snapshotted requirements, at the moment `POST .../start` re-checked it. */
export class ComparisonCandidateNotEligibleError extends HallCoreError {
  readonly code = "COMPARISON_CANDIDATE_NOT_ELIGIBLE";
  readonly statusCode = 409;

  constructor(adapterId: string, reason: string) {
    super(`Adapter "${adapterId}" is not currently eligible to start: ${reason}`);
  }
}

/** Phase 14 — CEO Agent planning, approval-gated delegation, and plan tracking. */
export class CeoPlanNotFoundError extends HallCoreError {
  readonly code = "CEO_PLAN_NOT_FOUND";
  readonly statusCode = 404;

  constructor(planId: string) {
    super(`No CEO plan found with planId "${planId}".`);
  }
}

export class CeoPlanVersionNotFoundError extends HallCoreError {
  readonly code = "CEO_PLAN_VERSION_NOT_FOUND";
  readonly statusCode = 404;

  constructor(planId: string, version: number) {
    super(`CEO plan "${planId}" has no version ${String(version)}.`);
  }
}

/** Wrong status for the attempted transition (e.g. approving a plan that is not `awaiting_approval`), or a stale optimistic-concurrency revision — both are the same "the plan moved since you last read it" family the client resolves by re-fetching. */
export class CeoPlanStateConflictError extends HallCoreError {
  readonly code = "CEO_PLAN_STATE_CONFLICT";
  readonly statusCode = 409;

  constructor(planId: string, currentStatus: string, attemptedAction: string) {
    super(`CEO plan "${planId}" cannot be ${attemptedAction} while in status "${currentStatus}".`);
  }
}

/**
 * Kickoff, "Plan versioning": approval/delegation is bound to an exact
 * `(planId, version, contentHash)` triple. Thrown when a request targets
 * a version or hash that is no longer the plan's active one — including
 * the case a client never learns the real reason for (a concurrent edit
 * landed between the client reading the plan and submitting a decision)
 * — the message deliberately says only that the binding no longer holds,
 * never which specific field changed, so a client cannot use this
 * response to probe plan internals it does not already have.
 */
export class CeoPlanApprovalBindingError extends HallCoreError {
  readonly code = "CEO_PLAN_APPROVAL_BINDING_MISMATCH";
  readonly statusCode = 409;

  constructor(planId: string) {
    super(
      `CEO plan "${planId}"'s active version or content no longer matches what was submitted for this decision. Re-fetch the plan and try again.`,
    );
  }
}

export class CeoPlanAlreadyDelegatedError extends HallCoreError {
  readonly code = "CEO_PLAN_ALREADY_DELEGATED";
  readonly statusCode = 409;

  constructor(planId: string) {
    super(`CEO plan "${planId}" has already been delegated.`);
  }
}

/**
 * Delegation-time revalidation (kickoff, "Delegation semantics") failed —
 * an ineligible or unavailable adapter, a parent task that no longer
 * exists or has entered an incompatible terminal state, or a dependency
 * graph that no longer validates. `safeReason` is always a bounded,
 * pre-composed sentence, never raw adapter output or a stack trace.
 * Delegation creates zero child tasks and zero assignments whenever this
 * is thrown — see `ceo-plan-orchestrator.ts`'s `delegate()`.
 */
export class CeoPlanDelegationBlockedError extends HallCoreError {
  readonly code = "CEO_PLAN_DELEGATION_BLOCKED";
  readonly statusCode = 422;

  constructor(planId: string, safeReason: string) {
    super(`CEO plan "${planId}" cannot be delegated: ${safeReason}`);
  }
}

/**
 * Phase 14.1 — a plan version's step names a `selectedAdapterId` that is
 * either not currently registered or does not satisfy that step's own
 * `requirements` — checked at version-creation time (not just delegation
 * time) so a browser cannot save an override that could never actually
 * delegate. Distinct from `CeoPlanDelegationBlockedError`, which fires
 * later, at delegation, when eligibility has drifted since the version
 * was saved.
 */
export class CeoPlanStepAdapterInvalidError extends HallCoreError {
  readonly code = "CEO_PLAN_STEP_ADAPTER_INVALID";
  readonly statusCode = 422;

  constructor(planId: string, stepId: string, safeReason: string) {
    super(`CEO plan "${planId}" step "${stepId}"'s selected adapter is invalid: ${safeReason}`);
  }
}

/**
 * Phase 14.1 — a client-submitted mutation token did not match the
 * plan's current state: either genuinely stale (a concurrent mutation
 * landed first) or malformed/forged. The message is deliberately
 * identical in both cases so a client cannot use the response to
 * distinguish "stale" from "forged," matching
 * `CeoPlanApprovalBindingError`'s own discipline. Replaces the old
 * plain-integer `revision` conflict path — see
 * `ceo-plan-mutation-token.ts`.
 */
export class CeoPlanMutationTokenInvalidError extends HallCoreError {
  readonly code = "CEO_PLAN_MUTATION_TOKEN_INVALID";
  readonly statusCode = 409;

  constructor(planId: string) {
    super(
      `CEO plan "${planId}"'s mutation token is stale or invalid. Re-fetch the plan and try again.`,
    );
  }
}

/** The deterministic (or scripted) planner returned a bounded "insufficient information" result rather than a plan — not a server error, but distinct from a normal successful generation so routes can respond with a clear, safe status. */
export class CeoPlanningBlockedError extends HallCoreError {
  readonly code = "CEO_PLANNING_BLOCKED";
  readonly statusCode = 422;

  // Re-declared (not just inherited) to widen HallCoreError's protected
  // constructor back to public, matching WorkspaceValidationFailedError's
  // pattern above.
  public constructor(reason: string) {
    super(reason);
  }
}
