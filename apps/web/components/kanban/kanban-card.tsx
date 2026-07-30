"use client";

import { useEffect, useRef, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import type { TaskStatus } from "@hall-of-wisdom/protocol";
import { ApiClientError } from "../../lib/api-client";
import type { TaskRecord } from "../../lib/api-schemas";
import { availableActionsFor, canDrag, type CardAction } from "../../lib/kanban";
import { StatusBadge } from "../task-list-item";
import { MoveMenu } from "./move-menu";

type LocalState = "idle" | "confirming-start" | "confirming-cancel" | "busy";

function safeMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "The action could not be completed.";
}

export function KanbanCard({
  record,
  isPending,
  shouldFocusOnMount,
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
  readonly record: TaskRecord;
  readonly isPending: boolean;
  /**
   * True when this task was just acted on (moved, assigned, started, or
   * cancelled) by the user, so this card instance should claim focus once
   * mounted. A successful move/assign changes the task's column, which
   * moves the `<li>` to a different parent `<ul>` once the board's
   * `refresh()` lands new data — React does not preserve component
   * identity across a parent change even with a stable `key`, so the OLD
   * card instance (whose own `finally` block could otherwise call
   * `.focus()`) is already unmounted by the time that happens. Only a
   * *new* instance mounting in the *new* column can still be the one to
   * claim focus — this prop is how the board tells it to.
   */
  readonly shouldFocusOnMount: boolean;
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
  const { task } = record;
  const [localState, setLocalState] = useState<LocalState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const actionsButtonRef = useRef<HTMLButtonElement>(null);
  const titleButtonRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Entering either confirmation state swaps the Actions/Start button
    // out for a "Confirm"/"Cancel" pair in the same render — the element
    // that was focused (Start task, or the Cancel-task menu item) is gone
    // from the DOM by the time this commits, and nothing else claims
    // focus on its own, so it falls to <body>. Claim it here instead,
    // same pattern as the mount-focus effect below.
    if (localState === "confirming-start" || localState === "confirming-cancel") {
      confirmButtonRef.current?.focus();
    }
  }, [localState]);

  useEffect(() => {
    if (!shouldFocusOnMount) return;
    // Phase 8 made `availableActionsFor` unconditionally include an "Open
    // discussion" action for every status, so the Actions menu (and
    // therefore `actionsButtonRef.current`) is now always rendered once
    // this card has mounted in its default `"idle"` local state —
    // `actions.length === 0` can no longer occur. The title button
    // (`titleButtonRef`) remains the draggable element itself but is no
    // longer needed as a focus fallback here.
    actionsButtonRef.current?.focus();
    onFocusHandled();
    // Covers both cases: a card that stays in the same column (state
    // update on an already-mounted instance — e.g. Start, which leaves
    // the task `assigned`) and a card that moved to a new column (a
    // freshly mounted instance whose very first render already has
    // `shouldFocusOnMount: true`). `onFocusHandled` clears the flag at
    // the board immediately after, so a later, unrelated poll refresh
    // never re-steals focus.
  }, [shouldFocusOnMount, onFocusHandled]);

  const draggable = canDrag(record) && !isPending;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.taskId,
    data: { taskId: task.taskId, fromStatus: task.status },
    disabled: !draggable,
  });

  const actions = availableActionsFor(record);
  const busy = isPending || localState === "busy";
  const isLaunching = task.status === "assigned" && record.runId !== undefined;

  async function handleAction(action: CardAction): Promise<void> {
    setErrorMessage(null);
    if (action.kind === "assign") {
      // Move focus to the stable, always-rendered "Actions" trigger BEFORE
      // opening the dialog, synchronously within this event handler — not
      // after. The element actually focused right now is the "Assign
      // agent" popover item button, which unmounts (MoveMenu closes) in
      // the same React commit that mounts AssignDialog; if we let that
      // commit happen first, Dialog's own mount effect captures whatever
      // `document.activeElement` happens to be by then (often already
      // reverted to <body>, since the item button is gone), and its
      // close/Escape handler restores focus to that already-detached
      // reference — a silent no-op that drops focus to <body>. Refocusing
      // the trigger here, before any state update is flushed, guarantees
      // Dialog captures a real, still-mounted element that will still be
      // there when the dialog closes.
      actionsButtonRef.current?.focus();
      onOpenAssign(record);
      return;
    }
    if (action.kind === "find-agent") {
      // Same refocus-before-open discipline as "assign" above, for the
      // same reason: the popover item that was just clicked unmounts in
      // the same commit that mounts the routing dialog.
      actionsButtonRef.current?.focus();
      onOpenFindAgent(record);
      return;
    }
    if (action.kind === "compare") {
      // Same refocus-before-open discipline as "assign"/"find-agent"
      // above, for the same reason: the popover item that was just
      // clicked unmounts in the same commit that mounts the compare
      // dialog.
      actionsButtonRef.current?.focus();
      onOpenCompare(record);
      return;
    }
    if (action.kind === "ceo-plans") {
      // Pure client-side navigation, like "discuss" — but synchronous and
      // with no server round trip first (there is nothing to ensure
      // exists; `/ceo` itself lists whatever plans already exist for this
      // task and offers creating a new one). No refocus is needed since
      // the page is about to navigate away entirely.
      onOpenCeoPlans(task.taskId);
      return;
    }
    if (action.kind === "start") {
      setLocalState("confirming-start");
      return;
    }
    if (action.kind === "cancel") {
      setLocalState("confirming-cancel");
      return;
    }
    if (action.kind === "discuss") {
      // No confirmation step: opening (or creating) a discussion never
      // changes task state and is safe to repeat — a second click while
      // one is already in flight is prevented by the board's own
      // `pendingTaskIds` tracking (see `isPending`/`busy` below), the same
      // mechanism move/start/cancel already use.
      setLocalState("busy");
      try {
        await onOpenDiscussion(task.taskId);
      } catch (error) {
        setErrorMessage(safeMessage(error));
        // On success this card navigates away entirely, so there is
        // nothing to refocus. On failure, though, the just-clicked "Open
        // discussion" popover item has already unmounted (MoveMenu
        // closed) with nothing else claiming focus — the same silent
        // drop-to-<body> gap the assign-dialog trigger-refocus fix above
        // exists for. Reclaim the stable "Actions" trigger explicitly.
        actionsButtonRef.current?.focus();
      } finally {
        setLocalState("idle");
      }
      return;
    }
    setLocalState("busy");
    try {
      await onMove(task.taskId, action.targetStatus);
    } catch (error) {
      setErrorMessage(safeMessage(error));
    } finally {
      setLocalState("idle");
      // No direct .focus() call here: closing the Move menu already
      // removed the just-clicked menuitem button from the DOM, so focus
      // has already fallen to <body> by this point regardless of outcome.
      // The board sets its "just acted on" flag for this taskId in its
      // own finally block (alongside refresh()), which re-renders this
      // card (on failure, the same instance; on a successful cross-column
      // move, a freshly mounted one) with `shouldFocusOnMount: true` — the
      // effect above is what actually reclaims focus, in both cases.
    }
  }

  async function confirmStart(): Promise<void> {
    setLocalState("busy");
    try {
      await onStart(task.taskId);
      setLocalState("idle");
    } catch (error) {
      setErrorMessage(safeMessage(error));
      setLocalState("idle");
    }
  }

  async function confirmCancel(): Promise<void> {
    setLocalState("busy");
    try {
      await onCancel(record);
      setLocalState("idle");
    } catch (error) {
      setErrorMessage(safeMessage(error));
      setLocalState("idle");
    }
  }

  return (
    <li
      ref={setNodeRef}
      data-task-id={task.taskId}
      className={`flex flex-col gap-2 rounded border border-stone-200 bg-white p-3 text-sm shadow-sm dark:border-stone-800 dark:bg-stone-900 ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <button
          ref={titleButtonRef}
          type="button"
          {...(draggable ? listeners : {})}
          {...(draggable ? attributes : {})}
          aria-label={
            draggable
              ? `Drag ${task.title}. Use the action menu for a keyboard-only move.`
              : `${task.title} (locked; cannot be moved)`
          }
          aria-disabled={!draggable}
          className={`flex-1 cursor-grab break-words text-left font-medium text-stone-900 focus-visible:outline-2 focus-visible:outline-amber-600 dark:text-stone-50 ${
            draggable ? "" : "cursor-default"
          }`}
        >
          {task.title}
        </button>
        <StatusBadge status={task.status} />
      </div>

      <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 break-words text-xs text-stone-500 dark:text-stone-400">
        <div>
          <dt className="sr-only">Project</dt>
          <dd>{task.projectId}</dd>
        </div>
        <div>
          <dt className="sr-only">Priority</dt>
          <dd className="capitalize">{task.priority}</dd>
        </div>
        {record.agentId ? (
          <div className="col-span-2">
            <dt className="sr-only">Assigned agent</dt>
            <dd>{record.agentId}</dd>
          </div>
        ) : null}
        <div className="col-span-2">
          <dt className="sr-only">Updated</dt>
          <dd>{new Date(task.updatedAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt className="sr-only">Events</dt>
          <dd>
            {record.eventCount} event{record.eventCount === 1 ? "" : "s"}
          </dd>
        </div>
      </dl>

      {record.failure ? (
        <p className="break-words text-xs text-red-700 dark:text-red-400">
          Failure: {record.failure.code}
        </p>
      ) : null}
      {record.cancellationRequested ? (
        <p className="text-xs text-stone-600 dark:text-stone-300" role="status">
          Cancellation requested
        </p>
      ) : null}
      {isLaunching ? (
        <p className="text-xs text-stone-600 dark:text-stone-300" role="status">
          Starting…
        </p>
      ) : null}
      {errorMessage ? (
        <p role="alert" className="break-words text-xs text-red-600 dark:text-red-400">
          {errorMessage}
        </p>
      ) : null}

      {actions.length === 0 && localState !== "confirming-cancel" ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {task.status === "assigned" && record.runId === undefined ? (
            localState === "confirming-start" ? (
              <span className="flex items-center gap-2">
                <span className="text-xs text-stone-600 dark:text-stone-300">
                  Start this task with the assigned agent?
                </span>
                <button
                  ref={confirmButtonRef}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void confirmStart();
                  }}
                  className="rounded bg-amber-700 px-2 py-1 text-xs font-medium text-white hover:bg-amber-800 disabled:opacity-60 dark:bg-amber-600"
                >
                  {busy ? "Starting…" : "Confirm"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setLocalState("idle");
                  }}
                  className="rounded border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 dark:border-stone-700 dark:text-stone-200"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setLocalState("confirming-start");
                }}
                className="rounded bg-amber-700 px-2 py-1 text-xs font-medium text-white hover:bg-amber-800 disabled:opacity-60 dark:bg-amber-600"
              >
                Start task
              </button>
            )
          ) : null}

          {localState === "confirming-cancel" ? (
            <span className="flex items-center gap-2">
              <span className="text-xs text-stone-600 dark:text-stone-300">Cancel this task?</span>
              <button
                ref={confirmButtonRef}
                type="button"
                disabled={busy}
                onClick={() => {
                  void confirmCancel();
                }}
                className="rounded bg-red-700 px-2 py-1 text-xs font-medium text-white hover:bg-red-800 disabled:opacity-60"
              >
                {busy ? "Cancelling…" : "Confirm"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setLocalState("idle");
                }}
                className="rounded border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 dark:border-stone-700 dark:text-stone-200"
              >
                Keep task
              </button>
            </span>
          ) : (
            <MoveMenu
              ref={actionsButtonRef}
              actions={actions}
              disabled={busy}
              onAction={(action) => {
                void handleAction(action);
              }}
            />
          )}
        </div>
      )}
    </li>
  );
}
