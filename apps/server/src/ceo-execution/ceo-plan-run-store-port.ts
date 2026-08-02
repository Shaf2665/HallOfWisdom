import type {
  CeoPlanExecutionActor,
  CeoPlanExecutionCircuitState,
  CeoPlanExecutionCircuitTripReason,
  CeoPlanExecutionEvent,
  CeoPlanExecutionEventType,
  CeoPlanExecutionInterventionType,
  CeoPlanExecutionMode,
  CeoPlanExecutionPolicy,
  CeoPlanExecutionTriggerReason,
  CeoPlanRun,
  CeoPlanRunRecoveryClassification,
  CeoPlanStepAttempt,
  CeoPlanStepAttemptStatus,
  CeoPlanStepDependencySummary,
  CeoPlanStepExecution,
  CeoPlanStepExecutionStatus,
  CeoPlanStepReadinessReason,
} from "@hall-of-wisdom/protocol";

/**
 * Everything the Phase 15 scheduler, recovery sequence, and REST routes
 * need from a plan-execution-run store — the execution-runtime analogue
 * of `CeoPlanStorePort` (Phase 14). Bundles run/step-execution/attempt/
 * circuit-breaker/intervention/event persistence into one port, mirroring
 * how `CeoPlanStorePort` itself bundles plan/version/approval/delegation/
 * events: everything here is scoped 1:1 to a single execution run and
 * mutated together, so one store (and one pair of in-memory/SQLite
 * implementations) is the right unit, not five. The durable execution
 * *signal queue* is deliberately a separate store
 * (`ExecutionSignalStorePort`) — it has genuinely distinct claim/coalesce
 * lifecycle semantics and much higher churn.
 */

export interface ConfigureRunStepInput {
  readonly stepId: string;
  readonly childTaskId: string;
  readonly dependencyStepIds: readonly string[];
}

export interface ConfigureRunInput {
  readonly runId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly executionMode: CeoPlanExecutionMode;
  readonly policy: CeoPlanExecutionPolicy;
  readonly now: string;
  readonly steps: readonly ConfigureRunStepInput[];
}

export interface RunLifecycleInput {
  readonly runId: string;
  readonly now: string;
}

export interface RecoveryPauseInput extends RunLifecycleInput {
  readonly classification: CeoPlanRunRecoveryClassification;
}

export interface UpdateStepExecutionInput {
  readonly runId: string;
  readonly planStepId: string;
  readonly status: CeoPlanStepExecutionStatus;
  readonly readinessReason: CeoPlanStepReadinessReason;
  readonly dependencySummary: CeoPlanStepDependencySummary;
  readonly lastFailureCode?: string | undefined;
  readonly nextEligibleAt?: string | undefined;
  readonly activeAttemptId?: string | undefined;
  readonly startedAt?: string | undefined;
  readonly completedAt?: string | undefined;
}

export interface CreateAttemptInput {
  readonly attemptId: string;
  readonly runId: string;
  readonly planStepId: string;
  readonly childTaskId: string;
  readonly attemptNumber: number;
  readonly triggerReason: CeoPlanExecutionTriggerReason;
  readonly schedulerSignalId: string;
  readonly leaseGeneration: number;
  readonly ownerToken: string;
  readonly now: string;
}

export interface UpdateAttemptInput {
  readonly attemptId: string;
  readonly status: CeoPlanStepAttemptStatus;
  readonly now: string;
  readonly taskRunId?: string | undefined;
  readonly safeFailureCode?: string | undefined;
  readonly safeFailureSummary?: string | undefined;
  readonly claimedAt?: string | undefined;
  readonly startedAt?: string | undefined;
  readonly finishedAt?: string | undefined;
}

export interface CircuitStateSnapshot {
  readonly state: CeoPlanExecutionCircuitState;
  readonly consecutiveFailures: number;
  readonly consecutiveSameCodeFailures: number;
  readonly noProgressAttempts: number;
  readonly lastFailureCode: string | undefined;
  readonly tripReason: CeoPlanExecutionCircuitTripReason | undefined;
}

