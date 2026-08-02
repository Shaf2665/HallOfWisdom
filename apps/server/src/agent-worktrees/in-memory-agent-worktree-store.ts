import {
  AgentWorktreeConflictError,
  AgentWorktreeInvalidTransitionError,
  AgentWorktreeNotFoundError,
  boundSafeSummary,
  sanitizeFailureCode,
} from "./agent-worktree-errors.js";
import type { AgentWorktreeStorePort } from "./agent-worktree-store-port.js";
import {
  isActiveAgentWorktreeStatus,
  type AgentWorktreeLifecycleStatus,
  type AgentWorktreeRecord,
  type AgentWorktreeRevisionInput,
  type CreateAgentWorktreeRecordInput,
  type MarkAgentWorktreeFailureInput,
  type MarkAgentWorktreeReadyInput,
} from "./agent-worktree-record.js";

export class InMemoryAgentWorktreeStore implements AgentWorktreeStorePort {
  readonly #records = new Map<string, AgentWorktreeRecord>();

  createCreating(input: CreateAgentWorktreeRecordInput): AgentWorktreeRecord {
    if (this.#records.has(input.worktreeId)) {
      throw new AgentWorktreeConflictError(`Agent worktree "${input.worktreeId}" already exists.`);
    }
    if (this.findActiveByAgentRunId(input.hallAgentRunId) !== undefined) {
      throw new AgentWorktreeConflictError(
        `Agent run "${input.hallAgentRunId}" already has an active worktree.`,
      );
    }
    const record: AgentWorktreeRecord = {
      ...input,
      status: "creating",
      revision: 0,
      readyAt: undefined,
      cleanupRequestedAt: undefined,
      cleanedAt: undefined,
      safeFailureCode: undefined,
      safeFailureSummary: undefined,
    };
    this.#records.set(input.worktreeId, record);
    return record;
  }

  get(worktreeId: string): AgentWorktreeRecord {
    const record = this.find(worktreeId);
    if (record === undefined) throw new AgentWorktreeNotFoundError(worktreeId);
    return record;
  }

  find(worktreeId: string): AgentWorktreeRecord | undefined {
    return this.#records.get(worktreeId);
  }

  findActiveByAgentRunId(hallAgentRunId: string): AgentWorktreeRecord | undefined {
    return Array.from(this.#records.values())
      .filter(
        (record) =>
          record.hallAgentRunId === hallAgentRunId && isActiveAgentWorktreeStatus(record.status),
      )
      .sort(compareRecords)[0];
  }

  list(): readonly AgentWorktreeRecord[] {
    return Array.from(this.#records.values()).sort(compareRecords);
  }

  markReady(input: MarkAgentWorktreeReadyInput): AgentWorktreeRecord {
    return this.#mutate(input.worktreeId, input.expectedRevision, "ready", () => ({
      status: "ready",
      readyAt: input.readyAt,
      safeFailureCode: undefined,
      safeFailureSummary: undefined,
    }));
  }

  markCreationFailed(input: MarkAgentWorktreeFailureInput): AgentWorktreeRecord {
    return this.#mutate(input.worktreeId, input.expectedRevision, "creation_failed", () => ({
      status: "creation_failed",
      safeFailureCode: sanitizeFailureCode(input.safeFailureCode),
      safeFailureSummary: boundSafeSummary(input.safeFailureSummary),
    }));
  }

  requestCleanup(input: AgentWorktreeRevisionInput): AgentWorktreeRecord {
    return this.#mutate(input.worktreeId, input.expectedRevision, "cleanup_pending", () => ({
      status: "cleanup_pending",
      cleanupRequestedAt: input.now,
    }));
  }

  markCleaned(input: AgentWorktreeRevisionInput): AgentWorktreeRecord {
    return this.#mutate(input.worktreeId, input.expectedRevision, "cleaned", () => ({
      status: "cleaned",
      cleanedAt: input.now,
      safeFailureCode: undefined,
      safeFailureSummary: undefined,
    }));
  }

  markCleanupFailed(input: MarkAgentWorktreeFailureInput): AgentWorktreeRecord {
    return this.#mutate(input.worktreeId, input.expectedRevision, "cleanup_failed", () => ({
      status: "cleanup_failed",
      safeFailureCode: sanitizeFailureCode(input.safeFailureCode),
      safeFailureSummary: boundSafeSummary(input.safeFailureSummary),
    }));
  }

  #mutate(
    worktreeId: string,
    expectedRevision: number,
    to: AgentWorktreeLifecycleStatus,
    buildPatch: () => Partial<AgentWorktreeRecord>,
  ): AgentWorktreeRecord {
    const current = this.get(worktreeId);
    if (current.revision !== expectedRevision) {
      throw new AgentWorktreeConflictError(`Agent worktree "${worktreeId}" revision is stale.`);
    }
    if (!isValidTransition(current.status, to)) {
      throw new AgentWorktreeInvalidTransitionError(worktreeId, current.status, to);
    }
    const updated: AgentWorktreeRecord = {
      ...current,
      ...buildPatch(),
      revision: current.revision + 1,
    };
    this.#records.set(worktreeId, updated);
    return updated;
  }
}

function compareRecords(a: AgentWorktreeRecord, b: AgentWorktreeRecord): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.worktreeId.localeCompare(b.worktreeId);
}

export function isValidTransition(
  from: AgentWorktreeLifecycleStatus,
  to: AgentWorktreeLifecycleStatus,
): boolean {
  if (from === "creating")
    return to === "ready" || to === "creation_failed" || to === "cleanup_pending";
  if (from === "ready") return to === "cleanup_pending";
  if (from === "creation_failed") return to === "cleanup_pending";
  if (from === "cleanup_pending") return to === "cleaned" || to === "cleanup_failed";
  if (from === "cleanup_failed") return to === "cleanup_pending";
  return false;
}
