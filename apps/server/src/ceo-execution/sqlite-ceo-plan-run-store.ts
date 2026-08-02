import {
  ceoPlanExecutionEventSchema,
  ceoPlanExecutionPolicySchema,
  type CeoPlanExecutionCircuitState,
  type CeoPlanExecutionCircuitTripReason,
  type CeoPlanExecutionEvent,
  type CeoPlanExecutionInterventionType,
  type CeoPlanExecutionMode,
  type CeoPlanExecutionTriggerReason,
  type CeoPlanRun,
  type CeoPlanRunRecoveryClassification,
  type CeoPlanRunStatus,
  type CeoPlanStepAttempt,
  type CeoPlanStepAttemptStatus,
  type CeoPlanStepExecution,
  type CeoPlanStepExecutionStatus,
  type CeoPlanStepReadinessReason,
} from "@hall-of-wisdom/protocol";
import type { HallDatabase } from "../persistence/database.js";
import { withTransaction } from "../persistence/transaction.js";
import { CorruptRecordError } from "../persistence/persistence-errors.js";
import {
  CeoPlanRunAlreadyActiveError,
  CeoPlanRunNotFoundError,
  CeoPlanRunStateConflictError,
  CeoPlanStepAttemptConflictError,
} from "../errors/app-error.js";
import type {
  AppendExecutionEventInput,
  CeoPlanRunStorePort,
  CircuitStateSnapshot,
  ClaimAttemptInput,
  ClaimAttemptResult,
  ConfigureRunInput,
  CreateAttemptInput,
  InterventionRecord,
  RecordCircuitFailureInput,
  RecordInterventionInput,
  RecoveryPauseInput,
  RunLifecycleInput,
  TripCircuitInput,
  UpdateAttemptInput,
  UpdateStepExecutionInput,
} from "./ceo-plan-run-store-port.js";

export interface SqliteCeoPlanRunStoreOptions {
  readonly db: HallDatabase;
}

interface RunRow {
  run_id: string;
  plan_id: string;
  plan_version: number;
  status: string;
  execution_mode: string;
  policy_snapshot_json: string;
  created_at: string;
  started_at: string | null;
  paused_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  active_generation: number;
  last_scheduler_decision_at: string | null;
  recovery_classification: string;
}

interface StepExecutionRow {
  run_id: string;
  plan_step_id: string;
  child_task_id: string;
  status: string;
  attempt_count: number;
  active_attempt_id: string | null;
  last_failure_code: string | null;
  next_eligible_at: string | null;
  dependency_summary_json: string;
  readiness_reason: string;
  started_at: string | null;
  completed_at: string | null;
}

interface AttemptRow {
  attempt_id: string;
  run_id: string;
  plan_step_id: string;
  child_task_id: string;
  attempt_number: number;
  status: string;
  trigger_reason: string;
  scheduler_signal_id: string;
  task_run_id: string | null;
  safe_failure_code: string | null;
  safe_failure_summary: string | null;
  created_at: string;
  claimed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  lease_generation: number;
}

interface CircuitRow {
  run_id: string;
  state: string;
  trip_reason: string | null;
  consecutive_failures: number;
  consecutive_same_code_failures: number;
  last_failure_code: string | null;
  no_progress_attempts: number;
}

function runRowToRun(row: RunRow): CeoPlanRun {
  let policySnapshot: unknown;
  try {
    policySnapshot = JSON.parse(row.policy_snapshot_json);
  } catch {
    throw new CorruptRecordError("ceo_plan_runs", row.run_id, "invalid policy JSON");
  }
  const parsedPolicy = ceoPlanExecutionPolicySchema.safeParse(policySnapshot);
  if (!parsedPolicy.success) {
    throw new CorruptRecordError("ceo_plan_runs", row.run_id, "policy failed schema validation");
  }
  return {
    id: row.run_id,
    planId: row.plan_id,
    planVersion: row.plan_version,
    status: row.status as CeoPlanRunStatus,
    executionMode: row.execution_mode as CeoPlanExecutionMode,
    policySnapshot: parsedPolicy.data,
    createdAt: row.created_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.paused_at !== null ? { pausedAt: row.paused_at } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    ...(row.failed_at !== null ? { failedAt: row.failed_at } : {}),
    ...(row.cancelled_at !== null ? { cancelledAt: row.cancelled_at } : {}),
    activeGeneration: row.active_generation,
    ...(row.last_scheduler_decision_at !== null
      ? { lastSchedulerDecisionAt: row.last_scheduler_decision_at }
      : {}),
    recoveryClassification: row.recovery_classification as CeoPlanRunRecoveryClassification,
  };
}

