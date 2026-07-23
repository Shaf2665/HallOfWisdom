import { z } from "zod";
import {
  agentCapabilitiesSchema,
  capabilityIdSchema,
  capabilityObservationSchema,
  communicationBoardSchema,
  communicationMessageSchema,
  executionTrustSchema,
  hallTaskSchema,
  structuredFailureSchema,
} from "@hall-of-wisdom/protocol";

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
    availability: availabilityStatusSchema,
    // Phase 10.2 — present only when availability is "available"; a
    // small, fixed, adapter-authored caveat about that otherwise-normal
    // result (e.g. Codex's trusted-local bypass notice). Never present
    // for any other availability value. See apps/server's adapters.ts.
    limitationNotice: z.string().optional(),
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
