import type { TaskStatus } from "@hall-of-wisdom/protocol";
import type { TaskRecord } from "../lib/api-schemas";

const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  ready: "Ready",
  assigned: "Assigned",
  running: "Running",
  reviewing: "Reviewing",
  waiting_for_approval: "Waiting for approval",
  blocked: "Blocked",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_CLASSES: Record<TaskStatus, string> = {
  backlog: "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
  ready: "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
  assigned: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  running: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  reviewing: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  waiting_for_approval: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  blocked: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  cancelled: "bg-stone-300 text-stone-800 dark:bg-stone-700 dark:text-stone-200",
};

export function StatusBadge({ status }: { readonly status: TaskStatus }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASSES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

export function TaskListItem({
  record,
  selected,
  onSelect,
}: {
  readonly record: TaskRecord;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { task } = record;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={`flex w-full flex-col gap-1 rounded border px-3 py-2 text-left text-sm transition-colors ${
          selected
            ? "border-amber-600 bg-amber-50 dark:border-amber-500 dark:bg-amber-950/40"
            : "border-stone-200 bg-white hover:bg-stone-50 dark:border-stone-800 dark:bg-stone-900 dark:hover:bg-stone-800"
        }`}
      >
        <span className="flex items-center justify-between gap-2">
          <span className="font-medium">{task.title}</span>
          <StatusBadge status={task.status} />
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-stone-500 dark:text-stone-400">
          <span>{task.projectId}</span>
          <span aria-hidden="true">·</span>
          <span className="capitalize">{task.priority}</span>
          <span aria-hidden="true">·</span>
          <span>{record.agentId}</span>
          <span aria-hidden="true">·</span>
          <span>{new Date(task.createdAt).toLocaleString()}</span>
          {record.eventCount > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span>
                {record.eventCount} event{record.eventCount === 1 ? "" : "s"}
              </span>
            </>
          ) : null}
        </span>
      </button>
    </li>
  );
}
