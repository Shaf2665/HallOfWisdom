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
