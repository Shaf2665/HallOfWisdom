"use client";

import { useCallback, useEffect, useState } from "react";
import { ApplicationShell } from "../components/application-shell";
import { ServerStatus } from "../components/server-status";
import { TaskCreateForm } from "../components/task-create-form";
import { TaskList, type TaskListState } from "../components/task-list";
import { TaskDetail } from "../components/task-detail";
import { EmptyState } from "../components/empty-state";
import { getTask, listTasks } from "../lib/api-client";
import type { CreateTaskResponse, TaskRecord } from "../lib/api-schemas";
import { resolveHallCoreUrl } from "../lib/hall-core-url";

const { httpUrl: BASE_URL, wsUrl: WS_BASE_URL } = resolveHallCoreUrl();

function replaceTask(tasks: readonly TaskRecord[], updated: TaskRecord): TaskRecord[] {
  const index = tasks.findIndex((task) => task.task.taskId === updated.task.taskId);
  if (index === -1) return [updated, ...tasks];
  const existing = tasks[index];
  // Never let a stale response overwrite a newer local snapshot.
  if (existing && existing.task.updatedAt > updated.task.updatedAt) return [...tasks];
  const next = [...tasks];
  next[index] = updated;
  return next;
}

export default function HomePage() {
  const [tasks, setTasks] = useState<readonly TaskRecord[]>([]);
  const [tasksState, setTasksState] = useState<TaskListState>("loading");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const loadTasks = useCallback(() => {
    setTasksState((current) => (current === "ready" ? current : "loading"));
    listTasks(BASE_URL)
      .then((response) => {
        setTasks(response.tasks);
        setTasksState("ready");
      })
      .catch(() => {
        setTasksState("error");
      });
  }, []);

  // Fetches on mount — synchronizing with Hall Core, not deriving state
  // from props, so an effect (not render-time computation) is correct here.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    loadTasks();
  }, [loadTasks]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function handleCreated(created: CreateTaskResponse): void {
    const { eventsPath: _eventsPath, ...record } = created;
    setTasks((current) => [record, ...current]);
    setSelectedTaskId(record.task.taskId);
  }

  function handleTaskTerminal(taskId: string): void {
    getTask(BASE_URL, taskId)
      .then((record) => {
        setTasks((current) => replaceTask(current, record));
      })
      .catch(() => {
        // A failed refresh here just means the list/detail keep showing
        // the last known snapshot — the WebSocket stream itself already
        // told the user the run reached a terminal state.
      });
  }

  const selectedTask = tasks.find((task) => task.task.taskId === selectedTaskId) ?? null;

  return (
    <ApplicationShell statusSlot={<ServerStatus baseUrl={BASE_URL} />}>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr]">
        <div className="flex flex-col gap-8 lg:order-1">
          <div className="rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
            <TaskCreateForm baseUrl={BASE_URL} onCreated={handleCreated} />
          </div>
          <div className="rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
            <TaskList
              state={tasksState}
              tasks={tasks}
              selectedTaskId={selectedTaskId}
              onSelect={setSelectedTaskId}
              onRefresh={loadTasks}
            />
          </div>
        </div>

        <div className="rounded-lg border border-stone-200 bg-white p-4 lg:order-2 dark:border-stone-800 dark:bg-stone-900">
          {selectedTask ? (
            <TaskDetail
              key={selectedTask.task.taskId}
              baseUrl={BASE_URL}
              wsBaseUrl={WS_BASE_URL}
              record={selectedTask}
              onTaskTerminal={handleTaskTerminal}
            />
          ) : (
            <EmptyState message="Select a task to see its details and live event stream." />
          )}
        </div>
      </div>
    </ApplicationShell>
  );
}
