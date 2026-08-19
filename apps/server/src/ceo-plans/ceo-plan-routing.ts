import type { TaskRequirements } from "@hall-of-wisdom/protocol";
import type { RoutingCandidateInput } from "../routing/routing-policy.js";
import { evaluateRouting } from "../routing/routing-policy.js";

export interface CeoStepRoutingResult {
  readonly recommendedAdapterId: string | undefined;
  readonly routingSummary: string;
}

/**
 * The one place a CEO plan step's adapter recommendation is computed —
 * used at plan-generation time (by the deterministic planner) and again,
 * unchanged, at approval-time review and delegation-time revalidation
 * (`ceo-plan-orchestrator.ts`), so "planning-time recommendations are
 * advisory, delegation-time eligibility is authoritative" (Phase 14
 * kickoff) is true by construction: every caller runs the exact same
 * `evaluateRouting` policy `routing-analysis`/`route-and-assign`/manual
 * assignment already use, just against whatever candidate list and
 * requirements are current at that call site. Never a second,
 * independently-reimplemented capability-matching algorithm.
 *
 * A step with no `requirements` at all gets no recommendation — the
 * planner must not guess at capability/trust constraints the task itself
 * never stated (Phase 14 kickoff, "must not pretend to understand
 * information it cannot derive").
 */
export function recommendStepAdapter(
  requirements: TaskRequirements | undefined,
  candidates: readonly RoutingCandidateInput[],
): CeoStepRoutingResult {
  if (requirements === undefined) {
    return {
      recommendedAdapterId: undefined,
      routingSummary:
        "No capability or execution-trust requirements are set on the parent task, so no adapter can be safely recommended for this step.",
    };
  }
  const routing = evaluateRouting(requirements, candidates);
  return {
    recommendedAdapterId: routing.recommendedAdapterId,
    routingSummary: routing.explanation,
  };
}

/**
 * Real execution-trust levels a vision-capable step can run under absent
 * any other, more specific constraint — mirrors `requirement-profiles.ts`'s
 * "real work" presets (`isolated` preferred, `trusted_local` allowed);
 * never `simulated` (no genuine vision execution) or `unavailable`.
 */
const DEFAULT_VISION_EXECUTION_TRUST: TaskRequirements["allowedExecutionTrust"] = [
  "isolated",
  "trusted_local",
];

/**
 * Issue #23 — a CEO plan step whose parent Gateway task carries an image
 * attachment must require `vision.image`, so `evaluateCandidateEligibility`
 * (via `recommendStepAdapter` at planning time, and `delegate()`'s own
 * revalidation) excludes any adapter without a *verified* observation for
 * it, exactly the same rule direct-task routing already enforces (see
 * `TaskOrchestrator#requirementsWithVisionIfImageAttached`). Unlike that
 * direct-task method, this one still synthesizes a fresh requirements
 * object when `requirements` was `undefined` — a CEO plan step always
 * needs *some* adapter selected, so it cannot opt out of capability-based
 * eligibility filtering the way a requirements-less direct task can. An
 * already-present `vision.image` is left as-is (idempotent), and a
 * requirements object already at the 9-capability cap is left unchanged —
 * `TaskAttachmentMaterializer`'s execution-time check remains the
 * authoritative, fail-closed guard regardless. Ordinary (non-image)
 * attachments never reach this function's `hasImageAttachment` parameter
 * as `true` — see `CeoPlanOrchestrator#hasImageAttachment`.
 */
export function withVisionRequirementForImage(
  requirements: TaskRequirements | undefined,
  hasImageAttachment: boolean,
): TaskRequirements | undefined {
  if (!hasImageAttachment) return requirements;
  if (requirements === undefined) {
    return {
      requiredCapabilities: ["vision.image"],
      allowedExecutionTrust: [...DEFAULT_VISION_EXECUTION_TRUST],
    };
  }
  if (requirements.requiredCapabilities.includes("vision.image")) return requirements;
  if (requirements.requiredCapabilities.length >= 9) return requirements;
  return {
    ...requirements,
    requiredCapabilities: [...requirements.requiredCapabilities, "vision.image"],
  };
}
