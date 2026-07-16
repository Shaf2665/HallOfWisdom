import { z } from "zod";
import { taskStatusSchema } from "@hall-of-wisdom/protocol";

/**
 * `POST /api/v1/tasks/:taskId/transition`'s request body. Accepts any
 * `TaskStatus` value at the schema layer — whether the specific
 * `targetStatus` is actually a permitted *manual* destination from the
 * task's *current* status is a business rule checked afterward
 * (`isManualTransitionAllowed` in `tasks/task-status-transitions.ts`), not
 * something this shape-only schema can express.
 */
export const transitionTaskRequestSchema = z.object({ targetStatus: taskStatusSchema }).strict();
export type TransitionTaskRequest = z.infer<typeof transitionTaskRequestSchema>;
