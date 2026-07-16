import { z } from "zod";
import {
  agentCapabilitiesSchema,
  hallTaskSchema,
  structuredFailureSchema,
} from "@hall-of-wisdom/protocol";

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

export const taskRecordSchema = z
  .object({
    task: hallTaskSchema,
    runId: z.string(),
    adapterId: z.string(),
    agentId: z.string(),
    eventCount: z.number(),
    lastSequence: z.number().optional(),
    terminalEventType: terminalEventTypeSchema.optional(),
    failure: structuredFailureSchema.optional(),
    cancellationRequested: z.boolean(),
    createdAt: z.string(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
  })
  .strict();
export type TaskRecord = z.infer<typeof taskRecordSchema>;

export const createTaskResponseSchema = taskRecordSchema.extend({
  eventsPath: z.string(),
});
export type CreateTaskResponse = z.infer<typeof createTaskResponseSchema>;

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
  })
  .strict();
export type AdapterSummary = z.infer<typeof adapterSummarySchema>;

export const listAdaptersResponseSchema = z
  .object({ adapters: z.array(adapterSummarySchema) })
  .strict();

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
