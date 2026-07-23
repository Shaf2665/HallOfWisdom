import { z } from "zod";
import {
  boundedNonBlankString,
  nonEmptyIdSchema,
  taskPrioritySchema,
  taskRequirementsSchema,
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
const workingDirectorySchema = z
  .string()
  .min(1, "must not be blank")
  .max(4096, "must not exceed 4096 characters");

const sharedTaskFields = {
  projectId: nonEmptyIdSchema,
  title: boundedNonBlankString(200),
  description: z.string().max(20000).optional(),
  priority: taskPrioritySchema.optional(),
} as const;

/**
 * Preserves Phase 6 behavior exactly: `adapterId` required, task starts
 * asynchronously, response is `202 Accepted`. `executionMode` is optional
 * here (defaulting to `"immediate"`) only so a request that never
 * mentions it at all — every existing client and test — keeps working
 * unchanged; see the `z.preprocess` below for how an entirely-absent
 * `executionMode` is defaulted before this union ever runs.
 */
const immediateCreateTaskRequestSchema = z
  .object({
    ...sharedTaskFields,
    executionMode: z.literal("immediate"),
    adapterId: nonEmptyIdSchema,
    workingDirectory: workingDirectorySchema.optional(),
  })
  .strict();

/**
 * A planning-only task: no adapter, no run, no execution. `adapterId` is
 * deliberately absent from this schema's shape (not merely optional) —
 * `.strict()` rejects it outright if a client sends one, since an adapter
 * on a task that isn't executing yet is meaningless and could otherwise
 * look like a promise this endpoint doesn't keep. Mock Agent scenario
 * selection has no place in either branch of this schema: it is, and
 * remains, server-startup-only configuration (see
 * `docs/architecture/0004-hall-core-server.md`, "Mock scenario
 * documentation"). `requirements` (Phase 11) is optional, deferred-only
 * (a running/immediate task has no routing decision left to make), and
 * flows straight through to `HallTask.requirements` — see
 * `docs/architecture/0011-agent-capabilities-trust-and-routing.md`.
 */
const deferredCreateTaskRequestSchema = z
  .object({
    ...sharedTaskFields,
    executionMode: z.literal("deferred"),
    workingDirectory: workingDirectorySchema.optional(),
    requirements: taskRequirementsSchema.optional(),
  })
  .strict();

/**
 * `executionMode` is defaulted to `"immediate"` up front, before the
 * discriminated union runs, so a request that omits it entirely (every
 * existing Phase 6 caller) is treated identically to one that sends
 * `"immediate"` explicitly — and still gets the clear, branch-specific
 * validation errors `z.discriminatedUnion` produces (e.g. "adapterId
 * required") rather than the harder-to-read combined-branch errors a
 * plain `z.union` of two independent object schemas would produce.
 */
export const createTaskRequestSchema = z.preprocess(
  (raw) => {
    if (raw !== null && typeof raw === "object" && !("executionMode" in raw)) {
      return { ...raw, executionMode: "immediate" };
    }
    return raw;
  },
  z.discriminatedUnion("executionMode", [
    immediateCreateTaskRequestSchema,
    deferredCreateTaskRequestSchema,
  ]),
);

export type ImmediateCreateTaskRequest = z.infer<typeof immediateCreateTaskRequestSchema>;
export type DeferredCreateTaskRequest = z.infer<typeof deferredCreateTaskRequestSchema>;
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

export const assignTaskRequestSchema = z
  .object({
    adapterId: nonEmptyIdSchema,
    workingDirectory: workingDirectorySchema.optional(),
  })
  .strict();
export type AssignTaskRequest = z.infer<typeof assignTaskRequestSchema>;
