import { z } from "zod";
import { isoTimestampSchema, nonEmptyIdSchema } from "./ids.js";
import { parseWithSchema, structuredFailureSchema } from "./errors.js";

/**
 * Run status is intentionally separate from task status: a single task can
 * span multiple runs (retries, resumed sessions), and a run's lifecycle
 * (queued -> starting -> running -> ...) does not map one-to-one onto the
 * task's broader workflow state (backlog -> ... -> completed).
 */
export const runStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "waiting_for_approval",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const agentRunSchema = z
  .object({
    runId: nonEmptyIdSchema,
    taskId: nonEmptyIdSchema,
    agentId: nonEmptyIdSchema,
    status: runStatusSchema,
    sessionId: nonEmptyIdSchema.optional(),
    createdAt: isoTimestampSchema,
    startedAt: isoTimestampSchema.optional(),
    completedAt: isoTimestampSchema.optional(),
    failure: structuredFailureSchema.optional(),
  })
  .strict();

export type AgentRun = z.infer<typeof agentRunSchema>;

export function parseAgentRun(input: unknown): AgentRun {
  return parseWithSchema(agentRunSchema, input, "AgentRun");
}
