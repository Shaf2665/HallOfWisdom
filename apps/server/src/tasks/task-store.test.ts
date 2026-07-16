import { describe, expect, it } from "vitest";
import type { HallTask } from "@hall-of-wisdom/protocol";
import { TaskStore } from "./task-store.js";
import {
  DuplicateTaskError,
  InvalidTaskTransitionError,
  TaskCapacityReachedError,
  TaskNotFoundError,
} from "../errors/app-error.js";
import type { TaskRecord } from "./task-record.js";

function makeTask(taskId: string, overrides: Partial<HallTask> = {}): HallTask {
  return {
    taskId,
    projectId: "project-1",
    title: "Test task",
    description: "",
    priority: "normal",
    status: "assigned",
    dependencyTaskIds: [],
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

function makeRecord(taskId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task: makeTask(taskId),
    runId: `run-${taskId}`,
    adapterId: "hall.mock-agent",
    agentId: "mock-agent",
    eventCount: 0,
    lastSequence: undefined,
    terminalEventType: undefined,
    failure: undefined,
    cancellationRequested: false,
    createdAt: "2026-07-15T12:00:00.000Z",
    startedAt: undefined,
    completedAt: undefined,
    ...overrides,
  };
}

describe("TaskStore", () => {
  it("adds and retrieves a task", () => {
    const store = new TaskStore({ maxTasks: 10 });
    store.add(makeRecord("task-1"));
    expect(store.get("task-1").task.taskId).toBe("task-1");
  });

  it("lists tasks in deterministic (insertion) order", () => {
    const store = new TaskStore({ maxTasks: 10 });
    store.add(makeRecord("task-1"));
    store.add(makeRecord("task-2"));
    store.add(makeRecord("task-3"));
    expect(store.list().map((record) => record.task.taskId)).toEqual([
      "task-1",
      "task-2",
      "task-3",
    ]);
  });

  it("rejects a duplicate task ID", () => {
    const store = new TaskStore({ maxTasks: 10 });
    store.add(makeRecord("task-1"));
    expect(() => {
      store.add(makeRecord("task-1"));
    }).toThrow(DuplicateTaskError);
  });

  it("rejects getting an unknown task", () => {
    const store = new TaskStore({ maxTasks: 10 });
    expect(() => store.get("nonexistent")).toThrow(TaskNotFoundError);
  });

  it("enforces the configured task capacity", () => {
    const store = new TaskStore({ maxTasks: 2 });
    store.add(makeRecord("task-1"));
    store.add(makeRecord("task-2"));
    expect(() => {
      store.add(makeRecord("task-3"));
    }).toThrow(TaskCapacityReachedError);
  });

  it("returns a defensive copy from get() — external mutation does not affect the store", () => {
    const store = new TaskStore({ maxTasks: 10 });
    store.add(makeRecord("task-1"));
    const snapshot = store.get("task-1");
    snapshot.eventCount = 999;
    snapshot.task.title = "mutated externally";
    expect(store.get("task-1").eventCount).toBe(0);
    expect(store.get("task-1").task.title).toBe("Test task");
  });

  it("returns defensive copies from list() too", () => {
    const store = new TaskStore({ maxTasks: 10 });
    store.add(makeRecord("task-1"));
    const [snapshot] = store.list();
    if (!snapshot) throw new Error("expected one task");
    snapshot.eventCount = 999;
    expect(store.get("task-1").eventCount).toBe(0);
  });

  it("allows the assigned -> running -> completed transition", () => {
    const store = new TaskStore({ maxTasks: 10 });
    store.add(makeRecord("task-1"));
    store.updateStatus("task-1", "running");
    store.updateStatus("task-1", "completed");
    expect(store.get("task-1").task.status).toBe("completed");
  });

  it("allows assigned -> cancelled directly (immediate-abort case)", () => {
    const store = new TaskStore({ maxTasks: 10 });
    store.add(makeRecord("task-1"));
    store.updateStatus("task-1", "cancelled");
    expect(store.get("task-1").task.status).toBe("cancelled");
  });

  it("rejects an invalid transition (e.g. completed -> running)", () => {
    const store = new TaskStore({ maxTasks: 10 });
    store.add(makeRecord("task-1"));
    store.updateStatus("task-1", "running");
    store.updateStatus("task-1", "completed");
    expect(() => {
      store.updateStatus("task-1", "running");
    }).toThrow(InvalidTaskTransitionError);
  });

  it("rejects restarting a terminal task", () => {
    const store = new TaskStore({ maxTasks: 10 });
    store.add(makeRecord("task-1"));
    store.updateStatus("task-1", "running");
    store.updateStatus("task-1", "failed");
    expect(() => {
      store.updateStatus("task-1", "running");
    }).toThrow(InvalidTaskTransitionError);
    expect(() => {
      store.updateStatus("task-1", "assigned");
    }).toThrow(InvalidTaskTransitionError);
  });

  it("records event metadata (event count, last sequence)", () => {
    const store = new TaskStore({ maxTasks: 10 });
    store.add(makeRecord("task-1"));
    store.recordEventMeta("task-1", 0);
    store.recordEventMeta("task-1", 1);
    const record = store.get("task-1");
    expect(record.eventCount).toBe(2);
    expect(record.lastSequence).toBe(1);
  });

  it("records safe failure information, not a raw Error object", () => {
    const store = new TaskStore({ maxTasks: 10 });
    store.add(makeRecord("task-1"));
    store.updateStatus("task-1", "running");
    store.setCompleted("task-1", "2026-07-15T12:00:01.000Z", "run.failed", {
      code: "MOCK_EXECUTION_FAILED",
      message: "The mock agent simulated a failure.",
    });
    const record = store.get("task-1");
    expect(record.failure).toEqual({
      code: "MOCK_EXECUTION_FAILED",
      message: "The mock agent simulated a failure.",
    });
    expect(record.terminalEventType).toBe("run.failed");
  });

  it("marks cancellation as requested", () => {
    const store = new TaskStore({ maxTasks: 10 });
    store.add(makeRecord("task-1"));
    expect(store.get("task-1").cancellationRequested).toBe(false);
    store.setCancellationRequested("task-1");
    expect(store.get("task-1").cancellationRequested).toBe(true);
  });
});
