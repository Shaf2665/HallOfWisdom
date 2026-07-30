"use client";

import { useState } from "react";
import type { CeoPlanStep, CeoPlanVersion } from "@hall-of-wisdom/protocol";
import {
  MAX_ACCEPTANCE_CRITERIA_PER_STEP,
  MAX_ACCEPTANCE_CRITERION_LENGTH,
  MAX_ASSUMPTION_OR_CONSTRAINT_LENGTH,
  MAX_CEO_PLAN_STEPS,
  MAX_PLAN_ASSUMPTIONS_OR_CONSTRAINTS,
  MAX_PLAN_OBJECTIVE_LENGTH,
  MAX_PLAN_SUMMARY_LENGTH,
  MAX_STEP_TEXT_LENGTH,
  MAX_STEP_TITLE_LENGTH,
} from "@hall-of-wisdom/protocol";
import { ApiClientError, createCeoPlanVersion } from "../../lib/api-client";
import type { CapabilityId, ExecutionTrust, TaskRequirements } from "../../lib/api-schemas";
import type { CeoPlanStepEditInput } from "../../lib/api-client";
import { CeoStepAdapterSelector } from "./ceo-step-adapter-selector";

const ALL_CAPABILITIES: readonly CapabilityId[] = [
  "project.read",
  "project.edit",
  "command.execute",
  "git.inspect",
  "structured.events",
  "cancellation",
  "session.resume",
  "network.access",
];

const ALL_TRUST_LEVELS: readonly ExecutionTrust[] = [
  "isolated",
  "trusted_local",
  "simulated",
  "unavailable",
];

const DEFAULT_REQUIREMENTS: TaskRequirements = {
  requiredCapabilities: [],
  allowedExecutionTrust: ["isolated"],
};

function toggled<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

interface EditableStep {
  readonly id: string;
  title: string;
  objective: string;
  boundedInstructions: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  requirements: TaskRequirements | undefined;
  selectedAdapterId: string | undefined;
  readonly recommendedAdapterId: string | undefined;
}

function toEditableStep(step: CeoPlanStep): EditableStep {
  return {
    id: step.id,
    title: step.title,
    objective: step.objective,
    boundedInstructions: step.boundedInstructions,
    acceptanceCriteria: [...step.acceptanceCriteria],
    dependencies: [...step.dependencies],
    requirements: step.requirements,
    selectedAdapterId: step.selectedAdapterId,
    recommendedAdapterId: step.recommendedAdapterId,
  };
}

function newEditableStep(): EditableStep {
  return {
    id: crypto.randomUUID(),
    title: "",
    objective: "",
    boundedInstructions: "",
    acceptanceCriteria: [],
    dependencies: [],
    requirements: undefined,
    selectedAdapterId: undefined,
    recommendedAdapterId: undefined,
  };
}

