"use client";

import { useId, useState } from "react";
import type { SubmitEvent } from "react";
import { ApiClientError, createCeoPlan } from "../../lib/api-client";
import type { CreateCeoPlanResponse, TaskRecord } from "../../lib/api-schemas";
import { Dialog } from "../kanban/dialog";

const MAX_PLANNING_INSTRUCTIONS_LENGTH = 2000;

/**
 * Opened from a task's "CEO plans" action (Kanban card, or the `/ceo`
 * page's task-filtered view). Merely opening this dialog creates nothing —
 * a draft plan is only generated on explicit form submission, and even
 * then the deterministic planner never starts an adapter or creates a
 * child task (see `docs/architecture/0014-ceo-planning-approval-and-delegation.md`,
 * "Safety model"). `planningInstructions` is the one bounded, optional
 * field the operator may supply to guide (never fabricate for) the
 * planner.
 */
export function CreateCeoPlanDialog({
  baseUrl,
  record,
  onCreated,
  onClose,
}: {
  readonly baseUrl: string;
  readonly record: TaskRecord;
  readonly onCreated: (created: CreateCeoPlanResponse) => void;
  readonly onClose: () => void;
}) {
  const titleId = useId();
  const [planningInstructions, setPlanningInstructions] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const trimmed = planningInstructions.trim();
      const created = await createCeoPlan(baseUrl, record.task.taskId, {
        ...(trimmed.length > 0 ? { planningInstructions: trimmed } : {}),
      });
      onCreated(created);
    } catch (error) {
      setSubmitError(
        error instanceof ApiClientError
          ? error.message
          : "The plan could not be created. The task may need a description first.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog titleId={titleId} onClose={onClose}>
      <form
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
        noValidate
        className="flex flex-col gap-4"
      >
        <h2 id={titleId} className="text-lg font-semibold">
          Ask CEO to plan
        </h2>
        <p className="text-sm text-stone-600 dark:text-stone-300">
          Generates a draft execution plan for{" "}
          <span className="font-medium">{record.task.title}</span> — a proposed set of steps with
          suggested agents, awaiting your review. This does not assign, start, or change the task in
          any way. You will approve or reject the plan, and separately choose whether to delegate it
          into real, still-unstarted child tasks.
        </p>

        <div className="flex flex-col gap-1">
          <label htmlFor={`${titleId}-instructions`} className="text-sm font-medium">
            Planning instructions <span className="font-normal text-stone-500">(optional)</span>
          </label>
          <textarea
            id={`${titleId}-instructions`}
            value={planningInstructions}
            onChange={(event) => {
              setPlanningInstructions(event.target.value);
            }}
            maxLength={MAX_PLANNING_INSTRUCTIONS_LENGTH}
            rows={4}
            placeholder="Any constraints or guidance for the planner — it can only use information you or the task already provide, never invent new facts."
            className="rounded border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
          />
        </div>

        {submitError ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {submitError}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600"
          >
            {submitting ? "Creating…" : "Create draft plan"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
