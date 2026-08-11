import { z } from "zod";
import {
  agentCapabilitiesSchema,
  capabilityIdSchema,
  capabilityObservationSchema,
  ceoApprovalSchema,
  ceoPlanEventSchema,
  ceoPlanExecutionEventSchema,
  ceoPlanExecutionModeSchema,
  ceoPlanExecutionPolicySchema,
  ceoPlanRunSchema,
  ceoPlanSchedulerStatusSchema,
  ceoPlanSchema,
  ceoPlanStatusSchema,
  ceoPlanStepAttemptSchema,
  ceoPlanStepExecutionSchema,
  ceoPlanStepSchema,
  ceoPlanVersionSchema,
  communicationBoardSchema,
  communicationMessageSchema,
  executionTrustSchema,
  hallTaskSchema,
  structuredFailureSchema,
  taskPrioritySchema,
  taskRequirementsSchema,
} from "@hall-of-wisdom/protocol";

export {
  ceoApprovalSchema,
  ceoPlanEventSchema,
  ceoPlanSchema,
  ceoPlanStatusSchema,
  ceoPlanStepSchema,
  ceoPlanVersionSchema,
};
export type {
  CeoApproval,
  CeoApprovalDecision,
  CeoPlan,
  CeoPlanActor,
  CeoPlanEvent,
  CeoPlanEventType,
  CeoPlanStatus,
  CeoPlanStep,
  CeoPlanVersion,
} from "@hall-of-wisdom/protocol";

/**
 * Phase 15 — the autonomous execution shapes. `CeoPlanRun`/
 * `CeoPlanStepExecution`/`CeoPlanStepAttempt`/`CeoPlanExecutionEvent`/
 * `CeoPlanExecutionPolicy`/`CeoPlanSchedulerStatus` all come straight from
 * `@hall-of-wisdom/protocol`, matching this file's established convention
 * of never redefining a protocol-owned shape. Only Hall Core's own wire
 * envelopes and the two shapes that exist purely server-side (circuit
 * state snapshot, intervention record — `ceo-plan-run-store-port.ts`) are
 * hand-mirrored here.
 */
export {
  ceoPlanExecutionEventSchema,
  ceoPlanExecutionModeSchema,
  ceoPlanExecutionPolicySchema,
  ceoPlanRunSchema,
  ceoPlanSchedulerStatusSchema,
  ceoPlanStepAttemptSchema,
  ceoPlanStepExecutionSchema,
};
export type {
  CeoPlanExecutionActor,
  CeoPlanExecutionCircuitState,
  CeoPlanExecutionCircuitTripReason,
  CeoPlanExecutionEvent,
  CeoPlanExecutionEventType,
  CeoPlanExecutionFailureClassification,
  CeoPlanExecutionInterventionType,
  CeoPlanExecutionMode,
  CeoPlanExecutionPolicy,
  CeoPlanExecutionSignalState,
  CeoPlanExecutionTriggerReason,
  CeoPlanRun,
  CeoPlanRunRecoveryClassification,
  CeoPlanRunStatus,
  CeoPlanSchedulerState,
  CeoPlanSchedulerStatus,
  CeoPlanStepAttempt,
  CeoPlanStepAttemptStatus,
  CeoPlanStepDependencySummary,
  CeoPlanStepExecution,
  CeoPlanStepExecutionStatus,
  CeoPlanStepReadinessReason,
} from "@hall-of-wisdom/protocol";
export {
  DEFAULT_CEO_PLAN_EXECUTION_POLICY,
  MAX_ADAPTER_CONCURRENCY_OVERRIDE,
  MAX_CONSECUTIVE_FAILURES_CEILING,
  MAX_MAX_ATTEMPTS_PER_STEP,
  MAX_MAX_CONCURRENT_STEPS,
  MAX_NO_PROGRESS_ATTEMPTS_CEILING,
  MAX_PLAN_ELAPSED_SECONDS_CEILING,
  MAX_RETRY_BACKOFF_SECONDS,
  MAX_STEP_ELAPSED_SECONDS_CEILING,
  MIN_ADAPTER_CONCURRENCY_OVERRIDE,
  MIN_MAX_ATTEMPTS_PER_STEP,
  MIN_MAX_CONCURRENT_STEPS,
} from "@hall-of-wisdom/protocol";

