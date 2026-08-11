"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiClientError, getTask, listCeoPlans, listTasks } from "../../lib/api-client";
import type { CeoPlan, CreateCeoPlanResponse, TaskRecord } from "../../lib/api-schemas";
import { CeoPlanStatusBadge } from "./ceo-plan-status-badge";
import { CreateCeoPlanDialog } from "./create-ceo-plan-dialog";

function safeMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "Could not load CEO plans.";
}

/**
 * Lists every CEO plan Hall Core knows about, or — when `parentTaskId` is
 * supplied (reached from a task's "CEO plans" Kanban card action, mirroring
 * how "Open discussion" reaches `/boards?boardId=task:...`) — only the
 * plans for that one task, with an "Ask CEO to plan" trigger to create a
 * new one. This is this codebase's closest equivalent to "show existing
 * linked CEO plans on the task detail page": there is no standalone task
 * detail page (the Kanban card is the task's primary surface), so the
 * filtered view here fills that role.
 */
export function CeoPlansList({
  baseUrl,
  parentTaskId,
}: {
  readonly baseUrl: string;
  readonly parentTaskId?: string;
}) {
  const router = useRouter();
  const [plans, setPlans] = useState<readonly CeoPlan[]>([]);
  const [parentTask, setParentTask] = useState<TaskRecord | null>(null);
  const [tasks, setTasks] = useState<readonly TaskRecord[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      listCeoPlans(baseUrl, { signal: controller.signal }),
      parentTaskId
        ? getTask(baseUrl, parentTaskId, { signal: controller.signal }).catch(() => null)
        : Promise.resolve(null),
      parentTaskId
        ? Promise.resolve([])
        : listTasks(baseUrl, { signal: controller.signal })
            .then((response) => response.tasks)
            .catch(() => []),
    ])
      .then(([plansResponse, taskRecord, taskRecords]) => {
        if (controller.signal.aborted) return;
        setPlans(plansResponse.plans);
        setParentTask(taskRecord);
        setTasks(taskRecords);
        setState("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setErrorMessage(safeMessage(error));
        setState("error");
      });
    return () => {
      controller.abort();
    };
  }, [baseUrl, parentTaskId]);

  function handleCreated(created: CreateCeoPlanResponse): void {
    setShowCreate(false);
    router.push(`/ceo/${encodeURIComponent(created.plan.id)}`);
  }

  if (state === "loading") {
    return (
      <p role="status" className="text-sm text-stone-500">
        Loading CEO plans…
      </p>
    );
  }

  if (state === "error") {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {errorMessage}
      </p>
    );
  }

  const visible = parentTaskId ? plans.filter((p) => p.parentTaskId === parentTaskId) : plans;
  const sorted = [...visible].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const taskTitleById = new Map(tasks.map((record) => [record.task.taskId, record.task.title]));

  return (
    <div className="flex flex-col gap-4">
      {parentTaskId ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-stone-200 p-3 dark:border-stone-800">
          <div>
            <h2 className="text-sm font-semibold">
              CEO plans for {parentTask ? parentTask.task.title : parentTaskId}
            </h2>
            <p className="text-xs text-stone-500 dark:text-stone-400">
              {sorted.length} plan{sorted.length === 1 ? "" : "s"} for this task.
            </p>
          </div>
          {parentTask ? (
            <button
              type="button"
              onClick={() => {
                setShowCreate(true);
              }}
              className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 dark:bg-amber-600"
            >
              Ask CEO to plan
            </button>
          ) : null}
        </div>
      ) : null}

      {sorted.length === 0 ? (
        <p className="text-sm text-stone-500 dark:text-stone-400">
          {parentTaskId
            ? "No CEO plans yet for this task."
            : "No CEO plans yet. Start one from a task's “CEO plans” action on the Kanban board."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sorted.map((plan) => (
            <li
              key={plan.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-stone-200 bg-white p-3 text-sm shadow-sm dark:border-stone-800 dark:bg-stone-900"
            >
              <div>
                <Link
                  href={`/ceo/${encodeURIComponent(plan.id)}`}
                  className="font-medium underline decoration-stone-300 underline-offset-2 hover:decoration-stone-600 dark:decoration-stone-700 dark:hover:decoration-stone-400"
                >
                  Plan {plan.id}
                </Link>
                {parentTaskId ? null : (
                  <p className="text-xs text-stone-500 dark:text-stone-400">
                    Task {taskTitleById.get(plan.parentTaskId) ?? plan.parentTaskId}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-stone-500 dark:text-stone-400">
                <span>v{plan.activeVersion}</span>
                <CeoPlanStatusBadge status={plan.status} />
                <span>{new Date(plan.updatedAt).toLocaleString()}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {showCreate && parentTask ? (
        <CreateCeoPlanDialog
          baseUrl={baseUrl}
          record={parentTask}
          onCreated={handleCreated}
          onClose={() => {
            setShowCreate(false);
          }}
        />
      ) : null}
    </div>
  );
}
