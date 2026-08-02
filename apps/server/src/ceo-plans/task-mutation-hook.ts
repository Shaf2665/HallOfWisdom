import type { TaskStorePort } from "../tasks/task-store-port.js";
import type { Snapshottable } from "./ephemeral-atomic-unit.js";

function isSnapshottableStore(
  value: TaskStorePort,
): value is TaskStorePort & Snapshottable<unknown> {
  return (
    typeof (value as { snapshot?: unknown }).snapshot === "function" &&
    typeof (value as { restore?: unknown }).restore === "function"
  );
}

/**
 * Phase 14.1 — wraps a `TaskStorePort` so every status-changing call also
 * notifies a listener, after the real store call succeeds. Wired once at
 * the composition root (before the taskStore is handed to BOTH
 * `TaskOrchestrator` and `createCeoPlanComposition`), so the hook fires
 * regardless of which orchestrator performed the mutation — a plan's
 * child task can change status via a route `TaskOrchestrator` owns
 * entirely, with no `CeoPlanOrchestrator` involvement at all. Exceptions
 * thrown by the listener are caught and swallowed (never surfaced to the
 * caller of the wrapped method) — a missed progress sync is recoverable
 * by the reconciliation pass; the real task mutation must never fail
 * because of it.
 *
 * Every one of `TaskStorePort`'s methods is explicitly delegated by name
 * (not `{ ...taskStore, add(...) {...} }` object-spread — `taskStore` is
 * a class instance, whose methods live on the prototype chain, not as
 * own enumerable properties, so a spread would silently produce
 * `undefined` for every method not explicitly redefined). The method
 * list here is taken directly from `TaskStorePort` itself.
 *
 * `recordEventMeta` is a real mutation (`TaskOrchestrator#handleEvent`
 * depends on it unconditionally existing) but deliberately does NOT
 * notify: it only ever touches `eventCount`/`lastSequence`, and
 * `deriveCeoPlanProgress` (the only consumer of this hook's
 * notifications, via `synchronizePlanProgress`) reads nothing but
 * `record.task.status`. Notifying on it would make every normalized
 * event on every delegated child task — not just status transitions —
 * pay for a full progress-sync read that is guaranteed to no-op (the
 * fingerprint can never change), which is pure overhead on the hottest
 * possible path.
 *
 * `snapshot()`/`restore()` (Phase 14.1's ephemeral atomic-unit
 * coordinator, see `ephemeral-atomic-unit.ts`) are deliberately NOT part
 * of `TaskStorePort` and are attached to the returned wrapper only when
 * the wrapped store itself actually has them — true for the ephemeral
 * `TaskStore`, false for the durable `SqliteTaskStore`. Always defining a
 * pass-through unconditionally would make `ceo-plan-composition.ts`'s
 * `isSnapshottable` structural check lie in durable mode (reporting
 * "snapshottable" for a wrapper whose `snapshot()` would throw).
 */
export function wrapTaskStoreWithMutationHook(
  taskStore: TaskStorePort,
  onTaskMutated: (taskId: string) => void,
): TaskStorePort {
  function notify(taskId: string): void {
    try {
      onTaskMutated(taskId);
    } catch {
      // swallowed — see doc comment above
    }
  }

  const wrapped: TaskStorePort = {
    // Pure reads / non-status fields — delegate as-is, no notification.
    setWorkingDirectory(taskId, workingDirectory) {
      taskStore.setWorkingDirectory(taskId, workingDirectory);
    },
    getWorkingDirectory(taskId) {
      return taskStore.getWorkingDirectory(taskId);
    },
    get(taskId) {
      return taskStore.get(taskId);
    },
    list() {
      return taskStore.list();
    },
    getRevision(taskId) {
      return taskStore.getRevision(taskId);
    },
    remainingCapacity() {
      return taskStore.remainingCapacity();
    },
    recordEventMeta(taskId, sequence) {
      taskStore.recordEventMeta(taskId, sequence);
    },
    // Status-changing methods — delegate, then notify.
    add(record) {
      taskStore.add(record);
      notify(record.task.taskId);
    },
    updateStatus(taskId, nextStatus) {
      taskStore.updateStatus(taskId, nextStatus);
      notify(taskId);
    },
    setStarted(taskId, startedAt) {
      taskStore.setStarted(taskId, startedAt);
      notify(taskId);
    },
    setCompleted(taskId, completedAt, terminalEventType, failure) {
      taskStore.setCompleted(taskId, completedAt, terminalEventType, failure);
      notify(taskId);
    },
    setCancellationRequested(taskId) {
      taskStore.setCancellationRequested(taskId);
      notify(taskId);
    },
    assignIfEligible(taskId, expectedRevision, expected, assignment) {
      const result = taskStore.assignIfEligible(taskId, expectedRevision, expected, assignment);
      notify(taskId);
      return result;
    },
    clearAssignment(taskId) {
      taskStore.clearAssignment(taskId);
      notify(taskId);
    },
    setRunId(taskId, runId) {
      taskStore.setRunId(taskId, runId);
      notify(taskId);
    },
    clearRunId(taskId) {
      taskStore.clearRunId(taskId);
      notify(taskId);
    },
    startIfEligible(taskId, expectedRevision, expected, runId) {
      const result = taskStore.startIfEligible(taskId, expectedRevision, expected, runId);
      notify(taskId);
      return result;
    },
    prepareRetryIfEligible(taskId, expectedRevision, expected) {
      const result = taskStore.prepareRetryIfEligible(taskId, expectedRevision, expected);
      notify(taskId);
      return result;
    },
  };

  if (isSnapshottableStore(taskStore)) {
    return Object.assign(wrapped, {
      snapshot: () => taskStore.snapshot(),
      restore: (snapshot: unknown) => {
        taskStore.restore(snapshot);
      },
    });
  }
  return wrapped;
}
