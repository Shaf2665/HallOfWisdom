import { z } from "zod";
import {
  agentIdentitySchema,
  boundedNonBlankString,
  hallTaskSchema,
  nonEmptyIdSchema,
  parseWithSchema,
  safeDetailsSchema,
} from "@hall-of-wisdom/protocol";

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
 */
export const agentTaskInputSchema = z
  .object({
    hallTask: hallTaskSchema,
    agentIdentity: agentIdentitySchema,
    runId: nonEmptyIdSchema,
    workingDirectory: boundedNonBlankString(4096),
    sessionId: nonEmptyIdSchema.optional(),
    metadata: safeDetailsSchema.optional(),
  })
  .strict();

export type AgentTaskInput = z.infer<typeof agentTaskInputSchema>;

export function parseAgentTaskInput(input: unknown): AgentTaskInput {
  return parseWithSchema(agentTaskInputSchema, input, "AgentTaskInput");
}