export const circuitStateSnapshotSchema = z
  .object({
    state: z.enum(["closed", "open"]),
    consecutiveFailures: z.number(),
    consecutiveSameCodeFailures: z.number(),
    noProgressAttempts: z.number(),
    lastFailureCode: z.string().optional(),
    tripReason: z
      .enum([
        "consecutive_failures",
        "consecutive_same_code_failures",
        "no_progress_retries",
        "rapid_attempt_churn",
        "adapter_flapping",
      ])
      .optional(),
  })
  .strict();
export type CircuitStateSnapshot = z.infer<typeof circuitStateSnapshotSchema>;

export const ceoPlanExecutionInterventionRecordSchema = z
  .object({
    id: z.string(),
    type: z.enum(["pause", "resume", "retry_step", "cancel", "emergency_stop"]),
    note: z.string().optional(),
    createdAt: z.string(),
  })
  .strict();
export type CeoPlanExecutionInterventionRecord = z.infer<
  typeof ceoPlanExecutionInterventionRecordSchema
>;

export const runMutationResponseSchema = z
  .object({ run: ceoPlanRunSchema, mutationToken: z.string() })
  .strict();
export type RunMutationResponse = z.infer<typeof runMutationResponseSchema>;

export const configureCeoPlanRunResponseSchema = z
  .object({ run: ceoPlanRunSchema, mutationToken: z.string() })
  .strict();
export type ConfigureCeoPlanRunResponse = z.infer<typeof configureCeoPlanRunResponseSchema>;

export const getCeoPlanRunResponseSchema = z
  .object({
    run: ceoPlanRunSchema,
    stepExecutions: z.array(ceoPlanStepExecutionSchema),
    attempts: z.array(ceoPlanStepAttemptSchema),
    circuit: circuitStateSnapshotSchema,
    interventions: z.array(ceoPlanExecutionInterventionRecordSchema),
    mutationToken: z.string(),
  })
  .strict();
export type GetCeoPlanRunResponse = z.infer<typeof getCeoPlanRunResponseSchema>;

export const listCeoPlanRunsResponseSchema = z.object({ runs: z.array(ceoPlanRunSchema) }).strict();
export type ListCeoPlanRunsResponse = z.infer<typeof listCeoPlanRunsResponseSchema>;

export const listCeoPlanRunEventsResponseSchema = z
  .object({ events: z.array(ceoPlanExecutionEventSchema) })
  .strict();
export type ListCeoPlanRunEventsResponse = z.infer<typeof listCeoPlanRunEventsResponseSchema>;

export const ceoPlanRunSchedulerStatusResponseSchema = z
  .object({
    state: z.enum(["active", "paused", "idle"]),
    pendingSignalCount: z.number(),
    claimedSignalCount: z.number(),
    runningStepCount: z.number(),
    waitingForDependencyCount: z.number(),
    retryWaitingCount: z.number(),
    circuitState: z.enum(["closed", "open"]),
    activeAttemptCount: z.number(),
    lastDecisionAt: z.string().optional(),
  })
  .strict();
export type CeoPlanRunSchedulerStatusResponse = z.infer<
  typeof ceoPlanRunSchedulerStatusResponseSchema
>;

export const emergencyStopOutcomeSchema = z
  .object({
    planStepId: z.string(),
    childTaskId: z.string(),
    outcome: z.enum(["cancellation_requested", "already_requested", "failed"]),
    detail: z.string().optional(),
  })
  .strict();
export type EmergencyStopOutcome = z.infer<typeof emergencyStopOutcomeSchema>;

export const emergencyStopResponseSchema = z
  .object({
    result: z
      .object({
        runId: z.string(),
        outcomes: z.array(emergencyStopOutcomeSchema),
        allSucceeded: z.boolean(),
      })
      .strict(),
    run: ceoPlanRunSchema,
    mutationToken: z.string(),
  })
  .strict();
export type EmergencyStopResponse = z.infer<typeof emergencyStopResponseSchema>;

export const retryCeoPlanRunStepResponseSchema = z
  .object({
    run: ceoPlanRunSchema,
    step: ceoPlanStepExecutionSchema,
    mutationToken: z.string(),
  })
  .strict();
