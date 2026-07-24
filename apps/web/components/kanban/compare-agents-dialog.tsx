"use client";

import { useEffect, useId, useState } from "react";
import type { SubmitEvent } from "react";
import { ApiClientError, createComparison, listAdapters } from "../../lib/api-client";
import type { AdapterSummary, AgentComparisonRecord, TaskRecord } from "../../lib/api-schemas";
import { Dialog } from "./dialog";

/**
 * Opened from a Kanban card's "Compare agents" action (`ready` tasks
 * only — see `lib/kanban.ts`'s `COMPARE_ACTION` doc comment). Lets the
 * operator pick exactly two different adapters to run the same task
 * against in isolated Git worktrees; creating the comparison here does
 * not prepare worktrees or start anything (see
 * `docs/architecture/0012-controlled-agent-comparison.md`) — those are
 * separate, explicit actions on the comparison detail page this dialog
 * navigates to on success.
 */
export function CompareAgentsDialog({
  baseUrl,
  record,
  onCreated,
  onClose,
}: {
  readonly baseUrl: string;
  readonly record: TaskRecord;
  readonly onCreated: (created: AgentComparisonRecord) => void;
  readonly onClose: () => void;
}) {
  const titleId = useId();
  const [adapters, setAdapters] = useState<readonly AdapterSummary[]>([]);
  const [adaptersState, setAdaptersState] = useState<"loading" | "ready" | "error">("loading");
  const [firstAdapterId, setFirstAdapterId] = useState("");
  const [secondAdapterId, setSecondAdapterId] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    listAdapters(baseUrl, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setAdapters(response.adapters);
        setAdaptersState("ready");
        const available = response.adapters.filter((a) => a.availability === "available");
        const first = available[0];
        const second = available.find((a) => a.adapterId !== first?.adapterId);
        if (first) setFirstAdapterId(first.adapterId);
        if (second) setSecondAdapterId(second.adapterId);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setAdaptersState("error");
      });
    return () => {
      controller.abort();
    };
  }, [baseUrl]);

  function isDisabledFor(adapter: AdapterSummary, otherSelectedId: string): boolean {
    if (adapter.availability !== "available") return true;
    // Never allow picking the same adapter for both slots — mirrors the
    // server's own `candidateAdapterIds` duplicate rejection
    // (`createComparisonRequestSchema`), enforced here too so the
    // operator sees it before submitting, not only after a 400.
    return adapter.adapterId === otherSelectedId;
  }

  const hasValidSelection =
    firstAdapterId.trim().length > 0 &&
    secondAdapterId.trim().length > 0 &&
    firstAdapterId !== secondAdapterId;

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;

    if (!hasValidSelection) {
      setSubmitError("Choose two different agents to compare.");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await createComparison(baseUrl, {
        sourceTaskId: record.task.taskId,
        candidateAdapterIds: [firstAdapterId, secondAdapterId],
      });
      onCreated(created);
    } catch (error) {
      setSubmitError(
        error instanceof ApiClientError ? error.message : "The comparison could not be created.",
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
          Compare agents
        </h2>
        <p className="text-sm text-stone-600 dark:text-stone-300">
          Runs <span className="font-medium">{record.task.title}</span> against two agents in
          separate, isolated copies of the repository, one at a time. Nothing starts until you
          explicitly start each candidate on the comparison page.
        </p>

        {adaptersState === "loading" ? (
          <p className="text-sm text-stone-500">Loading agents…</p>
        ) : adaptersState === "error" ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            Could not load agents.
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <label htmlFor={`${titleId}-first`} className="text-sm font-medium">
                First candidate
              </label>
              <select
                id={`${titleId}-first`}
                value={firstAdapterId}
                onChange={(event) => {
                  setFirstAdapterId(event.target.value);
                }}
                className="rounded border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
              >
                <option value="" disabled>
                  Select an agent…
                </option>
                {adapters.map((adapter) => (
                  <option
                    key={adapter.adapterId}
                    value={adapter.adapterId}
                    disabled={isDisabledFor(adapter, secondAdapterId)}
                  >
                    {adapter.agentDisplayName}
                    {adapter.availability !== "available" ? ` (${adapter.availability})` : ""}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={`${titleId}-second`} className="text-sm font-medium">
                Second candidate
              </label>
              <select
                id={`${titleId}-second`}
                value={secondAdapterId}
                onChange={(event) => {
                  setSecondAdapterId(event.target.value);
                }}
                className="rounded border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
              >
                <option value="" disabled>
                  Select an agent…
                </option>
                {adapters.map((adapter) => (
                  <option
                    key={adapter.adapterId}
                    value={adapter.adapterId}
                    disabled={isDisabledFor(adapter, firstAdapterId)}
                  >
                    {adapter.agentDisplayName}
                    {adapter.availability !== "available" ? ` (${adapter.availability})` : ""}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

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
            disabled={submitting || adaptersState !== "ready" || !hasValidSelection}
            className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600"
          >
            {submitting ? "Creating…" : "Compare"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
