import {
  parseTaskRequirements,
  parseWithSchema,
  structuredFailureSchema,
  executionTrustSchema,
  type ExecutionTrust,
  type StructuredFailure,
} from "@hall-of-wisdom/protocol";
import type { TerminalEventType } from "@hall-of-wisdom/hall-runner";
import {
  ComparisonCandidateNotFoundError,
  ComparisonCapacityReachedError,
  ComparisonNotFoundError,
  ComparisonStateConflictError,
  DuplicateComparisonError,
} from "../errors/app-error.js";
import { candidateResultEvidenceSchema as resultEvidenceSchema } from "./comparison-record.js";
import type {
  AgentComparisonRecord,
  CandidateResultEvidence,
  CandidateStatus,
  ComparisonCandidateRecord,
  ComparisonPreference,
  ComparisonStatus,
} from "./comparison-record.js";
import type { ComparisonStorePort } from "./comparison-store-port.js";
import type { HallDatabase } from "../persistence/database.js";
import { withTransaction } from "../persistence/transaction.js";
import { CorruptRecordError } from "../persistence/persistence-errors.js";
import { deriveComparisonStatus } from "./derive-comparison-status.js";

export interface SqliteComparisonStoreOptions {
  readonly db: HallDatabase;
  readonly maxComparisons: number;
}

interface ComparisonRow {
  comparison_id: string;
  source_task_id: string;
  title: string;
  description: string;
  priority: string;
  requirements_json: string | null;
  base_commit: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  prepared_at: string | null;
  cleanup_status: string;
  cleanup_error: string | null;
  prepare_failure_code: string | null;
  prepare_failure_reason: string | null;
  preference_json: string | null;
  revision: number;
}

interface CandidateRow {
  candidate_id: string;
  comparison_id: string;
  candidate_order: number;
  adapter_id: string;
  display_name: string;
  status: string;
  execution_trust: string | null;
  run_id: string | null;
  agent_id: string | null;
  created_at: string;
  prepared_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  event_count: number;
  last_sequence: number | null;
  terminal_event_type: string | null;
  failure_json: string | null;
  cancellation_requested: number;
  result_evidence_json: string | null;
  safe_failure_reason: string | null;
}

