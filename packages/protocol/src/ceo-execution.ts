import { z } from "zod";
import { boundedNonBlankString, isoTimestampSchema, nonEmptyIdSchema } from "./ids.js";
import { parseWithSchema } from "./errors.js";

/**
 * Phase 15 — autonomous execution of an already-approved and delegated CEO
 * plan. This module is the public, environment-agnostic projection of the
 * execution-run/step/attempt/signal domain: every schema here is what a
 * browser or another process is allowed to see. Internal fencing/lease data
 * (ownership epoch, claim lease, internal revision counters) is
 * deliberately never modeled here — it lives only in the server-side
 * persistence rows (`apps/server/src/ceo-execution/`) and is never
 * serialized into any of these shapes. See
 * `docs/architecture/0015-autonomous-plan-execution-and-scheduling.md`.
 */

// ---- Bounds ----------------------------------------------------------

export const MIN_MAX_CONCURRENT_STEPS = 1;
export const MAX_MAX_CONCURRENT_STEPS = 4;
export const MIN_MAX_ATTEMPTS_PER_STEP = 1;
export const MAX_MAX_ATTEMPTS_PER_STEP = 3;
export const MAX_RETRY_BACKOFF_SECONDS = 3600;
export const MAX_PLAN_ELAPSED_SECONDS_CEILING = 604_800; // 7 days
export const MAX_STEP_ELAPSED_SECONDS_CEILING = 86_400; // 1 day
export const MAX_CONSECUTIVE_FAILURES_CEILING = 10;
export const MAX_NO_PROGRESS_ATTEMPTS_CEILING = 10;
export const MIN_ADAPTER_CONCURRENCY_OVERRIDE = 1;
export const MAX_ADAPTER_CONCURRENCY_OVERRIDE = 4;
export const MAX_ADAPTER_CONCURRENCY_OVERRIDES = 20;
export const MAX_SAFE_FAILURE_CODE_LENGTH = 100;
export const MAX_SAFE_FAILURE_SUMMARY_LENGTH = 500;
export const MAX_SIGNAL_REASONS = 10;
export const MAX_INTERVENTION_NOTE_LENGTH = 1000;
export const MAX_EXECUTION_EVENT_PAYLOAD_KEYS = 25;
export const MAX_EXECUTION_EVENT_PAYLOAD_VALUE_LENGTH = 1000;

// ---- Execution mode & run status --------------------------------------

export const ceoPlanExecutionModeSchema = z.enum(["manual", "autonomous"]);
export type CeoPlanExecutionMode = z.infer<typeof ceoPlanExecutionModeSchema>;

/**
 * Smallest state set that accurately represents the lifecycle (the
 * kickoff's own guidance) — a separate transitional "pausing" status was
 * considered and dropped: an ordinary pause request returns immediately
 * and active tasks are left running under their own steam (see
 * "Pause semantics" in the architecture doc), so there is never a window
 * where the run is neither `running` nor `paused` that a distinct status
 * would need to represent.
 */
export const ceoPlanRunStatusSchema = z.enum([
  "configured",
  "running",
  "paused",
  "awaiting_intervention",
  "completed",
  "failed",
  "cancelled",
]);
export type CeoPlanRunStatus = z.infer<typeof ceoPlanRunStatusSchema>;

/** Terminal statuses accept no further scheduler mutation. */
export const CEO_PLAN_RUN_TERMINAL_STATUSES: readonly CeoPlanRunStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export const ceoPlanRunRecoveryClassificationSchema = z.enum([
  "none",
  "clean_continue",
  "unclean_paused",
]);
export type CeoPlanRunRecoveryClassification = z.infer<
  typeof ceoPlanRunRecoveryClassificationSchema
>;

// ---- Execution policy (immutable once a run starts) --------------------

const adapterConcurrencyOverridesSchema = z
  .record(
    nonEmptyIdSchema,
    z.number().int().min(MIN_ADAPTER_CONCURRENCY_OVERRIDE).max(MAX_ADAPTER_CONCURRENCY_OVERRIDE),
  )
  .refine(
    (overrides) => Object.keys(overrides).length <= MAX_ADAPTER_CONCURRENCY_OVERRIDES,
    `must not exceed ${String(MAX_ADAPTER_CONCURRENCY_OVERRIDES)} adapter overrides`,
  )
  .optional();

