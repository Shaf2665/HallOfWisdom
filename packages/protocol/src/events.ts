import { z } from "zod";
import { boundedNonBlankString, isoTimestampSchema, nonEmptyIdSchema } from "./ids.js";
import { parseWithSchema, structuredFailureSchema } from "./errors.js";
import { protocolVersionSchema } from "./version.js";

export const fileChangeOperationSchema = z.enum(["created", "modified", "deleted"]);
export type FileChangeOperation = z.infer<typeof fileChangeOperationSchema>;

export const approvalRiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export type ApprovalRiskLevel = z.infer<typeof approvalRiskLevelSchema>;

/**
 * Fields shared by every normalized event. `sequence` is a required,
 * non-negative integer so Hall Core can order events and detect duplicates
 * after a WebSocket reconnect, without depending on delivery order or
 * wall-clock timestamps (which can collide or arrive out of order).
 */
const eventEnvelopeShape = {
  protocolVersion: protocolVersionSchema,
  eventId: nonEmptyIdSchema,
  runId: nonEmptyIdSchema,
  taskId: nonEmptyIdSchema,
  agentId: nonEmptyIdSchema,
  timestamp: isoTimestampSchema,
  sequence: z.number().int().nonnegative(),
};

export const runStartedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("run.started"),
    payload: z.object({}).strict(),
  })
  .strict();
export type RunStartedEvent = z.infer<typeof runStartedEventSchema>;

export const messageDeltaEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("message.delta"),
    payload: z
      .object({
        text: z.string().max(20000, "text must not exceed 20000 characters"),
      })
      .strict(),
  })
  .strict();
export type MessageDeltaEvent = z.infer<typeof messageDeltaEventSchema>;

export const toolStartedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("tool.started"),
    payload: z
      .object({
        toolCallId: nonEmptyIdSchema,
        toolName: z.string().min(1).max(200, "toolName must not exceed 200 characters"),
      })
      .strict(),
  })
  .strict();
export type ToolStartedEvent = z.infer<typeof toolStartedEventSchema>;

export const toolCompletedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("tool.completed"),
    payload: z
      .object({
        toolCallId: nonEmptyIdSchema,
        toolName: z.string().min(1).max(200, "toolName must not exceed 200 characters"),
        success: z.boolean(),
        output: z.string().max(20000, "output must not exceed 20000 characters").optional(),
      })
      .strict(),
  })
  .strict();
export type ToolCompletedEvent = z.infer<typeof toolCompletedEventSchema>;

export const fileChangedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("file.changed"),
    payload: z
      .object({
        path: z.string().min(1).max(1024, "path must not exceed 1024 characters"),
        operation: fileChangeOperationSchema,
      })
      .strict(),
  })
  .strict();
export type FileChangedEvent = z.infer<typeof fileChangedEventSchema>;

export const approvalRequiredEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("approval.required"),
    payload: z
      .object({
        reason: z.string().min(1).max(2000, "reason must not exceed 2000 characters"),
        riskLevel: approvalRiskLevelSchema,
      })
      .strict(),
  })
  .strict();
export type ApprovalRequiredEvent = z.infer<typeof approvalRequiredEventSchema>;

export const runCompletedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("run.completed"),
    payload: z
      .object({
        summary: z.string().max(20000, "summary must not exceed 20000 characters").optional(),
      })
      .strict(),
  })
  .strict();
export type RunCompletedEvent = z.infer<typeof runCompletedEventSchema>;

export const runFailedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("run.failed"),
    payload: z
      .object({
        failure: structuredFailureSchema,
      })
      .strict(),
  })
  .strict();
export type RunFailedEvent = z.infer<typeof runFailedEventSchema>;

export const cancelledBySchema = z.enum(["user", "orchestrator", "system"]);
export type CancelledBy = z.infer<typeof cancelledBySchema>;

export const runCancelledEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("run.cancelled"),
    payload: z
      .object({
        cancelledBy: cancelledBySchema,
        reason: boundedNonBlankString(2000).optional(),
      })
      .strict(),
  })
  .strict();
export type RunCancelledEvent = z.infer<typeof runCancelledEventSchema>;

/**
 * `run.completed`, `run.failed`, and `run.cancelled` are the three terminal
 * events for a run: once one of them has been emitted, no further events
 * should follow for that run. This package only defines the event shapes;
 * it does not enforce "exactly one terminal event" or "no events after
 * termination" — that ordering/lifecycle rule belongs to the agent adapter
 * SDK (which produces the events) and Hall Core (which consumes them).
 */
export const normalizedAgentEventSchema = z.discriminatedUnion("type", [
  runStartedEventSchema,
  messageDeltaEventSchema,
  toolStartedEventSchema,
  toolCompletedEventSchema,
  fileChangedEventSchema,
  approvalRequiredEventSchema,
  runCompletedEventSchema,
  runFailedEventSchema,
  runCancelledEventSchema,
]);

export type NormalizedAgentEvent = z.infer<typeof normalizedAgentEventSchema>;

export function parseNormalizedAgentEvent(input: unknown): NormalizedAgentEvent {
  return parseWithSchema(normalizedAgentEventSchema, input, "NormalizedAgentEvent");
}

export function parseRunStartedEvent(input: unknown): RunStartedEvent {
  return parseWithSchema(runStartedEventSchema, input, "RunStartedEvent");
}

export function parseMessageDeltaEvent(input: unknown): MessageDeltaEvent {
  return parseWithSchema(messageDeltaEventSchema, input, "MessageDeltaEvent");
}

export function parseToolStartedEvent(input: unknown): ToolStartedEvent {
  return parseWithSchema(toolStartedEventSchema, input, "ToolStartedEvent");
}

export function parseToolCompletedEvent(input: unknown): ToolCompletedEvent {
  return parseWithSchema(toolCompletedEventSchema, input, "ToolCompletedEvent");
}

export function parseFileChangedEvent(input: unknown): FileChangedEvent {
  return parseWithSchema(fileChangedEventSchema, input, "FileChangedEvent");
}

export function parseApprovalRequiredEvent(input: unknown): ApprovalRequiredEvent {
  return parseWithSchema(approvalRequiredEventSchema, input, "ApprovalRequiredEvent");
}

export function parseRunCompletedEvent(input: unknown): RunCompletedEvent {
  return parseWithSchema(runCompletedEventSchema, input, "RunCompletedEvent");
}

export function parseRunFailedEvent(input: unknown): RunFailedEvent {
  return parseWithSchema(runFailedEventSchema, input, "RunFailedEvent");
}

export function parseRunCancelledEvent(input: unknown): RunCancelledEvent {
  return parseWithSchema(runCancelledEventSchema, input, "RunCancelledEvent");
}
