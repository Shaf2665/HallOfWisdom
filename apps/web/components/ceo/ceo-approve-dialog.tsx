"use client";

import { useEffect, useId, useState } from "react";
import { ApiClientError, approveCeoPlan, listAdapters } from "../../lib/api-client";
import type {
  AdapterSummary,
  CeoPlan,
  CeoPlanVersion,
  DecideCeoPlanApprovalResponse,
} from "../../lib/api-schemas";
import { Dialog } from "../kanban/dialog";

function stepLabel(version: CeoPlanVersion, stepId: string): string {
  const step = version.steps.find((s) => s.id === stepId);
  return step ? `Step ${String(step.position + 1)}: ${step.title}` : stepId;
}

/**
 * The approval dialog — deliberately the richest confirmation surface in
 * this feature, per the Phase 14 kickoff's explicit requirement list:
 * plan version, step count, every step's selected adapter and its
 * execution trust, any trusted-local warning, a dependency summary, and
 * an unchecked confirmation the operator must actively tick. There is no
 * pre-checked box — approving requires a deliberate action, and approving
 * itself starts nothing (delegation, a wholly separate later step, is the
 * only action that ever creates a child task).
 */
export function CeoApproveDialog({
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
  /** The plan's current opaque optimistic-concurrency token, from `GetCeoPlanResponse.mutationToken` — distinct from `version.version`, which is the plan-content version number. */
  readonly mutationToken: string;
  readonly onDecided: (result: DecideCeoPlanApprovalResponse) => void;
  readonly onClose: () => void;
}) {
  const titleId = useId();
  const [adapters, setAdapters] = useState<readonly AdapterSummary[]>([]);
  const [operatorNote, setOperatorNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    listAdapters(baseUrl, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setAdapters(response.adapters);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [baseUrl]);

  const adaptersById = new Map(adapters.map((a) => [a.adapterId, a]));
  const dependencyCount = version.steps.reduce((sum, step) => sum + step.dependencies.length, 0);

  async function handleApprove(): Promise<void> {
    if (submitting || !confirmed) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const trimmed = operatorNote.trim();
      const result = await approveCeoPlan(baseUrl, plan.id, {
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
          : "The approval could not be recorded. The plan may have changed — reload and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog titleId={titleId} onClose={onClose} maxWidthClassName="max-w-lg">
      <div className="flex flex-col gap-4">
        <h2 id={titleId} className="text-lg font-semibold">
          Approve plan version {version.version}
        </h2>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-stone-600 dark:text-stone-300">
          <div>
            <dt className="font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
              Steps
            </dt>
            <dd>{version.steps.length}</dd>
          </div>
          <div>
            <dt className="font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
              Dependencies
            </dt>
            <dd>{dependencyCount === 0 ? "None — every step is independent" : dependencyCount}</dd>
          </div>
        </dl>

        <div className="flex max-h-64 flex-col gap-2 overflow-y-auto rounded border border-stone-200 p-2 dark:border-stone-800">
          {version.steps.map((step) => {
            const adapterId = step.selectedAdapterId ?? step.recommendedAdapterId;
            const adapter = adapterId ? adaptersById.get(adapterId) : undefined;
            const isTrustedLocal = adapter?.executionTrust === "trusted_local";
            return (
              <div
                key={step.id}
                className="border-b border-stone-100 pb-2 text-sm last:border-b-0 dark:border-stone-900"
              >
                <p className="font-medium">
                  Step {step.position + 1}: {step.title}
                </p>
                <p className="text-xs text-stone-600 dark:text-stone-300">
                  Agent:{" "}
                  {adapterId
                    ? `${adapterId}${adapter ? ` (${adapter.executionTrust})` : ""}`
                    : "None selected — this step cannot be delegated yet"}
                </p>
                {step.dependencies.length > 0 ? (
                  <p className="text-xs text-stone-500 dark:text-stone-400">
                    Depends on: {step.dependencies.map((d) => stepLabel(version, d)).join(", ")}
                  </p>
                ) : null}
                {isTrustedLocal ? (
                  <p
                    role="alert"
                    className="mt-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                  >
                    {adapter.limitationNotice ??
                      "Trusted-local: this agent runs with the Hall Core user's filesystem permissions."}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={`${titleId}-note`} className="text-sm font-medium">
            Note <span className="font-normal text-stone-500">(optional)</span>
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

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => {
              setConfirmed(event.target.checked);
            }}
            className="mt-0.5"
          />
          <span>
            I understand approving this plan does not start any agent. A separate, explicit
            delegation step is required afterward to create — still unstarted — child tasks.
          </span>
        </label>

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
            disabled={submitting || !confirmed}
            onClick={() => {
              void handleApprove();
            }}
            className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-emerald-600"
          >
            {submitting ? "Approving…" : "Approve plan"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