export type RetryCeoPlanRunStepResponse = z.infer<typeof retryCeoPlanRunStepResponseSchema>;

export {
  capabilityIdSchema,
  capabilityStatusSchema,
  capabilityEvidenceCategorySchema,
  capabilityObservationSchema,
  executionTrustSchema,
  taskRequirementsSchema,
} from "@hall-of-wisdom/protocol";
export type {
  CapabilityId,
  CapabilityStatus,
  CapabilityEvidenceCategory,
  CapabilityObservation,
  ExecutionTrust,
  TaskRequirements,
} from "@hall-of-wisdom/protocol";

export { communicationBoardSchema, communicationMessageSchema };
export type { CommunicationBoard, CommunicationMessage } from "@hall-of-wisdom/protocol";

/**
 * Hall Core response shapes, kept local to this app rather than in
 * `@hall-of-wisdom/protocol` — they describe this one HTTP API's wire
 * envelopes (task records, adapter summaries, error bodies), not the
 * provider-neutral agent/event contract the protocol package owns. Reuses
 * `hallTaskSchema`/`structuredFailureSchema`/`agentCapabilitiesSchema` from
 * the protocol package wherever a field's shape actually comes from there.
 */

export const healthResponseSchema = z
  .object({
    status: z.literal("ok"),
    application: z.string(),
    protocolVersion: z.string(),
    uptimeSeconds: z.number(),
  })
  .strict();
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const authSessionResponseSchema = z.object({ authenticated: z.boolean() }).strict();
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;

/**
 * Phase 13 — `GET /api/v1/system/storage`. Mirrors the server's own
 * bounded, path-free response shape (`routes/system.ts`): `schemaVersion`/
 * `previousShutdown`/`recovery` are `null` in ephemeral (`"in-memory"`)
 * mode, since there is nothing durable to report.
 */
const worktreeHealthCountsSchema = z
  .object({
    healthy: z.number(),
    interrupted: z.number(),
    workspace_missing: z.number(),
    workspace_unverified: z.number(),
    cleanup_required: z.number(),
    unsafe_path: z.number(),
  })
  .strict();

const recoverySummarySchema = z
  .object({
    tasksScanned: z.number(),
    taskEventProjectionsRepaired: z.number(),
    taskTerminalOutcomesReplayed: z.number(),
    interruptedTaskRunCount: z.number(),
    comparisonsScanned: z.number(),
    interruptedPreparationCount: z.number(),
    interruptedCleanupCount: z.number(),
    comparisonEventProjectionsRepaired: z.number(),
    comparisonTerminalOutcomesReplayed: z.number(),
    interruptedCandidateRunCount: z.number(),
    worktreeHealthCounts: worktreeHealthCountsSchema,
    orphanWorktreeCount: z.number(),
  })
  .strict();

export const systemStorageResponseSchema = z
  .object({
    mode: z.enum(["durable", "in-memory"]),
    ready: z.boolean(),
    schemaVersion: z.number().nullable(),
    startedAt: z.string(),
    previousShutdown: z.enum(["clean", "unclean", "first_start"]).nullable(),
    recovery: recoverySummarySchema.nullable(),
  })
  .strict();
export type SystemStorageResponse = z.infer<typeof systemStorageResponseSchema>;

const terminalEventTypeSchema = z.enum(["run.completed", "run.failed", "run.cancelled"]);

/**
 * `runId`/`adapterId`/`agentId` are absent (never an empty string) for a
 * planning task that has not been assigned (backlog/ready) or started
 * (assigned, before `POST .../start`) — see
 * `docs/architecture/0006-kanban-board.md`, "Task snapshot compatibility".
 */
