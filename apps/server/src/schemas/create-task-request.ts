import { z } from "zod";
import {
  boundedNonBlankString,
  nonEmptyIdSchema,
  taskPrioritySchema,
} from "@hall-of-wisdom/protocol";

/**
 * Reuses the protocol package's own bounded primitives (`nonEmptyIdSchema`,
 * `boundedNonBlankString`, `taskPrioritySchema`) rather than duplicating
 * `HallTask`'s validation rules. `.strict()` rejects unknown fields at
 * this trust boundary.
 *
 * `workingDirectory` is intentionally relative-only (validated further in
 * `TaskOrchestrator`, which resolves it against the server's configured
 * workspace root before ever reaching Hall Runner) — see
 * `docs/architecture/0004-hall-core-server.md` ("Why API requests cannot
 * choose arbitrary workspace roots").
 */
export const createTaskRequestSchema = z
  .object({
    projectId: nonEmptyIdSchema,
    title: boundedNonBlankString(200),
    description: z.string().max(20000).optional(),
    priority: taskPrioritySchema.optional(),
    adapterId: nonEmptyIdSchema,
    workingDirectory: z
      .string()
      .min(1, "must not be blank")
      .max(4096, "must not exceed 4096 characters")
      .optional(),
  })
  .strict();

export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;
