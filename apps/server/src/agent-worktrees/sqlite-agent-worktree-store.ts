import type { HallDatabase } from "../persistence/database.js";
import { CorruptRecordError } from "../persistence/persistence-errors.js";
import { withTransaction } from "../persistence/transaction.js";
import {
  AgentWorktreeConflictError,
  AgentWorktreeCorruptRecordError,
  AgentWorktreeInvalidTransitionError,
  AgentWorktreeNotFoundError,
  boundSafeSummary,
  sanitizeFailureCode,
} from "./agent-worktree-errors.js";
import type { AgentWorktreeStorePort } from "./agent-worktree-store-port.js";
import {
  isActiveAgentWorktreeStatus,
  isAgentWorktreeLifecycleStatus,
  type AgentWorktreeLifecycleStatus,
  type AgentWorktreeRecord,
  type AgentWorktreeRevisionInput,
  type CreateAgentWorktreeRecordInput,
  type MarkAgentWorktreeFailureInput,
  type MarkAgentWorktreeReadyInput,
} from "./agent-worktree-record.js";
import { isValidTransition } from "./in-memory-agent-worktree-store.js";

interface AgentWorktreeRow {
  readonly worktree_id: string;
  readonly hall_task_id: string;
  readonly hall_agent_run_id: string;
  readonly adapter_id: string | null;
  readonly agent_id: string | null;
  readonly source_repository_root: string;
  readonly source_working_directory_relative_path: string;
  readonly base_commit: string;
  readonly worktree_path: string;
  readonly status: string;
  readonly created_at: string;
  readonly revision: number;
  readonly ready_at: string | null;
  readonly cleanup_requested_at: string | null;
  readonly cleaned_at: string | null;
  readonly safe_failure_code: string | null;
  readonly safe_failure_summary: string | null;
}

export interface SqliteAgentWorktreeStoreOptions {
  readonly db: HallDatabase;
}

export class SqliteAgentWorktreeStore implements AgentWorktreeStorePort {
  readonly #db: HallDatabase;

  constructor(options: SqliteAgentWorktreeStoreOptions) {
    this.#db = options.db;
  }

