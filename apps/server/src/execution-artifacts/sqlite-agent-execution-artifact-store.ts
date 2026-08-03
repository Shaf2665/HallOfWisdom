import type { HallDatabase } from "../persistence/database.js";
import { withTransaction } from "../persistence/transaction.js";
import {
  AgentExecutionArtifactConflictError,
  AgentExecutionArtifactCorruptRecordError,
  AgentExecutionArtifactNotFoundError,
  AgentExecutionArtifactRunNotFoundError,
} from "./agent-execution-artifact-errors.js";
import {
  cloneArtifact,
  createAgentExecutionArtifactRecord,
  parseStoredAgentExecutionArtifactRecord,
  type AgentExecutionArtifactRecord,
  type CreateAgentExecutionArtifactInput,
} from "./agent-execution-artifact-record.js";
import type { AgentExecutionArtifactStorePort } from "./agent-execution-artifact-store-port.js";

export interface SqliteAgentExecutionArtifactStoreOptions {
  readonly db: HallDatabase;
}

interface AgentExecutionArtifactRow {
  readonly artifact_id: string;
  readonly hall_task_id: string;
  readonly hall_agent_run_id: string;
  readonly adapter_id: string;
  readonly worktree_id: string | null;
  readonly provider_execution_ref: string | null;
  readonly terminal_outcome: string;
  readonly terminal_reason_code: string | null;
  readonly safe_terminal_summary: string | null;
  readonly started_at: string;
  readonly finished_at: string;
  readonly duration_ms: number;
  readonly exit_code: number | null;
  readonly base_commit: string | null;
  readonly final_commit: string | null;
  readonly changed_files_json: string;
  readonly changed_files_truncated: number;
  readonly diff_files_changed: number;
  readonly diff_insertions: number;
  readonly diff_deletions: number;
  readonly final_summary: string | null;
  readonly final_summary_truncated: number;
  readonly created_at: string;
}

interface ExistsRow {
  readonly present: 1;
}

const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

export class SqliteAgentExecutionArtifactStore implements AgentExecutionArtifactStorePort {
  readonly #db: HallDatabase;

  constructor(options: SqliteAgentExecutionArtifactStoreOptions) {
    this.#db = options.db;
  }

