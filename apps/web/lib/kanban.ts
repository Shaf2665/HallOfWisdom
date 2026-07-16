import type { TaskPriority, TaskStatus } from "@hall-of-wisdom/protocol";
import type { TaskRecord } from "./api-schemas";

/**
 * Pure Kanban domain logic — no fetching, no DOM, no React. Every function
 * here is keyed off the full `TaskStatus` union via an exhaustive switch
 * (see `columnKindForStatus`), so adding a new status to the protocol
 * package without updating this file is a compile error, not a runtime
 * "silently falls into the wrong column" bug.
 */

export type ColumnKind = "planning" | "execution" | "future" | "terminal";

export interface ColumnDefinition {
  readonly status: TaskStatus;
  readonly label: string;
  readonly description: string;
  readonly kind: ColumnKind;
}

/** Display order, matching the Kanban spec's column list exactly. */
export const COLUMN_DEFINITIONS: readonly ColumnDefinition[] = [
  {
    status: "backlog",
    label: "Backlog",
    description: "Not yet ready to start.",
    kind: "planning",
  },
  {
    status: "ready",
    label: "Ready",
    description: "Ready to be assigned to an agent.",
    kind: "planning",
  },
  {
    status: "assigned",
    label: "Assigned",
    description: "An agent is assigned; not yet started.",
    kind: "planning",
  },
  {
    status: "running",
    label: "In Progress",
    description: "An agent is actively working on this task.",
    kind: "execution",
  },
  {
    status: "reviewing",
    label: "Agent Review",
    description: "Not automated yet — a future workflow phase.",
    kind: "future",
  },
  {
    status: "waiting_for_approval",
    label: "Human Approval",
    description: "Not automated yet — a future workflow phase.",
    kind: "future",
  },
  {
    status: "blocked",
    label: "Blocked",
    description: "Paused. Move back to Backlog or Ready to resume.",
    kind: "planning",
  },
  {
    status: "completed",
    label: "Completed",
    description: "Finished successfully.",
    kind: "terminal",
  },
  {
    status: "failed",
    label: "Failed",
    description: "Finished with a failure.",
    kind: "terminal",
  },
  {
    status: "cancelled",
    label: "Cancelled",
    description: "Finished by cancellation.",
    kind: "terminal",
  },
];

function assertNeverStatus(status: never): never {
  throw new Error(`Unhandled TaskStatus in Kanban domain logic: ${String(status)}`);
}

/**
 * Column classification: `"planning"` (backlog/ready/assigned/blocked —
 * manually controlled), `"execution"` (running — driven only by
 * `run.started`), `"future"` (reviewing/waiting_for_approval — visible
 * placeholders, not automated), `"terminal"` (completed/failed/cancelled).
 * The exhaustive switch (no fallthrough default that guesses) is what
 * makes an unsupported status a compile-time error rather than a silent
 * miscategorization.
 */
export function columnKindForStatus(status: TaskStatus): ColumnKind {
  switch (status) {
    case "backlog":
    case "ready":
    case "assigned":
    case "blocked":
      return "planning";
    case "running":
      return "execution";
    case "reviewing":
    case "waiting_for_approval":
      return "future";
    case "completed":
    case "failed":
    case "cancelled":
      return "terminal";
    default:
      return assertNeverStatus(status);
  }
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return columnKindForStatus(status) === "terminal";
}

export function isPlanningStatus(status: TaskStatus): boolean {
  return columnKindForStatus(status) === "planning";
}

/** Statuses under active execution control, including the not-yet-automated future columns. */
export function isExecutionControlledStatus(status: TaskStatus): boolean {
  const kind = columnKindForStatus(status);
  return kind === "execution" || kind === "future";
}

/**
 * The exact subset of destinations a client may request through
 * `POST /api/v1/tasks/:taskId/transition` — mirrors Hall Core's own
 * `MANUAL_TRANSITIONS` (`apps/server/src/tasks/task-status-transitions.ts`)
 * exactly. Kept as an explicit client-side copy (not fetched from the
 * server) so the Move menu can render synchronously with no network
 * round-trip; Hall Core's own check is still the actual authority — this
 * is presentation-layer defense in depth, the same pattern already
 * established for WebSocket event validation in Phase 6.
 */
