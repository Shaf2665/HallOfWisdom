import { isTerminalEventType } from "@hall-of-wisdom/hall-runner";
import { isTerminalTaskStatus } from "../tasks/task-status-transitions.js";
import type { TaskStorePort } from "../tasks/task-store-port.js";
import type { TaskRecord } from "../tasks/task-record.js";
import type { NormalizedEventStorePort } from "../events/event-store-port.js";
import { EventStoreError } from "../events/event-store-errors.js";
import { buildInfrastructureFailureEvent } from "../events/synthetic-events.js";

export const RESTART_INTERRUPTED_RUN_CODE = "HALL_RESTART_INTERRUPTED_RUN";

export interface TaskReconciliationSummary {
  readonly tasksScanned: number;
  readonly eventProjectionsRepaired: number;
  readonly terminalOutcomesReplayed: number;
  readonly interruptedRunsMarkedFailed: readonly string[];
}

/**
 * Runs unconditionally on every durable startup (never gated behind
 * "previous shutdown was unclean") — see
 * `docs/architecture/0013-durable-persistence-and-recovery.md`,
 * "Projections, not cross-store transactions." `TaskOrchestrator#handleEvent`
 * writes the authoritative event first (`eventStore.append`, its own
 * committed transaction) and only then updates `TaskStore`'s
 * `eventCount`/`lastSequence`/status/completion fields in separate
 * transactions; a crash between those two writes leaves the task record
 * stale relative to its own event stream. Rather than require cross-store
 * atomicity (impossible with one `BEGIN IMMEDIATE` per store), this treats
 * the events table as the single source of truth and replays whatever
 * `TaskStore` mutations a completed `#handleEvent` call would have made,
 * using each store's own already-idempotent public methods.
 *
 * Idempotent by construction across repeated unclean restarts: every step
 * below is keyed off the task's CURRENT persisted state, not off whether
 * the previous shutdown was unclean, so a second consecutive unclean
 * restart finds each task already reconciled (terminal, or event counts
 * already caught up) and does nothing further to it — see
 * `recordInterruptedRun`'s own note on why this can never append a second
 * synthetic terminal event for the same run.
 */
export function reconcileTasks(
  taskStore: TaskStorePort,
  eventStore: NormalizedEventStorePort,
): TaskReconciliationSummary {
  const tasks = taskStore.list();
  let eventProjectionsRepaired = 0;
  let terminalOutcomesReplayed = 0;
  const interruptedRunsMarkedFailed: string[] = [];

  for (const initial of tasks) {
    const taskId = initial.task.taskId;
    const actualEvents = eventStore.list(taskId);

    if (actualEvents.length > initial.eventCount) {
      for (const event of actualEvents.slice(initial.eventCount)) {
        taskStore.recordEventMeta(taskId, event.sequence);
      }
      eventProjectionsRepaired += 1;
    }

    const record = taskStore.get(taskId);
    if (isTerminalTaskStatus(record.task.status)) continue;

    const lastEvent = actualEvents.at(-1);
    if (lastEvent !== undefined && isTerminalEventType(lastEvent.type)) {
      // Sequence N+1 can only ever be appended after sequence N's entire
      // synchronous `#handleEvent` handling (including its own status
      // commit) already succeeded, within the same process lifetime — a
      // crash can therefore only ever leave the LAST event's status-side
      // effects uncommitted, never an earlier one's (e.g. a persisted
      // `run.completed` implies `run.started`'s `updateStatus("running")`
      // already committed). This transition should always be valid as a
      // result — but recovery runs before the server accepts a single
      // request, so an unexpected `InvalidTaskTransitionError` here must
      // never brick startup: caught and treated the same as "could not
      // cleanly replay," falling through to the interrupted-run path below
      // instead of propagating.
      try {
        switch (lastEvent.type) {
          case "run.completed":
            taskStore.updateStatus(taskId, "completed");
            taskStore.setCompleted(taskId, lastEvent.timestamp, "run.completed");
            break;
          case "run.failed":
            taskStore.updateStatus(taskId, "failed");
            taskStore.setCompleted(
              taskId,
              lastEvent.timestamp,
              "run.failed",
              lastEvent.payload.failure,
            );
            break;
          case "run.cancelled":
            taskStore.updateStatus(taskId, "cancelled");
            taskStore.setCompleted(taskId, lastEvent.timestamp, "run.cancelled");
            break;
        }
        terminalOutcomesReplayed += 1;
        continue;
      } catch (error) {
        console.error(
          `Recovery could not replay the terminal outcome for task "${taskId}"; falling back to marking it interrupted: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const stillNonTerminal = taskStore.get(taskId);
    if (
      !isTerminalTaskStatus(stillNonTerminal.task.status) &&
      stillNonTerminal.runId !== undefined
    ) {
      const marked = recordInterruptedRun(taskStore, eventStore, taskId, stillNonTerminal);
      if (marked) interruptedRunsMarkedFailed.push(taskId);
    }
  }

  return {
    tasksScanned: tasks.length,
    eventProjectionsRepaired,
    terminalOutcomesReplayed,
    interruptedRunsMarkedFailed,
  };
}

function recordInterruptedRun(
  taskStore: TaskStorePort,
  eventStore: NormalizedEventStorePort,
  taskId: string,
  record: TaskRecord,
): boolean {
  if (record.runId === undefined || record.agentId === undefined) {
    console.error(`Recovery cannot mark task "${taskId}" interrupted: it has no run recorded.`);
    return false;
  }

  const failureEvent = buildInfrastructureFailureEvent({
    runId: record.runId,
    taskId,
    agentId: record.agentId,
    sequence: eventStore.nextSequence(taskId),
    code: RESTART_INTERRUPTED_RUN_CODE,
    message: "This task's run was interrupted by a Hall Core restart and was not resumed.",
  });

  try {
    const result = eventStore.append(taskId, failureEvent, {
      runId: record.runId,
      taskId,
      agentId: record.agentId,
    });
    if (result.stored) {
      taskStore.recordEventMeta(taskId, failureEvent.sequence);
    }
  } catch (error) {
    if (!(error instanceof EventStoreError)) throw error;
    console.error(
      `Recovery could not store the interrupted-run event for task "${taskId}": ${error.message}`,
    );
  }

  taskStore.updateStatus(taskId, "failed");
  taskStore.setCompleted(
    taskId,
    failureEvent.timestamp,
    "run.failed",
    failureEvent.payload.failure,
  );
  return true;
}
