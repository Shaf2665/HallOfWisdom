"use client";

import type { TaskStatus } from "@hall-of-wisdom/protocol";
import { useDroppable } from "@dnd-kit/core";
import type { TaskRecord } from "../../lib/api-schemas";
import type { ColumnDefinition } from "../../lib/kanban";
import type { CeoPlanRunBadgeMap } from "../../hooks/use-ceo-plan-run-badges";
import { KanbanCard } from "./kanban-card";

export function KanbanColumn({
  column,
  tasks,
  isValidDropTarget,
  isDragActive,
  isPending,
  lastActedOnTaskId,
  executionBadges,
  onFocusHandled,
  onMove,
  onOpenAssign,
  onOpenFindAgent,
  onOpenCompare,
  onOpenCeoPlans,
  onStart,
  onCancel,
  onOpenDiscussion,
}: {
  readonly column: ColumnDefinition;
  readonly tasks: readonly TaskRecord[];
  /** Whether the currently-dragged card could legally drop here — only meaningful while a drag is active. */
  readonly isValidDropTarget: boolean;
  readonly isDragActive: boolean;
  readonly isPending: (taskId: string) => boolean;
  readonly lastActedOnTaskId: string | null;
  readonly executionBadges: CeoPlanRunBadgeMap;
  readonly onFocusHandled: () => void;
  readonly onMove: (taskId: string, targetStatus: TaskStatus) => Promise<void>;
  readonly onOpenAssign: (record: TaskRecord) => void;
  readonly onOpenFindAgent: (record: TaskRecord) => void;
  readonly onOpenCompare: (record: TaskRecord) => void;
  readonly onOpenCeoPlans: (taskId: string) => void;
  readonly onStart: (taskId: string) => Promise<void>;
  readonly onCancel: (record: TaskRecord) => Promise<void>;
  readonly onOpenDiscussion: (taskId: string) => Promise<void>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.status });

  const highlight = isDragActive && isValidDropTarget;
  const rejectHighlight = isDragActive && !isValidDropTarget && isOver;

  return (
    <section
      aria-labelledby={`column-${column.status}-heading`}
      className={`flex w-72 shrink-0 flex-col gap-2 rounded-lg border p-3 transition-colors ${
        rejectHighlight
          ? "border-red-400 bg-red-50/50 dark:border-red-800 dark:bg-red-950/20"
          : highlight
            ? "border-amber-500 bg-amber-50/50 dark:border-amber-600 dark:bg-amber-950/20"
            : "border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-950/40"
      }`}
    >
      <header>
        <div className="flex items-center justify-between gap-2">
          <h2 id={`column-${column.status}-heading`} className="text-sm font-semibold">
            {column.label}
          </h2>
          <span
            className="rounded-full bg-stone-200 px-2 py-0.5 text-xs font-medium text-stone-700 dark:bg-stone-800 dark:text-stone-300"
            aria-label={`${String(tasks.length)} tasks`}
          >
            {tasks.length}
          </span>
        </div>
        <p className="text-xs text-stone-500 dark:text-stone-400">{column.description}</p>
        {column.kind === "future" ? (
          <p className="mt-1 text-xs italic text-stone-400 dark:text-stone-500">
            Not automated yet — a later phase.
          </p>
        ) : null}
      </header>

      {/*
        Deliberately no aria-live here: with 3s polling, a live region on
        this list would re-announce the entire column's contents on every
        refresh (event counts ticking, cards moving) — a screen-reader
        firehose, and redundant with the board's single dedicated
        announcer for move/assign/start/cancel results.
      */}
      <ul ref={setNodeRef} className="flex min-h-[4rem] flex-1 flex-col gap-2 overflow-y-auto">
        {tasks.length === 0 ? (
          <li className="rounded border border-dashed border-stone-300 p-3 text-center text-xs text-stone-400 dark:border-stone-700 dark:text-stone-500">
            No tasks
          </li>
        ) : (
          tasks.map((record) => (
            <KanbanCard
              key={record.task.taskId}
              record={record}
              isPending={isPending(record.task.taskId)}
              shouldFocusOnMount={lastActedOnTaskId === record.task.taskId}
              executionBadge={executionBadges.get(record.task.taskId)}
              onFocusHandled={onFocusHandled}
              onMove={onMove}
              onOpenAssign={onOpenAssign}
              onOpenFindAgent={onOpenFindAgent}
              onOpenCompare={onOpenCompare}
              onOpenCeoPlans={onOpenCeoPlans}
              onStart={onStart}
              onCancel={onCancel}
              onOpenDiscussion={onOpenDiscussion}
            />
          ))
        )}
      </ul>
    </section>
  );
}
