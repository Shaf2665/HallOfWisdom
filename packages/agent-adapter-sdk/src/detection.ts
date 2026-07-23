import { z } from "zod";
import {
  boundedNonBlankString,
  capabilityObservationSchema,
  executionTrustSchema,
  parseWithSchema,
} from "@hall-of-wisdom/protocol";

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
    /**
     * Phase 11 — provider-neutral, server-derived execution-trust
     * classification (see `packages/protocol`'s `capability.ts`). Optional
     * at the schema level only so pre-Phase-11 test fakes that never set
     * it keep compiling; every real adapter's `detect()` always populates
     * it as a business rule enforced by that adapter's own tests, not by
     * this schema. Never accepted from browser input anywhere in this
     * codebase — always computed here, inside `detect()`.
     */
    executionTrust: executionTrustSchema.optional(),
    /**
     * Phase 11 — bounded, per-capability runtime observations for this
     * machine, right now. Optional for the same pre-existing-fake reason
     * as `executionTrust`. See `CapabilityObservation`'s doc comment for
     * what `safeSummary` may and may not contain.
     */
    capabilityObservations: capabilityObservationSchema
      .array()
      .max(8, "must not exceed 8 capability observations")
      .optional(),
    /**
     * Phase 11 — bounded, hand-authored safety caveats surfaced to the
     * operator (e.g. Codex trusted-local's sandbox-bypass warning). Never
     * raw process output — same discipline as `diagnosticMessage`.
     */
    limitations: boundedNonBlankString(300)
      .array()
      .max(6, "must not exceed 6 limitations")
      .optional(),
  })
  .strict();

export type AgentDetectionResult = z.infer<typeof agentDetectionResultSchema>;

export function parseAgentDetectionResult(input: unknown): AgentDetectionResult {
  return parseWithSchema(agentDetectionResultSchema, input, "AgentDetectionResult");
}