export interface RecordCircuitFailureInput {
  readonly runId: string;
  readonly failureCode: string;
  readonly isNoProgress: boolean;
}

export interface TripCircuitInput {
  readonly runId: string;
  readonly reason: CeoPlanExecutionCircuitTripReason;
  readonly stepId: string | undefined;
  readonly now: string;
}

export interface AppendExecutionEventInput {
  readonly runId: string;
  readonly type: CeoPlanExecutionEventType;
  readonly actor: CeoPlanExecutionActor;
  readonly payload: Record<string, string | number | boolean | null>;
  readonly now: string;
}

export interface RecordInterventionInput {
  readonly interventionId: string;
  readonly runId: string;
  readonly type: CeoPlanExecutionInterventionType;
  readonly note: string | undefined;
  readonly now: string;
}

export interface InterventionRecord {
  readonly id: string;
  readonly type: CeoPlanExecutionInterventionType;
  readonly note: string | undefined;
  readonly createdAt: string;
}

export interface ClaimAttemptInput extends CreateAttemptInput {
  readonly readinessReason: CeoPlanStepReadinessReason;
  readonly dependencySummary: CeoPlanStepDependencySummary;
}

export interface ClaimAttemptResult {
  readonly attempt: CeoPlanStepAttempt;
  readonly stepExecution: CeoPlanStepExecution;
}

export interface ClaimAbandonedRetryIntentInput {
  readonly intentId: string;
  readonly runId: string;
  readonly planStepId: string;
  readonly childTaskId: string;
  readonly abandonedAttemptId: string;
  readonly now: string;
}

export interface AbandonedRetryIntentRecord {
  readonly id: string;
  readonly runId: string;
  readonly planStepId: string;
  readonly childTaskId: string;
  readonly abandonedAttemptId: string;
  readonly requestedAt: string;
  readonly replacementAttemptId: string | undefined;
  readonly replacementClaimedAt: string | undefined;
}

export interface ClaimAbandonedRetryIntentResult {
  readonly intent: AbandonedRetryIntentRecord;
  readonly created: boolean;
}

export interface LinkAbandonedRetryIntentReplacementInput {
  readonly intentId: string;
  readonly replacementAttemptId: string;
  readonly now: string;
}

export interface CeoPlanRunStorePort {
  configureRun(input: ConfigureRunInput): CeoPlanRun;
  startRun(input: RunLifecycleInput): CeoPlanRun;
  pauseRun(input: RunLifecycleInput): CeoPlanRun;
  resumeRun(input: RunLifecycleInput): CeoPlanRun;
  cancelRun(input: RunLifecycleInput): CeoPlanRun;
  recoveryPauseRun(input: RecoveryPauseInput): CeoPlanRun;
  completeRun(input: RunLifecycleInput): CeoPlanRun;
  failRun(input: RunLifecycleInput): CeoPlanRun;
  recordSchedulerDecision(runId: string, now: string): void;

  getRun(runId: string): CeoPlanRun;
  findRun(runId: string): CeoPlanRun | undefined;
  getActiveRunForPlan(planId: string): CeoPlanRun | undefined;
  listRuns(): readonly CeoPlanRun[];
  /** Private — used only by scheduler-internal generation checks; identical value to the public run's own `activeGeneration`. */
  getActiveGeneration(runId: string): number;

  upsertStepExecution(input: UpdateStepExecutionInput): CeoPlanStepExecution;
  getStepExecution(runId: string, planStepId: string): CeoPlanStepExecution;
  listStepExecutions(runId: string): readonly CeoPlanStepExecution[];
  listStepExecutionsByChildTask(childTaskId: string): readonly CeoPlanStepExecution[];

