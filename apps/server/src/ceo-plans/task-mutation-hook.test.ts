import { describe, expect, it, vi } from "vitest";
import type { HallTask } from "@hall-of-wisdom/protocol";
import { TaskStore } from "../tasks/task-store.js";
import type { TaskStorePort } from "../tasks/task-store-port.js";
import type { TaskRecord } from "../tasks/task-record.js";
import { wrapTaskStoreWithMutationHook } from "./task-mutation-hook.js";

function makeTaskRecord(taskId: string, overrides: Partial<HallTask> = {}): TaskRecord {
  return {
    task: {
      taskId,
      projectId: "project-1",
      title: "Test task",
      description: "",
      priority: "normal",
      status: "backlog",
      dependencyTaskIds: [],
      createdAt: "2026-07-15T12:00:00.000Z",
      updatedAt: "2026-07-15T12:00:00.000Z",
      ...overrides,
    },
    runId: undefined,
    adapterId: undefined,
    agentId: undefined,
    eventCount: 0,
    lastSequence: undefined,
    terminalEventType: undefined,
    failure: undefined,
    cancellationRequested: false,
    createdAt: "2026-07-15T12:00:00.000Z",
    startedAt: undefined,
    completedAt: undefined,
    assignedExecutionTrust: undefined,
  };
}

