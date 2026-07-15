import { z } from "zod";
import { boundedNonBlankString, parseWithSchema } from "@hall-of-wisdom/protocol";

export const availabilityStatusSchema = z.enum([
  "available",
  "busy",
  "rate_limited",
  "logged_out",
  "offline",
  "unavailable",
  "unsupported",
]);
export type AvailabilityStatus = z.infer<typeof availabilityStatusSchema>;

/**
 * Result of asking an adapter "is your agent usable right now?". Never
 * carries credentials or authentication tokens — only whether the agent
 * is installed/available and a short, bounded diagnostic string.
 *
 * `diagnosticMessage` is bounded in length like every other free-text
 * field, but boundedness is not the same as safety: this schema has no
 * way to know whether a diagnostic string happens to contain a token or
 * other secret an adapter captured from process output. Adapters must not
 * put unredacted output into this field (see the protocol package's
 * `structuredFailureSchema` documentation for the same caveat applied to
 * failure details).
 */
export const agentDetectionResultSchema = z
  .object({
    installed: z.boolean(),
    executablePath: boundedNonBlankString(1024).optional(),
    detectedVersion: boundedNonBlankString(64).optional(),
    availability: availabilityStatusSchema,
    diagnosticMessage: boundedNonBlankString(500).optional(),
  })
  .strict();

export type AgentDetectionResult = z.infer<typeof agentDetectionResultSchema>;

export function parseAgentDetectionResult(input: unknown): AgentDetectionResult {
  return parseWithSchema(agentDetectionResultSchema, input, "AgentDetectionResult");
}
