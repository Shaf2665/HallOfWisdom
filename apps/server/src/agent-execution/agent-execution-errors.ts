export abstract class AgentExecutionOrchestrationError extends Error {
  readonly safeFailureCode: string;
  readonly safeFailureSummary: string;

  protected constructor(safeFailureCode: string, safeFailureSummary: string) {
    super(safeFailureSummary);
    this.name = new.target.name;
    this.safeFailureCode = safeFailureCode;
    this.safeFailureSummary = safeFailureSummary;
  }
}

export class AgentExecutionWorktreePreparationError extends AgentExecutionOrchestrationError {
  constructor(summary = "Hall Core could not prepare an isolated worktree for this execution.") {
    super("WORKTREE_PREPARATION_FAILED", summary);
  }
}

export class AgentExecutionArtifactTerminalizationError extends AgentExecutionOrchestrationError {
  constructor(summary = "Hall Core could not persist the execution artifact safely.") {
    super("EXECUTION_ARTIFACT_TERMINALIZATION_FAILED", summary);
  }
}

export class AgentExecutionArtifactMismatchError extends AgentExecutionArtifactTerminalizationError {
  constructor() {
    super("Existing execution artifact does not match the authoritative terminal state.");
  }
}

export class GitArtifactCollectionError extends AgentExecutionOrchestrationError {
  constructor(summary = "Hall Core could not collect Git evidence safely.") {
    super("GIT_ARTIFACT_COLLECTION_FAILED", summary);
  }
}

/**
 * This task's linked attachments exceed `MAX_TASK_ATTACHMENTS` or
 * `MAX_TASK_ATTACHMENTS_TOTAL_BYTES` (see `@hall-of-wisdom/agent-adapter-sdk`).
 * Thrown before any blob is read or any file is written — excess
 * attachments are never silently dropped.
 */
export class AttachmentMaterializationLimitExceededError extends AgentExecutionOrchestrationError {
  constructor(
    summary = "This task's attachments exceed Hall's materialization limit for a single execution.",
  ) {
    super("ATTACHMENT_MATERIALIZATION_LIMIT_EXCEEDED", summary);
  }
}

/** An attachment linked to this task's board could not be read from blob storage (missing or unreadable). */
export class AttachmentBlobUnavailableError extends AgentExecutionOrchestrationError {
  constructor(summary = "An attachment linked to this task could not be read from storage.") {
    super("ATTACHMENT_BLOB_UNAVAILABLE", summary);
  }
}

/**
 * This task has linked attachments, but the resolved execution is not
 * running in a Hall-owned isolated worktree — there is no Hall-owned
 * bounded directory to materialize them into. Hall never invents a second,
 * non-worktree temp-storage location for this; the task must be assigned
 * to an adapter/configuration that runs isolated instead.
 */
export class AttachmentsRequireIsolatedExecutionError extends AgentExecutionOrchestrationError {
  constructor(
    summary = "This task has attachments, which requires isolated (worktree) execution.",
  ) {
    super("ATTACHMENT_REQUIRES_ISOLATED_EXECUTION", summary);
  }
}

/**
 * This task has a linked image attachment, but the adapter resolved for
 * this execution does not report a *verified* `vision.image` capability
 * observation right now. Thrown before any attachment is materialized —
 * an image attachment is never silently sent to an adapter that can't
 * actually analyze it (e.g. Claude Code, which only ever *declares*
 * `vision.image`; see `adapters/claude-code/src/detection.ts`). This is
 * the execution-time backstop that applies regardless of how the adapter
 * was chosen — auto-routed or manually assigned — complementing (not
 * replacing) `TaskOrchestrator`'s routing-time `vision.image` requirement
 * injection for image-attached tasks.
 */
export class ImageAttachmentRequiresVisionCapabilityError extends AgentExecutionOrchestrationError {
  constructor(
    summary = "This task has an image attachment, which requires an adapter with verified vision.image support.",
  ) {
    super("IMAGE_ATTACHMENT_REQUIRES_VISION_CAPABILITY", summary);
  }
}
