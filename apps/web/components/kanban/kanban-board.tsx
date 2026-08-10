"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { TaskStatus } from "@hall-of-wisdom/protocol";
import {
  ApiClientError,
  cancelTask,
  ensureTaskBoard,
  startTask,
  transitionTask,
} from "../../lib/api-client";
import type { AgentComparisonRecord, CreateTaskResponse, TaskRecord } from "../../lib/api-schemas";
import { useKanbanTasks } from "../../hooks/use-kanban-tasks";
import { useCeoPlanRunBadges } from "../../hooks/use-ceo-plan-run-badges";
import {
  COLUMN_DEFINITIONS,
  DEFAULT_KANBAN_FILTERS,
  filterTasks,
  groupTasksByColumn,
  groupTasksBySimpleColumn,
  isValidDragTarget,
  resolveDragOutcome,
  resolveSimpleDragTarget,
  SIMPLE_COLUMNS,
  type KanbanFilters,
  type SimpleColumnKind,
} from "../../lib/kanban";
import { AssignDialog } from "./assign-dialog";
import { BacklogTaskForm } from "./backlog-task-form";
import { CompareAgentsDialog } from "./compare-agents-dialog";
import { KanbanColumn } from "./kanban-column";
import { KanbanFiltersBar } from "./kanban-filters";
import { RoutingDialog } from "./routing-dialog";

function safeMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "The action could not be completed.";
}

type KanbanViewMode = "simple" | "detailed";
const KANBAN_VIEW_STORAGE_KEY = "hall-kanban-view-mode";

function readStoredViewMode(): KanbanViewMode {
  if (typeof window === "undefined") return "simple";
  return window.localStorage.getItem(KANBAN_VIEW_STORAGE_KEY) === "detailed"
    ? "detailed"
    : "simple";
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (event: MediaQueryListEvent): void => {
      setReduced(event.matches);
    };
    query.addEventListener("change", handler);
    return () => {
      query.removeEventListener("change", handler);
    };
  }, []);
  return reduced;
}

/**
 * Deliberately opens no WebSocket connections of its own — cards reflect
 * live progress through polling (`useKanbanTasks`) only, per the Kanban
 * spec's "no new global WebSocket API" / "no one WebSocket per task"
 * restrictions. A user who wants the live, event-by-event timeline for a
 * specific task already has it on the Task Console (`/`), which reuses
 * the same `useTaskEvents` hook from Phase 6 unchanged.
 */