const MANUAL_TRANSITIONS: Readonly<Partial<Record<TaskStatus, readonly TaskStatus[]>>> = {
  backlog: ["ready", "blocked", "cancelled"],
  ready: ["backlog", "blocked", "cancelled"],
  assigned: ["ready", "blocked", "cancelled"],
  blocked: ["backlog", "ready", "cancelled"],
};

export function manualDestinationsFor(status: TaskStatus): readonly TaskStatus[] {
  return MANUAL_TRANSITIONS[status] ?? [];
}

/**
 * A card is locked (no drag, no manual move, no Start/Assign) once it is
 * under execution control, terminal, or — the state that's easy to miss —
 * `assigned` with a run already claimed (`runId` set) but before
 * `run.started` has arrived. That in-between "Starting…" window is real
 * execution, not a planning state, even though `task.status` hasn't
 * flipped to `"running"` yet.
 */
export function isCardLocked(record: TaskRecord): boolean {
  const status = record.task.status;
  if (isTerminalStatus(status)) return true;
  if (isExecutionControlledStatus(status)) return true;
  if (status === "assigned" && record.runId !== undefined) return true;
  return false;
}

export function canDrag(record: TaskRecord): boolean {
  return !isCardLocked(record);
}

/**
 * Whether a drag from column `from` to column `to` is a legitimate drop —
 * used to highlight valid destinations during a drag. Two special cases
 * on top of `manualDestinationsFor` (which governs the generic
 * `/transition` endpoint, used by the Move menu and the dedicated Cancel
 * action, not drag):
 *
 * - `ready -> assigned` is a valid *drag* target (opens the assignment
 *   dialog) even though it's deliberately excluded from
 *   `manualDestinationsFor` (assignment has its own endpoint with its own
 *   validation the generic transition can't perform).
 * - Dropping onto any *terminal* column — including Cancelled — is never
 *   a valid drag target, even though `cancelled` legitimately appears in
 *   `manualDestinationsFor` for every planning status (that's what powers
 *   the explicit "Cancel task" action). Cancelling is a deliberate,
 *   confirmed action, never an accidental drag onto a terminal column;
 *   see the Kanban spec's "Dragging to terminal, review or approval
 *   columns: Reject unless the server lifecycle already placed the task
 *   there."
 */
export function isValidDragTarget(from: TaskStatus, to: TaskStatus): boolean {
  if (from === "ready" && to === "assigned") return true;
  if (isTerminalStatus(to)) return false;
  return manualDestinationsFor(from).includes(to);
}

export type DragOutcome =
  | { readonly kind: "invalid" }
  | { readonly kind: "assign" }
  | { readonly kind: "move"; readonly targetStatus: TaskStatus };

/**
 * The decision a completed drag resolves to — pulled out of
 * `KanbanBoard`'s `handleDragEnd` so the branch selection (invalid drop /
 * open the assign dialog / send a transition request) is a plain function
 * testable without simulating a real dnd-kit pointer or keyboard drag
 * (which needs real layout geometry jsdom doesn't provide). `handleDragEnd`
 * itself keeps only the DOM/event-specific bits: reading `event.active`/
 * `event.over` and dispatching to `setAssigningRecord`/`handleMove`.
 */
export function resolveDragOutcome(from: TaskStatus, to: TaskStatus): DragOutcome {
  if (!isValidDragTarget(from, to)) return { kind: "invalid" };
  if (to === "assigned") return { kind: "assign" };
  return { kind: "move", targetStatus: to };
}

export type CardAction =
  | { readonly kind: "move"; readonly targetStatus: TaskStatus; readonly label: string }
  | { readonly kind: "assign"; readonly label: string }
  | { readonly kind: "start"; readonly label: string }
  | { readonly kind: "cancel"; readonly label: string };

