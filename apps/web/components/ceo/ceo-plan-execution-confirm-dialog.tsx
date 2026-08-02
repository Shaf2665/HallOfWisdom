"use client";

import { useId, useState, type ReactNode } from "react";
import { ApiClientError } from "../../lib/api-client";
import { Dialog } from "../kanban/dialog";

function safeMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "The action could not be completed.";
}

/**
 * Shared confirm-and-act dialog for the run-level operator controls that
 * are consequential enough to warrant an explicit confirmation step
 * (pause, cancel future scheduling, emergency stop) but do not need a
 * bespoke layout of their own — unlike start execution, which shows a much
 * larger read-only summary of the plan and policy
 * (`CeoPlanExecutionStartDialog`). `requiredCheckboxText`, when supplied,
 * gates the confirm button on that exact box being checked, unchecked by
 * default — used by emergency stop, which per the kickoff needs its own
 * exact-text acknowledgement distinct from every other control's copy.
 */
export function CeoPlanExecutionConfirmDialog({
  title,
  description,
  extra,
  requiredCheckboxText,
  confirmLabel,
  busyLabel,
  danger = false,
  onConfirm,
  onDone,
  onClose,
}: {
  readonly title: string;
  readonly description: string;
  /** Additional read-only detail rendered between the description and the (optional) checkbox — e.g. emergency stop's active-linked-task count. */
  readonly extra?: ReactNode;
  readonly requiredCheckboxText?: string;
  readonly confirmLabel: string;
  readonly busyLabel: string;
  readonly danger?: boolean;
  readonly onConfirm: () => Promise<void>;
  readonly onDone: () => void;
  readonly onClose: () => void;
}) {
  const titleId = useId();
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requiresCheckbox = requiredCheckboxText !== undefined;
  const blocked = requiresCheckbox && !confirmed;

  async function handleConfirm(): Promise<void> {
    if (submitting || blocked) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
      onDone();
    } catch (err) {
      setError(safeMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog titleId={titleId} onClose={onClose} maxWidthClassName="max-w-md">
      <div className="flex flex-col gap-4">
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
        <p className="text-sm text-stone-600 dark:text-stone-300">{description}</p>
        {extra ?? null}

        {requiredCheckboxText ? (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => {
                setConfirmed(event.target.checked);
              }}
              className="mt-0.5"
            />
            <span>{requiredCheckboxText}</span>
          </label>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
          >
            Never mind
          </button>
          <button
            type="button"
            disabled={submitting || blocked}
            title={
              blocked ? "Check the acknowledgement box above to enable this button." : undefined
            }
            onClick={() => {
              void handleConfirm();
            }}
            className={
              danger
                ? "rounded bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-red-600"
                : "rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600"
            }
          >
            {submitting ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
