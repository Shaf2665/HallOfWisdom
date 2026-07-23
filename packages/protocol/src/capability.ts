import { z } from "zod";
import { boundedNonBlankString } from "./ids.js";
import { parseWithSchema } from "./errors.js";

/**
 * Phase 11 — the bounded, provider-neutral vocabulary of task-relevant
 * capabilities Hall reasons about for routing. This is deliberately a
 * different, higher-level vocabulary than `AgentCapabilities` (streaming,
 * toolEvents, mcp, ...) in `agent-capabilities.ts`, which describes
 * integration mechanics an adapter implements; this one describes what a
 * task actually needs an agent to be able to do. Never a provider name.
 */
export const capabilityIdSchema = z.enum([
  "project.read",
  "project.edit",
  "command.execute",
  "git.inspect",
  "structured.events",
  "cancellation",
  "session.resume",
  "network.access",
]);
export type CapabilityId = z.infer<typeof capabilityIdSchema>;

const MAX_CAPABILITY_COUNT = 8;

/**
 * Shared by `TaskRequirements.requiredCapabilities` here and by
 * `AgentAdapterDescriptor.declaredCapabilities` in `agent-adapter-sdk` —
 * both are "a bounded, deduped list of capability ids," just for two
 * different purposes (what a task needs vs. what an adapter declares).
 */
export function dedupedCapabilityArray(message: string) {
  return z
    .array(capabilityIdSchema)
    .max(MAX_CAPABILITY_COUNT, `must not exceed ${String(MAX_CAPABILITY_COUNT)} capabilities`)
    .refine((values) => new Set(values).size === values.length, message);
}

/**
 * How confidently Hall can vouch for a capability observation. `verified`
 * and `restricted` are both backed by evidence; `declared` means the
 * adapter claims support but Hall has not independently confirmed it on
 * this machine; `unverified` and `unsupported` are the two "no" states —
 * `unsupported` when the adapter never claims the capability at all,
 * `unverified` when it does but nothing has confirmed it either way.
 */
export const capabilityStatusSchema = z.enum([
  "verified",
  "declared",
  "unverified",
  "restricted",
  "unsupported",
]);
export type CapabilityStatus = z.infer<typeof capabilityStatusSchema>;

/**
 * Provider-neutral execution-trust classification. Server-derived only —
 * see `agent-adapter-sdk`'s `AgentDetectionResult.executionTrust` doc
 * comment — never accepted from browser input. `simulated` and
 * `trusted_local` are not ranked "above"/"below" each other in a single
 * total order; routing's tie-break policy documents its own explicit
 * ordering rather than relying on enum declaration order to mean anything.
 */
export const executionTrustSchema = z.enum([
  "simulated",
  "isolated",
  "trusted_local",
  "unavailable",
]);
export type ExecutionTrust = z.infer<typeof executionTrustSchema>;

/**
 * Bounded, descriptive category for what actually backs a capability
 * observation. Deliberately not a full test log or transcript — see
 * `CapabilityObservation.safeSummary`'s doc comment for what belongs (and
 * does not belong) in the accompanying free-text summary.
 */
export const capabilityEvidenceCategorySchema = z.enum([
  "deterministic_test",
  "isolated_smoke_test",
  "browser_smoke_test",
  "environment_probe",
  "declared_only",
  "unavailable",
]);
export type CapabilityEvidenceCategory = z.infer<typeof capabilityEvidenceCategorySchema>;

/**
 * One capability's current, machine-specific status as reported by an
 * adapter's `detect()`. `safeSummary` is a short, hand-authored sentence —
 * never raw process output, a prompt, a fixture path, an executable path,
 * account data, or authentication output. See `agent-adapter-sdk`'s
 * `AgentDetectionResult` doc comment for the same discipline applied to
 * `diagnosticMessage`.
 */
export const capabilityObservationSchema = z
  .object({
    capability: capabilityIdSchema,
    status: capabilityStatusSchema,
    safeSummary: boundedNonBlankString(300),
    evidence: capabilityEvidenceCategorySchema,
  })
  .strict();
export type CapabilityObservation = z.infer<typeof capabilityObservationSchema>;

export function parseCapabilityObservation(input: unknown): CapabilityObservation {
  return parseWithSchema(capabilityObservationSchema, input, "CapabilityObservation");
}

/**
 * Optional, provider-neutral requirements a deferred task may carry.
 * `allowedExecutionTrust` is an explicit allow-list rather than a
 * "maximum" threshold: execution trust values are not a single strict
 * order (whether `simulated` is "more" or "less" trusted than
 * `trusted_local` depends on what the task is for), so only an explicit
 * list is unambiguous. Routing must never widen this list on a task's
 * behalf — see `routing-policy.ts` in `apps/server`.
 */
export const taskRequirementsSchema = z
  .object({
    requiredCapabilities: dedupedCapabilityArray(
      "must not list the same capability more than once",
    ),
    allowedExecutionTrust: z
      .array(executionTrustSchema)
      .min(1, "must allow at least one execution trust level")
      .max(4, "must not exceed the 4 known execution trust levels")
      .refine(
        (values) => new Set(values).size === values.length,
        "must not list the same execution trust level more than once",
      ),
  })
  .strict();
export type TaskRequirements = z.infer<typeof taskRequirementsSchema>;

export function parseTaskRequirements(input: unknown): TaskRequirements {
  return parseWithSchema(taskRequirementsSchema, input, "TaskRequirements");
}
