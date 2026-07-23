import { z } from "zod";
import { boundedNonBlankString, isoTimestampSchema, nonEmptyIdSchema } from "./ids.js";
import { parseWithSchema } from "./errors.js";
import { taskRequirementsSchema } from "./capability.js";

export const taskPrioritySchema = z.enum(["low", "normal", "high", "critical"]);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

export const taskStatusSchema = z.enum([
  "backlog",
  "ready",
  "assigned",
  "running",
  "reviewing",
  "waiting_for_approval",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const hallTaskSchema = z
  .object({
    taskId: nonEmptyIdSchema,
    projectId: nonEmptyIdSchema,
    title: boundedNonBlankString(200),
    description: z.string().max(20000, "description must not exceed 20000 characters"),
    priority: taskPrioritySchema,
    status: taskStatusSchema,
    assignedAgentId: nonEmptyIdSchema.optional(),
    reviewerAgentId: nonEmptyIdSchema.optional(),
    dependencyTaskIds: z.array(nonEmptyIdSchema).max(200, "must not exceed 200 dependencies"),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    /**
     * Phase 11 — optional, provider-neutral capability/trust requirements.
     * Omitted entirely for every task created before this phase and for
     * any task that never routes through the capability-matching flow —
     * `hallTaskSchema` stays valid without it, per the explicit
     * "existing tasks without requirements remain valid" requirement.
     */
    requirements: taskRequirementsSchema.optional(),
  })
  .strict();

export type HallTask = z.infer<typeof hallTaskSchema>;

export function parseHallTask(input: unknown): HallTask {
  return parseWithSchema(hallTaskSchema, input, "HallTask");
}
