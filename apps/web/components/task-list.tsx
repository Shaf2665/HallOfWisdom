import type { TaskRecord } from "../lib/api-schemas";
import { EmptyState } from "./empty-state";
import { TaskListItem } from "./task-list-item";

export type TaskListState = "loading" | "ready" | "error";

export function TaskList({
  state,
  tasks,
  selectedTaskId,
  onSelect,
  onRefresh,
}: {
  readonly state: TaskListState;
  readonly tasks: readonly TaskRecord[];
  readonly selectedTaskId: string | null;
  readonly onSelect: (taskId: string) => void;
  readonly onRefresh: () => void;
}) {
  return (
    <section aria-labelledby="recent-tasks-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 id="recent-tasks-heading" className="text-lg font-semibold">
          Recent Tasks
        </h2>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
        >
          Refresh
        </button>
      </div>

      {state === "loading" ? (
        <p className="text-sm text-stone-500 dark:text-stone-400">Loading tasks…</p>
      ) : state === "error" ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          Tasks could not be loaded.
        </p>
      ) : tasks.length === 0 ? (
        <EmptyState message="No tasks yet. Create one to get started." />
      ) : (
        <ul className="flex flex-col gap-2">
          {tasks.map((record) => (
            <TaskListItem
              key={record.task.taskId}
              record={record}
              selected={record.task.taskId === selectedTaskId}
              onSelect={() => {
                onSelect(record.task.taskId);
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
