import type { CeoPlannerInput, CeoPlannerPort, CeoPlannerResult } from "./ceo-planner-port.js";
import { recommendStepAdapter } from "./ceo-plan-routing.js";

export const SCRIPTED_CEO_PLANNER_ID = "ceo_planner.scripted-test";

/** `exactOptionalPropertyTypes` forbids assigning `recommendedAdapterId: undefined` outright — this omits the key entirely when there is no recommendation. */
function optionalRecommendedAdapter(
  adapterId: string | undefined,
): { recommendedAdapterId: string } | Record<string, never> {
  return adapterId !== undefined ? { recommendedAdapterId: adapterId } : {};
}

/**
 * Test-only planner satisfying `CeoPlannerPort` without any template
 * logic of its own — always proposes one fixed, minimal two-step plan
 * (unless the parent task has no description, in which case it blocks,
 * exactly like the deterministic planner) so the shared contract suite in
 * `ceo-planner-contract.ts` can run unmodified against it. Real adapter
 * recommendation still goes through `recommendStepAdapter` — the same
 * shared, pure routing function the deterministic planner uses — so the
 * contract's eligibility invariants are exercised for real, not stubbed
 * out.
 */
export function createScriptedCeoPlanner(): CeoPlannerPort {
  return {
    plannerId: SCRIPTED_CEO_PLANNER_ID,
    generatePlan(input: CeoPlannerInput): CeoPlannerResult {
      if (input.parentTask.description.trim().length === 0) {
        return { kind: "blocked", reason: "Scripted planner: no description to plan from." };
      }
      const routing = recommendStepAdapter(input.parentTask.requirements, input.routingCandidates);
      const requirements = input.parentTask.requirements;
      return {
        kind: "plan",
        draft: {
          objective: `Scripted objective for "${input.parentTask.title}".`,
          summary: "Scripted two-step plan.",
          assumptions: [],
          constraints: [],
          steps: [
            {
              title: "Scripted step one",
              objective: "Scripted objective one.",
              boundedInstructions: "Scripted instructions one.",
              acceptanceCriteria: ["Scripted acceptance one."],
              dependsOnStepIndex: [],
              ...(requirements !== undefined ? { requirements } : {}),
              ...optionalRecommendedAdapter(routing.recommendedAdapterId),
              routingSummary: routing.routingSummary,
            },
            {
              title: "Scripted step two",
              objective: "Scripted objective two.",
              boundedInstructions: "Scripted instructions two.",
              acceptanceCriteria: ["Scripted acceptance two."],
              dependsOnStepIndex: [0],
              ...(requirements !== undefined ? { requirements } : {}),
              ...optionalRecommendedAdapter(routing.recommendedAdapterId),
              routingSummary: routing.routingSummary,
            },
          ],
        },
      };
    },
  };
}
