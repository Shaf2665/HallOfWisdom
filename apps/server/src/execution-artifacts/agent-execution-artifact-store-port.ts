import type {
  AgentExecutionArtifactRecord,
  CreateAgentExecutionArtifactInput,
} from "./agent-execution-artifact-record.js";

export interface AgentExecutionArtifactStorePort {
  create(input: CreateAgentExecutionArtifactInput): AgentExecutionArtifactRecord;
  get(artifactId: string): AgentExecutionArtifactRecord;
  find(artifactId: string): AgentExecutionArtifactRecord | undefined;
  getByHallAgentRunId(hallAgentRunId: string): AgentExecutionArtifactRecord;
  findByHallAgentRunId(hallAgentRunId: string): AgentExecutionArtifactRecord | undefined;
  /** Deterministic order: createdAt ASC, artifactId ASC. */
  list(): readonly AgentExecutionArtifactRecord[];
}