export const ceoPlanExecutionPolicySchema = z
  .object({
    maxConcurrentSteps: z
      .number()
      .int()
      .min(MIN_MAX_CONCURRENT_STEPS)
      .max(MAX_MAX_CONCURRENT_STEPS),
    maxAttemptsPerStep: z
      .number()
      .int()
      .min(MIN_MAX_ATTEMPTS_PER_STEP)
      .max(MAX_MAX_ATTEMPTS_PER_STEP),
    allowAutomaticTransientRetry: z.boolean(),
    retryBackoffSeconds: z.number().int().min(0).max(MAX_RETRY_BACKOFF_SECONDS),
    maxPlanElapsedSeconds: z.number().int().positive().max(MAX_PLAN_ELAPSED_SECONDS_CEILING),
    maxStepElapsedSeconds: z.number().int().positive().max(MAX_STEP_ELAPSED_SECONDS_CEILING),
    maxConsecutiveFailures: z.number().int().min(1).max(MAX_CONSECUTIVE_FAILURES_CEILING),
    maxNoProgressAttempts: z.number().int().min(1).max(MAX_NO_PROGRESS_ATTEMPTS_CEILING),
    pauseOnAnyPermanentFailure: z.boolean(),
    adapterConcurrencyOverrides: adapterConcurrencyOverridesSchema,
  })
  .strict();
export type CeoPlanExecutionPolicy = z.infer<typeof ceoPlanExecutionPolicySchema>;

export function parseCeoPlanExecutionPolicy(input: unknown): CeoPlanExecutionPolicy {
  return parseWithSchema(ceoPlanExecutionPolicySchema, input, "CeoPlanExecutionPolicy");
}

/** Conservative defaults — bounded 1-step, 1-attempt, no automatic retry. Operators widen deliberately, never by omission. */
export const DEFAULT_CEO_PLAN_EXECUTION_POLICY: CeoPlanExecutionPolicy = {
  maxConcurrentSteps: 1,
  maxAttemptsPerStep: 1,
  allowAutomaticTransientRetry: false,
  retryBackoffSeconds: 30,
  maxPlanElapsedSeconds: 3600,
  maxStepElapsedSeconds: 1800,
  maxConsecutiveFailures: 2,
  maxNoProgressAttempts: 2,
  pauseOnAnyPermanentFailure: true,
};

// ---- Plan execution run --------------------------------------------------

export const ceoPlanRunSchema = z
  .object({
    id: nonEmptyIdSchema,
    planId: nonEmptyIdSchema,
    planVersion: z.number().int().positive(),
    status: ceoPlanRunStatusSchema,
    executionMode: ceoPlanExecutionModeSchema,
    policySnapshot: ceoPlanExecutionPolicySchema,
    createdAt: isoTimestampSchema,
    startedAt: isoTimestampSchema.optional(),
    pausedAt: isoTimestampSchema.optional(),
    completedAt: isoTimestampSchema.optional(),
    failedAt: isoTimestampSchema.optional(),
    cancelledAt: isoTimestampSchema.optional(),
    activeGeneration: z.number().int().nonnegative(),
    lastSchedulerDecisionAt: isoTimestampSchema.optional(),
    recoveryClassification: ceoPlanRunRecoveryClassificationSchema,
    // Deliberately absent: `internalRevision` — private, store-internal
    // only. Never exposed publicly (see this file's header comment).
  })
  .strict();
export type CeoPlanRun = z.infer<typeof ceoPlanRunSchema>;

export function parseCeoPlanRun(input: unknown): CeoPlanRun {
  return parseWithSchema(ceoPlanRunSchema, input, "CeoPlanRun");
}

// ---- Step execution (runtime projection over the linked child task) ----

export const ceoPlanStepExecutionStatusSchema = z.enum([
  "waiting_for_dependencies",
  "ready",
  "queued",
  "claimed",
  "starting",
  "running",
  "retry_wait",
  "completed",
  "failed",
  "cancelled",
  "awaiting_intervention",
]);
export type CeoPlanStepExecutionStatus = z.infer<typeof ceoPlanStepExecutionStatusSchema>;