function stepRowToStep(row: StepExecutionRow): CeoPlanStepExecution {
  let dependencySummary: unknown;
  try {
    dependencySummary = JSON.parse(row.dependency_summary_json);
  } catch {
    throw new CorruptRecordError(
      "ceo_plan_step_executions",
      `${row.run_id}/${row.plan_step_id}`,
      "invalid dependency summary JSON",
    );
  }
  return {
    planRunId: row.run_id,
    planStepId: row.plan_step_id,
    childTaskId: row.child_task_id,
    status: row.status as CeoPlanStepExecutionStatus,
    attemptCount: row.attempt_count,
    ...(row.active_attempt_id !== null ? { activeAttemptId: row.active_attempt_id } : {}),
    ...(row.last_failure_code !== null ? { lastFailureCode: row.last_failure_code } : {}),
    ...(row.next_eligible_at !== null ? { nextEligibleAt: row.next_eligible_at } : {}),
    dependencySummary: dependencySummary as CeoPlanStepExecution["dependencySummary"],
    readinessReason: row.readiness_reason as CeoPlanStepReadinessReason,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  };
}

function attemptRowToAttempt(row: AttemptRow): CeoPlanStepAttempt {
  return {
    id: row.attempt_id,
    planRunId: row.run_id,
    planStepId: row.plan_step_id,
    childTaskId: row.child_task_id,
    attemptNumber: row.attempt_number,
    status: row.status as CeoPlanStepAttemptStatus,
    triggerReason: row.trigger_reason as CeoPlanExecutionTriggerReason,
    schedulerSignalId: row.scheduler_signal_id,
    ...(row.task_run_id !== null ? { taskRunId: row.task_run_id } : {}),
    ...(row.safe_failure_code !== null ? { safeFailureCode: row.safe_failure_code } : {}),
    ...(row.safe_failure_summary !== null ? { safeFailureSummary: row.safe_failure_summary } : {}),
    createdAt: row.created_at,
    ...(row.claimed_at !== null ? { claimedAt: row.claimed_at } : {}),
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    leaseGeneration: row.lease_generation,
  };
}

const ATTEMPT_TERMINAL = ["completed", "failed", "cancelled", "abandoned"];
const RUN_TERMINAL = ["completed", "failed", "cancelled"];

/**
 * Durable-mode `CeoPlanRunStorePort` implementation —
 * `InMemoryCeoPlanRunStore`'s behavioral twin, run against the same
 * contract tests. Every mutating method goes through `withTransaction`
 * (the Phase 13.2 ownership fence), reentrant exactly like
 * `SqliteCeoPlanStore`, so a caller spanning this store and another one
 * (never the case in Phase 15 — the scheduler's atomic claim never spans
 * `TaskStore`, per the architecture doc) would compose correctly too.
 */
export class SqliteCeoPlanRunStore implements CeoPlanRunStorePort {
  readonly #db: HallDatabase;

  constructor(options: SqliteCeoPlanRunStoreOptions) {
    this.#db = options.db;
  }

