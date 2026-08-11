"use client";

import { useEffect, useState } from "react";
import { getRoutingAnalysis, listAdapters } from "../../lib/api-client";
import type { CeoPlanStep } from "../../lib/api-schemas";

export interface AgentChoice {
  readonly id: string;
  readonly name: string;
}

export type AgentChoicesByStep = Readonly<Record<string, readonly AgentChoice[]>>;
export type AgentChoicesState = "loading" | "ready" | "error";

function sortedChoices(choices: readonly AgentChoice[]): readonly AgentChoice[] {
  return [...choices].sort((left, right) => left.name.localeCompare(right.name));
}

export function useCeoStepAgentChoices({
  baseUrl,
  parentTaskId,
  steps,
}: {
  readonly baseUrl: string;
  readonly parentTaskId: string;
  readonly steps: readonly CeoPlanStep[];
}): { readonly state: AgentChoicesState; readonly choices: AgentChoicesByStep } {
  const [state, setState] = useState<AgentChoicesState>("loading");
  const [choices, setChoices] = useState<AgentChoicesByStep>({});
  const stepsKey = steps
    .map(
      (step) =>
        `${step.id}:${step.selectedAdapterId ?? ""}:${step.recommendedAdapterId ?? ""}:${step.requirements?.requiredCapabilities.join(",") ?? ""}:${step.requirements?.allowedExecutionTrust.join(",") ?? ""}`,
    )
    .join("|");

  useEffect(() => {
    const controller = new AbortController();
    const needsUnscopedChoices = steps.some((step) => step.requirements === undefined);
    const unscopedChoicesRequest = needsUnscopedChoices
      ? listAdapters(baseUrl, { signal: controller.signal }).then(({ adapters }) =>
          sortedChoices(
            adapters
              .filter((adapter) => adapter.assignable)
              .map((adapter) => ({ id: adapter.adapterId, name: adapter.agentDisplayName })),
          ),
        )
      : undefined;

    Promise.all(
      steps.map(async (step) => {
        if (step.requirements === undefined) {
          return [step.id, (await unscopedChoicesRequest) ?? []] as const;
        }

        const analysis = await getRoutingAnalysis(baseUrl, parentTaskId, step.requirements, {
          signal: controller.signal,
        });
        return [
          step.id,
          sortedChoices(
            analysis.candidates
              .filter((candidate) => candidate.assignable && candidate.rank !== undefined)
              .map((candidate) => ({ id: candidate.adapterId, name: candidate.displayName })),
          ),
        ] as const;
      }),
    )
      .then((entries) => {
        if (controller.signal.aborted) return;
        const nextChoices: Record<string, readonly AgentChoice[]> = {};
        for (const [stepId, stepChoices] of entries) nextChoices[stepId] = stepChoices;
        setChoices(nextChoices);
        setState("ready");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setState("error");
      });

    return () => {
      controller.abort();
    };
    // The immutable active plan version is the identity boundary. `stepsKey`
    // captures the only step fields that affect these requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, parentTaskId, stepsKey]);

  return { state, choices };
}