export const taskRecordSchema = z
  .object({
    task: hallTaskSchema,
    runId: z.string().optional(),
    adapterId: z.string().optional(),
    agentId: z.string().optional(),
    eventCount: z.number(),
    lastSequence: z.number().optional(),
    terminalEventType: terminalEventTypeSchema.optional(),
    failure: structuredFailureSchema.optional(),
    cancellationRequested: z.boolean(),
    createdAt: z.string(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    // Phase 11 — a snapshot of the assigned adapter's execution trust taken
    // at assignment time; absent until a task is assigned. `task.requirements`
    // (also Phase 11) already flows through `hallTaskSchema` above.
    assignedExecutionTrust: executionTrustSchema.optional(),
  })
  .strict();
export type TaskRecord = z.infer<typeof taskRecordSchema>;

/**
 * The envelope `POST /api/v1/tasks` (both execution modes) and
 * `POST /api/v1/tasks/:taskId/start` return: a full `TaskRecord` plus,
 * only when a run actually exists, `eventsPath`. A deferred-mode create
 * response has no `eventsPath` — absent, never an empty string.
 */
export const createTaskResponseSchema = taskRecordSchema.extend({
  eventsPath: z.string().optional(),
});
export type CreateTaskResponse = z.infer<typeof createTaskResponseSchema>;

export const executionModeSchema = z.enum(["immediate", "deferred"]);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

export const listTasksResponseSchema = z.object({ tasks: z.array(taskRecordSchema) }).strict();

export const cancelTaskResponseSchema = z
  .object({
    taskId: z.string(),
    cancellationRequested: z.boolean(),
    alreadyRequested: z.boolean(),
  })
  .strict();
export type CancelTaskResponse = z.infer<typeof cancelTaskResponseSchema>;

const integrationLevelSchema = z.enum([
  "native",
  "structured_cli",
  "interactive_cli",
  "ide_bridge",
  "restricted",
  "unsupported",
]);

const operatingSystemSchema = z.enum(["windows", "macos", "linux"]);

const availabilityStatusSchema = z.enum([
  "available",
  "busy",
  "rate_limited",
  "logged_out",
  "offline",
  "unavailable",
  "unsupported",
]);

export const adapterSummarySchema = z
  .object({
    adapterId: z.string(),
    displayName: z.string(),
    adapterVersion: z.string(),
    agentId: z.string(),
    agentDisplayName: z.string(),
    provider: z.string().optional(),
    integrationLevel: integrationLevelSchema,
    supportedOperatingSystems: z.array(operatingSystemSchema),
    capabilities: agentCapabilitiesSchema,
    // Phase 17.2 — straight from AgentDetectionResult's own already-safe
    // `installed` field (see apps/server's routes/adapters.ts).
    installed: z.boolean(),
    availability: availabilityStatusSchema,
    // Phase 10.2 — present only when availability is "available"; a
    // small, fixed, adapter-authored caveat about that otherwise-normal
    // result (e.g. Codex's trusted-local bypass notice). Never present
    // for any other availability value. See apps/server's adapters.ts.
    limitationNotice: z.string().optional(),
    // Phase 17.2 — the SAME underlying diagnosticMessage widened to
    // every availability value, not just "available" — used by the
    // Providers page to explain why a provider isn't connected. See
    // apps/server's routes/adapters.ts SafeAdapterSummary doc comment
    // for why widening this specific field is safe.
    statusMessage: z.string().optional(),
    detectedVersion: z.string().optional(),
    // Phase 11 — declaredCapabilities is static descriptor metadata;
    // everything else here is a fresh runtime observation from this
    // adapter's own detect() call. See apps/server's routes/adapters.ts.
    declaredCapabilities: z.array(capabilityIdSchema),
    assignable: z.boolean(),
    executionTrust: executionTrustSchema,
    capabilityObservations: z.array(capabilityObservationSchema),
    limitations: z.array(z.string()),
    detectedAt: z.string(),
  })
  .strict();
export type AdapterSummary = z.infer<typeof adapterSummarySchema>;

export const listAdaptersResponseSchema = z
  .object({ adapters: z.array(adapterSummarySchema) })
  .strict();

export const getAdapterResponseSchema = z.object({ adapter: adapterSummarySchema }).strict();

export const hermesSettingsResponseSchema = z
  .object({
    configured: z.boolean(),
    ready: z.boolean(),
    apiKeyConfigured: z.boolean(),
    environmentOverrideActive: z.boolean(),
    runtimeRoot: z.string().optional(),
    routerBaseUrl: z.string().optional(),
    pythonPath: z.string().optional(),
    message: z.string(),
    detectedVersion: z.string().optional(),
    technicalMessage: z.string().optional(),
  })
  .strict();
export type HermesSettingsResponse = z.infer<typeof hermesSettingsResponseSchema>;

/**
 * Phase 11 — routing routes' response shapes. Mirrors
 * `apps/server/src/routing/routing-policy.ts`'s `RoutingCandidate`/
 * `RoutingResult` and `TaskOrchestrator.routeAndAssign()`'s response.
 */
export const routingCandidateSchema = z
  .object({
    adapterId: z.string(),
    displayName: z.string(),
    availability: availabilityStatusSchema,
    assignable: z.boolean(),
    executionTrust: executionTrustSchema,
    verifiedCapabilities: z.array(capabilityIdSchema),
    missingCapabilities: z.array(capabilityIdSchema),
    restrictedCapabilities: z.array(capabilityIdSchema),
    trustAllowed: z.boolean(),
    safeReason: z.string(),
    rank: z.number().optional(),
  })
  .strict();
export type RoutingCandidate = z.infer<typeof routingCandidateSchema>;

export const routingAnalysisResponseSchema = z
  .object({
    taskId: z.string(),
    requiredCapabilities: z.array(capabilityIdSchema),
    allowedExecutionTrust: z.array(executionTrustSchema),
    candidates: z.array(routingCandidateSchema),
    recommendedAdapterId: z.string().optional(),
    explanation: z.string(),
    generatedAt: z.string(),
  })
  .strict();
export type RoutingAnalysisResponse = z.infer<typeof routingAnalysisResponseSchema>;

export const routeAndAssignResponseSchema = z
  .object({
    record: taskRecordSchema,
    routingExplanation: z.string(),
    generatedAt: z.string(),
  })
  .strict();
export type RouteAndAssignResponse = z.infer<typeof routeAndAssignResponseSchema>;

const requestValidationIssueSchema = z.object({ path: z.string(), message: z.string() }).strict();

export const errorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.array(requestValidationIssueSchema).optional(),
      })
      .strict(),
  })
  .strict();