  #getRunRow(runId: string): RunRow {
    const row = this.#db.prepare("SELECT * FROM ceo_plan_runs WHERE run_id = ?").get(runId);
    if (!row) throw new CeoPlanRunNotFoundError(runId);
    return row as unknown as RunRow;
  }

  #requireStatus(row: RunRow, allowed: readonly CeoPlanRunStatus[], action: string): void {
    if (!allowed.includes(row.status as CeoPlanRunStatus)) {
      throw new CeoPlanRunStateConflictError(row.run_id, row.status, action);
    }
  }

  configureRun(input: ConfigureRunInput): CeoPlanRun {
    return withTransaction(this.#db, () => {
      const existingActive = this.#db
        .prepare(
          `SELECT run_id FROM ceo_plan_runs WHERE plan_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
        )
        .get(input.planId);
      if (existingActive) throw new CeoPlanRunAlreadyActiveError(input.planId);

      this.#db
        .prepare(
          `INSERT INTO ceo_plan_runs (
            run_id, plan_id, plan_version, status, execution_mode, policy_snapshot_json,
            created_at, active_generation, recovery_classification
          ) VALUES (?, ?, ?, 'configured', ?, ?, ?, 0, 'none')`,
        )
        .run(
          input.runId,
          input.planId,
          input.planVersion,
          input.executionMode,
          JSON.stringify(input.policy),
          input.now,
        );
      this.#db
        .prepare(
          `INSERT INTO ceo_plan_execution_circuit_state (run_id, state) VALUES (?, 'closed')`,
        )
        .run(input.runId);
      for (const step of input.steps) {
        const waiting = step.dependencyStepIds.length > 0;
        this.#db
          .prepare(
            `INSERT INTO ceo_plan_step_executions (
              run_id, plan_step_id, child_task_id, status, attempt_count,
              dependency_summary_json, readiness_reason
            ) VALUES (?, ?, ?, ?, 0, ?, ?)`,
          )
          .run(
            input.runId,
            step.stepId,
            step.childTaskId,
            waiting ? "waiting_for_dependencies" : "ready",
            JSON.stringify({
              totalDependencies: step.dependencyStepIds.length,
              completedDependencies: 0,
              failedDependencies: 0,
              cancelledDependencies: 0,
            }),
            waiting ? "waiting_for_dependencies" : "run_not_active",
          );
      }
      return runRowToRun(this.#getRunRow(input.runId));
    });
  }

  #transitionRun(
    input: RunLifecycleInput,
    allowedFrom: readonly CeoPlanRunStatus[],
    action: string,
    columns: string,
    values: readonly (string | number | null)[],
  ): CeoPlanRun {
    return withTransaction(this.#db, () => {
      const row = this.#getRunRow(input.runId);
      this.#requireStatus(row, allowedFrom, action);
      this.#db
        .prepare(`UPDATE ceo_plan_runs SET ${columns} WHERE run_id = ?`)
        .run(...values, input.runId);
      return runRowToRun(this.#getRunRow(input.runId));
    });
  }

  startRun(input: RunLifecycleInput): CeoPlanRun {
    return this.#transitionRun(
      input,
      ["configured"],
      "started",
      "status = 'running', started_at = ?",
      [input.now],
    );
  }

  pauseRun(input: RunLifecycleInput): CeoPlanRun {
    return this.#transitionRun(
      input,
      ["running", "awaiting_intervention"],
      "paused",
      "status = 'paused', paused_at = ?",
      [input.now],
    );
  }

  resumeRun(input: RunLifecycleInput): CeoPlanRun {
    return withTransaction(this.#db, () => {
      const run = this.#transitionRun(
        input,
        ["paused", "awaiting_intervention"],
        "resumed",
        "status = 'running', paused_at = NULL, active_generation = active_generation + 1",
        [],
      );
      // Resume is the one explicit operator action that clears a
      // tripped circuit — nothing automatic ever calls `resetCircuit`
      // (grep confirms this was its only production call site's
      // absence before this fix: a resumed run would otherwise stay
      // permanently blocked at `circuit.state === "open"` even after
      // the operator explicitly resumed it). A no-op when the circuit
      // was already closed.
      this.resetCircuit(input.runId);
      return run;
    });
  }

  cancelRun(input: RunLifecycleInput): CeoPlanRun {
    return this.#transitionRun(
      input,
      ["configured", "running", "paused", "awaiting_intervention"],
      "cancelled",
      "status = 'cancelled', cancelled_at = ?, active_generation = active_generation + 1",
      [input.now],
    );
  }

  recoveryPauseRun(input: RecoveryPauseInput): CeoPlanRun {
    return this.#transitionRun(
      input,
      ["running", "paused"],
      "recovery-paused",
      "status = 'awaiting_intervention', active_generation = active_generation + 1, recovery_classification = ?",
      [input.classification],
    );
  }

  completeRun(input: RunLifecycleInput): CeoPlanRun {
    return this.#transitionRun(
      input,
      ["running"],
      "completed",
      "status = 'completed', completed_at = ?",
      [input.now],
    );
  }

  failRun(input: RunLifecycleInput): CeoPlanRun {
    return this.#transitionRun(
      input,
      ["running", "awaiting_intervention"],
      "failed",
      "status = 'failed', failed_at = ?",
      [input.now],
    );
  }

  recordSchedulerDecision(runId: string, now: string): void {
    withTransaction(this.#db, () => {
      this.#db
        .prepare("UPDATE ceo_plan_runs SET last_scheduler_decision_at = ? WHERE run_id = ?")
        .run(now, runId);
    });
  }

  getRun(runId: string): CeoPlanRun {
    return runRowToRun(this.#getRunRow(runId));
  }

  findRun(runId: string): CeoPlanRun | undefined {
    const row = this.#db.prepare("SELECT * FROM ceo_plan_runs WHERE run_id = ?").get(runId);
    return row === undefined ? undefined : runRowToRun(row as unknown as RunRow);
  }

  getActiveRunForPlan(planId: string): CeoPlanRun | undefined {
    const row = this.#db
      .prepare(
        `SELECT * FROM ceo_plan_runs WHERE plan_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
      )
      .get(planId);
    return row === undefined ? undefined : runRowToRun(row as unknown as RunRow);
  }

  listRuns(): readonly CeoPlanRun[] {
    const rows = this.#db.prepare("SELECT * FROM ceo_plan_runs").all() as unknown as RunRow[];
    return rows.map(runRowToRun);
  }

  getActiveGeneration(runId: string): number {
    return this.#getRunRow(runId).active_generation;
  }

  upsertStepExecution(input: UpdateStepExecutionInput): CeoPlanStepExecution {
    return withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `UPDATE ceo_plan_step_executions SET
            status = ?, readiness_reason = ?, dependency_summary_json = ?,
            last_failure_code = COALESCE(?, last_failure_code),
            next_eligible_at = ?,
            active_attempt_id = COALESCE(?, active_attempt_id),
            attempt_count = attempt_count + ?,
            started_at = COALESCE(started_at, ?),
            completed_at = COALESCE(?, completed_at)
          WHERE run_id = ? AND plan_step_id = ?`,
        )
        .run(
          input.status,
          input.readinessReason,
          JSON.stringify(input.dependencySummary),
          input.lastFailureCode ?? null,
          input.nextEligibleAt ?? null,
          input.activeAttemptId ?? null,
          input.status === "claimed" ? 1 : 0,
          input.startedAt ?? null,
          input.completedAt ?? null,
          input.runId,
          input.planStepId,
        );
      return this.getStepExecution(input.runId, input.planStepId);
    });
  }

  getStepExecution(runId: string, planStepId: string): CeoPlanStepExecution {
    const row = this.#db
      .prepare("SELECT * FROM ceo_plan_step_executions WHERE run_id = ? AND plan_step_id = ?")
      .get(runId, planStepId);
    if (!row) throw new CeoPlanRunNotFoundError(`${runId}/${planStepId}`);
    return stepRowToStep(row as unknown as StepExecutionRow);
  }

  listStepExecutions(runId: string): readonly CeoPlanStepExecution[] {
    const rows = this.#db
      .prepare("SELECT * FROM ceo_plan_step_executions WHERE run_id = ?")
      .all(runId) as unknown as StepExecutionRow[];
    return rows.map(stepRowToStep);
  }

  listStepExecutionsByChildTask(childTaskId: string): readonly CeoPlanStepExecution[] {
    const rows = this.#db
      .prepare("SELECT * FROM ceo_plan_step_executions WHERE child_task_id = ?")
      .all(childTaskId) as unknown as StepExecutionRow[];
    return rows.map(stepRowToStep);
  }

  createAttempt(input: CreateAttemptInput): CeoPlanStepAttempt {
    return withTransaction(this.#db, () => {
      const active = this.getActiveAttempt(input.runId, input.planStepId);
      if (active) throw new CeoPlanStepAttemptConflictError(input.runId, input.planStepId);
      this.#db
        .prepare(
          `INSERT INTO ceo_plan_step_attempts (
            attempt_id, run_id, plan_step_id, child_task_id, attempt_number, status,
            trigger_reason, scheduler_signal_id, created_at, claimed_at, lease_generation, owner_token
          ) VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.attemptId,
          input.runId,
          input.planStepId,
          input.childTaskId,
          input.attemptNumber,
          input.triggerReason,
          input.schedulerSignalId,
          input.now,
          input.now,
          input.leaseGeneration,
          input.ownerToken,
        );
      return this.getAttempt(input.attemptId);
    });
  }

  /**
   * Wraps `createAttempt` + `upsertStepExecution` in one outer
   * transaction. `withTransaction` is reentrant (nested calls become
   * `SAVEPOINT`s), so if the step-execution write throws, the attempt
   * insert's savepoint rolls back too — no attempt row can persist without
   * its matching "claimed" step projection.
   */
  claimAttempt(input: ClaimAttemptInput): ClaimAttemptResult {
    return withTransaction(this.#db, () => {
      const attempt = this.createAttempt(input);
      const stepExecution = this.upsertStepExecution({
        runId: input.runId,
        planStepId: input.planStepId,
        status: "claimed",
        readinessReason: input.readinessReason,
        dependencySummary: input.dependencySummary,
        activeAttemptId: attempt.id,
      });
      return { attempt, stepExecution };
    });
  }

  updateAttempt(input: UpdateAttemptInput): CeoPlanStepAttempt {
    return withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `UPDATE ceo_plan_step_attempts SET
            status = ?,
            task_run_id = COALESCE(?, task_run_id),
            safe_failure_code = COALESCE(?, safe_failure_code),
            safe_failure_summary = COALESCE(?, safe_failure_summary),
            claimed_at = COALESCE(?, claimed_at),
            started_at = COALESCE(?, started_at),
            finished_at = COALESCE(?, finished_at)
          WHERE attempt_id = ?`,
        )
        .run(
          input.status,
          input.taskRunId ?? null,
          input.safeFailureCode ?? null,
          input.safeFailureSummary ?? null,
          input.claimedAt ?? null,
          input.startedAt ?? null,
          input.finishedAt ?? null,
          input.attemptId,
        );
      return this.getAttempt(input.attemptId);
    });
  }

  getAttempt(attemptId: string): CeoPlanStepAttempt {
    const row = this.#db
      .prepare("SELECT * FROM ceo_plan_step_attempts WHERE attempt_id = ?")
      .get(attemptId);
    if (!row) throw new CeoPlanRunNotFoundError(attemptId);
    return attemptRowToAttempt(row as unknown as AttemptRow);
  }

  listAttempts(runId: string, planStepId?: string): readonly CeoPlanStepAttempt[] {
    const rows = (planStepId === undefined
      ? this.#db.prepare("SELECT * FROM ceo_plan_step_attempts WHERE run_id = ?").all(runId)
      : this.#db
          .prepare("SELECT * FROM ceo_plan_step_attempts WHERE run_id = ? AND plan_step_id = ?")
          .all(runId, planStepId)) as unknown as AttemptRow[];
    return rows.map(attemptRowToAttempt);
  }

  getActiveAttempt(runId: string, planStepId: string): CeoPlanStepAttempt | undefined {
    const placeholders = ATTEMPT_TERMINAL.map(() => "?").join(", ");
    const row = this.#db
      .prepare(
        `SELECT * FROM ceo_plan_step_attempts
         WHERE run_id = ? AND plan_step_id = ? AND status NOT IN (${placeholders})`,
      )
      .get(runId, planStepId, ...ATTEMPT_TERMINAL);
    return row === undefined ? undefined : attemptRowToAttempt(row as unknown as AttemptRow);
  }

  getCircuitState(runId: string): CircuitStateSnapshot {
    const row = this.#db
      .prepare("SELECT * FROM ceo_plan_execution_circuit_state WHERE run_id = ?")
      .get(runId) as unknown as CircuitRow | undefined;
    if (!row) throw new CeoPlanRunNotFoundError(runId);
    return {
      state: row.state as CeoPlanExecutionCircuitState,
      consecutiveFailures: row.consecutive_failures,
      consecutiveSameCodeFailures: row.consecutive_same_code_failures,
      noProgressAttempts: row.no_progress_attempts,
      lastFailureCode: row.last_failure_code ?? undefined,
      tripReason: (row.trip_reason ?? undefined) as CeoPlanExecutionCircuitTripReason | undefined,
    };
  }

  recordCircuitOutcome(input: RecordCircuitFailureInput): void {
    withTransaction(this.#db, () => {
      const current = this.getCircuitState(input.runId);
      const sameCode = current.lastFailureCode === input.failureCode;
      this.#db
        .prepare(
          `UPDATE ceo_plan_execution_circuit_state SET
            consecutive_failures = consecutive_failures + 1,
            consecutive_same_code_failures = ?,
            last_failure_code = ?,
            no_progress_attempts = ?
          WHERE run_id = ?`,
        )
        .run(
          sameCode ? current.consecutiveSameCodeFailures + 1 : 1,
          input.failureCode,
          input.isNoProgress ? current.noProgressAttempts + 1 : 0,
          input.runId,
        );
    });
  }

  recordCircuitProgress(runId: string): void {
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `UPDATE ceo_plan_execution_circuit_state SET
            consecutive_failures = 0, consecutive_same_code_failures = 0, no_progress_attempts = 0
          WHERE run_id = ?`,
        )
        .run(runId);
    });
  }

  tripCircuit(input: TripCircuitInput): void {
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `UPDATE ceo_plan_execution_circuit_state SET state = 'open', trip_reason = ?, tripped_at = ?, tripped_step_id = ?
           WHERE run_id = ?`,
        )
        .run(input.reason, input.now, input.stepId ?? null, input.runId);
    });
  }

  resetCircuit(runId: string): void {
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `UPDATE ceo_plan_execution_circuit_state SET
            state = 'closed', trip_reason = NULL, consecutive_failures = 0,
            consecutive_same_code_failures = 0, no_progress_attempts = 0,
            tripped_at = NULL, tripped_step_id = NULL
          WHERE run_id = ?`,
        )
        .run(runId);
    });
  }

  appendEvent(input: AppendExecutionEventInput): CeoPlanExecutionEvent {
    return withTransaction(this.#db, () => {
      const nextSeq = this.#db
        .prepare(
          "SELECT COALESCE(MAX(sequence), -1) + 1 AS n FROM ceo_plan_execution_events WHERE run_id = ?",
        )
        .get(input.runId) as { n: number };
      this.#db
        .prepare(
          `INSERT INTO ceo_plan_execution_events (run_id, sequence, event_type, actor, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          nextSeq.n,
          input.type,
          input.actor,
          JSON.stringify(input.payload),
          input.now,
        );
      return {
        planRunId: input.runId,
        sequence: nextSeq.n,
        type: input.type,
        actor: input.actor,
        payload: input.payload,
        timestamp: input.now,
      };
    });
  }

  listEvents(runId: string, afterSequence?: number): readonly CeoPlanExecutionEvent[] {
    const rows = (afterSequence === undefined
      ? this.#db
          .prepare("SELECT * FROM ceo_plan_execution_events WHERE run_id = ? ORDER BY sequence")
          .all(runId)
      : this.#db
          .prepare(
            "SELECT * FROM ceo_plan_execution_events WHERE run_id = ? AND sequence > ? ORDER BY sequence",
          )
          .all(runId, afterSequence)) as unknown as {
      run_id: string;
      sequence: number;
      event_type: string;
      actor: string;
      payload_json: string;
      created_at: string;
    }[];
    return rows.map((row) => {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        throw new CorruptRecordError(
          "ceo_plan_execution_events",
          `${row.run_id}:${String(row.sequence)}`,
          "invalid JSON",
        );
      }
      const candidate = {
        planRunId: row.run_id,
        sequence: row.sequence,
        type: row.event_type,
        actor: row.actor,
        payload,
        timestamp: row.created_at,
      };
      const parsed = ceoPlanExecutionEventSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new CorruptRecordError(
          "ceo_plan_execution_events",
          `${row.run_id}:${String(row.sequence)}`,
          "event row failed schema validation",
        );
      }
      return parsed.data;
    });
  }

  recordIntervention(input: RecordInterventionInput): void {
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO ceo_plan_execution_interventions (intervention_id, run_id, type, actor, note, created_at)
           VALUES (?, ?, ?, 'human:local-operator', ?, ?)`,
        )
        .run(input.interventionId, input.runId, input.type, input.note ?? null, input.now);
    });
  }

  listInterventions(runId: string): readonly InterventionRecord[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM ceo_plan_execution_interventions WHERE run_id = ? ORDER BY created_at",
      )
      .all(runId) as unknown as {
      intervention_id: string;
      type: string;
      note: string | null;
      created_at: string;
    }[];
    return rows.map((row) => ({
      id: row.intervention_id,
      type: row.type as CeoPlanExecutionInterventionType,
      note: row.note ?? undefined,
      createdAt: row.created_at,
    }));
  }

  claimBoardAuditOnce(runId: string, dedupKey: string, now: string): boolean {
    return withTransaction(this.#db, () => {
      const existing = this.#db
        .prepare("SELECT 1 FROM ceo_plan_execution_board_audit WHERE run_id = ? AND dedup_key = ?")
        .get(runId, dedupKey);
      if (existing) return false;
      this.#db
        .prepare(
          "INSERT INTO ceo_plan_execution_board_audit (run_id, dedup_key, created_at) VALUES (?, ?, ?)",
        )
        .run(runId, dedupKey, now);
      return true;
    });
  }
}

// Re-exported for readability at call sites that only need the terminal sets.
export const CEO_PLAN_RUN_TERMINAL_STATUS_LIST = RUN_TERMINAL;
export const CEO_PLAN_STEP_ATTEMPT_TERMINAL_STATUS_LIST = ATTEMPT_TERMINAL;
