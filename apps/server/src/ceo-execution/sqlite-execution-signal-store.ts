import { randomUUID } from "node:crypto";
import {
  ceoPlanExecutionSignalSchema,
  MAX_SIGNAL_REASONS,
  type CeoPlanExecutionSignal,
  type CeoPlanExecutionSignalPriority,
} from "@hall-of-wisdom/protocol";
import type { HallDatabase } from "../persistence/database.js";
import { withTransaction } from "../persistence/transaction.js";
import { CorruptRecordError } from "../persistence/persistence-errors.js";
import type {
  ClaimedSignal,
  ClaimNextSignalInput,
  EnqueueSignalInput,
  EnqueueSignalResult,
  ExecutionSignalStorePort,
} from "./execution-signal-store-port.js";

export interface SqliteExecutionSignalStoreOptions {
  readonly db: HallDatabase;
}

interface SignalRow {
  signal_id: string;
  run_id: string;
  plan_step_id: string | null;
  generation: number;
  reasons_json: string;
  priority: string;
  available_at: string;
  created_at: string;
  updated_at: string;
  state: string;
  attempt_count: number;
  claim_lease: string | null;
  claim_expires_at: string | null;
}

function rowToSignal(row: SignalRow): CeoPlanExecutionSignal {
  let reasons: unknown;
  try {
    reasons = JSON.parse(row.reasons_json);
  } catch {
    throw new CorruptRecordError(
      "ceo_plan_execution_signals",
      row.signal_id,
      "invalid reasons JSON",
    );
  }
  const candidate = {
    id: row.signal_id,
    planRunId: row.run_id,
    ...(row.plan_step_id !== null ? { planStepId: row.plan_step_id } : {}),
    generation: row.generation,
    reasons,
    priority: row.priority,
    availableAt: row.available_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    state: row.state,
    attemptCount: row.attempt_count,
  };
  // Never trust previously-written JSON/columns as-is — re-validate the
  // whole public projection through its own strict schema on every read,
  // exactly like `sqlite-ceo-plan-run-store.ts` does for its policy and
  // dependency-summary JSON columns.
  const parsed = ceoPlanExecutionSignalSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CorruptRecordError(
      "ceo_plan_execution_signals",
      row.signal_id,
      "signal row failed schema validation",
    );
  }
  return parsed.data;
}

/**
 * Durable-mode `ExecutionSignalStorePort` implementation —
 * `InMemoryExecutionSignalStore`'s behavioral twin. Coalescing uses the
 * same "check-then-write inside `withTransaction`'s `BEGIN IMMEDIATE`
 * exclusive lock" discipline every other Phase 13/14/15 SQLite store uses
 * (e.g. `SqliteCeoPlanRunStore.createAttempt`'s active-attempt check) —
 * migration 5's partial unique index on `(run_id, COALESCE(plan_step_id,
 * ''), generation) WHERE state = 'pending'` is kept as a database-level
 * defense-in-depth guarantee (see `migrations.ceo-execution.test.ts`),
 * not the primary coalescing mechanism.
 */
export class SqliteExecutionSignalStore implements ExecutionSignalStorePort {
  readonly #db: HallDatabase;

  constructor(options: SqliteExecutionSignalStoreOptions) {
    this.#db = options.db;
  }

