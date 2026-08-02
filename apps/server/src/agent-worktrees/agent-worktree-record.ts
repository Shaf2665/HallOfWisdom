export const AGENT_WORKTREE_LIFECYCLE_STATUSES = [
  "creating",
  "ready",
  "creation_failed",
  "cleanup_pending",
  "cleaned",
  "cleanup_failed",
] as const;

export type AgentWorktreeLifecycleStatus = (typeof AGENT_WORKTREE_LIFECYCLE_STATUSES)[number];

export interface AgentWorktreeRecord {
  readonly worktreeId: string;
  readonly hallTaskId: string;
  readonly hallAgentRunId: string;
  readonly canonicalSourceRepositoryRoot: string;
  readonly sourceWorkingDirectoryRelativePath: string;
  readonly baseCommit: string;
  readonly canonicalWorktreePath: string;
  readonly status: AgentWorktreeLifecycleStatus;
  readonly createdAt: string;
  readonly revision: number;
  readonly readyAt: string | undefined;
  readonly cleanupRequestedAt: string | undefined;
  readonly cleanedAt: string | undefined;
  readonly safeFailureCode: string | undefined;
  readonly safeFailureSummary: string | undefined;
}

export interface CreateAgentWorktreeRecordInput {
  readonly worktreeId: string;
  readonly hallTaskId: string;
  readonly hallAgentRunId: string;
  readonly canonicalSourceRepositoryRoot: string;
  readonly sourceWorkingDirectoryRelativePath: string;
  readonly baseCommit: string;
  readonly canonicalWorktreePath: string;
  readonly createdAt: string;
}

export interface MarkAgentWorktreeReadyInput {
  readonly worktreeId: string;
  readonly expectedRevision: number;
  readonly readyAt: string;
}

export interface MarkAgentWorktreeFailureInput {
  readonly worktreeId: string;
  readonly expectedRevision: number;
  readonly safeFailureCode: string;
  readonly safeFailureSummary: string;
  readonly now: string;
}

export interface AgentWorktreeRevisionInput {
  readonly worktreeId: string;
  readonly expectedRevision: number;
  readonly now: string;
}

export function isAgentWorktreeLifecycleStatus(
  value: string,
): value is AgentWorktreeLifecycleStatus {
  return AGENT_WORKTREE_LIFECYCLE_STATUSES.includes(value as AgentWorktreeLifecycleStatus);
}

export function isActiveAgentWorktreeStatus(status: AgentWorktreeLifecycleStatus): boolean {
  return status !== "creation_failed" && status !== "cleaned";
}
