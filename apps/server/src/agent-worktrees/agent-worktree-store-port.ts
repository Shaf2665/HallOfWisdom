import type {
  AgentWorktreeRecord,
  AgentWorktreeRevisionInput,
  CreateAgentWorktreeRecordInput,
  MarkAgentWorktreeFailureInput,
  MarkAgentWorktreeReadyInput,
} from "./agent-worktree-record.js";

export interface AgentWorktreeStorePort {
  createCreating(input: CreateAgentWorktreeRecordInput): AgentWorktreeRecord;
  get(worktreeId: string): AgentWorktreeRecord;
  find(worktreeId: string): AgentWorktreeRecord | undefined;
  findActiveByAgentRunId(hallAgentRunId: string): AgentWorktreeRecord | undefined;
  list(): readonly AgentWorktreeRecord[];
  markReady(input: MarkAgentWorktreeReadyInput): AgentWorktreeRecord;
  markCreationFailed(input: MarkAgentWorktreeFailureInput): AgentWorktreeRecord;
  requestCleanup(input: AgentWorktreeRevisionInput): AgentWorktreeRecord;
  markCleaned(input: AgentWorktreeRevisionInput): AgentWorktreeRecord;
  markCleanupFailed(input: MarkAgentWorktreeFailureInput): AgentWorktreeRecord;
}
