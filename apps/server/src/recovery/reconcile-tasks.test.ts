import { afterEach, describe, expect, it } from "vitest";
import { parseHallTask, type NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { SqliteTaskStore } from "../tasks/sqlite-task-store.js";
import { SqliteEventStore } from "../events/sqlite-event-store.js";
import type { TaskRecord } from "../tasks/task-record.js";
import { reconcileTasks, RESTART_INTERRUPTED_RUN_CODE } from "./reconcile-tasks.js";

const openDatabases: HallDatabase[] = [];
afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close();
});

function openHarness(): { taskStore: SqliteTaskStore; eventStore: SqliteEventStore } {
  const db = HallDatabase.openInMemory();
  runMigrations(db);
  openDatabases.push(db);
  return {
    taskStore: new SqliteTaskStore({ db, maxTasks: 100 }),
    eventStore: new SqliteEventStore({ db, streamKind: "task", maxEventsPerStream: 50 }),
  };
}

const NOW = "2026-01-01T00:00:00.000Z";

function buildTaskRecord(
  taskId: string,
  overrides: Partial<TaskRecord> & { status?: string } = {},
): TaskRecord {
  const task = parseHallTask({
    taskId,
    projectId: "proj-1",
    title: "Task",
    description: "",
    priority: "normal",
    status: overrides.status ?? "assigned",
    dependencyTaskIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  });
  return {
    task,
    runId: overrides.runId,
    adapterId: overrides.adapterId ?? "hall.claude-code",
    agentId: overrides.agentId ?? "agent-1",
    eventCount: overrides.eventCount ?? 0,
    lastSequence: overrides.lastSequence,
    terminalEventType: overrides.terminalEventType,
    failure: overrides.failure,
    cancellationRequested: overrides.cancellationRequested ?? false,
    createdAt: NOW,
    startedAt: overrides.startedAt,
    completedAt: overrides.completedAt,
    assignedExecutionTrust: overrides.assignedExecutionTrust,
  };
}

function makeEvent(
  taskId: string,
  sequence: number,
  overrides: Partial<NormalizedAgentEvent> = {},
): NormalizedAgentEvent {
  return {
    protocolVersion: "0.1",
    eventId: `${taskId}-event-${String(sequence)}`,
    runId: "run-1",
    taskId,
    agentId: "agent-1",
    timestamp: NOW,
    sequence,
    type: "run.started",
    payload: {},
    ...overrides,
  } as NormalizedAgentEvent;
}

