import type { TaskStatus } from "@hall-of-wisdom/protocol";

/**
 * The full status graph `TaskStore.updateStatus()` enforces — every edge
 * any code path in this server may ever apply, whether driven by a client
 * request or by an adapter's own normalized events. This is intentionally
 * broader than what a client may request directly through the manual
 * planning-transition endpoint (`MANUAL_TRANSITIONS` below); the extra
 * edges here are reachable only from specific, already-guarded internal
 * call sites:
 *
 * - `assigned -> running`: only ever applied by `TaskOrchestrator`
 *   (`#handleEvent`) in response to a real `run.started` event, never
 *   directly from a request.
 * - `assigned -> failed`, `running -> failed`: only ever applied by
 *   `TaskOrchestrator`'s infrastructure-failure workflow (Phase 5.1) or in
 *   response to a real `run.failed` event.
 * - `assigned -> cancelled`, `running -> cancelled`: only ever applied in
 *   response to a real `run.cancelled` event (an active-run cancellation,
 *   requested via `POST /tasks/:taskId/cancel`, still has to wait for the
 *   adapter to actually stop before the status changes).
 * - `ready -> assigned`: only ever applied by `TaskOrchestrator.assignTask()`,
 *   after adapter existence/availability and working-directory validation.
 *
 * `reviewing` and `waiting_for_approval` have no outgoing edges anywhere
 * in this table — those columns exist in the Kanban board (Phase 7) as
 * future-workflow placeholders (see `docs/architecture/0006-kanban-board.md`,
 * "Why Agent Review and Human Approval are visible but not automated")
 * and are not reachable from anything in this server yet.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> = {
  backlog: new Set(["ready", "blocked", "cancelled"]),
  ready: new Set(["backlog", "blocked", "cancelled", "assigned"]),
  assigned: new Set(["ready", "blocked", "cancelled", "running", "failed"]),
  running: new Set(["completed", "failed", "cancelled"]),
  reviewing: new Set([]),
  waiting_for_approval: new Set([]),
  blocked: new Set(["backlog", "ready", "cancelled"]),
  completed: new Set([]),
  failed: new Set([]),
  cancelled: new Set([]),
};

/**
 * The strict subset of `ALLOWED_TRANSITIONS` a client may request directly
 * through `POST /api/v1/tasks/:taskId/transition`. Deliberately excludes
 * `running`, `reviewing`, `waiting_for_approval`, `completed`, and
 * `failed` as destinations from every status — those are always
 * execution-controlled or terminal, never a manual planning move — by
 * simply never listing them, rather than by a separate blocklist check.
 * `ready -> assigned` is likewise excluded here even though it's a valid
 * edge in the full graph: that transition only ever happens through
 * `POST /tasks/:taskId/assign`, which does real adapter/availability/
 * working-directory validation the generic transition endpoint has no way
 * to perform.
 */
const MANUAL_TRANSITIONS: Readonly<Partial<Record<TaskStatus, ReadonlySet<TaskStatus>>>> = {
  backlog: new Set(["ready", "blocked", "cancelled"]),
  ready: new Set(["backlog", "blocked", "cancelled"]),
  assigned: new Set(["ready", "blocked", "cancelled"]),
  blocked: new Set(["backlog", "ready", "cancelled"]),
};

export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** Statuses under active execution control — never eligible for a manual planning move. */
export const EXECUTION_CONTROLLED_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "running",
  "reviewing",
  "waiting_for_approval",
]);

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

export function isExecutionControlledStatus(status: TaskStatus): boolean {
  return EXECUTION_CONTROLLED_STATUSES.has(status);
}

export function isValidTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}

export function isManualTransitionAllowed(from: TaskStatus, to: TaskStatus): boolean {
  return MANUAL_TRANSITIONS[from]?.has(to) ?? false;
}