  createCreating(input: CreateAgentWorktreeRecordInput): AgentWorktreeRecord {
    return withTransaction(this.#db, () => {
      try {
        this.#db
          .prepare(
            `INSERT INTO agent_worktrees (
              worktree_id,
              hall_task_id,
              hall_agent_run_id,
              adapter_id,
              agent_id,
              source_repository_root,
              source_working_directory_relative_path,
              base_commit,
              worktree_path,
              status,
              created_at,
              revision
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, 0)`,
          )
          .run(
            input.worktreeId,
            input.hallTaskId,
            input.hallAgentRunId,
            input.adapterId ?? null,
            input.agentId ?? null,
            input.canonicalSourceRepositoryRoot,
            input.sourceWorkingDirectoryRelativePath,
            input.baseCommit,
            input.canonicalWorktreePath,
            input.createdAt,
          );
      } catch {
        throw new AgentWorktreeConflictError(
          "Agent worktree creation conflicts with an existing worktree record.",
        );
      }
      return this.get(input.worktreeId);
    });
  }

  get(worktreeId: string): AgentWorktreeRecord {
    const record = this.find(worktreeId);
    if (record === undefined) throw new AgentWorktreeNotFoundError(worktreeId);
    return record;
  }

  find(worktreeId: string): AgentWorktreeRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM agent_worktrees WHERE worktree_id = ?")
      .get(worktreeId) as unknown as AgentWorktreeRow | undefined;
    return row === undefined ? undefined : rowToRecord(row);
  }

  findActiveByAgentRunId(hallAgentRunId: string): AgentWorktreeRecord | undefined {
    const rows = this.#db
      .prepare(
        `SELECT * FROM agent_worktrees
         WHERE hall_agent_run_id = ?
         ORDER BY created_at ASC, worktree_id ASC`,
      )
      .all(hallAgentRunId) as unknown as AgentWorktreeRow[];
    return rows.map(rowToRecord).find((record) => isActiveAgentWorktreeStatus(record.status));
  }

  list(): readonly AgentWorktreeRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM agent_worktrees ORDER BY created_at ASC, worktree_id ASC")
      .all() as unknown as AgentWorktreeRow[];
    return rows.map(rowToRecord);
  }

  markReady(input: MarkAgentWorktreeReadyInput): AgentWorktreeRecord {
    return this.#mutate(input.worktreeId, input.expectedRevision, "ready", {
      readyAt: input.readyAt,
      safeFailureCode: undefined,
      safeFailureSummary: undefined,
    });
  }

  markCreationFailed(input: MarkAgentWorktreeFailureInput): AgentWorktreeRecord {
    return this.#mutate(input.worktreeId, input.expectedRevision, "creation_failed", {
      safeFailureCode: sanitizeFailureCode(input.safeFailureCode),
      safeFailureSummary: boundSafeSummary(input.safeFailureSummary),
    });
  }

  requestCleanup(input: AgentWorktreeRevisionInput): AgentWorktreeRecord {
    return this.#mutate(input.worktreeId, input.expectedRevision, "cleanup_pending", {
      cleanupRequestedAt: input.now,
    });
  }

  markCleaned(input: AgentWorktreeRevisionInput): AgentWorktreeRecord {
    return this.#mutate(input.worktreeId, input.expectedRevision, "cleaned", {
      cleanedAt: input.now,
      safeFailureCode: undefined,
      safeFailureSummary: undefined,
    });
  }

  markCleanupFailed(input: MarkAgentWorktreeFailureInput): AgentWorktreeRecord {
    return this.#mutate(input.worktreeId, input.expectedRevision, "cleanup_failed", {
      safeFailureCode: sanitizeFailureCode(input.safeFailureCode),
      safeFailureSummary: boundSafeSummary(input.safeFailureSummary),
    });
  }

  #mutate(
    worktreeId: string,
    expectedRevision: number,
    to: AgentWorktreeLifecycleStatus,
    patch: {
      readonly readyAt?: string | undefined;
      readonly cleanupRequestedAt?: string | undefined;
      readonly cleanedAt?: string | undefined;
      readonly safeFailureCode?: string | undefined;
      readonly safeFailureSummary?: string | undefined;
    },
  ): AgentWorktreeRecord {
    return withTransaction(this.#db, () => {
      const current = this.get(worktreeId);
      if (current.revision !== expectedRevision) {
        throw new AgentWorktreeConflictError(`Agent worktree "${worktreeId}" revision is stale.`);
      }
      if (!isValidTransition(current.status, to)) {
        throw new AgentWorktreeInvalidTransitionError(worktreeId, current.status, to);
      }

      const result = this.#db
        .prepare(
          `UPDATE agent_worktrees SET
            status = ?,
            ready_at = COALESCE(?, ready_at),
            cleanup_requested_at = COALESCE(?, cleanup_requested_at),
            cleaned_at = COALESCE(?, cleaned_at),
            safe_failure_code = ?,
            safe_failure_summary = ?,
            revision = revision + 1
           WHERE worktree_id = ? AND revision = ?`,
        )
        .run(
          to,
          patch.readyAt ?? null,
          patch.cleanupRequestedAt ?? null,
          patch.cleanedAt ?? null,
          patch.safeFailureCode ?? null,
          patch.safeFailureSummary ?? null,
          worktreeId,
          expectedRevision,
        );
      if (Number(result.changes) !== 1) {
        throw new AgentWorktreeConflictError(`Agent worktree "${worktreeId}" revision is stale.`);
      }
      return this.get(worktreeId);
    });
  }
}

function rowToRecord(row: AgentWorktreeRow): AgentWorktreeRecord {
  if (!isAgentWorktreeLifecycleStatus(row.status)) {
    throw new AgentWorktreeCorruptRecordError(row.worktree_id);
  }
  if (row.revision < 0 || !Number.isInteger(row.revision)) {
    throw new CorruptRecordError(
      "agent_worktree",
      row.worktree_id,
      "revision must be non-negative",
    );
  }
  return {
    worktreeId: row.worktree_id,
    hallTaskId: row.hall_task_id,
    hallAgentRunId: row.hall_agent_run_id,
    adapterId: row.adapter_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    canonicalSourceRepositoryRoot: row.source_repository_root,
    sourceWorkingDirectoryRelativePath: row.source_working_directory_relative_path,
    baseCommit: row.base_commit,
    canonicalWorktreePath: row.worktree_path,
    status: row.status,
    createdAt: row.created_at,
    revision: row.revision,
    readyAt: row.ready_at ?? undefined,
    cleanupRequestedAt: row.cleanup_requested_at ?? undefined,
    cleanedAt: row.cleaned_at ?? undefined,
    safeFailureCode: row.safe_failure_code ?? undefined,
    safeFailureSummary: row.safe_failure_summary ?? undefined,
  };
}
