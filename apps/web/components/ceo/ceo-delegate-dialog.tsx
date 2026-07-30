"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { ApiClientError, delegateCeoPlan, listAdapters } from "../../lib/api-client";
import type {
  AdapterSummary,
  CeoPlan,
  CeoPlanVersion,
  DelegateCeoPlanResponse,
} from "../../lib/api-schemas";
import { Dialog } from "../kanban/dialog";

/**
 * Delegation dialog. Per the Phase 14 kickoff: shows child-task count,
 * each step's selected adapter and execution trust, a dependency count,
 * and an explicit unstarted-task warning behind a required confirmation —
 * then, on success, shows the created (still-unstarted) child tasks with
 * navigation to the Kanban board, where starting each one remains a
 * separate, explicit operator action. Deliberately has no bulk "Start
 * All" control (kickoff: "must NOT show a bulk Start All control in
 * Phase 14").
 */
export function CeoDelegateDialog({
  baseUrl,
  plan,
  version,
  mutationToken,
  onClose,
}: {
  readonly baseUrl: string;
  readonly plan: CeoPlan;
  readonly version: CeoPlanVersion;
  readonly mutationToken: string;
  readonly onClose: (result: DelegateCeoPlanResponse | null) => void;
}) {
  const titleId = useId();
  const [adapters, setAdapters] = useState<readonly AdapterSummary[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<DelegateCeoPlanResponse | null>(null);

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

  async function handleDelegate(): Promise<void> {
    if (submitting || !confirmed) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const delegated = await delegateCeoPlan(baseUrl, plan.id, mutationToken);
      setResult(delegated);
    } catch (error) {
      setSubmitError(
        error instanceof ApiClientError
          ? error.message
          : "Delegation failed. The plan, adapters, or the parent task may have changed since approval — reload and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <Dialog
        titleId={titleId}
        onClose={() => {
          onClose(result);
        }}
        maxWidthClassName="max-w-lg"
      >
        <div className="flex flex-col gap-4">
          <h2 id={titleId} className="text-lg font-semibold">
            Delegated — {result.childTasks.length} child task
            {result.childTasks.length === 1 ? "" : "s"} created
          </h2>
          <p className="text-sm text-stone-600 dark:text-stone-300">
            Every child task below is assigned but not started. Start each one individually from the
            Kanban board when you are ready.
          </p>
          <ul className="flex flex-col gap-2">
            {result.childTasks.map((childTask) => (
              <li
                key={childTask.task.taskId}
                className="rounded border border-stone-200 p-2 text-sm dark:border-stone-800"
              >
                <p className="font-medium">{childTask.task.title}</p>
                <p className="text-xs text-stone-500 dark:text-stone-400">
                  Status: {childTask.task.status}
                  {childTask.adapterId ? ` · Agent: ${childTask.adapterId}` : ""}
                </p>
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Link
              href="/board"
              className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 dark:bg-amber-600"
            >
              Go to Kanban board
            </Link>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      titleId={titleId}
      onClose={() => {
        onClose(null);
      }}
      maxWidthClassName="max-w-lg"
    >
      <div className="flex flex-col gap-4">
        <h2 id={titleId} className="text-lg font-semibold">
          Delegate plan version {version.version}
        </h2>
        <p className="text-sm text-stone-600 dark:text-stone-300">
          Creates and assigns one task per step below. It does not start them — eligibility and
          agent availability are re-checked at this moment; if anything has changed since approval,
          nothing is created.
        </p>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-stone-600 dark:text-stone-300">
          <div>
            <dt className="font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
              Child tasks to create
            </dt>
            <dd>{version.steps.length}</dd>
          </div>
          <div>
            <dt className="font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
              Dependencies
            </dt>
            <dd>{dependencyCount}</dd>
          </div>
        </dl>

        <div className="flex max-h-56 flex-col gap-2 overflow-y-auto rounded border border-stone-200 p-2 dark:border-stone-800">
          {version.steps.map((step) => {
            const adapterId = step.selectedAdapterId ?? step.recommendedAdapterId;
            const adapter = adapterId ? adaptersById.get(adapterId) : undefined;
            return (
              <div key={step.id} className="text-sm">
                <p className="font-medium">
                  Step {step.position + 1}: {step.title}
                </p>
                <p className="text-xs text-stone-600 dark:text-stone-300">
                  {adapterId
                    ? `${adapterId} (${adapter ? adapter.executionTrust : "trust unknown until delegation"})`
                    : "No agent selected — delegation will be blocked"}
                </p>
              </div>
            );
          })}
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
            I understand this creates {version.steps.length} real task
            {version.steps.length === 1 ? "" : "s"}, left unstarted. I will start each one
            individually.
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
            onClick={() => {
              onClose(null);
            }}
            className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting || !confirmed}
            onClick={() => {
              void handleDelegate();
            }}
            className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600"
          >
            {submitting ? "Delegating…" : "Delegate"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
