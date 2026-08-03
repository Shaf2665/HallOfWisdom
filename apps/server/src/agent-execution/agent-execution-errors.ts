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
