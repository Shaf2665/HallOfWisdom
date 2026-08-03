export abstract class AgentExecutionArtifactError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class AgentExecutionArtifactNotFoundError extends AgentExecutionArtifactError {
  constructor(artifactId: string) {
    super(`Agent execution artifact "${artifactId}" was not found.`);
  }
}

export class AgentExecutionArtifactRunNotFoundError extends AgentExecutionArtifactError {
  constructor(hallAgentRunId: string) {
    super(`Agent execution artifact for run "${hallAgentRunId}" was not found.`);
  }
}

export class AgentExecutionArtifactConflictError extends AgentExecutionArtifactError {
  constructor(message: string) {
    super(`Agent execution artifact conflict: ${message}`);
  }
}

export class AgentExecutionArtifactValidationError extends AgentExecutionArtifactError {
  constructor(message: string) {
    super(`Agent execution artifact is invalid: ${message}`);
  }
}

export class AgentExecutionArtifactCorruptRecordError extends AgentExecutionArtifactError {
  constructor(artifactId: string, detail: string) {
    super(`Agent execution artifact "${artifactId}" is corrupt: ${detail}`);
  }
}