/** Every reason a step is or is not currently eligible to launch — bounded and exhaustive so a UI or audit trail can render it without inventing prose. */
export const ceoPlanStepReadinessReasonSchema = z.enum([
  "ready",
  "waiting_for_dependencies",
  "blocked_by_failed_dependency",
  "blocked_by_cancelled_dependency",
  "waiting_for_capacity",
  "waiting_for_adapter",
  "adapter_ineligible",
  "trust_ineligible",
  "policy_limit_reached",
  "circuit_open",
  "operator_intervention",
  "run_not_active",
  "attempt_already_active",
  "completed",
  "cancelled",
  "stale_generation",
]);
export type CeoPlanStepReadinessReason = z.infer<typeof ceoPlanStepReadinessReasonSchema>;

export const ceoPlanStepDependencySummarySchema = z
  .object({
    totalDependencies: z.number().int().nonnegative(),
    completedDependencies: z.number().int().nonnegative(),
    failedDependencies: z.number().int().nonnegative(),
    cancelledDependencies: z.number().int().nonnegative(),
  })
  .strict();
export type CeoPlanStepDependencySummary = z.infer<typeof ceoPlanStepDependencySummarySchema>;

const safeFailureCodeSchema = z.string().max(MAX_SAFE_FAILURE_CODE_LENGTH);

export const ceoPlanStepExecutionSchema = z
  .object({
    planRunId: nonEmptyIdSchema,
    planStepId: nonEmptyIdSchema,
    childTaskId: nonEmptyIdSchema,
    status: ceoPlanStepExecutionStatusSchema,
    attemptCount: z.number().int().nonnegative(),
    activeAttemptId: nonEmptyIdSchema.optional(),
    lastFailureCode: safeFailureCodeSchema.optional(),
    nextEligibleAt: isoTimestampSchema.optional(),
    dependencySummary: ceoPlanStepDependencySummarySchema,
    readinessReason: ceoPlanStepReadinessReasonSchema,
    startedAt: isoTimestampSchema.optional(),
    completedAt: isoTimestampSchema.optional(),
  })
  .strict();
export type CeoPlanStepExecution = z.infer<typeof ceoPlanStepExecutionSchema>;

export function parseCeoPlanStepExecution(input: unknown): CeoPlanStepExecution {
  return parseWithSchema(ceoPlanStepExecutionSchema, input, "CeoPlanStepExecution");
}

// ---- Execution attempts --------------------------------------------------

export const ceoPlanStepAttemptStatusSchema = z.enum([
  "claimed",
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled",
  "abandoned",
]);
export type CeoPlanStepAttemptStatus = z.infer<typeof ceoPlanStepAttemptStatusSchema>;

export const CEO_PLAN_STEP_ATTEMPT_TERMINAL_STATUSES: readonly CeoPlanStepAttemptStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "abandoned",
];

export const ceoPlanExecutionTriggerReasonSchema = z.enum([
  "execution_started",
  "dependency_completed",
  "dependency_failed",
  "task_terminal",
  "operator_resumed",
  "capacity_available",
  "retry_due",
  "adapter_availability_changed",
  "startup_reconciliation",
  "periodic_reconciliation",
  "operator_manual_retry",
]);
export type CeoPlanExecutionTriggerReason = z.infer<typeof ceoPlanExecutionTriggerReasonSchema>;

export const ceoPlanStepAttemptSchema = z
  .object({
    id: nonEmptyIdSchema,
    planRunId: nonEmptyIdSchema,
    planStepId: nonEmptyIdSchema,
    childTaskId: nonEmptyIdSchema,
    attemptNumber: z.number().int().positive(),
    status: ceoPlanStepAttemptStatusSchema,
    triggerReason: ceoPlanExecutionTriggerReasonSchema,
    schedulerSignalId: nonEmptyIdSchema,
    taskRunId: nonEmptyIdSchema.optional(),
    safeFailureCode: safeFailureCodeSchema.optional(),
    safeFailureSummary: boundedNonBlankString(MAX_SAFE_FAILURE_SUMMARY_LENGTH).optional(),
    createdAt: isoTimestampSchema,
    claimedAt: isoTimestampSchema.optional(),
    startedAt: isoTimestampSchema.optional(),
    finishedAt: isoTimestampSchema.optional(),
    leaseGeneration: z.number().int().nonnegative(),
    // Deliberately absent: internal owner/lease fields — private only.
  })
  .strict();
