"use client";

import { useEffect, useState } from "react";
import { listAdapters } from "../../lib/api-client";
import type {
  AdapterSummary,
  CeoDelegationLink,
  CeoPlanStepAttempt,
  CeoPlanStepExecution,
  CeoPlanVersion,
} from "../../lib/api-schemas";
import {
  DEFAULT_WORKER_ACTIVITY_FILTERS,
  filterWorkerActivity,
  hasActiveFilters,
  projectWorkerActivity,
  type WorkerActivityFilters,
} from "../../lib/ceo-worker-activity";
import { useTaskEvents } from "../../hooks/use-task-events";
import { ConnectionStatus } from "../connection-status";
import { TaskEventTimeline } from "../task-event-timeline";
import { statusBadgeClass, STEP_STATUS_LABELS } from "./ceo-plan-execution-section";

const TERMINAL_STEP_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * A worker's live event stream is only ever subscribed to while its card is
 * expanded — `useTaskEvents` accepts `null` to mean "don't connect", and
 * `<details>` alone would NOT be enough to gate this: it only toggles CSS
 * display, it doesn't unmount children, so the WebSocket hook must be given
 * `null` explicitly rather than relying on the collapsed card to stop it.
 */
function WorkerEventFeed({
  taskId,
  wsBaseUrl,
}: {
  readonly taskId: string | null;
  readonly wsBaseUrl: string;
}) {
  const { connectionState, events, reconnectAttempt } = useTaskEvents(taskId, wsBaseUrl);
  return (
    <div className="mt-2 flex flex-col gap-2">
      <ConnectionStatus state={connectionState} reconnectAttempt={reconnectAttempt} />
      <TaskEventTimeline events={events} />
    </div>
  );
}

/**
 * CEO → worker real-time activity view (issue #24). Derived entirely from
 * data the parent already fetches (`version`, `links`, `stepExecutions`,
 * `attempts`) plus one additional `listAdapters` call for adapter display
 * names — no new endpoints, no new event store. See
 * `apps/web/lib/ceo-worker-activity.ts` for the pure hierarchy-projection
 * logic this renders.
 */
export function CeoWorkerActivityPanel({
  baseUrl,
  wsBaseUrl,
  version,
  links,
  stepExecutions,
  attempts,
}: {
  readonly baseUrl: string;
  readonly wsBaseUrl: string;
  readonly version: CeoPlanVersion;
  readonly links: readonly CeoDelegationLink[];
  readonly stepExecutions: readonly CeoPlanStepExecution[];
  readonly attempts: readonly CeoPlanStepAttempt[];
}) {
  const [adapters, setAdapters] = useState<ReadonlyMap<string, AdapterSummary>>(new Map());
  const [filters, setFilters] = useState<WorkerActivityFilters>(DEFAULT_WORKER_ACTIVITY_FILTERS);
  const [expandedStepIds, setExpandedStepIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    async function loadAdapters(): Promise<void> {
      try {
        const response = await listAdapters(baseUrl);
        if (cancelled) return;
        setAdapters(new Map(response.adapters.map((adapter) => [adapter.adapterId, adapter])));
      } catch {
        // Never fabricate an adapter badge — leaving the map empty just
        // omits the badge for every worker, which is the correct fallback.
        // Covers both a rejected request and a test double that returns
        // `undefined` instead of a promise.
      }
    }
    void loadAdapters();
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  const workers = projectWorkerActivity(version, links, stepExecutions, attempts, adapters);
  const visible = filterWorkerActivity(workers, filters);
  const finishedCount = workers.filter((worker) => TERMINAL_STEP_STATUSES.has(worker.status)).length;
  const statusesPresent = Array.from(new Set(workers.map((worker) => worker.status))).sort();
  const adapterIdsPresent = Array.from(
    new Set(workers.map((worker) => worker.adapterId).filter((id): id is string => id !== null)),
  ).sort();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
          Worker activity
        </h4>
        <span className="text-xs text-stone-500 dark:text-stone-400">
          {finishedCount} of {workers.length} workers finished
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={filters.search}
          onChange={(event) => {
            setFilters((prev) => ({ ...prev, search: event.target.value }));
          }}
          placeholder="Search workers…"
          aria-label="Search workers"
          className="rounded border border-stone-300 px-2 py-1 text-xs dark:border-stone-700 dark:bg-stone-900"
        />
        <select
          value={filters.status}
          onChange={(event) => {
            setFilters((prev) => ({
              ...prev,
              status: event.target.value as WorkerActivityFilters["status"],
            }));
          }}
          aria-label="Filter by status"
          className="rounded border border-stone-300 px-2 py-1 text-xs dark:border-stone-700 dark:bg-stone-900"
        >
          <option value="all">All statuses</option>
          {statusesPresent.map((status) => (
            <option key={status} value={status}>
              {STEP_STATUS_LABELS[status] ?? status}
            </option>
          ))}
        </select>
        <select
          value={filters.adapterId}
          onChange={(event) => {
            setFilters((prev) => ({ ...prev, adapterId: event.target.value }));
          }}
          aria-label="Filter by adapter"
          className="rounded border border-stone-300 px-2 py-1 text-xs dark:border-stone-700 dark:bg-stone-900"
        >
          <option value="all">All adapters</option>
          {adapterIdsPresent.map((adapterId) => (
            <option key={adapterId} value={adapterId}>
              {adapters.get(adapterId)?.displayName ?? adapterId}
            </option>
          ))}
        </select>
        {hasActiveFilters(filters) ? (
          <button
            type="button"
            onClick={() => {
              setFilters(DEFAULT_WORKER_ACTIVITY_FILTERS);
            }}
            className="text-xs font-medium text-amber-700 hover:underline dark:text-amber-400"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <p className="text-xs text-stone-500 dark:text-stone-400">
          No workers match the current filters.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map((worker) => {
            const open = expandedStepIds.has(worker.stepId);
            const failureText = worker.lastFailureSummary ?? worker.lastFailureCode;
            return (
              <li key={worker.stepId}>
                <details
                  open={open}
                  onToggle={(event) => {
                    const isOpen = event.currentTarget.open;
                    setExpandedStepIds((prev) => {
                      const next = new Set(prev);
                      if (isOpen) {
                        next.add(worker.stepId);
                      } else {
                        next.delete(worker.stepId);
                      }
                      return next;
                    });
                  }}
                  className="rounded border border-stone-200 p-3 text-sm dark:border-stone-800"
                >
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                    <span className="font-medium">{worker.title}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(worker.status)}`}
                    >
                      {STEP_STATUS_LABELS[worker.status] ?? worker.status}
                    </span>
                    {worker.adapterDisplayName ? (
                      <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                        {worker.adapterDisplayName}
                      </span>
                    ) : null}
                    <span className="text-xs text-stone-500 dark:text-stone-400">
                      Attempt count: {worker.attemptCount}
                    </span>
                  </summary>
                  {failureText ? (
                    <p className="mt-1 text-xs text-red-600 dark:text-red-400">{failureText}</p>
                  ) : null}
                  <WorkerEventFeed taskId={open ? worker.childTaskId : null} wsBaseUrl={wsBaseUrl} />
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