describe("reconcileTasks", () => {
  it("leaves a task with no run untouched", () => {
    const { taskStore, eventStore } = openHarness();
    taskStore.add(buildTaskRecord("t-1", { status: "ready", runId: undefined }));

    const summary = reconcileTasks(taskStore, eventStore);

    expect(summary.tasksScanned).toBe(1);
    expect(summary.eventProjectionsRepaired).toBe(0);
    expect(summary.interruptedRunsMarkedFailed).toEqual([]);
    expect(taskStore.get("t-1").task.status).toBe("ready");
  });

  it("is a no-op for an already-terminal, fully-consistent task", () => {
    const { taskStore, eventStore } = openHarness();
    taskStore.add(buildTaskRecord("t-1", { status: "running", runId: "run-1", eventCount: 0 }));
    eventStore.append("t-1", makeEvent("t-1", 0, { type: "run.started" }), {
      runId: "run-1",
      taskId: "t-1",
      agentId: "agent-1",
    });
    eventStore.append("t-1", makeEvent("t-1", 1, { type: "run.completed", payload: {} }), {
      runId: "run-1",
      taskId: "t-1",
      agentId: "agent-1",
    });
    taskStore.recordEventMeta("t-1", 0);
    taskStore.recordEventMeta("t-1", 1);
    taskStore.updateStatus("t-1", "completed");
    taskStore.setCompleted("t-1", NOW, "run.completed");

    const summary = reconcileTasks(taskStore, eventStore);

    expect(summary.eventProjectionsRepaired).toBe(0);
    expect(summary.terminalOutcomesReplayed).toBe(0);
    expect(summary.interruptedRunsMarkedFailed).toEqual([]);
  });

  it("replays a terminal event whose status-side effects never committed", () => {
    const { taskStore, eventStore } = openHarness();
    taskStore.add(buildTaskRecord("t-1", { status: "running", runId: "run-1", eventCount: 0 }));
    // Simulate: eventStore.append() committed, but the subsequent
    // TaskStore.recordEventMeta/updateStatus/setCompleted calls never ran.
    eventStore.append("t-1", makeEvent("t-1", 0, { type: "run.completed", payload: {} }), {
      runId: "run-1",
      taskId: "t-1",
      agentId: "agent-1",
    });

    const summary = reconcileTasks(taskStore, eventStore);

    expect(summary.eventProjectionsRepaired).toBe(1);
    expect(summary.terminalOutcomesReplayed).toBe(1);
    expect(summary.interruptedRunsMarkedFailed).toEqual([]);

    const record = taskStore.get("t-1");
    expect(record.task.status).toBe("completed");
    expect(record.eventCount).toBe(1);
    expect(record.lastSequence).toBe(0);
    expect(record.terminalEventType).toBe("run.completed");
  });

  it("marks a genuinely interrupted run failed exactly once, even across repeated recovery passes", () => {
    const { taskStore, eventStore } = openHarness();
    taskStore.add(buildTaskRecord("t-1", { status: "running", runId: "run-1", eventCount: 0 }));
    eventStore.append("t-1", makeEvent("t-1", 0, { type: "run.started" }), {
      runId: "run-1",
      taskId: "t-1",
      agentId: "agent-1",
    });

    const firstPass = reconcileTasks(taskStore, eventStore);
    expect(firstPass.interruptedRunsMarkedFailed).toEqual(["t-1"]);

    const afterFirst = taskStore.get("t-1");
    expect(afterFirst.task.status).toBe("failed");
    expect(afterFirst.failure?.code).toBe(RESTART_INTERRUPTED_RUN_CODE);
    const eventsAfterFirst = eventStore.list("t-1");
    expect(eventsAfterFirst).toHaveLength(2);
    expect(eventsAfterFirst[1]?.type).toBe("run.failed");

    const secondPass = reconcileTasks(taskStore, eventStore);
    expect(secondPass.interruptedRunsMarkedFailed).toEqual([]);
    expect(secondPass.eventProjectionsRepaired).toBe(0);
    expect(eventStore.list("t-1")).toHaveLength(2);
  });

  it("treats a run with zero events at all as interrupted", () => {
    const { taskStore, eventStore } = openHarness();
    taskStore.add(buildTaskRecord("t-1", { status: "assigned", runId: "run-1", eventCount: 0 }));

    const summary = reconcileTasks(taskStore, eventStore);

    expect(summary.interruptedRunsMarkedFailed).toEqual(["t-1"]);
    expect(taskStore.get("t-1").task.status).toBe("failed");
  });

  it("reconciles multiple independently-interrupted tasks in a single pass without one affecting another", () => {
    const { taskStore, eventStore } = openHarness();
    // t-1: genuinely interrupted (no terminal event at all).
    taskStore.add(buildTaskRecord("t-1", { status: "running", runId: "run-1", eventCount: 0 }));
    eventStore.append("t-1", makeEvent("t-1", 0, { type: "run.started" }), {
      runId: "run-1",
      taskId: "t-1",
      agentId: "agent-1",
    });
    // t-2: terminal event committed but status-side effects never landed.
    taskStore.add(buildTaskRecord("t-2", { status: "running", runId: "run-2", eventCount: 0 }));
    eventStore.append(
      "t-2",
      makeEvent("t-2", 0, { runId: "run-2", taskId: "t-2", type: "run.completed", payload: {} }),
      { runId: "run-2", taskId: "t-2", agentId: "agent-1" },
    );
    // t-3: never started, nothing to reconcile.
    taskStore.add(buildTaskRecord("t-3", { status: "backlog", runId: undefined, eventCount: 0 }));

    const summary = reconcileTasks(taskStore, eventStore);

    expect(summary.tasksScanned).toBe(3);
    expect(summary.interruptedRunsMarkedFailed).toEqual(["t-1"]);
    expect(summary.terminalOutcomesReplayed).toBe(1);
    expect(taskStore.get("t-1").task.status).toBe("failed");
    expect(taskStore.get("t-2").task.status).toBe("completed");
    expect(taskStore.get("t-3").task.status).toBe("backlog");
  });
});