export type CeoPlanStepAttempt = z.infer<typeof ceoPlanStepAttemptSchema>;

export function parseCeoPlanStepAttempt(input: unknown): CeoPlanStepAttempt {
  return parseWithSchema(ceoPlanStepAttemptSchema, input, "CeoPlanStepAttempt");
}

// ---- Durable execution-signal queue (public projection) ----------------

export const ceoPlanExecutionSignalStateSchema = z.enum([
  "pending",
  "claimed",
  "processed",
  "cancelled",
]);
export type CeoPlanExecutionSignalState = z.infer<typeof ceoPlanExecutionSignalStateSchema>;

export const ceoPlanExecutionSignalPrioritySchema = z.enum(["normal", "high"]);
export type CeoPlanExecutionSignalPriority = z.infer<typeof ceoPlanExecutionSignalPrioritySchema>;

export const ceoPlanExecutionSignalSchema = z
  .object({
    id: nonEmptyIdSchema,
    planRunId: nonEmptyIdSchema,
    planStepId: nonEmptyIdSchema.optional(),
    generation: z.number().int().nonnegative(),
    reasons: z
      .array(ceoPlanExecutionTriggerReasonSchema)
      .min(1)
      .max(MAX_SIGNAL_REASONS)
      .refine(
        (reasons) => new Set(reasons).size === reasons.length,
        "reasons must not contain duplicates",
      ),
    priority: ceoPlanExecutionSignalPrioritySchema,
    availableAt: isoTimestampSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    state: ceoPlanExecutionSignalStateSchema,
    attemptCount: z.number().int().nonnegative(),
    // Deliberately absent: `claimLease`, `internalRevision` — private only.
  })
  .strict();
export type CeoPlanExecutionSignal = z.infer<typeof ceoPlanExecutionSignalSchema>;

export function parseCeoPlanExecutionSignal(input: unknown): CeoPlanExecutionSignal {
  return parseWithSchema(ceoPlanExecutionSignalSchema, input, "CeoPlanExecutionSignal");
}

// ---- Circuit breaker ------------------------------------------------------

export const ceoPlanExecutionCircuitStateSchema = z.enum(["closed", "open"]);
export type CeoPlanExecutionCircuitState = z.infer<typeof ceoPlanExecutionCircuitStateSchema>;

export const ceoPlanExecutionCircuitTripReasonSchema = z.enum([
  "consecutive_failures",
  "consecutive_same_code_failures",
  "no_progress_retries",
  "rapid_attempt_churn",
  "adapter_flapping",
]);
export type CeoPlanExecutionCircuitTripReason = z.infer<
  typeof ceoPlanExecutionCircuitTripReasonSchema
>;

// ---- Retry/failure classification -----------------------------------------

export const ceoPlanExecutionFailureClassificationSchema = z.enum([
  "transient",
  "permanent",
  "security",
  "ownership_lost",
  "cancelled",
  "requirements_changed",
  "adapter_unavailable",
  "unknown",
]);
export type CeoPlanExecutionFailureClassification = z.infer<
  typeof ceoPlanExecutionFailureClassificationSchema
>;

// ---- Operator intervention -------------------------------------------------

export const ceoPlanExecutionInterventionTypeSchema = z.enum([
  "pause",
  "resume",
  "retry_step",
  "cancel",
  "emergency_stop",
]);
export type CeoPlanExecutionInterventionType = z.infer<
  typeof ceoPlanExecutionInterventionTypeSchema
>;