export type ErrorResponseBody = z.infer<typeof errorResponseSchema>;

/**
 * Hall-Core-specific wrapper envelopes around the shared, provider-neutral
 * `communicationBoardSchema`/`communicationMessageSchema` from
 * `@hall-of-wisdom/protocol` — this one HTTP API's response shapes, not
 * part of the cross-process communication contract itself.
 */
export const listBoardsResponseSchema = z
  .object({ boards: z.array(communicationBoardSchema) })
  .strict();
export type ListBoardsResponse = z.infer<typeof listBoardsResponseSchema>;

export const ensureBoardResponseSchema = z
  .object({
    board: communicationBoardSchema,
    messagesPath: z.string(),
    livePath: z.string(),
  })
  .strict();
export type EnsureBoardResponse = z.infer<typeof ensureBoardResponseSchema>;

export const listBoardMessagesResponseSchema = z
  .object({ messages: z.array(communicationMessageSchema) })
  .strict();
export type ListBoardMessagesResponse = z.infer<typeof listBoardMessagesResponseSchema>;

/**
 * Phase 12 — controlled multi-agent execution comparison. Mirrors
 * `apps/server/src/comparisons/comparison-record.ts` field-for-field —
 * that file is the single source of truth; every schema below reproduces
 * its shapes and status enums exactly, following this file's own
 * established hand-mirroring convention. `ComparisonCandidateRecord` has
 * no path field at all on the server (worktree paths are kept in a
 * private, non-serialized map) — this schema, by construction, can never
 * accept or forward one either.
 */
export const comparisonStatusSchema = z.enum([
  "draft",
  "preparing",
  "ready",
  "running",
  "partially_completed",
  "completed",
  "failed",
  "cancelled",
  "cleaning",
  "cleaned",
]);
export type ComparisonStatus = z.infer<typeof comparisonStatusSchema>;