  create(input: CreateAgentExecutionArtifactInput): AgentExecutionArtifactRecord {
    const record = createAgentExecutionArtifactRecord(input);
    return withTransaction(this.#db, () => {
      try {
        this.#db
          .prepare(
            `INSERT INTO agent_execution_artifacts (
              artifact_id,
              hall_task_id,
              hall_agent_run_id,
              adapter_id,
              worktree_id,
              provider_execution_ref,
              terminal_outcome,
              terminal_reason_code,
              safe_terminal_summary,
              started_at,
              finished_at,
              duration_ms,
              exit_code,
              base_commit,
              final_commit,
              changed_files_json,
              changed_files_truncated,
              diff_files_changed,
              diff_insertions,
              diff_deletions,
              final_summary,
              final_summary_truncated,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            record.artifactId,
            record.hallTaskId,
            record.hallAgentRunId,
            record.adapterId,
            record.worktreeId ?? null,
            record.providerExecutionRef ?? null,
            record.outcome,
            record.terminalReasonCode ?? null,
            record.safeTerminalSummary ?? null,
            record.startedAt,
            record.finishedAt,
            record.durationMs,
            record.exitCode ?? null,
            record.baseCommit ?? null,
            record.finalCommit ?? null,
            JSON.stringify(record.changedFiles),
            record.changedFilesTruncated ? 1 : 0,
            record.diffSummary.filesChanged,
            record.diffSummary.insertions,
            record.diffSummary.deletions,
            record.finalSummary ?? null,
            record.finalSummaryTruncated ? 1 : 0,
            record.createdAt,
          );
      } catch (error) {
        const conflict = classifyCreateConflict(this.#db, record, error);
        if (conflict !== undefined) throw conflict;
        throw error;
      }
      return this.get(record.artifactId);
    });
  }

  get(artifactId: string): AgentExecutionArtifactRecord {
    const record = this.find(artifactId);
    if (record === undefined) throw new AgentExecutionArtifactNotFoundError(artifactId);
    return record;
  }

  find(artifactId: string): AgentExecutionArtifactRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM agent_execution_artifacts WHERE artifact_id = ?")
      .get(artifactId) as unknown as AgentExecutionArtifactRow | undefined;
    return row === undefined ? undefined : rowToRecord(row);
  }

  getByHallAgentRunId(hallAgentRunId: string): AgentExecutionArtifactRecord {
    const record = this.findByHallAgentRunId(hallAgentRunId);
    if (record === undefined) throw new AgentExecutionArtifactRunNotFoundError(hallAgentRunId);
    return record;
  }

  findByHallAgentRunId(hallAgentRunId: string): AgentExecutionArtifactRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM agent_execution_artifacts WHERE hall_agent_run_id = ?")
      .get(hallAgentRunId) as unknown as AgentExecutionArtifactRow | undefined;
    return row === undefined ? undefined : rowToRecord(row);
  }

  list(): readonly AgentExecutionArtifactRecord[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM agent_execution_artifacts ORDER BY created_at COLLATE BINARY ASC, artifact_id COLLATE BINARY ASC",
      )
      .all() as unknown as AgentExecutionArtifactRow[];
    return rows.map(rowToRecord);
  }
}

function classifyCreateConflict(
  db: HallDatabase,
  record: AgentExecutionArtifactRecord,
  error: unknown,
): AgentExecutionArtifactConflictError | undefined {
  if (!isDuplicateConstraintError(error)) return undefined;

  try {
    const existingArtifact = db
      .prepare("SELECT 1 AS present FROM agent_execution_artifacts WHERE artifact_id = ?")
      .get(record.artifactId) as ExistsRow | undefined;
    if (existingArtifact !== undefined) {
      return new AgentExecutionArtifactConflictError(
        "Agent execution artifact creation conflicts with an existing artifact ID.",
      );
    }

    const existingRun = db
      .prepare("SELECT 1 AS present FROM agent_execution_artifacts WHERE hall_agent_run_id = ?")
      .get(record.hallAgentRunId) as ExistsRow | undefined;
    if (existingRun !== undefined) {
      return new AgentExecutionArtifactConflictError(
        "Agent execution artifact creation conflicts with an existing Hall agent run artifact.",
      );
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function isDuplicateConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const maybeSqliteError = error as { readonly code?: unknown; readonly errcode?: unknown };
  return (
    maybeSqliteError.code === "ERR_SQLITE_ERROR" &&
    (maybeSqliteError.errcode === SQLITE_CONSTRAINT_PRIMARYKEY ||
      maybeSqliteError.errcode === SQLITE_CONSTRAINT_UNIQUE)
  );
}

function rowToRecord(row: AgentExecutionArtifactRow): AgentExecutionArtifactRecord {
  let changedFiles: unknown;
  try {
    changedFiles = JSON.parse(row.changed_files_json) as unknown;
  } catch {
    throw new AgentExecutionArtifactCorruptRecordError(
      row.artifact_id,
      "changedFiles JSON is malformed",
    );
  }

  return cloneArtifact(
    parseStoredAgentExecutionArtifactRecord({
      artifactId: row.artifact_id,
      hallTaskId: row.hall_task_id,
      hallAgentRunId: row.hall_agent_run_id,
      adapterId: row.adapter_id,
      worktreeId: row.worktree_id ?? undefined,
      providerExecutionRef: row.provider_execution_ref ?? undefined,
      outcome: row.terminal_outcome,
      terminalReasonCode: row.terminal_reason_code ?? undefined,
      safeTerminalSummary: row.safe_terminal_summary ?? undefined,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      exitCode: row.exit_code ?? undefined,
      baseCommit: row.base_commit ?? undefined,
      finalCommit: row.final_commit ?? undefined,
      changedFiles,
      changedFilesTruncated: sqliteBoolean(
        row.changed_files_truncated,
        row.artifact_id,
        "changed_files_truncated",
      ),
      diffSummary: {
        filesChanged: row.diff_files_changed,
        insertions: row.diff_insertions,
        deletions: row.diff_deletions,
      },
      finalSummary: row.final_summary ?? undefined,
      finalSummaryTruncated: sqliteBoolean(
        row.final_summary_truncated,
        row.artifact_id,
        "final_summary_truncated",
      ),
      createdAt: row.created_at,
    }),
  );
}

function sqliteBoolean(value: number, artifactId: string, column: string): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  throw new AgentExecutionArtifactCorruptRecordError(artifactId, `${column} must be 0 or 1`);
}