function candidateRowToRecord(row: CandidateRow): ComparisonCandidateRecord {
  try {
    const failure: StructuredFailure | undefined =
      row.failure_json !== null
        ? parseWithSchema(
            structuredFailureSchema,
            JSON.parse(row.failure_json),
            "StructuredFailure",
          )
        : undefined;
    const resultEvidence: CandidateResultEvidence | undefined =
      row.result_evidence_json !== null
        ? parseWithSchema(
            resultEvidenceSchema,
            JSON.parse(row.result_evidence_json),
            "CandidateResultEvidence",
          )
        : undefined;
    const executionTrust: ExecutionTrust | undefined =
      row.execution_trust !== null
        ? parseWithSchema(executionTrustSchema, row.execution_trust, "ExecutionTrust")
        : undefined;

    return {
      candidateId: row.candidate_id,
      adapterId: row.adapter_id,
      displayName: row.display_name,
      status: row.status as CandidateStatus,
      executionTrust,
      runId: row.run_id ?? undefined,
      agentId: row.agent_id ?? undefined,
      createdAt: row.created_at,
      preparedAt: row.prepared_at ?? undefined,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      eventCount: row.event_count,
      lastSequence: row.last_sequence ?? undefined,
      terminalEventType: (row.terminal_event_type as TerminalEventType | null) ?? undefined,
      failure,
      cancellationRequested: row.cancellation_requested !== 0,
      resultEvidence,
      safeFailureReason: row.safe_failure_reason ?? undefined,
    };
  } catch (error) {
    if (error instanceof CorruptRecordError) throw error;
    throw new CorruptRecordError(
      "comparison_candidates",
      row.candidate_id,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function comparisonRowToRecord(
  row: ComparisonRow,
  candidateRows: readonly CandidateRow[],
): AgentComparisonRecord {
  try {
    const ordered = [...candidateRows].sort((a, b) => a.candidate_order - b.candidate_order);
    const [a, b] = ordered;
    if (!a || !b || ordered.length !== 2) {
      throw new Error(`expected exactly 2 candidates, found ${String(ordered.length)}`);
    }
    const candidates: readonly [ComparisonCandidateRecord, ComparisonCandidateRecord] = [
      candidateRowToRecord(a),
      candidateRowToRecord(b),
    ];

    return {
      comparisonId: row.comparison_id,
      sourceTaskId: row.source_task_id,
      title: row.title,
      description: row.description,
      priority: row.priority as AgentComparisonRecord["priority"],
      requirements:
        row.requirements_json !== null
          ? parseTaskRequirements(JSON.parse(row.requirements_json))
          : undefined,
      baseCommit: row.base_commit ?? undefined,
      status: row.status as ComparisonStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      preparedAt: row.prepared_at ?? undefined,
      candidates,
      cleanupStatus: row.cleanup_status as AgentComparisonRecord["cleanupStatus"],
      cleanupError: row.cleanup_error ?? undefined,
      prepareFailureCode: row.prepare_failure_code ?? undefined,
      prepareFailureReason: row.prepare_failure_reason ?? undefined,
      preference:
        row.preference_json !== null
          ? (JSON.parse(row.preference_json) as ComparisonPreference)
          : undefined,
    };
  } catch (error) {
    if (error instanceof CorruptRecordError) throw error;
    throw new CorruptRecordError(
      "comparisons",
      row.comparison_id,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * SQLite-backed durable sibling of `ComparisonStore` — implements the
 * identical `ComparisonStorePort` contract, verified by the shared
 * contract-test suite. `deriveComparisonStatus` (Phase 13's extracted,
 * shared pure function) is reused verbatim rather than reimplemented, so
 * both backends can never silently drift on this specific piece of
 * business logic. Internal-only fields (source repository path, candidate
 * worktree paths) are **not** part of this class at all — those are a
 * separate, `ComparisonOrchestrator`-level concern (see
 * `comparison-internal-paths-port.ts`), exactly mirroring how the
 * in-memory `ComparisonStore` never held them either.
 */
export class SqliteComparisonStore implements ComparisonStorePort {
  readonly #db: HallDatabase;
  readonly #maxComparisons: number;

  constructor(options: SqliteComparisonStoreOptions) {
    this.#db = options.db;
    this.#maxComparisons = options.maxComparisons;
  }

  add(record: AgentComparisonRecord): void {
    const existing = this.#db
      .prepare("SELECT 1 FROM comparisons WHERE comparison_id = ?")
      .get(record.comparisonId);
    if (existing) throw new DuplicateComparisonError(record.comparisonId);

    const count = (this.#db.prepare("SELECT COUNT(*) AS c FROM comparisons").get() as { c: number })
      .c;
    if (count >= this.#maxComparisons)
      throw new ComparisonCapacityReachedError(this.#maxComparisons);

    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO comparisons (
            comparison_id, source_task_id, title, description, priority, requirements_json,
            base_commit, status, created_at, updated_at, prepared_at, cleanup_status,
            cleanup_error, prepare_failure_code, prepare_failure_reason, preference_json, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(
          record.comparisonId,
          record.sourceTaskId,
          record.title,
          record.description,
          record.priority,
          record.requirements !== undefined ? JSON.stringify(record.requirements) : null,
          record.baseCommit ?? null,
          record.status,
          record.createdAt,
          record.updatedAt,
          record.preparedAt ?? null,
          record.cleanupStatus,
          record.cleanupError ?? null,
          record.prepareFailureCode ?? null,
          record.prepareFailureReason ?? null,
          record.preference !== undefined ? JSON.stringify(record.preference) : null,
        );

      record.candidates.forEach((candidate, index) => {
        this.#insertCandidate(record.comparisonId, index, candidate);
      });
    });
  }

  get(comparisonId: string): AgentComparisonRecord {
    return this.#buildRecord(this.#mustGetComparisonRow(comparisonId));
  }

  list(): AgentComparisonRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM comparisons ORDER BY rowid ASC")
      .all() as unknown as ComparisonRow[];
    return rows.map((row) => this.#buildRecord(row));
  }

  getRevision(comparisonId: string): number {
    return this.#mustGetComparisonRow(comparisonId).revision;
  }

  claimPreparing(comparisonId: string): AgentComparisonRecord {
    const row = this.#mustGetComparisonRow(comparisonId);
    if (row.status !== "draft") {
      throw new ComparisonStateConflictError(comparisonId, row.status, "prepared");
    }
    return withTransaction(this.#db, () => {
      this.#updateComparison(comparisonId, { status: "preparing" });
      return this.#buildRecord(this.#mustGetComparisonRow(comparisonId));
    });
  }

  setReady(
    comparisonId: string,
    input: {
      readonly baseCommit: string;
      readonly candidates: readonly {
        readonly candidateId: string;
        readonly executionTrust: ExecutionTrust;
      }[];
    },
  ): AgentComparisonRecord {
    const row = this.#mustGetComparisonRow(comparisonId);
    if (row.status !== "preparing") {
      throw new ComparisonStateConflictError(comparisonId, row.status, "marked ready");
    }
    const now = new Date().toISOString();
    return withTransaction(this.#db, () => {
      this.#updateComparison(comparisonId, {
        baseCommit: input.baseCommit,
        status: "ready",
        preparedAt: now,
      });
      for (const candidateInput of input.candidates) {
        this.#mustGetCandidateRow(comparisonId, candidateInput.candidateId);
        this.#db
          .prepare(
            "UPDATE comparison_candidates SET status = 'prepared', execution_trust = ?, prepared_at = ? WHERE candidate_id = ?",
          )
          .run(candidateInput.executionTrust, now, candidateInput.candidateId);
      }
      return this.#buildRecord(this.#mustGetComparisonRow(comparisonId));
    });
  }

  setPrepareFailed(
    comparisonId: string,
    failedCandidateId: string | undefined,
    code: string,
    safeReason: string,
  ): AgentComparisonRecord {
    const row = this.#mustGetComparisonRow(comparisonId);
    if (row.status !== "preparing") {
      throw new ComparisonStateConflictError(comparisonId, row.status, "marked failed");
    }
    return withTransaction(this.#db, () => {
      this.#updateComparison(comparisonId, {
        status: "failed",
        prepareFailureCode: code,
        prepareFailureReason: safeReason,
      });
      if (failedCandidateId !== undefined) {
        this.#mustGetCandidateRow(comparisonId, failedCandidateId);
        this.#db
          .prepare(
            "UPDATE comparison_candidates SET safe_failure_reason = ? WHERE candidate_id = ?",
          )
          .run(safeReason, failedCandidateId);
      }
      return this.#buildRecord(this.#mustGetComparisonRow(comparisonId));
    });
  }

  claimCandidateStart(
    comparisonId: string,
    candidateId: string,
    runId: string,
    agentId: string,
  ): AgentComparisonRecord {
    const row = this.#mustGetComparisonRow(comparisonId);
    if (row.status !== "ready" && row.status !== "running") {
      throw new ComparisonStateConflictError(comparisonId, row.status, "started");
    }
    const candidate = this.#mustGetCandidateRow(comparisonId, candidateId);
    if (candidate.status !== "prepared") {
      throw new ComparisonStateConflictError(comparisonId, candidate.status, "started");
    }
    const candidates = this.#listCandidateRows(comparisonId);
    const anotherRunning = candidates.some(
      (c) => c.candidate_id !== candidateId && c.status === "running",
    );
    if (anotherRunning) {
      throw new ComparisonStateConflictError(
        comparisonId,
        "running",
        "started (comparisons run candidates sequentially, one at a time)",
      );
    }
    const now = new Date().toISOString();
    return withTransaction(this.#db, () => {
      this.#db
        .prepare(
          "UPDATE comparison_candidates SET status = 'running', run_id = ?, agent_id = ?, started_at = ? WHERE candidate_id = ?",
        )
        .run(runId, agentId, now, candidateId);
      this.#updateComparison(comparisonId, { status: "running" });
      return this.#buildRecord(this.#mustGetComparisonRow(comparisonId));
    });
  }

  clearCandidateStart(comparisonId: string, candidateId: string): void {
    this.#mustGetCandidateRow(comparisonId, candidateId);
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          "UPDATE comparison_candidates SET status = 'prepared', run_id = NULL, agent_id = NULL, started_at = NULL WHERE candidate_id = ?",
        )
        .run(candidateId);
      this.#recomputeAndUpdateStatus(comparisonId);
    });
  }

  recordCandidateEventMeta(comparisonId: string, candidateId: string, sequence: number): void {
    this.#mustGetCandidateRow(comparisonId, candidateId);
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          "UPDATE comparison_candidates SET event_count = event_count + 1, last_sequence = ? WHERE candidate_id = ?",
        )
        .run(sequence, candidateId);
      this.#bumpRevisionOnly(comparisonId);
    });
  }

  setCandidateCompleted(
    comparisonId: string,
    candidateId: string,
    input: {
      readonly completedAt: string;
      readonly terminalEventType: TerminalEventType;
      readonly failure?: StructuredFailure | undefined;
      readonly resultEvidence?: CandidateResultEvidence | undefined;
    },
  ): AgentComparisonRecord {
    this.#mustGetCandidateRow(comparisonId, candidateId);
    const status: CandidateStatus =
      input.terminalEventType === "run.completed"
        ? "completed"
        : input.terminalEventType === "run.cancelled"
          ? "cancelled"
          : "failed";
    return withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `UPDATE comparison_candidates SET completed_at = ?, terminal_event_type = ?, failure_json = ?,
             result_evidence_json = ?, status = ? WHERE candidate_id = ?`,
        )
        .run(
          input.completedAt,
          input.terminalEventType,
          input.failure !== undefined ? JSON.stringify(input.failure) : null,
          input.resultEvidence !== undefined ? JSON.stringify(input.resultEvidence) : null,
          status,
          candidateId,
        );
      this.#recomputeAndUpdateStatus(comparisonId);
      return this.#buildRecord(this.#mustGetComparisonRow(comparisonId));
    });
  }

  setCandidateCancellationRequested(
    comparisonId: string,
    candidateId: string,
  ): { alreadyRequested: boolean } {
    const candidate = this.#mustGetCandidateRow(comparisonId, candidateId);
    if (candidate.status !== "running") {
      throw new ComparisonStateConflictError(comparisonId, candidate.status, "cancelled");
    }
    if (candidate.cancellation_requested !== 0) {
      return { alreadyRequested: true };
    }
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          "UPDATE comparison_candidates SET cancellation_requested = 1 WHERE candidate_id = ?",
        )
        .run(candidateId);
      this.#bumpRevisionOnly(comparisonId);
    });
    return { alreadyRequested: false };
  }

  cancelUnstartedCandidate(comparisonId: string, candidateId: string): AgentComparisonRecord {
    const candidate = this.#mustGetCandidateRow(comparisonId, candidateId);
    if (candidate.status !== "pending" && candidate.status !== "prepared") {
      throw new ComparisonStateConflictError(comparisonId, candidate.status, "cancelled");
    }
    const now = new Date().toISOString();
    return withTransaction(this.#db, () => {
      this.#db
        .prepare(
          "UPDATE comparison_candidates SET status = 'cancelled', completed_at = ? WHERE candidate_id = ?",
        )
        .run(now, candidateId);
      this.#recomputeAndUpdateStatus(comparisonId);
      return this.#buildRecord(this.#mustGetComparisonRow(comparisonId));
    });
  }

  claimCleanup(comparisonId: string): AgentComparisonRecord {
    const row = this.#mustGetComparisonRow(comparisonId);
    if (row.status === "preparing") {
      throw new ComparisonStateConflictError(comparisonId, row.status, "cleaned up");
    }
    if (row.cleanup_status === "in_progress") {
      throw new ComparisonStateConflictError(
        comparisonId,
        row.status,
        "cleaned up (already in progress)",
      );
    }
    if (row.cleanup_status === "completed") {
      throw new ComparisonStateConflictError(
        comparisonId,
        row.status,
        "cleaned up (already completed)",
      );
    }
    const nextStatus =
      row.status === "draft" || row.status === "ready" || row.status === "running"
        ? "cancelled"
        : (row.status as ComparisonStatus);
    return withTransaction(this.#db, () => {
      this.#updateComparison(comparisonId, {
        cleanupStatus: "in_progress",
        cleanupError: null,
        status: nextStatus,
      });
      return this.#buildRecord(this.#mustGetComparisonRow(comparisonId));
    });
  }

  markCleaning(comparisonId: string): void {
    this.#mustGetComparisonRow(comparisonId);
    withTransaction(this.#db, () => {
      this.#updateComparison(comparisonId, { status: "cleaning" });
    });
  }

  setCleanupCompleted(comparisonId: string): AgentComparisonRecord {
    this.#mustGetComparisonRow(comparisonId);
    return withTransaction(this.#db, () => {
      this.#updateComparison(comparisonId, {
        cleanupStatus: "completed",
        cleanupError: null,
        status: "cleaned",
      });
      return this.#buildRecord(this.#mustGetComparisonRow(comparisonId));
    });
  }

  setCleanupFailed(comparisonId: string, safeError: string): AgentComparisonRecord {
    this.#mustGetComparisonRow(comparisonId);
    return withTransaction(this.#db, () => {
      this.#updateComparison(comparisonId, { cleanupStatus: "failed", cleanupError: safeError });
      return this.#buildRecord(this.#mustGetComparisonRow(comparisonId));
    });
  }

  setPreference(
    comparisonId: string,
    preference: ComparisonPreference | undefined,
  ): AgentComparisonRecord {
    this.#mustGetComparisonRow(comparisonId);
    return withTransaction(this.#db, () => {
      this.#updateComparison(comparisonId, {
        preferenceJson: preference !== undefined ? JSON.stringify(preference) : null,
      });
      return this.#buildRecord(this.#mustGetComparisonRow(comparisonId));
    });
  }

  // ---- internal helpers ----

  #insertCandidate(
    comparisonId: string,
    order: number,
    candidate: ComparisonCandidateRecord,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO comparison_candidates (
          candidate_id, comparison_id, candidate_order, adapter_id, display_name, status,
          execution_trust, run_id, agent_id, created_at, prepared_at, started_at, completed_at,
          event_count, last_sequence, terminal_event_type, failure_json, cancellation_requested,
          result_evidence_json, safe_failure_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.candidateId,
        comparisonId,
        order,
        candidate.adapterId,
        candidate.displayName,
        candidate.status,
        candidate.executionTrust ?? null,
        candidate.runId ?? null,
        candidate.agentId ?? null,
        candidate.createdAt,
        candidate.preparedAt ?? null,
        candidate.startedAt ?? null,
        candidate.completedAt ?? null,
        candidate.eventCount,
        candidate.lastSequence ?? null,
        candidate.terminalEventType ?? null,
        candidate.failure !== undefined ? JSON.stringify(candidate.failure) : null,
        candidate.cancellationRequested ? 1 : 0,
        candidate.resultEvidence !== undefined ? JSON.stringify(candidate.resultEvidence) : null,
        candidate.safeFailureReason ?? null,
      );
  }

  #recomputeAndUpdateStatus(comparisonId: string): void {
    const row = this.#mustGetComparisonRow(comparisonId);
    const candidates = this.#listCandidateRows(comparisonId);
    const ordered = [...candidates].sort((a, b) => a.candidate_order - b.candidate_order);
    const [a, b] = ordered;
    if (!a || !b)
      throw new CorruptRecordError("comparison_candidates", comparisonId, "missing candidate rows");
    const nextStatus = deriveComparisonStatus(row.status as ComparisonStatus, [
      a.status as CandidateStatus,
      b.status as CandidateStatus,
    ]);
    this.#updateComparison(comparisonId, { status: nextStatus });
  }

  #updateComparison(
    comparisonId: string,
    fields: {
      status?: string;
      baseCommit?: string;
      preparedAt?: string;
      cleanupStatus?: string;
      cleanupError?: string | null;
      prepareFailureCode?: string;
      prepareFailureReason?: string;
      preferenceJson?: string | null;
    },
  ): void {
    const now = new Date().toISOString();
    const setClauses: string[] = ["updated_at = ?", "revision = revision + 1"];
    const values: unknown[] = [now];
    for (const [key, value] of Object.entries(fields)) {
      const column = {
        status: "status",
        baseCommit: "base_commit",
        preparedAt: "prepared_at",
        cleanupStatus: "cleanup_status",
        cleanupError: "cleanup_error",
        prepareFailureCode: "prepare_failure_code",
        prepareFailureReason: "prepare_failure_reason",
        preferenceJson: "preference_json",
      }[key];
      if (column === undefined) continue;
      setClauses.push(`${column} = ?`);
      values.push(value);
    }
    values.push(comparisonId);
    this.#db
      .prepare(`UPDATE comparisons SET ${setClauses.join(", ")} WHERE comparison_id = ?`)
      .run(...(values as []));
  }

  #bumpRevisionOnly(comparisonId: string): void {
    this.#db
      .prepare("UPDATE comparisons SET revision = revision + 1 WHERE comparison_id = ?")
      .run(comparisonId);
  }

  #buildRecord(row: ComparisonRow): AgentComparisonRecord {
    const candidateRows = this.#listCandidateRows(row.comparison_id);
    return comparisonRowToRecord(row, candidateRows);
  }

  #listCandidateRows(comparisonId: string): CandidateRow[] {
    return this.#db
      .prepare(
        "SELECT * FROM comparison_candidates WHERE comparison_id = ? ORDER BY candidate_order ASC",
      )
      .all(comparisonId) as unknown as CandidateRow[];
  }

  #mustGetComparisonRow(comparisonId: string): ComparisonRow {
    const row = this.#db
      .prepare("SELECT * FROM comparisons WHERE comparison_id = ?")
      .get(comparisonId) as ComparisonRow | undefined;
    if (!row) throw new ComparisonNotFoundError(comparisonId);
    return row;
  }

  #mustGetCandidateRow(comparisonId: string, candidateId: string): CandidateRow {
    const row = this.#db
      .prepare("SELECT * FROM comparison_candidates WHERE candidate_id = ? AND comparison_id = ?")
      .get(candidateId, comparisonId) as CandidateRow | undefined;
    if (!row) throw new ComparisonCandidateNotFoundError(comparisonId, candidateId);
    return row;
  }
}