export const ceoPlanExecutionInterventionSchema = z
  .object({
    id: nonEmptyIdSchema,
    planRunId: nonEmptyIdSchema,
    type: ceoPlanExecutionInterventionTypeSchema,
    actor: z.literal("human:local-operator"),
    note: boundedNonBlankString(MAX_INTERVENTION_NOTE_LENGTH).optional(),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type CeoPlanExecutionIntervention = z.infer<typeof ceoPlanExecutionInterventionSchema>;

// ---- Actor attribution ------------------------------------------------------

const taskRunActorPattern = /^task-run:[A-Za-z0-9_-]{1,128}$/;

/** Bounded set of server-only actor identities plus a pattern-matched task-run reference — never a free-form, browser-suppliable string. */
export const ceoPlanExecutionActorSchema = z.union([
  z.enum(["system:ceo-scheduler", "human:local-operator", "recovery:hall-core"]),
  z.string().regex(taskRunActorPattern),
]);
export type CeoPlanExecutionActor = z.infer<typeof ceoPlanExecutionActorSchema>;

// ---- Execution event stream (dedicated, never mixed with other streams) --

export const ceoPlanExecutionEventTypeSchema = z.enum([
  "ceo.execution.configured",
  "ceo.execution.started",
  "ceo.execution.paused",
  "ceo.execution.resumed",
  "ceo.execution.cancelled",
  "ceo.execution.completed",
  "ceo.execution.failed",
  "ceo.execution.recovery_paused",
  "ceo.execution.signal_queued",
  "ceo.execution.signal_coalesced",
  "ceo.execution.step_ready",
  "ceo.execution.step_claimed",
  "ceo.execution.step_started",
  "ceo.execution.step_completed",
  "ceo.execution.step_failed",
  "ceo.execution.retry_scheduled",
  "ceo.execution.retry_requested",
  "ceo.execution.circuit_opened",
  "ceo.execution.emergency_stop_requested",
]);
export type CeoPlanExecutionEventType = z.infer<typeof ceoPlanExecutionEventTypeSchema>;

const boundedExecutionEventPayloadSchema = z
  .record(
    z.string().max(100, "payload key must not exceed 100 characters"),
    z.union([
      z.string().max(MAX_EXECUTION_EVENT_PAYLOAD_VALUE_LENGTH),
      z.number(),
      z.boolean(),
      z.null(),
    ]),
  )
  .refine(
    (payload) => Object.keys(payload).length <= MAX_EXECUTION_EVENT_PAYLOAD_KEYS,
    `payload must not exceed ${String(MAX_EXECUTION_EVENT_PAYLOAD_KEYS)} keys`,
  );

export const ceoPlanExecutionEventSchema = z
  .object({
    planRunId: nonEmptyIdSchema,
    sequence: z.number().int().nonnegative(),
    type: ceoPlanExecutionEventTypeSchema,
    actor: ceoPlanExecutionActorSchema,
    payload: boundedExecutionEventPayloadSchema,
    timestamp: isoTimestampSchema,
  })
  .strict();
export type CeoPlanExecutionEvent = z.infer<typeof ceoPlanExecutionEventSchema>;

export function parseCeoPlanExecutionEvent(input: unknown): CeoPlanExecutionEvent {
  return parseWithSchema(ceoPlanExecutionEventSchema, input, "CeoPlanExecutionEvent");
}

// ---- Scheduler status (safe, bounded summary surface) ---------------------

export const ceoPlanSchedulerStateSchema = z.enum([
  "idle",
  "active",
  "paused",
  "ownership_lost",
  "overloaded",
]);
export type CeoPlanSchedulerState = z.infer<typeof ceoPlanSchedulerStateSchema>;

export const ceoPlanSchedulerStatusSchema = z
  .object({
    state: ceoPlanSchedulerStateSchema,
    pendingSignalCount: z.number().int().nonnegative(),
    claimedSignalCount: z.number().int().nonnegative(),
    runningPlanCount: z.number().int().nonnegative(),
    runningStepCount: z.number().int().nonnegative(),
    waitingForDependencyCount: z.number().int().nonnegative(),
    waitingForCapacityCount: z.number().int().nonnegative(),
    retryWaitingCount: z.number().int().nonnegative(),
    circuitOpenCount: z.number().int().nonnegative(),
    signalsCoalesced: z.number().int().nonnegative(),
    lastDecisionAt: isoTimestampSchema.optional(),
    reconciliationEnabled: z.boolean(),
    reconciliationIntervalSeconds: z.number().int().positive(),
  })
  .strict();
export type CeoPlanSchedulerStatus = z.infer<typeof ceoPlanSchedulerStatusSchema>;