export function KanbanBoard({ baseUrl }: { readonly baseUrl: string }) {
  const router = useRouter();
  const { tasks, state, warning, refresh } = useKanbanTasks(baseUrl);
  const executionBadges = useCeoPlanRunBadges(baseUrl);
  const [filters, setFilters] = useState<KanbanFilters>(DEFAULT_KANBAN_FILTERS);
  const [viewMode, setViewMode] = useState<KanbanViewMode>(() => readStoredViewMode());
  const [pendingTaskIds, setPendingTaskIds] = useState<ReadonlySet<string>>(new Set());
  const [assigningRecord, setAssigningRecord] = useState<TaskRecord | null>(null);
  const [findingAgentRecord, setFindingAgentRecord] = useState<TaskRecord | null>(null);
  const [comparingRecord, setComparingRecord] = useState<TaskRecord | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // The task a card should reclaim focus for once it (re)mounts — see
  // KanbanCard's `shouldFocusOnMount` doc comment for why a plain ref on
  // the acting element isn't enough: a successful move/assign changes
  // which column's <ul> the card lives under, which unmounts the old
  // instance entirely.
  const [lastActedOnTaskId, setLastActedOnTaskId] = useState<string | null>(null);
  const handleFocusHandled = useCallback(() => {
    setLastActedOnTaskId(null);
  }, []);
  const reducedMotion = usePrefersReducedMotion();

  const handleViewModeChange = useCallback((next: KanbanViewMode) => {
    setViewMode(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(KANBAN_VIEW_STORAGE_KEY, next);
    }
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  const filteredTasks = useMemo(() => filterTasks(tasks, filters), [tasks, filters]);
  const grouped = useMemo(() => groupTasksByColumn(filteredTasks), [filteredTasks]);
  const simpleGrouped = useMemo(() => groupTasksBySimpleColumn(filteredTasks), [filteredTasks]);
  const activeRecord = activeTaskId
    ? (tasks.find((record) => record.task.taskId === activeTaskId) ?? null)
    : null;

  const isPending = useCallback((taskId: string) => pendingTaskIds.has(taskId), [pendingTaskIds]);

  async function withPending<T>(taskId: string, run: () => Promise<T>): Promise<T> {
    setPendingTaskIds((current) => new Set(current).add(taskId));
    try {
      return await run();
    } finally {
      setPendingTaskIds((current) => {
        const next = new Set(current);
        next.delete(taskId);
        return next;
      });
    }
  }

  const handleMove = useCallback(
    async (taskId: string, targetStatus: TaskStatus): Promise<void> => {
      await withPending(taskId, async () => {
        try {
          await transitionTask(baseUrl, taskId, targetStatus);
          setAnnouncement(`Task moved to ${targetStatus.replace(/_/g, " ")}.`);
        } catch (error) {
          setAnnouncement(safeMessage(error));
          throw error;
        } finally {
          // `refresh()` must be awaited BEFORE `lastActedOnTaskId` is set —
          // see the doc comment on that state above. Setting it first would
          // let the still-mounted, soon-to-be-unmounted OLD-column card
          // instance observe `shouldFocusOnMount: true` on a plain prop
          // update (not a mount) and immediately consume/clear it via
          // `onFocusHandled()`, before `tasks` ever reflects the new
          // column — leaving the real, freshly-mounted NEW-column instance
          // with `shouldFocusOnMount: false` on its first render, and focus
          // falling to <body>. Awaiting first ensures `tasks` (and thus
          // which column's <ul> this card lives under) is already correct
          // by the time the flag is set, so only the right instance ever
          // observes it.
          await refresh();
          setLastActedOnTaskId(taskId);
        }
      });
    },
    [baseUrl, refresh],
  );

  const handleStart = useCallback(
    async (taskId: string): Promise<void> => {
      await withPending(taskId, async () => {
        try {
          await startTask(baseUrl, taskId);
          setAnnouncement("Task started.");
        } catch (error) {
          setAnnouncement(safeMessage(error));
          throw error;
        } finally {
          // See handleMove's comment above for why refresh() is awaited
          // before the focus flag is set.
          await refresh();
          setLastActedOnTaskId(taskId);
        }
      });
    },
    [baseUrl, refresh],
  );

  const handleCancel = useCallback(
    async (record: TaskRecord): Promise<void> => {
      await withPending(record.task.taskId, async () => {
        try {
          if (record.runId === undefined) {
            await transitionTask(baseUrl, record.task.taskId, "cancelled");
          } else {
            await cancelTask(baseUrl, record.task.taskId);
          }
          setAnnouncement("Cancellation requested.");
        } catch (error) {
          setAnnouncement(safeMessage(error));
          throw error;
        } finally {
          // See handleMove's comment above for why refresh() is awaited
          // before the focus flag is set.
          await refresh();
          setLastActedOnTaskId(record.task.taskId);
        }
      });
    },
    [baseUrl, refresh],
  );

  /**
   * Never changes task state — `POST .../board` only ensures a discussion
   * board exists (idempotently) and this handler navigates to it. No
   * `refresh()`/`lastActedOnTaskId` bookkeeping is needed here (unlike
   * move/start/cancel/assign): there is no column change or task-count
   * update for this card to reflect, and the page is about to navigate
   * away on success anyway.
   */
  const handleOpenDiscussion = useCallback(
    async (taskId: string): Promise<void> => {
      await withPending(taskId, async () => {
        try {
          const { board } = await ensureTaskBoard(baseUrl, taskId);
          router.push(`/boards?boardId=${encodeURIComponent(board.boardId)}`);
        } catch (error) {
          setAnnouncement(safeMessage(error));
          throw error;
        }
      });
    },
    [baseUrl, router],
  );

  async function handleAssigned(updated: TaskRecord): Promise<void> {
    setAssigningRecord(null);
    setAnnouncement(`${updated.task.title} assigned.`);
    // See handleMove's comment above for why refresh() is awaited before
    // the focus flag is set.
    await refresh();
    setLastActedOnTaskId(updated.task.taskId);
  }

  async function handleRouted(updated: TaskRecord): Promise<void> {
    setFindingAgentRecord(null);
    setAnnouncement(`${updated.task.title} routed and assigned.`);
    // See handleMove's comment above for why refresh() is awaited before
    // the focus flag is set.
    await refresh();
    setLastActedOnTaskId(updated.task.taskId);
  }

  // Memoized so its identity stays stable across the board's frequent
  // poll-driven re-renders (every 3s while a task is active). Dialog's own
  // focus-trap effect depends on this exact reference — an unmemoized
  // inline arrow function here would re-run that effect on every poll
  // tick, yanking focus back to the dialog's first field while the user
  // is mid-interaction with it.
  const handleCloseAssign = useCallback(() => {
    setAssigningRecord(null);
  }, []);

  const handleCloseFindAgent = useCallback(() => {
    setFindingAgentRecord(null);
  }, []);

  const handleCloseCompare = useCallback(() => {
    setComparingRecord(null);
  }, []);

  /**
   * Unlike assign/route/move, a successful comparison creation navigates
   * away from the board entirely (to the new comparison's detail page) —
   * so, mirroring `handleOpenDiscussion`'s reasoning, there is nothing on
   * this page left to `refresh()` or restore focus to.
   */
  function handleCompared(created: AgentComparisonRecord): void {
    setComparingRecord(null);
    router.push(`/comparisons/${encodeURIComponent(created.comparisonId)}`);
  }

  /** See `CEO_PLANS_ACTION`'s doc comment in `lib/kanban.ts` — pure client-side navigation, nothing to await first. */
  const handleOpenCeoPlans = useCallback(
    (taskId: string): void => {
      router.push(`/ceo?parentTaskId=${encodeURIComponent(taskId)}`);
    },
    [router],
  );

  function handleCreated(created: CreateTaskResponse): void {
    setAnnouncement(`${created.task.title} added to Backlog.`);
    void refresh();
  }

  function handleDragStart(event: DragStartEvent): void {
    setActiveTaskId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent): void {
    const taskId = String(event.active.id);
    setActiveTaskId(null);
    const record = tasks.find((r) => r.task.taskId === taskId);
    if (!record || !event.over) return;

    if (viewMode === "simple") {
      // Ambiguous grouped drops resolve to `null` — the existing per-card
      // action menu is the answer there, never a guessed transition.
      const targetStatus = resolveSimpleDragTarget(
        record.task.status,
        event.over.id as SimpleColumnKind,
      );
      if (targetStatus === null) return;
      void handleMove(taskId, targetStatus);
      return;
    }

    const targetStatus = event.over.id as TaskStatus;
    const outcome = resolveDragOutcome(record.task.status, targetStatus);
    if (outcome.kind === "invalid") return;
    if (outcome.kind === "assign") {
      setAssigningRecord(record);
      return;
    }
    void handleMove(taskId, outcome.targetStatus);
  }

  function columnLabelForOverId(overId: string): string {
    if (viewMode === "simple") {
      return SIMPLE_COLUMNS.find((c) => c.kind === overId)?.label ?? overId;
    }
    return COLUMN_DEFINITIONS.find((c) => c.status === overId)?.label ?? overId;
  }

  function handleDragCancel(): void {
    setActiveTaskId(null);
  }

  const announcements: Announcements = {
    onDragStart({ active }) {
      const title = tasks.find((r) => r.task.taskId === String(active.id))?.task.title ?? "task";
      return `Picked up ${title}.`;
    },
    onDragOver({ active, over }) {
      const title = tasks.find((r) => r.task.taskId === String(active.id))?.task.title ?? "task";
      const columnLabel = over ? columnLabelForOverId(String(over.id)) : null;
      return columnLabel
        ? `${title} is over the ${columnLabel} column.`
        : `${title} is no longer over a column.`;
    },
    onDragEnd({ active, over }) {
      const title = tasks.find((r) => r.task.taskId === String(active.id))?.task.title ?? "task";
      if (!over) return `${title} was not moved.`;
      const record = tasks.find((r) => r.task.taskId === String(active.id));
      const columnLabel = columnLabelForOverId(String(over.id));
      const isValid = record
        ? viewMode === "simple"
          ? resolveSimpleDragTarget(record.task.status, over.id as SimpleColumnKind) !== null
          : isValidDragTarget(record.task.status, over.id as TaskStatus)
        : false;
      if (!isValid) return `${title} cannot be moved to ${columnLabel}.`;
      return `${title} moved to ${columnLabel}.`;
    },
    onDragCancel({ active }) {
      const title = tasks.find((r) => r.task.taskId === String(active.id))?.task.title ?? "task";
      return `Moving ${title} was cancelled.`;
    },
  };

  return (
    <div className="flex flex-col gap-4">
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {warning ? (
        <p
          role="status"
          className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
        >
          {warning}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <BacklogTaskForm baseUrl={baseUrl} onCreated={handleCreated} />
        <div className="flex items-center gap-2">
          <div
            role="group"
            aria-label="Kanban view"
            className="flex rounded border border-stone-300 dark:border-stone-700"
          >
            {(["simple", "detailed"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={viewMode === mode}
                onClick={() => {
                  handleViewModeChange(mode);
                }}
                className={`px-3 py-1.5 text-sm font-medium first:rounded-l last:rounded-r ${
                  viewMode === mode
                    ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
                    : "text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"
                }`}
              >
                {mode === "simple" ? "Simple view" : "Detailed view"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              void refresh();
            }}
            className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
          >
            Refresh
          </button>
        </div>
      </div>

      <KanbanFiltersBar tasks={tasks} filters={filters} onChange={setFilters} />

      {state === "loading" ? (
        <p role="status" className="text-sm text-stone-500">
          Loading tasks…
        </p>
      ) : state === "error" && tasks.length === 0 ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          Could not load tasks.
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          accessibility={{ announcements }}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <div
            role="region"
            aria-label="Kanban workflow columns, scrollable horizontally"
            className="relative flex gap-4 overflow-x-auto pb-2"
          >
            {viewMode === "simple"
              ? SIMPLE_COLUMNS.map((column) => (
                  <KanbanColumn
                    key={column.kind}
                    columnId={column.kind}
                    label={column.label}
                    description={column.description}
                    tasks={simpleGrouped[column.kind]}
                    isDragActive={activeTaskId !== null}
                    isValidDropTarget={
                      activeRecord !== null &&
                      resolveSimpleDragTarget(activeRecord.task.status, column.kind) !== null
                    }
                    isPending={isPending}
                    lastActedOnTaskId={lastActedOnTaskId}
                    executionBadges={executionBadges}
                    onFocusHandled={handleFocusHandled}
                    onMove={handleMove}
                    onOpenAssign={setAssigningRecord}
                    onOpenFindAgent={setFindingAgentRecord}
                    onOpenCompare={setComparingRecord}
                    onOpenCeoPlans={handleOpenCeoPlans}
                    onStart={handleStart}
                    onCancel={handleCancel}
                    onOpenDiscussion={handleOpenDiscussion}
                  />
                ))
              : COLUMN_DEFINITIONS.map((column) => (
                  <KanbanColumn
                    key={column.status}
                    columnId={column.status}
                    label={column.label}
                    description={column.description}
                    showFutureNote={column.kind === "future"}
                    tasks={grouped[column.status]}
                    isDragActive={activeTaskId !== null}
                    isValidDropTarget={
                      activeRecord !== null &&
                      isValidDragTarget(activeRecord.task.status, column.status)
                    }
                    isPending={isPending}
                    lastActedOnTaskId={lastActedOnTaskId}
                    executionBadges={executionBadges}
                    onFocusHandled={handleFocusHandled}
                    onMove={handleMove}
                    onOpenAssign={setAssigningRecord}
                    onOpenFindAgent={setFindingAgentRecord}
                    onOpenCompare={setComparingRecord}
                    onOpenCeoPlans={handleOpenCeoPlans}
                    onStart={handleStart}
                    onCancel={handleCancel}
                    onOpenDiscussion={handleOpenDiscussion}
                  />
                ))}
          </div>
          <DragOverlay dropAnimation={reducedMotion ? null : undefined}>
            {activeRecord ? (
              <div className="w-72 rounded border border-amber-500 bg-white p-3 text-sm shadow-lg dark:bg-stone-900">
                <p className="font-medium">{activeRecord.task.title}</p>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {assigningRecord ? (
        <AssignDialog
          baseUrl={baseUrl}
          record={assigningRecord}
          onAssigned={(updated) => {
            void handleAssigned(updated);
          }}
          onClose={handleCloseAssign}
        />
      ) : null}

      {findingAgentRecord ? (
        <RoutingDialog
          baseUrl={baseUrl}
          record={findingAgentRecord}
          onAssigned={(updated) => {
            void handleRouted(updated);
          }}
          onClose={handleCloseFindAgent}
        />
      ) : null}

      {comparingRecord ? (
        <CompareAgentsDialog
          baseUrl={baseUrl}
          record={comparingRecord}
          onCreated={handleCompared}
          onClose={handleCloseCompare}
        />
      ) : null}
    </div>
  );
}
