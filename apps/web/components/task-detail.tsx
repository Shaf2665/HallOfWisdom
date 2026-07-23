"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ApiClientError, cancelTask, ensureTaskBoard, transitionTask } from "../lib/api-client";
import type { TaskRecord } from "../lib/api-schemas";
import { useTaskEvents } from "../hooks/use-task-events";
import { StatusBadge } from "./task-list-item";
import { ConnectionStatus } from "./connection-status";
import { TaskEventTimeline } from "./task-event-timeline";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

type CancelState = "idle" | "confirming" | "pending" | "requested" | "conflict";
type DiscussionState = "idle" | "pending";

function safeMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "The discussion could not be opened.";
}

export function TaskDetail({
  baseUrl,
  wsBaseUrl,
  record,
  onTaskTerminal,
}: {
  readonly baseUrl: string;
  readonly wsBaseUrl: string;
  readonly record: TaskRecord;
  readonly onTaskTerminal: (taskId: string) => void;
}) {
  const { task } = record;
  const router = useRouter();
  // No reset-on-taskId-change effect needed: the parent renders this
  // component with `key={task.taskId}` (see app/page.tsx), so React itself
  // remounts it — and therefore reinitializes all of its local state,
  // `cancelState` and `discussionState` included — whenever the selected
  // task changes.
  const [cancelState, setCancelState] = useState<CancelState>("idle");
  const [discussionState, setDiscussionState] = useState<DiscussionState>("idle");
  const [discussionError, setDiscussionError] = useState<string | null>(null);

  // A planning task (no run yet) has nothing to stream — never opens a
  // WebSocket connection until it has actually started (`runId` set).
  const { connectionState, events, reconnectAttempt } = useTaskEvents(
    record.runId !== undefined ? task.taskId : null,
    wsBaseUrl,
    {
      onTerminalEvent: () => {
        onTaskTerminal(task.taskId);
      },
    },
  );

  const isTerminal = TERMINAL_STATUSES.has(task.status);

  /**
   * Idempotent and safe for any task state, including terminal ones — see
   * `docs/architecture/0007-communication-boards.md`, "Task-discussion
   * idempotency". `discussionState` guards against a duplicate board
   * request from repeated clicks while one is already in flight, the same
   * pending-lock discipline the Kanban card's own discuss action uses.
   */
  async function handleOpenDiscussion(): Promise<void> {
    if (discussionState === "pending") return;
    setDiscussionState("pending");
    setDiscussionError(null);
    try {
      const { board } = await ensureTaskBoard(baseUrl, task.taskId);
      router.push(`/boards?boardId=${encodeURIComponent(board.boardId)}`);
    } catch (error) {
      setDiscussionError(safeMessage(error));
      setDiscussionState("idle");
    }
  }

  async function handleConfirmCancel(): Promise<void> {
    setCancelState("pending");
    try {
      if (record.runId === undefined) {
        // No active run to cancel — this is a planning-state move, and it
        // completes synchronously (unlike an active-run cancel, which only
        // becomes "cancelled" once `run.cancelled` arrives).
        await transitionTask(baseUrl, task.taskId, "cancelled");
        setCancelState("requested");
        onTaskTerminal(task.taskId);
      } else {
        await cancelTask(baseUrl, task.taskId);
        setCancelState("requested");
      }
    } catch (error) {
      if (error instanceof ApiClientError && error.statusCode === 409) {
        setCancelState("conflict");
      } else {
        setCancelState("idle");
      }
    }
  }

  return (
    <section aria-labelledby="task-detail-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="task-detail-heading" className="text-lg font-semibold break-words">
          {task.title}
        </h2>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <StatusBadge status={task.status} />
          {record.agentId ? (
            <span className="text-sm text-stone-500 dark:text-stone-400">{record.agentId}</span>
          ) : null}
          <button
            type="button"
            onClick={() => {
              void handleOpenDiscussion();
            }}
            disabled={discussionState === "pending"}
            className="rounded border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
          >
            {discussionState === "pending" ? "Opening discussion…" : "Open discussion"}
          </button>
        </div>
        {discussionError ? (
          <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
            {discussionError}
          </p>
        ) : null}
      </div>

      {task.description ? (
        <p className="text-sm text-stone-700 dark:text-stone-300">{task.description}</p>
      ) : null}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <DetailField label="Task ID" value={task.taskId} />
        {record.runId ? <DetailField label="Run ID" value={record.runId} /> : null}
        <DetailField label="Project" value={task.projectId} />
        <DetailField label="Priority" value={task.priority} />
        {record.adapterId ? <DetailField label="Adapter" value={record.adapterId} /> : null}
        {record.agentId ? <DetailField label="Agent" value={record.agentId} /> : null}
        <DetailField label="Created" value={new Date(task.createdAt).toLocaleString()} />
        <DetailField label="Updated" value={new Date(task.updatedAt).toLocaleString()} />
        <DetailField label="Events" value={String(record.eventCount)} />
        {record.terminalEventType ? (
          <DetailField label="Terminal event" value={record.terminalEventType} />
        ) : null}
        {task.requirements ? (
          <DetailField
            label="Required capabilities"
            value={
              task.requirements.requiredCapabilities.length === 0
                ? "None"
                : task.requirements.requiredCapabilities.join(", ")
            }
          />
        ) : null}
        {task.requirements ? (
          <DetailField
            label="Allowed execution trust"
            value={task.requirements.allowedExecutionTrust.join(", ")}
          />
        ) : null}
        {record.assignedExecutionTrust ? (
          <DetailField label="Assigned trust mode" value={record.assignedExecutionTrust} />
        ) : null}
      </dl>

      {record.failure ? (
        <div
          role="alert"
          className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          <p className="font-medium">Task failed — {record.failure.code}</p>
          <p>{record.failure.message}</p>
        </div>
      ) : null}

      {!isTerminal ? (
        <div className="flex items-center gap-2">
          {cancelState === "idle" && (
            <button
              type="button"
              onClick={() => {
                setCancelState("confirming");
              }}
              className="rounded border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              Cancel task
            </button>
          )}
          {cancelState === "confirming" && (
            <>
              <span className="text-sm text-stone-600 dark:text-stone-300">Cancel this task?</span>
              <button
                type="button"
                onClick={() => {
                  void handleConfirmCancel();
                }}
                className="rounded bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800"
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={() => {
                  setCancelState("idle");
                }}
                className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
              >
                Keep running
              </button>
            </>
          )}
          {cancelState === "pending" && (
            <button
              type="button"
              disabled
              className="rounded border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 opacity-60 dark:border-red-800 dark:text-red-400"
            >
              Cancelling…
            </button>
          )}
          {cancelState === "requested" && (
            <p role="status" className="text-sm text-stone-600 dark:text-stone-300">
              Cancellation requested.
            </p>
          )}
          {cancelState === "conflict" && (
            <p role="alert" className="text-sm text-stone-600 dark:text-stone-300">
              This task can no longer be cancelled.
            </p>
          )}
        </div>
      ) : null}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-base font-semibold">Live Event Timeline</h3>
          <ConnectionStatus state={connectionState} reconnectAttempt={reconnectAttempt} />
        </div>
        <TaskEventTimeline events={events} />
      </div>
    </section>
  );
}

function DetailField({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">
        {label}
      </dt>
      <dd className="break-words text-stone-800 dark:text-stone-200">{value}</dd>
    </div>
  );
}