  enqueue(input: EnqueueSignalInput): EnqueueSignalResult {
    return withTransaction(this.#db, () => {
      const existingRow = this.#db
        .prepare(
          `SELECT * FROM ceo_plan_execution_signals
           WHERE run_id = ? AND COALESCE(plan_step_id, '') = ? AND generation = ? AND state = 'pending'`,
        )
        .get(input.planRunId, input.planStepId ?? "", input.generation) as unknown as
        SignalRow | undefined;

      if (existingRow) {
        const existing = rowToSignal(existingRow);
        const reasons = existing.reasons.includes(input.reason)
          ? existing.reasons
          : existing.reasons.length < MAX_SIGNAL_REASONS
            ? [...existing.reasons, input.reason]
            : existing.reasons;
        const priority: CeoPlanExecutionSignalPriority =
          existing.priority === "high" ? "high" : input.priority;
        const availableAt =
          input.availableAt < existing.availableAt ? input.availableAt : existing.availableAt;
        this.#db
          .prepare(
            `UPDATE ceo_plan_execution_signals SET
              reasons_json = ?, priority = ?, available_at = ?, updated_at = ?
             WHERE signal_id = ?`,
          )
          .run(JSON.stringify(reasons), priority, availableAt, input.now, existing.id);
        return {
          signal: { ...existing, reasons, priority, availableAt, updatedAt: input.now },
          created: false,
        };
      }

      this.#db
        .prepare(
          `INSERT INTO ceo_plan_execution_signals (
            signal_id, run_id, plan_step_id, generation, reasons_json, priority,
            available_at, created_at, updated_at, state, attempt_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)`,
        )
        .run(
          input.signalId,
          input.planRunId,
          input.planStepId ?? null,
          input.generation,
          JSON.stringify([input.reason]),
          input.priority,
          input.availableAt,
          input.now,
          input.now,
        );
      const row = this.#db
        .prepare("SELECT * FROM ceo_plan_execution_signals WHERE signal_id = ?")
        .get(input.signalId) as unknown as SignalRow;
      return { signal: rowToSignal(row), created: true };
    });
  }

  claimNext(input: ClaimNextSignalInput): ClaimedSignal | undefined {
    return withTransaction(this.#db, () => {
      this.#releaseExpiredClaimsLocked(input.now);
      if (input.eligibleRunIds.length === 0) return undefined;
      const placeholders = input.eligibleRunIds.map(() => "?").join(", ");
      const row = this.#db
        .prepare(
          `SELECT * FROM ceo_plan_execution_signals
           WHERE state = 'pending' AND run_id IN (${placeholders}) AND available_at <= ?
           ORDER BY (priority = 'high') DESC, created_at ASC
           LIMIT 1`,
        )
        .get(...input.eligibleRunIds, input.now) as unknown as SignalRow | undefined;
      if (!row) return undefined;
      const claimLease = randomUUID();
      const claimExpiresAt = new Date(
        new Date(input.now).getTime() + input.leaseSeconds * 1000,
      ).toISOString();
      this.#db
        .prepare(
          `UPDATE ceo_plan_execution_signals SET
            state = 'claimed', attempt_count = attempt_count + 1, updated_at = ?,
            claim_lease = ?, claim_owner_token = ?, claim_expires_at = ?
           WHERE signal_id = ?`,
        )
        .run(input.now, claimLease, input.ownerToken, claimExpiresAt, row.signal_id);
      const updated = this.#db
        .prepare("SELECT * FROM ceo_plan_execution_signals WHERE signal_id = ?")
        .get(row.signal_id) as unknown as SignalRow;
      return { signal: rowToSignal(updated), claimLease };
    });
  }

  markProcessed(signalId: string, claimLease: string, now: string): void {
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `UPDATE ceo_plan_execution_signals SET
            state = 'processed', updated_at = ?, claim_lease = NULL, claim_owner_token = NULL, claim_expires_at = NULL
           WHERE signal_id = ? AND claim_lease = ?`,
        )
        .run(now, signalId, claimLease);
    });
  }

  releaseClaim(signalId: string, claimLease: string, now: string): void {
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `UPDATE ceo_plan_execution_signals SET
            state = 'pending', updated_at = ?, claim_lease = NULL, claim_owner_token = NULL, claim_expires_at = NULL
           WHERE signal_id = ? AND claim_lease = ?`,
        )
        .run(now, signalId, claimLease);
    });
  }

  #releaseExpiredClaimsLocked(now: string): number {
    const result = this.#db
      .prepare(
        `UPDATE ceo_plan_execution_signals SET
          state = 'pending', updated_at = ?, claim_lease = NULL, claim_owner_token = NULL, claim_expires_at = NULL
         WHERE state = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?`,
      )
      .run(now, now);
    return Number(result.changes);
  }

  releaseExpiredClaims(now: string): number {
    return withTransaction(this.#db, () => this.#releaseExpiredClaimsLocked(now));
  }

  cancelSignalsForRun(planRunId: string, now: string): number {
    return withTransaction(this.#db, () => {
      const result = this.#db
        .prepare(
          `UPDATE ceo_plan_execution_signals SET
            state = 'cancelled', updated_at = ?, claim_lease = NULL, claim_owner_token = NULL, claim_expires_at = NULL
           WHERE run_id = ? AND state IN ('pending', 'claimed')`,
        )
        .run(now, planRunId);
      return Number(result.changes);
    });
  }

  cancelSignalsForStep(planRunId: string, planStepId: string, now: string): number {
    return withTransaction(this.#db, () => {
      const result = this.#db
        .prepare(
          `UPDATE ceo_plan_execution_signals SET
            state = 'cancelled', updated_at = ?, claim_lease = NULL, claim_owner_token = NULL, claim_expires_at = NULL
           WHERE run_id = ? AND plan_step_id = ? AND state IN ('pending', 'claimed')`,
        )
        .run(now, planRunId, planStepId);
      return Number(result.changes);
    });
  }

  getSignal(signalId: string): CeoPlanExecutionSignal | undefined {
    const row = this.#db
      .prepare("SELECT * FROM ceo_plan_execution_signals WHERE signal_id = ?")
      .get(signalId) as unknown as SignalRow | undefined;
    return row === undefined ? undefined : rowToSignal(row);
  }

  listSignalsForRun(planRunId: string): readonly CeoPlanExecutionSignal[] {
    const rows = this.#db
      .prepare("SELECT * FROM ceo_plan_execution_signals WHERE run_id = ? ORDER BY created_at")
      .all(planRunId) as unknown as SignalRow[];
    return rows.map(rowToSignal);
  }

  countByState(): { pending: number; claimed: number } {
    const pending = this.#db
      .prepare("SELECT COUNT(*) AS n FROM ceo_plan_execution_signals WHERE state = 'pending'")
      .get() as { n: number };
    const claimed = this.#db
      .prepare("SELECT COUNT(*) AS n FROM ceo_plan_execution_signals WHERE state = 'claimed'")
      .get() as { n: number };
    return { pending: pending.n, claimed: claimed.n };
  }

  nextPendingAvailableAt(): string | undefined {
    // Served by `idx_ceo_plan_execution_signals_claimable`
    // (`state, available_at, priority`) — a bounded index seek, never a
    // scan proportional to signal history.
    const row = this.#db
      .prepare(
        "SELECT MIN(available_at) AS earliest FROM ceo_plan_execution_signals WHERE state = 'pending'",
      )
      .get() as { earliest: string | null };
    return row.earliest ?? undefined;
  }
}