/** A small, bounded, editable list of short strings — used for assumptions, constraints, and each step's acceptance criteria. */
function BoundedStringListEditor({
  legend,
  items,
  maxItems,
  maxItemLength,
  addLabel,
  onChange,
}: {
  readonly legend: string;
  readonly items: readonly string[];
  readonly maxItems: number;
  readonly maxItemLength: number;
  readonly addLabel: string;
  readonly onChange: (next: string[]) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-sm font-medium">{legend}</legend>
      <ul className="flex flex-col gap-1">
        {items.map((item, index) => (
          <li key={index} className="flex items-center gap-2">
            <input
              type="text"
              aria-label={`${legend} ${String(index + 1)}`}
              value={item}
              maxLength={maxItemLength}
              onChange={(event) => {
                const next = [...items];
                next[index] = event.target.value;
                onChange(next);
              }}
              className="flex-1 rounded border border-stone-300 bg-white px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-900"
            />
            <button
              type="button"
              aria-label={`Remove ${legend.toLowerCase()} ${String(index + 1)}`}
              onClick={() => {
                onChange(items.filter((_, i) => i !== index));
              }}
              className="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      {items.length < maxItems ? (
        <button
          type="button"
          onClick={() => {
            onChange([...items, ""]);
          }}
          className="self-start text-xs font-medium text-amber-700 hover:underline dark:text-amber-400"
        >
          {addLabel}
        </button>
      ) : null}
    </fieldset>
  );
}

/**
 * Phase 14.1 — always saves via "Save as new version" (`createCeoPlanVersion`),
 * never an in-place mutation of the version being viewed. Reachable from
 * `draft`/`rejected`/`awaiting_approval`/`approved` plans (`ceo-plan-detail.tsx`
 * gates visibility of the entry point); the server itself re-checks and
 * rejects a `delegated`/terminal plan (`CeoPlanStateConflictError`) as its
 * own trust boundary, so this form does not duplicate that check.
 *
 * Every submitted step is built as an explicit literal, never a spread of
 * the loaded `CeoPlanStep` — `CeoPlanStep` carries `routingSummary`
 * (always present) and `recommendedAdapterId`/`delegatedTaskId`, none of
 * which `editedCeoPlanStepRequestSchema` (a `.strict()` schema) accepts;
 * spreading would 400 on submit despite typechecking cleanly, since a
 * spread suppresses excess-property checking.
 */
export function CeoPlanEditForm({
  baseUrl,
  planId,
  parentTaskId,
  mutationToken,
  currentVersion,
  onSaved,
  onCancel,
}: {
  readonly baseUrl: string;
  readonly planId: string;
  readonly parentTaskId: string;
  readonly mutationToken: string;
  readonly currentVersion: CeoPlanVersion;
  readonly onSaved: (newVersion: CeoPlanVersion) => void;
  readonly onCancel: () => void;
}) {
  const [objective, setObjective] = useState(currentVersion.objective);
  const [summary, setSummary] = useState(currentVersion.summary);
  const [assumptions, setAssumptions] = useState<string[]>([...currentVersion.assumptions]);
  const [constraints, setConstraints] = useState<string[]>([...currentVersion.constraints]);
  const [steps, setSteps] = useState<EditableStep[]>(currentVersion.steps.map(toEditableStep));
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Every bounded text field the server's `boundedNonBlankString` schema
  // requires must be non-blank before submission — most fields start
  // pre-filled from a valid `currentVersion`, but "Add step"/"Add
  // assumption"/"Add constraint"/"Add acceptance criterion" each insert an
  // empty string an operator must fill in. Without this check, Save would
  // 400 with a generic validation error instead of a clear, local one.
  const hasBlankRequiredField =
    objective.trim().length === 0 ||
    summary.trim().length === 0 ||
    assumptions.some((item) => item.trim().length === 0) ||
    constraints.some((item) => item.trim().length === 0) ||
    steps.some(
      (step) =>
        step.title.trim().length === 0 ||
        step.objective.trim().length === 0 ||
        step.boundedInstructions.trim().length === 0 ||
        step.acceptanceCriteria.some((item) => item.trim().length === 0),
    );

  function updateStep(index: number, patch: Partial<EditableStep>): void {
    setSteps((current) => current.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  }

  function moveStep(index: number, direction: -1 | 1): void {
    setSteps((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [removed] = next.splice(index, 1);
      if (removed === undefined) return current;
      next.splice(target, 0, removed);
      return next;
    });
  }

  function removeStep(index: number): void {
    setSteps((current) => {
      const removedId = current[index]?.id;
      if (removedId === undefined) return current;
      return current
        .filter((_, i) => i !== index)
        .map((step) => ({
          ...step,
          dependencies: step.dependencies.filter((depId) => depId !== removedId),
        }));
    });
  }

  function addStep(): void {
    setSteps((current) => [...current, newEditableStep()]);
  }

  function toggleDependency(stepIndex: number, depStepId: string): void {
    setSteps((current) =>
      current.map((step, i) =>
        i === stepIndex ? { ...step, dependencies: toggled(step.dependencies, depStepId) } : step,
      ),
    );
  }

  async function handleSave(): Promise<void> {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const stepIds = new Set(steps.map((step) => step.id));
      const submittedSteps: CeoPlanStepEditInput[] = steps.map((step, index) => ({
        id: step.id,
        position: index,
        title: step.title,
        objective: step.objective,
        boundedInstructions: step.boundedInstructions,
        acceptanceCriteria: step.acceptanceCriteria,
        dependencies: step.dependencies.filter((depId) => stepIds.has(depId) && depId !== step.id),
        ...(step.requirements !== undefined ? { requirements: step.requirements } : {}),
        ...(step.selectedAdapterId !== undefined
          ? { selectedAdapterId: step.selectedAdapterId }
          : {}),
      }));
      const response = await createCeoPlanVersion(baseUrl, planId, {
        expectedMutationToken: mutationToken,
        objective,
        summary,
        assumptions,
        constraints,
        steps: submittedSteps,
      });
      onSaved(response.version);
    } catch (error) {
      setSubmitError(
        error instanceof ApiClientError
          ? error.message
          : "The new version could not be saved. The plan may have changed — reload and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <label htmlFor="ceo-plan-edit-objective" className="text-sm font-medium">
          Plan objective
        </label>
        <textarea
          id="ceo-plan-edit-objective"
          value={objective}
          onChange={(event) => {
            setObjective(event.target.value);
          }}
          maxLength={MAX_PLAN_OBJECTIVE_LENGTH}
          rows={2}
          className="rounded border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="ceo-plan-edit-summary" className="text-sm font-medium">
          Plan summary
        </label>
        <textarea
          id="ceo-plan-edit-summary"
          value={summary}
          onChange={(event) => {
            setSummary(event.target.value);
          }}
          maxLength={MAX_PLAN_SUMMARY_LENGTH}
          rows={3}
          className="rounded border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
        />
      </div>

      <BoundedStringListEditor
        legend="Assumptions"
        items={assumptions}
        maxItems={MAX_PLAN_ASSUMPTIONS_OR_CONSTRAINTS}
        maxItemLength={MAX_ASSUMPTION_OR_CONSTRAINT_LENGTH}
        addLabel="Add assumption"
        onChange={setAssumptions}
      />

      <BoundedStringListEditor
        legend="Constraints"
        items={constraints}
        maxItems={MAX_PLAN_ASSUMPTIONS_OR_CONSTRAINTS}
        maxItemLength={MAX_ASSUMPTION_OR_CONSTRAINT_LENGTH}
        addLabel="Add constraint"
        onChange={setConstraints}
      />

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Steps ({steps.length})</h3>
          {steps.length < MAX_CEO_PLAN_STEPS ? (
            <button
              type="button"
              onClick={addStep}
              className="rounded border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
            >
              Add step
            </button>
          ) : null}
        </div>

        {steps.map((step, index) => (
          <div
            key={step.id}
            className="flex flex-col gap-3 rounded border border-stone-200 p-3 dark:border-stone-800"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">Step {index + 1}</p>
              <div className="flex gap-1">
                <button
                  type="button"
                  aria-label={`Move step ${String(index + 1)} up`}
                  disabled={index === 0}
                  onClick={() => {
                    moveStep(index, -1);
                  }}
                  className="rounded border border-stone-300 px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40 dark:border-stone-700"
                >
                  Move up
                </button>
                <button
                  type="button"
                  aria-label={`Move step ${String(index + 1)} down`}
                  disabled={index === steps.length - 1}
                  onClick={() => {
                    moveStep(index, 1);
                  }}
                  className="rounded border border-stone-300 px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40 dark:border-stone-700"
                >
                  Move down
                </button>
                <button
                  type="button"
                  aria-label={`Remove step ${String(index + 1)}`}
                  onClick={() => {
                    removeStep(index);
                  }}
                  className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 dark:border-red-800 dark:text-red-400"
                >
                  Remove step
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label
                htmlFor={`ceo-plan-edit-step-${step.id}-title`}
                className="text-xs font-medium"
              >
                Title
              </label>
              <input
                id={`ceo-plan-edit-step-${step.id}-title`}
                type="text"
                value={step.title}
                maxLength={MAX_STEP_TITLE_LENGTH}
                onChange={(event) => {
                  updateStep(index, { title: event.target.value });
                }}
                className="rounded border border-stone-300 bg-white px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-900"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label
                htmlFor={`ceo-plan-edit-step-${step.id}-objective`}
                className="text-xs font-medium"
              >
                Objective
              </label>
              <textarea
                id={`ceo-plan-edit-step-${step.id}-objective`}
                value={step.objective}
                maxLength={MAX_STEP_TEXT_LENGTH}
                rows={2}
                onChange={(event) => {
                  updateStep(index, { objective: event.target.value });
                }}
                className="rounded border border-stone-300 bg-white px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-900"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label
                htmlFor={`ceo-plan-edit-step-${step.id}-instructions`}
                className="text-xs font-medium"
              >
                Bounded instructions
              </label>
              <textarea
                id={`ceo-plan-edit-step-${step.id}-instructions`}
                value={step.boundedInstructions}
                maxLength={MAX_STEP_TEXT_LENGTH}
                rows={2}
                onChange={(event) => {
                  updateStep(index, { boundedInstructions: event.target.value });
                }}
                className="rounded border border-stone-300 bg-white px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-900"
              />
            </div>

            <BoundedStringListEditor
              legend="Acceptance criteria"
              items={step.acceptanceCriteria}
              maxItems={MAX_ACCEPTANCE_CRITERIA_PER_STEP}
              maxItemLength={MAX_ACCEPTANCE_CRITERION_LENGTH}
              addLabel="Add acceptance criterion"
              onChange={(next) => {
                updateStep(index, { acceptanceCriteria: next });
              }}
            />

            {steps.length > 1 ? (
              <fieldset className="flex flex-col gap-1">
                <legend className="text-xs font-medium">Depends on</legend>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {steps.map((other, otherIndex) =>
                    otherIndex === index ? null : (
                      <label key={other.id} className="flex items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          checked={step.dependencies.includes(other.id)}
                          onChange={() => {
                            toggleDependency(index, other.id);
                          }}
                        />
                        Step {otherIndex + 1}
                        {other.title.length > 0 ? `: ${other.title}` : ""}
                      </label>
                    ),
                  )}
                </div>
              </fieldset>
            ) : null}

            <fieldset className="flex flex-col gap-1">
              <label className="flex items-center gap-1.5 text-xs font-medium">
                <input
                  type="checkbox"
                  checked={step.requirements !== undefined}
                  onChange={() => {
                    updateStep(index, {
                      requirements:
                        step.requirements === undefined ? DEFAULT_REQUIREMENTS : undefined,
                      selectedAdapterId: undefined,
                    });
                  }}
                />
                Set capability/execution-trust requirements
              </label>
              {step.requirements !== undefined ? (
                <div className="flex flex-col gap-2 rounded border border-stone-200 p-2 dark:border-stone-800">
                  <fieldset className="flex flex-col gap-1">
                    <legend className="text-xs font-medium">Required capabilities</legend>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {ALL_CAPABILITIES.map((capability) => (
                        <label key={capability} className="flex items-center gap-1.5 text-xs">
                          <input
                            type="checkbox"
                            checked={step.requirements?.requiredCapabilities.includes(capability)}
                            onChange={() => {
                              const current = step.requirements ?? DEFAULT_REQUIREMENTS;
                              updateStep(index, {
                                requirements: {
                                  ...current,
                                  requiredCapabilities: toggled(
                                    current.requiredCapabilities,
                                    capability,
                                  ),
                                },
                                selectedAdapterId: undefined,
                              });
                            }}
                          />
                          {capability}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset className="flex flex-col gap-1">
                    <legend className="text-xs font-medium">Allowed execution trust</legend>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {ALL_TRUST_LEVELS.map((trust) => (
                        <label key={trust} className="flex items-center gap-1.5 text-xs">
                          <input
                            type="checkbox"
                            checked={step.requirements?.allowedExecutionTrust.includes(trust)}
                            onChange={() => {
                              const current = step.requirements ?? DEFAULT_REQUIREMENTS;
                              updateStep(index, {
                                requirements: {
                                  ...current,
                                  allowedExecutionTrust: toggled(
                                    current.allowedExecutionTrust,
                                    trust,
                                  ),
                                },
                                selectedAdapterId: undefined,
                              });
                            }}
                          />
                          {trust}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </div>
              ) : null}
            </fieldset>

            <CeoStepAdapterSelector
              baseUrl={baseUrl}
              parentTaskId={parentTaskId}
              requirements={step.requirements}
              selectedAdapterId={step.selectedAdapterId}
              recommendedAdapterId={step.recommendedAdapterId}
              onChange={(selectedAdapterId) => {
                updateStep(index, { selectedAdapterId });
              }}
            />
          </div>
        ))}
      </div>

      {hasBlankRequiredField ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          Every field (objective, summary, and each step&apos;s title, objective, instructions, and
          acceptance criteria) must be filled in before saving.
        </p>
      ) : null}

      {submitError ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {submitError}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={submitting || steps.length === 0 || hasBlankRequiredField}
          onClick={() => {
            void handleSave();
          }}
          className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600"
        >
          {submitting ? "Saving…" : "Save as new version"}
        </button>
      </div>
    </div>
  );
}
