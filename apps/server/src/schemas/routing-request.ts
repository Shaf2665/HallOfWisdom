import { z } from "zod";
import { taskRequirementsSchema } from "@hall-of-wisdom/protocol";

/**
 * `POST /api/v1/tasks/:taskId/routing-analysis` and `POST
 * .../route-and-assign`'s shared, optional request body. When
 * `requirements` is supplied it overrides (but never persists, for
 * `routing-analysis`) the task's own `requirements` for this one call —
 * lets the "Find suitable agent" dialog preview/route against a freshly
 * chosen profile even for a task that has no `requirements` saved yet.
 * When omitted, the task's own persisted `requirements` is used instead;
 * if neither exists, the caller gets `TaskRequirementsNotSetError`.
 */
export const routingRequestSchema = z
  .object({ requirements: taskRequirementsSchema.optional() })
  .strict();
export type RoutingRequest = z.infer<typeof routingRequestSchema>;
