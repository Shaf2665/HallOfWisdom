"use client";

import { useId, useState } from "react";
import { ApiClientError, rejectCeoPlan } from "../../lib/api-client";
import type { CeoPlan, CeoPlanVersion, DecideCeoPlanApprovalResponse } from "../../lib/api-schemas";
import { Dialog } from "../kanban/dialog";

/**
 * Rejection is bound to the same exact version and content hash as
 * approval (kickoff, "Human approval model") but needs none of the
 * approval dialog's rich adapter/trust review — a rejected plan is not
 * about to run anything; it simply returns to the operator for revision
 * into a new draft version.
 */
export function CeoRejectDialog({
  baseUrl,
  plan,
  version,
  mutationToken,
  onDecided,
  onClose,
}: {
  readonly baseUrl: string;
  readonly plan: CeoPlan;
  readonly version: CeoPlanVersion;
  readonly mutationToken: string;
  readonly onDecided: (result: DecideCeoPlanApprovalResponse) => void;
  readonly onClose: () => void;
}) {
  const titleId = useId();
  const [operatorNote, setOperatorNote] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleReject(): Promise<void> {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const trimmed = operatorNote.trim();
      const result = await rejectCeoPlan(baseUrl, plan.id, {
        expectedMutationToken: mutationToken,
        planVersion: version.version,
        contentHash: version.contentHash,
        ...(trimmed.length > 0 ? { operatorNote: trimmed } : {}),
      });
      onDecided(result);
    } catch (error) {
      setSubmitError(
        error instanceof ApiClientError
          ? error.message
          : "The rejection could not be recorded. The plan may have changed — reload and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog titleId={titleId} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <h2 id={titleId} className="text-lg font-semibold">
          Reject plan version {version.version}
        </h2>
        <p className="text-sm text-stone-600 dark:text-stone-300">
          The plan stays on record. You can revise it into a new draft version afterward.
        </p>

        <div className="flex flex-col gap-1">
          <label htmlFor={`${titleId}-note`} className="text-sm font-medium">
            Reason <span className="font-normal text-stone-500">(optional)</span>
          </label>
          <input
            id={`${titleId}-note`}
            type="text"
            value={operatorNote}
            onChange={(event) => {
              setOperatorNote(event.target.value);
            }}
            maxLength={1000}
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
            type="button"
            disabled={submitting}
            onClick={() => {
              void handleReject();
            }}
            className="rounded border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            {submitting ? "Rejecting…" : "Reject plan"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