describe("wrapTaskStoreWithMutationHook", () => {
  it("delegates every TaskStorePort method's return value and real effect to the wrapped store", () => {
    const taskStore = new TaskStore({ maxTasks: 100 });
    const wrapped = wrapTaskStoreWithMutationHook(taskStore, () => {
      /* no-op */
    });

    wrapped.add(makeTaskRecord("task-1"));
    expect(wrapped.get("task-1").task.taskId).toBe("task-1");
    expect(wrapped.list()).toHaveLength(1);
    expect(wrapped.getRevision("task-1")).toBe(0);
    expect(wrapped.remainingCapacity()).toBe(taskStore.remainingCapacity());

    wrapped.setWorkingDirectory("task-1", "packages/protocol");
    expect(wrapped.getWorkingDirectory("task-1")).toBe("packages/protocol");

    wrapped.recordEventMeta("task-1", 0);
    expect(wrapped.get("task-1").eventCount).toBe(1);

    wrapped.setStarted("task-1", "2026-07-15T12:01:00.000Z");
    expect(wrapped.get("task-1").startedAt).toBe("2026-07-15T12:01:00.000Z");

    wrapped.setCompleted("task-1", "2026-07-15T12:02:00.000Z", "run.completed");
    expect(wrapped.get("task-1").completedAt).toBe("2026-07-15T12:02:00.000Z");

    wrapped.setCancellationRequested("task-1");
    expect(wrapped.get("task-1").cancellationRequested).toBe(true);
  });

  it("notifies the listener with the mutated taskId for every status-changing method, including add()", () => {
    const taskStore = new TaskStore({ maxTasks: 100 });
    const notified: string[] = [];
    const wrapped = wrapTaskStoreWithMutationHook(taskStore, (taskId) => notified.push(taskId));

    wrapped.add(makeTaskRecord("task-1"));
    wrapped.setStarted("task-1", "2026-07-15T12:01:00.000Z");
    wrapped.setCompleted("task-1", "2026-07-15T12:02:00.000Z", "run.completed");
    wrapped.setCancellationRequested("task-1");
    wrapped.clearRunId("task-1");

    expect(notified).toEqual(["task-1", "task-1", "task-1", "task-1", "task-1"]);
  });

  it("notifies after assignIfEligible/clearAssignment/setRunId/updateStatus with the correct taskId", () => {
    const taskStore = new TaskStore({ maxTasks: 100 });
    taskStore.add(makeTaskRecord("task-1", { status: "ready" }));
    const notified: string[] = [];
    const wrapped = wrapTaskStoreWithMutationHook(taskStore, (taskId) => notified.push(taskId));

    wrapped.assignIfEligible(
      "task-1",
      wrapped.getRevision("task-1"),
      { status: "ready", runId: undefined, adapterId: undefined, agentId: undefined },
      { adapterId: "hall.mock-agent", agentId: "mock-agent", executionTrust: "isolated" },
    );
    wrapped.setRunId("task-1", "run-1");
    wrapped.clearAssignment("task-1");

    expect(notified).toEqual(["task-1", "task-1", "task-1"]);
  });

  it("does not notify for pure-read/non-status methods: get, list, getRevision, remainingCapacity, getWorkingDirectory, setWorkingDirectory, recordEventMeta", () => {
    const taskStore = new TaskStore({ maxTasks: 100 });
    taskStore.add(makeTaskRecord("task-1"));
    const notified: string[] = [];
    const wrapped = wrapTaskStoreWithMutationHook(taskStore, (taskId) => notified.push(taskId));

    wrapped.get("task-1");
    wrapped.list();
    wrapped.getRevision("task-1");
    wrapped.remainingCapacity();
    wrapped.setWorkingDirectory("task-1", "packages/protocol");
    wrapped.getWorkingDirectory("task-1");
    wrapped.recordEventMeta("task-1", 0);

    expect(notified).toEqual([]);
    expect(wrapped.get("task-1").eventCount).toBe(1);
  });

  it("swallows a listener exception — the real mutation still succeeds and the caller never sees the listener's error", () => {
    const taskStore = new TaskStore({ maxTasks: 100 });
    const wrapped = wrapTaskStoreWithMutationHook(taskStore, () => {
      throw new Error("listener blew up");
    });

    expect(() => {
      wrapped.add(makeTaskRecord("task-1"));
    }).not.toThrow();
    expect(wrapped.get("task-1").task.taskId).toBe("task-1");
  });

  it("exposes a working snapshot()/restore() pass-through when the wrapped store supports it", () => {
    const taskStore = new TaskStore({ maxTasks: 100 });
    const wrapped = wrapTaskStoreWithMutationHook(taskStore, () => {
      /* no-op */
    }) as TaskStorePort & {
      snapshot?: () => unknown;
      restore?: (s: unknown) => void;
    };
    expect(typeof wrapped.snapshot).toBe("function");
    expect(typeof wrapped.restore).toBe("function");

    wrapped.add(makeTaskRecord("task-1"));
    const snap = wrapped.snapshot?.();
    wrapped.add(makeTaskRecord("task-2"));
    wrapped.restore?.(snap);

    expect(wrapped.list()).toHaveLength(1);
    expect(() => wrapped.get("task-2")).toThrow();
  });

  it("does not expose snapshot()/restore() when the wrapped store does not support it (e.g. a durable-mode store)", () => {
    const taskStore = new TaskStore({ maxTasks: 100 });
    const nonSnapshottable: TaskStorePort = {
      setWorkingDirectory: taskStore.setWorkingDirectory.bind(taskStore),
      getWorkingDirectory: taskStore.getWorkingDirectory.bind(taskStore),
      add: taskStore.add.bind(taskStore),
      get: taskStore.get.bind(taskStore),
      list: taskStore.list.bind(taskStore),
      getRevision: taskStore.getRevision.bind(taskStore),
      updateStatus: taskStore.updateStatus.bind(taskStore),
      recordEventMeta: taskStore.recordEventMeta.bind(taskStore),
      setStarted: taskStore.setStarted.bind(taskStore),
      setCompleted: taskStore.setCompleted.bind(taskStore),
      setCancellationRequested: taskStore.setCancellationRequested.bind(taskStore),
      assignIfEligible: taskStore.assignIfEligible.bind(taskStore),
      clearAssignment: taskStore.clearAssignment.bind(taskStore),
      setRunId: taskStore.setRunId.bind(taskStore),
      clearRunId: taskStore.clearRunId.bind(taskStore),
      startIfEligible: taskStore.startIfEligible.bind(taskStore),
      prepareRetryIfEligible: taskStore.prepareRetryIfEligible.bind(taskStore),
      remainingCapacity: taskStore.remainingCapacity.bind(taskStore),
    };
    const wrapped = wrapTaskStoreWithMutationHook(nonSnapshottable, () => {
      /* no-op */
    }) as TaskStorePort & {
      snapshot?: unknown;
      restore?: unknown;
    };
    expect(wrapped.snapshot).toBeUndefined();
    expect(wrapped.restore).toBeUndefined();
  });

  it("Phase 14.1 trap check: the underlying store's own add() is called through apply-style dispatch — a spy on the wrapped store's add still observes calls made via the wrapper", () => {
    const taskStore = new TaskStore({ maxTasks: 100 });
    const addSpy = vi.spyOn(taskStore, "add");
    const wrapped = wrapTaskStoreWithMutationHook(taskStore, () => {
      /* no-op */
    });
    wrapped.add(makeTaskRecord("task-1"));
    expect(addSpy).toHaveBeenCalledTimes(1);
  });
});
