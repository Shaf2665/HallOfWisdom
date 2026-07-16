"use client";

import { useId, useMemo } from "react";
import type { TaskRecord } from "../../lib/api-schemas";
import { DEFAULT_KANBAN_FILTERS, hasActiveFilters, type KanbanFilters } from "../../lib/kanban";

/** Client-side only — derives its own option lists from the current task set, no new server query API. */
export function KanbanFiltersBar({
  tasks,
  filters,
  onChange,
}: {
  readonly tasks: readonly TaskRecord[];
  readonly filters: KanbanFilters;
  readonly onChange: (filters: KanbanFilters) => void;
}) {
  const formId = useId();

  const agentOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const record of tasks) {
      if (record.agentId) ids.add(record.agentId);
    }
    return Array.from(ids).sort();
  }, [tasks]);

  const active = hasActiveFilters(filters);

  return (
    <div className="flex flex-wrap items-end gap-3 rounded border border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-900">
      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-search`} className="text-xs font-medium">
          Search
        </label>
        <input
          id={`${formId}-search`}
          type="text"
          value={filters.search}
          placeholder="Title or project"
          onChange={(event) => {
            onChange({ ...filters, search: event.target.value });
          }}
          className="rounded border border-stone-300 bg-white px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-900"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-priority`} className="text-xs font-medium">
          Priority
        </label>
        <select
          id={`${formId}-priority`}
          value={filters.priority}
          onChange={(event) => {
            onChange({ ...filters, priority: event.target.value as KanbanFilters["priority"] });
          }}
          className="rounded border border-stone-300 bg-white px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-900"
        >
          <option value="all">All</option>
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-agent`} className="text-xs font-medium">
          Assigned agent
        </label>
        <select
          id={`${formId}-agent`}
          value={filters.agentId}
          onChange={(event) => {
            onChange({ ...filters, agentId: event.target.value });
          }}
          className="rounded border border-stone-300 bg-white px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-900"
        >
          <option value="all">All</option>
          {agentOptions.map((agentId) => (
            <option key={agentId} value={agentId}>
              {agentId}
            </option>
          ))}
        </select>
      </div>

      <label className="flex items-center gap-2 pb-1.5 text-sm">
        <input
          type="checkbox"
          checked={filters.showTerminal}
          onChange={(event) => {
            onChange({ ...filters, showTerminal: event.target.checked });
          }}
        />
        Show completed/failed/cancelled
      </label>

      <button
        type="button"
        disabled={!active}
        onClick={() => {
          onChange(DEFAULT_KANBAN_FILTERS);
        }}
        className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
      >
        Clear filters
      </button>
    </div>
  );
}
