import type { TaskStatus } from "@hall-of-wisdom/protocol";

/**
 * Phase 5 only drives tasks through `assigned -> running -> {completed |
 * failed | cancelled}` (a task is created directly in `assigned` state,
 * since an adapter is already selected at creation time) — plus
 * `assigned -> cancelled` directly, for the immediate-abort case where a
 * cancellation request arrives before `run.started` is ever emitted, and
 * `assigned -> failed` directly, for a Hall Core infrastructure failure
 * (Phase 5.1's event-capacity/store-invariant handling — see
 * `docs/architecture/0004-hall-core-server.md`, "Event-capacity terminal
 * handling") that occurs on the very first event a task ever receives,
 * before `run.started` could be stored. The remaining `TaskStatus` values
 * from the protocol package (`backlog`, `ready`, `reviewing`,
 * `waiting_for_approval`, `blocked`) belong to a fuller Kanban workflow
 * (Phase 7+) and are not reachable from this server yet — they are listed
 * here with no allowed outgoing transitions so the table stays exhaustive
 * over the whole `TaskStatus` type.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> = {
  backlog: new Set(["assigned"]),
  ready: new Set([]),
  assigned: new Set(["running", "cancelled", "failed"]),
  running: new Set(["completed", "failed", "cancelled"]),
  reviewing: new Set([]),
  waiting_for_approval: new Set([]),
  blocked: new Set([]),
  completed: new Set([]),
  failed: new Set([]),
  cancelled: new Set([]),
};

export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

export function isValidTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}
