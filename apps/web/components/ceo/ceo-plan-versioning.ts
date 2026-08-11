import type { CeoPlanStepEditInput } from "../../lib/api-client";
import type { CeoPlanVersion } from "../../lib/api-schemas";

export type AgentSelections = Readonly<Record<string, string | undefined>>;

export function stepsWithAgentChoices(
  version: CeoPlanVersion,
  selections: AgentSelections,
): readonly CeoPlanStepEditInput[] {
  return version.steps.map((step) => {
    const selectedAdapterId = Object.prototype.hasOwnProperty.call(selections, step.id)
      ? selections[step.id]
      : step.selectedAdapterId;
    return {
      id: step.id,
      position: step.position,
      title: step.title,
      objective: step.objective,
      boundedInstructions: step.boundedInstructions,
      acceptanceCriteria: step.acceptanceCriteria,
      dependencies: step.dependencies,
      ...(step.requirements !== undefined ? { requirements: step.requirements } : {}),
      ...(selectedAdapterId !== undefined ? { selectedAdapterId } : {}),
    };
  });
}
