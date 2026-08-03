import {
  AgentExecutionArtifactConflictError,
  AgentExecutionArtifactNotFoundError,
  AgentExecutionArtifactRunNotFoundError,
} from "./agent-execution-artifact-errors.js";
import {
  cloneArtifact,
  compareArtifactStrings,
  createAgentExecutionArtifactRecord,
  parseStoredAgentExecutionArtifactRecord,
  type AgentExecutionArtifactRecord,
  type CreateAgentExecutionArtifactInput,
} from "./agent-execution-artifact-record.js";
import type { AgentExecutionArtifactStorePort } from "./agent-execution-artifact-store-port.js";

export class InMemoryAgentExecutionArtifactStore implements AgentExecutionArtifactStorePort {
  readonly #records = new Map<string, AgentExecutionArtifactRecord>();
  readonly #artifactIdByRunId = new Map<string, string>();

  create(input: CreateAgentExecutionArtifactInput): AgentExecutionArtifactRecord {
    const record = createAgentExecutionArtifactRecord(input);
    if (this.#records.has(record.artifactId)) {
      throw new AgentExecutionArtifactConflictError(
        "Agent execution artifact creation conflicts with an existing artifact ID.",
      );
    }
    if (this.#artifactIdByRunId.has(record.hallAgentRunId)) {
      throw new AgentExecutionArtifactConflictError(
        "Agent execution artifact creation conflicts with an existing Hall agent run artifact.",
      );
    }
    const stored = parseStoredAgentExecutionArtifactRecord(record);
    this.#records.set(stored.artifactId, cloneArtifact(stored));
    this.#artifactIdByRunId.set(stored.hallAgentRunId, stored.artifactId);
    return cloneArtifact(stored);
  }

  get(artifactId: string): AgentExecutionArtifactRecord {
    const record = this.find(artifactId);
    if (record === undefined) throw new AgentExecutionArtifactNotFoundError(artifactId);
    return record;
  }

  find(artifactId: string): AgentExecutionArtifactRecord | undefined {
    const record = this.#records.get(artifactId);
    return record === undefined
      ? undefined
      : cloneArtifact(parseStoredAgentExecutionArtifactRecord(record));
  }

  getByHallAgentRunId(hallAgentRunId: string): AgentExecutionArtifactRecord {
    const record = this.findByHallAgentRunId(hallAgentRunId);
    if (record === undefined) throw new AgentExecutionArtifactRunNotFoundError(hallAgentRunId);
    return record;
  }

  findByHallAgentRunId(hallAgentRunId: string): AgentExecutionArtifactRecord | undefined {
    const artifactId = this.#artifactIdByRunId.get(hallAgentRunId);
    return artifactId === undefined ? undefined : this.find(artifactId);
  }

  list(): readonly AgentExecutionArtifactRecord[] {
    return Array.from(this.#records.values())
      .map((record) => cloneArtifact(parseStoredAgentExecutionArtifactRecord(record)))
      .sort(compareArtifacts);
  }
}

export function compareArtifacts(
  a: AgentExecutionArtifactRecord,
  b: AgentExecutionArtifactRecord,
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return compareArtifactStrings(a.artifactId, b.artifactId);
}