  /** Throws `CeoPlanStepAttemptConflictError` if the step already has a non-terminal attempt (database-enforced via a partial unique index in SQLite mode; application-checked in ephemeral mode). */
  createAttempt(input: CreateAttemptInput): CeoPlanStepAttempt;
  /**
   * Creates the attempt AND marks the step execution "claimed" as one
   * operation — closes the gap a two-call `createAttempt` +
   * `upsertStepExecution` sequence would leave, where a crash or thrown
   * error between the two writes could persist an attempt row with no
   * corresponding step-projection update. Throws
   * `CeoPlanStepAttemptConflictError` under the same conditions as
   * `createAttempt`; on that error, no step execution row is touched.
   *
   * In SQLite mode this is genuinely atomic: both writes happen inside
   * one outer `withTransaction`, and `upsertStepExecution` throwing rolls
   * back `createAttempt`'s own `SAVEPOINT` too. This method itself has no
   * internal rollback — it is two plain sequential calls with no
   * transaction of its own. In ephemeral mode the guarantee instead comes
   * from its one real production call site
   * (`CeoPlanExecutionScheduler#tryAdvanceStep`), which always wraps this
   * call in `SchedulerDeps.runAtomicUnit` — for ephemeral mode a genuine
   * snapshot/restore coordinator (`createEphemeralAtomicUnit`) that
   * snapshots `planRunStore` before the call and restores it wholesale on
   * any throw, including one from `upsertStepExecution` itself. Same
   * all-or-nothing guarantee as SQLite, different mechanism (snapshot/
   * restore vs. `SAVEPOINT`) — proven by the failure-injection test in
   * `ceo-plan-execution-atomicity.contract.ts` ("attempt creation: an
   * injected step-execution failure during claimAttempt leaves NO
   * dangling attempt row"), run against both backends. See kickoff §8.
   */
  claimAttempt(input: ClaimAttemptInput): ClaimAttemptResult;
  updateAttempt(input: UpdateAttemptInput): CeoPlanStepAttempt;
  getAttempt(attemptId: string): CeoPlanStepAttempt;
  /**
   * Deterministic order is part of the port contract:
   * - step-specific calls return `attemptNumber ASC`;
   * - run-wide calls return `planStepId ASC, attemptNumber ASC`.
   *
   * Callers may use the final item from a step-specific result as the
   * latest attempt; no caller may depend on database/default insertion
   * order.
   */
  listAttempts(runId: string, planStepId?: string): readonly CeoPlanStepAttempt[];
  getActiveAttempt(runId: string, planStepId: string): CeoPlanStepAttempt | undefined;

  /**
   * Durable, idempotent proof that a human operator requested recovery of
   * one exact abandoned attempt. This is intentionally separate from Board
   * messages and from inferred task/step state: restart reconciliation may
   * continue abandoned retry work only when this row exists.
   */
  claimAbandonedRetryIntent(input: ClaimAbandonedRetryIntentInput): ClaimAbandonedRetryIntentResult;
  findAbandonedRetryIntent(
    runId: string,
    planStepId: string,
    abandonedAttemptId: string,
  ): AbandonedRetryIntentRecord | undefined;
  listAbandonedRetryIntents(): readonly AbandonedRetryIntentRecord[];
  linkAbandonedRetryIntentReplacement(
    input: LinkAbandonedRetryIntentReplacementInput,
  ): AbandonedRetryIntentRecord;

  getCircuitState(runId: string): CircuitStateSnapshot;
  recordCircuitOutcome(input: RecordCircuitFailureInput): void;
  recordCircuitProgress(runId: string): void;
  tripCircuit(input: TripCircuitInput): void;
  resetCircuit(runId: string): void;

  appendEvent(input: AppendExecutionEventInput): CeoPlanExecutionEvent;
  listEvents(runId: string, afterSequence?: number): readonly CeoPlanExecutionEvent[];

  recordIntervention(input: RecordInterventionInput): void;
  listInterventions(runId: string): readonly InterventionRecord[];

  /** Idempotent dedup gate for Board-audit summaries: returns `true` only the first time this `(runId, dedupKey)` pair is claimed — callers post a Board message iff this returns `true`. */
  claimBoardAuditOnce(runId: string, dedupKey: string, now: string): boolean;
}
