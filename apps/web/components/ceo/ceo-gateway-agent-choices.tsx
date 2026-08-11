"use client";

import { useId, useState } from "react";
import type { CeoPlanStep } from "../../lib/api-schemas";
import type { AgentSelections } from "./ceo-plan-versioning";
import { useCeoStepAgentChoices } from "./use-ceo-step-agent-choices";

export function CeoGatewayAgentChoices({
  baseUrl,
  parentTaskId,
  steps,
  actionsDisabled,
  canPrepare,
  saving,
  preparing,
  prepareConfirmed,
  onPrepareConfirmedChange,
  onPrepare,
  onSave,
}: {
  readonly baseUrl: string;
  readonly parentTaskId: string;
  readonly steps: readonly CeoPlanStep[];
  readonly actionsDisabled: boolean;
  readonly canPrepare: boolean;
  readonly saving: boolean;
  readonly preparing: boolean;
  readonly prepareConfirmed: boolean;
  readonly onPrepareConfirmedChange: (confirmed: boolean) => void;
  readonly onPrepare: () => void;
  readonly onSave: (selections: AgentSelections) => void;
}) {
  const groupId = useId();
  const [selections, setSelections] = useState<AgentSelections>({});
  const { state, choices } = useCeoStepAgentChoices({ baseUrl, parentTaskId, steps });

  if (state === "loading") {
    return (
      <p role="status" className="text-sm text-stone-600 dark:text-stone-300">
        Finding available agents…
      </p>
    );
  }

  if (state === "error") {
    return (
      <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">
        Hall couldn’t load available agents. Reload this page, or review the full plan.
      </p>
    );
  }

  const stepsNeedingChoices = steps.filter((step) => {
    const effectiveAdapterId = step.selectedAdapterId ?? step.recommendedAdapterId;
    return (
      effectiveAdapterId === undefined ||
      !(choices[step.id] ?? []).some((choice) => choice.id === effectiveAdapterId)
    );
  });

  if (stepsNeedingChoices.length === 0) {
    return (
      <div className="space-y-3">
        <label className="flex items-start gap-2 text-sm leading-5 text-stone-700 dark:text-stone-200">
          <input
            type="checkbox"
            checked={prepareConfirmed}
            disabled={actionsDisabled || !canPrepare}
            onChange={(event) => {
              onPrepareConfirmedChange(event.target.checked);
            }}
            className="mt-0.5"
          />
          <span>
            I understand Hall will create {steps.length} ready-to-start task
            {steps.length === 1 ? "" : "s"}, but will not start any work yet.
          </span>
        </label>
        <button
          type="button"
          disabled={actionsDisabled || !canPrepare || !prepareConfirmed}
          onClick={onPrepare}
          className="rounded-lg bg-amber-700 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600 dark:hover:bg-amber-500"
        >
          {preparing ? "Preparing work…" : "Prepare work"}
        </button>
      </div>
    );
  }

  const allSelected = stepsNeedingChoices.every((step) => {
    const selected = selections[step.id];
    return (
      selected !== undefined && (choices[step.id] ?? []).some((choice) => choice.id === selected)
    );
  });

  return (
    <div className="space-y-4 rounded-lg border border-amber-300 bg-amber-100/60 p-3 dark:border-amber-800 dark:bg-amber-950/40">
      <div>
        <h5 className="text-sm font-semibold">Agent choice needed</h5>
        <p className="mt-1 text-sm leading-5 text-stone-700 dark:text-stone-200">
          Choose an available agent for each step below before Hall prepares the work.
        </p>
      </div>
      {stepsNeedingChoices.map((step, index) => {
        const stepChoices = choices[step.id] ?? [];
        return (
          <fieldset key={step.id} className="space-y-2">
            <legend className="text-sm font-semibold">{step.title}</legend>
            {stepChoices.length === 0 ? (
              <p className="text-sm text-amber-800 dark:text-amber-300">
                No suitable agent is ready for this step. Review the full plan to adjust it.
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {stepChoices.map((choice) => (
                  <label
                    key={choice.id}
                    className="flex items-center gap-2 rounded-lg border border-amber-200 bg-white/70 px-3 py-2 text-sm dark:border-amber-900 dark:bg-stone-950/40"
                  >
                    <input
                      type="radio"
                      name={`${groupId}-step-${String(index)}`}
                      checked={selections[step.id] === choice.id}
                      disabled={actionsDisabled || !canPrepare}
                      onChange={() => {
                        setSelections((current) => ({ ...current, [step.id]: choice.id }));
                      }}
                    />
                    <span>{choice.name}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        );
      })}

      <p className="text-xs leading-5 text-stone-600 dark:text-stone-300">
        Saving these choices creates an updated draft so you can review and approve it again.
      </p>
      <button
        type="button"
        disabled={actionsDisabled || !canPrepare || !allSelected}
        onClick={() => {
          onSave(selections);
        }}
        className="rounded-lg bg-amber-700 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600 dark:hover:bg-amber-500"
      >
        {saving ? "Saving choices…" : "Save agent choices"}
      </button>
    </div>
  );
}
