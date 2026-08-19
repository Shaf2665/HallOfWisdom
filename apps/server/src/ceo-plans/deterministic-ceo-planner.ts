import { MAX_STEP_TEXT_LENGTH } from "@hall-of-wisdom/protocol";
import type {
  CeoPlannerInput,
  CeoPlannerPlanDraft,
  CeoPlannerPort,
  CeoPlannerResult,
} from "./ceo-planner-port.js";
import { recommendStepAdapter, withAttachmentDerivedRequirements } from "./ceo-plan-routing.js";

/** `exactOptionalPropertyTypes` forbids assigning `recommendedAdapterId: undefined` outright — this omits the key entirely when there is no recommendation, exactly like every other optional field in this codebase. */
function optionalRecommendedAdapter(
  adapterId: string | undefined,
): { recommendedAdapterId: string } | Record<string, never> {
  return adapterId !== undefined ? { recommendedAdapterId: adapterId } : {};
}

export const DETERMINISTIC_CEO_PLANNER_ID = "ceo_planner.deterministic";

const TRUNCATION_MARKER = " … (truncated)";

/**
 * Cuts `text` down to fit inside `maxLength`, leaving room for
 * `TRUNCATION_MARKER` when a cut actually happens — never silently drops
 * the marker even when `text` is already exactly at the bound. This is
 * the only place this module ever shortens task-authored text; it never
 * paraphrases, summarizes, or otherwise rewrites it (Phase 14 kickoff:
 * "must not pretend to understand information it cannot derive").
 */
function truncateForBound(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const keep = Math.max(0, maxLength - TRUNCATION_MARKER.length);
  return text.slice(0, keep) + TRUNCATION_MARKER;
}

/**
 * Deterministic, rule-and-template CEO planner — the only planner Phase
 * 14 wires into production (`ceo-plan-composition.ts`). Produces a
 * generic three-step investigate/implement/verify plan built only from
 * fields the parent task actually carries: title, description, priority,
 * requirements, and an optional bounded operator instruction. It never
 * invents a file name, a shell command, a repository fact, a credential,
 * or an acceptance criterion more specific than what the task's own
 * description already states — every piece of task-specific text in the
 * output is either a direct (possibly truncated) copy of task-authored
 * text or one of a small number of fixed, generic template sentences that
 * make no claim about repository contents. See `ceo-planner-port.ts` for
 * why this is safe to later swap for a model-backed planner without
 * touching anything downstream.
 */
export function createDeterministicCeoPlanner(): CeoPlannerPort {
  return {
    plannerId: DETERMINISTIC_CEO_PLANNER_ID,
    generatePlan(input: CeoPlannerInput): CeoPlannerResult {
      const description = input.parentTask.description.trim();
      if (description.length === 0) {
        return {
          kind: "blocked",
          reason:
            "The parent task has no description. Add a description of what needs to be done — the CEO Agent does not fabricate scope it was not given — then ask it to plan again.",
        };
      }

      const title = input.parentTask.title;
      // Issue #23 (final correction) — the parent task's own requirements,
      // narrowed to isolated-only execution (and, for an image, also
      // requiring vision.image) when the parent's Communication Board
      // carries a human attachment (`withAttachmentDerivedRequirements`'s
      // doc comment). All three generic steps inherit the same original
      // user context, so all three carry the same requirements — see this
      // module's own doc comment on why that is safe for a generic,
      // non-semantic plan. A trust conflict (the task's own requirements
      // already exclude isolated) blocks the whole plan rather than
      // silently producing one no adapter could ever satisfy.
      const requirementsResult = withAttachmentDerivedRequirements(
        input.parentTask.requirements,
        input.attachmentSignal,
      );
      if (requirementsResult.kind === "blocked") {
        return { kind: "blocked", reason: requirementsResult.reason };
      }
      const requirements = requirementsResult.requirements;
      const routing = recommendStepAdapter(requirements, input.routingCandidates);
      const truncatedDescription = truncateForBound(description, MAX_STEP_TEXT_LENGTH - 80);

      const constraints: string[] = [`Priority: ${input.parentTask.priority}.`];
      if (input.planningInstructions !== undefined) {
        constraints.push(`Operator guidance: ${input.planningInstructions}`);
      }
      if (requirements === undefined) {
        constraints.push(
          "The parent task has no capability or execution-trust requirements set, so no step below carries an adapter recommendation.",
        );
      }
      if (input.attachmentSignal !== "none") {
        constraints.push(
          input.attachmentSignal === "image"
            ? "The parent task's Communication Board carries an image attachment, so every step below requires isolated execution and verified vision capability."
            : "The parent task's Communication Board carries an attachment, so every step below requires isolated execution.",
        );
      }

      const draft: CeoPlannerPlanDraft = {
        objective: truncateForBound(`Deliver: ${title}`, MAX_STEP_TEXT_LENGTH),
        summary: `A three-step investigate / implement / verify plan for "${title}".`,
        assumptions: [],
        constraints,
        steps: [
          {
            title: truncateForBound(`Investigate: ${title}`, 200),
            objective:
              "Understand what needs to change and confirm the scope described by the task.",
            boundedInstructions: `Review the task description and confirm the scope before making any change: ${truncatedDescription}`,
            acceptanceCriteria: [
              "The scope of the required change is understood and any open questions are written down.",
            ],
            dependsOnStepIndex: [],
            ...(requirements !== undefined ? { requirements } : {}),
            ...optionalRecommendedAdapter(routing.recommendedAdapterId),
            routingSummary: routing.routingSummary,
          },
          {
            title: truncateForBound(`Implement: ${title}`, 200),
            objective: "Implement the change described by the task.",
            boundedInstructions: `Implement the following, exactly as described, without expanding scope: ${truncatedDescription}`,
            acceptanceCriteria: [
              "The implementation satisfies the task's description.",
              "No files unrelated to the task's description are modified.",
            ],
            dependsOnStepIndex: [0],
            ...(requirements !== undefined ? { requirements } : {}),
            ...optionalRecommendedAdapter(routing.recommendedAdapterId),
            routingSummary: routing.routingSummary,
          },
          {
            title: truncateForBound(`Verify: ${title}`, 200),
            objective: "Verify the implementation is complete and correct.",
            boundedInstructions:
              "Confirm the Implement step's acceptance criteria are satisfied and that no existing behavior regressed.",
            acceptanceCriteria: [
              "Every acceptance criterion from the Implement step is satisfied.",
              "No regression is introduced.",
            ],
            dependsOnStepIndex: [1],
            ...(requirements !== undefined ? { requirements } : {}),
            ...optionalRecommendedAdapter(routing.recommendedAdapterId),
            routingSummary: routing.routingSummary,
          },
        ],
      };

      return { kind: "plan", draft };
    },
  };
}