export const candidateStatusSchema = z.enum([
  "pending",
  "prepared",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type CandidateStatus = z.infer<typeof candidateStatusSchema>;

export const cleanupStatusSchema = z.enum(["not_started", "in_progress", "completed", "failed"]);
export type CleanupStatus = z.infer<typeof cleanupStatusSchema>;

export const changedFileEntrySchema = z
  .object({
    relativePath: z.string().max(4096),
    changeType: z.enum(["added", "modified", "deleted", "renamed"]),
    additions: z.number().int().min(0),
    deletions: z.number().int().min(0),
  })
  .strict();
export type ChangedFileEntry = z.infer<typeof changedFileEntrySchema>;

export const candidateResultEvidenceSchema = z
  .object({
    changedFiles: z.array(changedFileEntrySchema).max(500),
    totalAdditions: z.number().int().min(0),
    totalDeletions: z.number().int().min(0),
    /** Unified diff text, bounded server-side; omitted entirely if there were no changes. */
    boundedDiff: z.string().max(200_000).optional(),
    truncated: z.boolean(),
  })
  .strict();
export type CandidateResultEvidence = z.infer<typeof candidateResultEvidenceSchema>;

export const comparisonCandidateRecordSchema = z
  .object({
    candidateId: z.string(),
    adapterId: z.string(),
    displayName: z.string(),
    status: candidateStatusSchema,
    executionTrust: executionTrustSchema.optional(),
    runId: z.string().optional(),
    agentId: z.string().optional(),
    createdAt: z.string(),
    preparedAt: z.string().optional(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    eventCount: z.number(),
    lastSequence: z.number().optional(),
    terminalEventType: terminalEventTypeSchema.optional(),
    failure: structuredFailureSchema.optional(),
    cancellationRequested: z.boolean(),
    resultEvidence: candidateResultEvidenceSchema.optional(),
    /** A safe, bounded, non-path failure reason for `preparing`-stage failures. */
    safeFailureReason: z.string().optional(),
  })
  .strict();
export type ComparisonCandidateRecord = z.infer<typeof comparisonCandidateRecordSchema>;

export const comparisonPreferenceSchema = z
  .object({
    candidateId: z.string(),
    note: z.string().optional(),
    recordedAt: z.string(),
  })
  .strict();
export type ComparisonPreference = z.infer<typeof comparisonPreferenceSchema>;

export const agentComparisonRecordSchema = z
  .object({
    comparisonId: z.string(),
    sourceTaskId: z.string(),
    title: z.string(),
    description: z.string(),
    priority: taskPrioritySchema,
    requirements: taskRequirementsSchema.optional(),
    baseCommit: z.string().optional(),
    status: comparisonStatusSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    preparedAt: z.string().optional(),
    candidates: z.tuple([comparisonCandidateRecordSchema, comparisonCandidateRecordSchema]),
    cleanupStatus: cleanupStatusSchema,
    cleanupError: z.string().optional(),
    /** A stable, machine-checkable code for a `preparing`-stage failure that is not specific to either candidate (e.g. no source working directory, or a dirty source repository). */
    prepareFailureCode: z.string().optional(),
    /** A safe, bounded, path-free reason paired with `prepareFailureCode`. */
    prepareFailureReason: z.string().optional(),
    preference: comparisonPreferenceSchema.optional(),
  })
  .strict();
export type AgentComparisonRecord = z.infer<typeof agentComparisonRecordSchema>;

export const listComparisonsResponseSchema = z
  .object({ comparisons: z.array(agentComparisonRecordSchema) })
  .strict();
export type ListComparisonsResponse = z.infer<typeof listComparisonsResponseSchema>;

export const cancelComparisonCandidateResponseSchema = z
  .object({
    comparisonId: z.string(),
    candidateId: z.string(),
    cancellationRequested: z.literal(true),
    alreadyRequested: z.boolean(),
  })
  .strict();
export type CancelComparisonCandidateResponse = z.infer<
  typeof cancelComparisonCandidateResponseSchema
>;

/**
 * Phase 14 — the CEO Agent control plane. The `CeoPlan`/`CeoPlanVersion`/
 * `CeoApproval`/`CeoPlanEvent` shapes themselves come straight from
 * `@hall-of-wisdom/protocol` (re-exported above) — this section covers
 * only Hall Core's own wire envelopes and the two shapes that exist
 * purely server-side and have no protocol-package schema of their own:
 * derived plan progress (`ceo-plan-progress.ts`) and a delegation link
 * (`ceo-plan-store-port.ts`'s `DelegationLink`). Mirrors both field-for-
 * field, following this file's established hand-mirroring convention.
 */
export const ceoPlanStepProgressStatusSchema = z.enum([
  "waiting_for_dependencies",
  "ready_to_start",
  "running",
  "completed",
  "failed",
  "cancelled",
  "blocked",
]);
export type CeoPlanStepProgressStatus = z.infer<typeof ceoPlanStepProgressStatusSchema>;

export const ceoPlanStepProgressSchema = z
  .object({
    stepId: z.string(),
    childTaskId: z.string().optional(),
    status: ceoPlanStepProgressStatusSchema,
  })
  .strict();
export type CeoPlanStepProgress = z.infer<typeof ceoPlanStepProgressSchema>;

export const ceoPlanProgressSummarySchema = z
  .object({
    totalSteps: z.number(),
    completed: z.number(),
    running: z.number(),
    failed: z.number(),
    cancelled: z.number(),
    blocked: z.number(),
    notStarted: z.number(),
    steps: z.array(ceoPlanStepProgressSchema),
  })
  .strict();
export type CeoPlanProgressSummary = z.infer<typeof ceoPlanProgressSummarySchema>;

export const ceoDelegationLinkSchema = z
  .object({
    planId: z.string(),
    planVersion: z.number(),
    stepId: z.string(),
    childTaskId: z.string(),
    adapterId: z.string(),
    delegatedAt: z.string(),
  })
  .strict();
export type CeoDelegationLink = z.infer<typeof ceoDelegationLinkSchema>;

export const createCeoPlanResponseSchema = z
  .object({ plan: ceoPlanSchema, version: ceoPlanVersionSchema })
  .strict();
export type CreateCeoPlanResponse = z.infer<typeof createCeoPlanResponseSchema>;

export const getCeoPlanResponseSchema = z
  .object({
    plan: ceoPlanSchema,
    progress: ceoPlanProgressSummarySchema,
    links: z.array(ceoDelegationLinkSchema),
    /** Phase 14.1 — an opaque optimistic-concurrency token to echo back as `expectedMutationToken` on the next mutating call. Never the plan's internal `revision` integer, and never a `CeoPlanVersion`'s private `internalRevision` either. */
    mutationToken: z.string(),
  })
  .strict();
export type GetCeoPlanResponse = z.infer<typeof getCeoPlanResponseSchema>;

export const listCeoPlansResponseSchema = z.object({ plans: z.array(ceoPlanSchema) }).strict();
export type ListCeoPlansResponse = z.infer<typeof listCeoPlansResponseSchema>;

export const deleteCeoPlanResponseSchema = z.object({ deleted: z.literal(true) }).strict();
export type DeleteCeoPlanResponse = z.infer<typeof deleteCeoPlanResponseSchema>;

export const listCeoPlanVersionsResponseSchema = z
  .object({ versions: z.array(ceoPlanVersionSchema) })
  .strict();
export type ListCeoPlanVersionsResponse = z.infer<typeof listCeoPlanVersionsResponseSchema>;

export const listCeoApprovalsResponseSchema = z
  .object({ approvals: z.array(ceoApprovalSchema) })
  .strict();
export type ListCeoApprovalsResponse = z.infer<typeof listCeoApprovalsResponseSchema>;

export const listCeoPlanEventsResponseSchema = z
  .object({ events: z.array(ceoPlanEventSchema) })
  .strict();
export type ListCeoPlanEventsResponse = z.infer<typeof listCeoPlanEventsResponseSchema>;

export const decideCeoPlanApprovalResponseSchema = z
  .object({ plan: ceoPlanSchema, approval: ceoApprovalSchema })
  .strict();
export type DecideCeoPlanApprovalResponse = z.infer<typeof decideCeoPlanApprovalResponseSchema>;

export const delegateCeoPlanResponseSchema = z
  .object({
    plan: ceoPlanSchema,
    links: z.array(ceoDelegationLinkSchema),
    childTasks: z.array(taskRecordSchema),
  })
  .strict();
export type DelegateCeoPlanResponse = z.infer<typeof delegateCeoPlanResponseSchema>;
