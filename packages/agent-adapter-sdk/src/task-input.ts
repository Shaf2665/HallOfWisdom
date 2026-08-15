import { z } from "zod";
import {
  agentIdentitySchema,
  attachmentFilenameSchema,
  attachmentKindSchema,
  attachmentMimeTypeSchema,
  boundedNonBlankString,
  hallTaskSchema,
  nonEmptyIdSchema,
  parseWithSchema,
  safeDetailsSchema,
} from "@hall-of-wisdom/protocol";

/**
 * Per-execution cap on how many attachments Hall will materialize into an
 * agent's isolated worktree, and their combined size — see
 * `TaskAttachmentMaterializer` in Hall Core. Exceeding either bound fails
 * the execution clearly (`ATTACHMENT_MATERIALIZATION_LIMIT_EXCEEDED`)
 * rather than silently dropping attachments past the limit.
 */
export const MAX_TASK_ATTACHMENTS = 20;
export const MAX_TASK_ATTACHMENTS_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * One materialized attachment, as an adapter sees it: a safe path relative
 * to `AgentTaskInput.workingDirectory` (never an absolute host path), plus
 * the same display metadata already carried by `MessageAttachment`.
 * `relativePath`/`filename`/`mimeType`/`kind` are all built from
 * already-validated data (a server-generated UUID attachment id and the
 * upload-time-validated filename) — nothing here is a fresh sanitization
 * boundary.
 */
export const taskAttachmentManifestEntrySchema = z
  .object({
    relativePath: boundedNonBlankString(600),
    filename: attachmentFilenameSchema,
    mimeType: attachmentMimeTypeSchema,
    kind: attachmentKindSchema,
  })
  .strict();

export type TaskAttachmentManifestEntry = z.infer<typeof taskAttachmentManifestEntrySchema>;

/**
 * Input an adapter receives when starting a task.
 *
 * `workingDirectory` is intentionally just a bounded string: this SDK does
 * not touch the filesystem and does not validate that the path exists, is
 * absolute, or is safe to use. That validation — including path traversal
 * checks — is Hall Runner's responsibility, performed before an adapter is
 * ever invoked, so it happens exactly once in one trusted place rather
 * than being duplicated (or forgotten) inside every adapter.
 *
 * `metadata` reuses the protocol package's `safeDetailsSchema` (bounded,
 * flat primitives, capped key count) for the same reason as elsewhere in
 * Hall: it bounds shape and size, not meaning. It must never contain
 * provider credentials or raw environment variable values — that is a
 * caller obligation this schema cannot enforce by itself.
 *
 * `attachments` is omitted entirely (never an empty array) when a task has
 * none — this is what keeps every existing text-only `AgentTaskInput`
 * payload unchanged. Populated only by `TaskOrchestrator`, from files it
 * has itself materialized into the task's isolated worktree; never
 * constructed from unvalidated caller input.
 */
export const agentTaskInputSchema = z
  .object({
    hallTask: hallTaskSchema,
    agentIdentity: agentIdentitySchema,
    runId: nonEmptyIdSchema,
    workingDirectory: boundedNonBlankString(4096),
    sessionId: nonEmptyIdSchema.optional(),
    metadata: safeDetailsSchema.optional(),
    attachments: z
      .array(taskAttachmentManifestEntrySchema)
      .min(1)
      .max(MAX_TASK_ATTACHMENTS)
      .optional(),
  })
  .strict();

export type AgentTaskInput = z.infer<typeof agentTaskInputSchema>;

export function parseAgentTaskInput(input: unknown): AgentTaskInput {
  return parseWithSchema(agentTaskInputSchema, input, "AgentTaskInput");
}