/**
 * The exact action set for each card state, matching the Kanban spec's
 * per-status examples (including the "Return to Ready" wording specific
 * to an assigned card, versus the generic "Move to X" everywhere else).
 * A running task exposes only "Cancel active task"; a locked/launching or
 * terminal card exposes nothing (terminal cards are view-only).
 */
export function availableActionsFor(record: TaskRecord): readonly CardAction[] {
  const status = record.task.status;

  if (status === "running") {
    return [{ kind: "cancel", label: "Cancel active task" }];
  }
  if (isExecutionControlledStatus(status) || isTerminalStatus(status)) {
    return [];
  }
  if (status === "assigned" && record.runId !== undefined) {
    // Launching: a run was claimed but run.started has not arrived yet.
    return [];
  }

  switch (status) {
    case "backlog":
      return [
        { kind: "move", targetStatus: "ready", label: "Move to Ready" },
        { kind: "move", targetStatus: "blocked", label: "Move to Blocked" },
        { kind: "cancel", label: "Cancel task" },
      ];
    case "ready":
      return [
        { kind: "move", targetStatus: "backlog", label: "Move to Backlog" },
        { kind: "assign", label: "Assign agent" },
        { kind: "move", targetStatus: "blocked", label: "Move to Blocked" },
        { kind: "cancel", label: "Cancel task" },
      ];
    case "assigned":
      return [
        { kind: "start", label: "Start task" },
        { kind: "move", targetStatus: "ready", label: "Return to Ready" },
        { kind: "move", targetStatus: "blocked", label: "Move to Blocked" },
        { kind: "cancel", label: "Cancel task" },
      ];
    case "blocked":
      return [
        { kind: "move", targetStatus: "backlog", label: "Move to Backlog" },
        { kind: "move", targetStatus: "ready", label: "Move to Ready" },
        { kind: "cancel", label: "Cancel task" },
      ];
    default:
      return [];
  }
}

export interface KanbanFilters {
  readonly search: string;
  readonly priority: TaskPriority | "all";
  /** `"all"` is a sentinel meaning "no agent filter" — every other value is a real `agentId`. */
  readonly agentId: string;
  readonly showTerminal: boolean;
}

export const DEFAULT_KANBAN_FILTERS: KanbanFilters = {
  search: "",
  priority: "all",
  agentId: "all",
  showTerminal: true,
};

export function hasActiveFilters(filters: KanbanFilters): boolean {
  return (
    filters.search.trim().length > 0 ||
    filters.priority !== "all" ||
    filters.agentId !== "all" ||
    !filters.showTerminal
  );
}

/** Client-side only — no new server query API. Pure and cheap enough to run on every render. */
export function filterTasks(
  tasks: readonly TaskRecord[],
  filters: KanbanFilters,
): readonly TaskRecord[] {
  const search = filters.search.trim().toLowerCase();
  return tasks.filter((record) => {
    if (!filters.showTerminal && isTerminalStatus(record.task.status)) return false;
    if (filters.priority !== "all" && record.task.priority !== filters.priority) return false;
    if (filters.agentId !== "all" && record.agentId !== filters.agentId) return false;
    if (search.length > 0) {
      const haystack = `${record.task.title} ${record.task.projectId}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

/**
 * Groups tasks by column, preserving the server's own list order within
 * each group — Phase 7 deliberately implements no persisted within-column
 * custom ordering (see `docs/architecture/0006-kanban-board.md`).
 */
export function groupTasksByColumn(
  tasks: readonly TaskRecord[],
): Readonly<Record<TaskStatus, readonly TaskRecord[]>> {
  const grouped: Record<TaskStatus, TaskRecord[]> = {
    backlog: [],
    ready: [],
    assigned: [],
    running: [],
    reviewing: [],
    waiting_for_approval: [],
    blocked: [],
    completed: [],
    failed: [],
    cancelled: [],
  };
  for (const record of tasks) {
    grouped[record.task.status].push(record);
  }
  return grouped;
}
