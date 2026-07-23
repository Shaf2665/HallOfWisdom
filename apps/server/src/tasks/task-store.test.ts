import { describe, expect, it } from "vitest";
import type { HallTask } from "@hall-of-wisdom/protocol";
import { TaskStore } from "./task-store.js";
import {
  DuplicateTaskError,
  InvalidTaskTransitionError,
  TaskCapacityReachedError,
  TaskNotFoundError,
  TaskStateConflictError,
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
    assignedExecutionTrust: undefined,
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

  describe("assignIfEligible", () => {
    function makeReadyRecord(taskId: string): TaskRecord {
      return makeRecord(taskId, {
        task: makeTask(taskId, { status: "ready" }),
        runId: undefined,
        adapterId: undefined,
        agentId: undefined,
      });
    }

    it("commits a first assignment from ready, moving status to assigned", () => {
      const store = new TaskStore({ maxTasks: 10 });
      store.add(makeReadyRecord("task-1"));
      const result = store.assignIfEligible(
        "task-1",
        store.getRevision("task-1"),
        { status: "ready", runId: undefined, adapterId: undefined, agentId: undefined },
        { adapterId: "hall.mock-agent", agentId: "mock-agent", executionTrust: "isolated" },
      );
      expect(result.task.status).toBe("assigned");
      expect(result.adapterId).toBe("hall.mock-agent");
      expect(result.agentId).toBe("mock-agent");
      expect(store.get("task-1").task.status).toBe("assigned");
    });

    it("commits a reassignment while already assigned with no run, leaving status unchanged", () => {
      const store = new TaskStore({ maxTasks: 10 });
      store.add(
        makeRecord("task-1", {
          task: makeTask("task-1", { status: "assigned" }),
          runId: undefined,
          adapterId: "hall.old-agent",
          agentId: "old-agent",
        }),
      );
      const result = store.assignIfEligible(
        "task-1",
        store.getRevision("task-1"),
        { status: "assigned", runId: undefined, adapterId: "hall.old-agent", agentId: "old-agent" },
        { adapterId: "hall.new-agent", agentId: "new-agent", executionTrust: "isolated" },
      );
      expect(result.task.status).toBe("assigned");
      expect(result.adapterId).toBe("hall.new-agent");
      expect(result.agentId).toBe("new-agent");
    });

    it("rejects when the live status no longer matches the expected snapshot (e.g. moved to blocked)", () => {
      const store = new TaskStore({ maxTasks: 10 });
      store.add(makeReadyRecord("task-1"));
      const staleRevision = store.getRevision("task-1");
      store.updateStatus("task-1", "blocked");
      expect(() => {
        store.assignIfEligible(
          "task-1",
          staleRevision,
          { status: "ready", runId: undefined, adapterId: undefined, agentId: undefined },
          { adapterId: "hall.mock-agent", agentId: "mock-agent", executionTrust: "isolated" },
        );
      }).toThrow(TaskStateConflictError);
      // The rejected commit must not have mutated anything.
      expect(store.get("task-1").task.status).toBe("blocked");
      expect(store.get("task-1").adapterId).toBeUndefined();
    });

    it("rejects when a run has already been claimed since the snapshot was taken", () => {
      const store = new TaskStore({ maxTasks: 10 });
      store.add(
        makeRecord("task-1", {
          task: makeTask("task-1", { status: "assigned" }),
          runId: undefined,
          adapterId: "hall.old-agent",
          agentId: "old-agent",
        }),
      );
      const staleRevision = store.getRevision("task-1");
      store.setRunId("task-1", "run-1");
      expect(() => {
        store.assignIfEligible(
          "task-1",
          staleRevision,
          {
            status: "assigned",
            runId: undefined,
            adapterId: "hall.old-agent",
            agentId: "old-agent",
          },
          { adapterId: "hall.new-agent", agentId: "new-agent", executionTrust: "isolated" },
        );
      }).toThrow(TaskStateConflictError);
    });

    it("rejects a stale snapshot even when the live status string still matches (a different assignment already committed)", () => {
      const store = new TaskStore({ maxTasks: 10 });
      store.add(makeReadyRecord("task-1"));
      const staleRevision = store.getRevision("task-1");
      // First commit: ready -> assigned via hall.first-agent.
      store.assignIfEligible(
        "task-1",
        staleRevision,
        { status: "ready", runId: undefined, adapterId: undefined, agentId: undefined },
        { adapterId: "hall.first-agent", agentId: "first-agent", executionTrust: "isolated" },
      );
      // A second caller's snapshot (also taken while the task was still
      // "ready", at the same stale revision) is now stale: the live status
      // is "assigned", not "ready", AND the revision has moved on.
      expect(() => {
        store.assignIfEligible(
          "task-1",
          staleRevision,
          { status: "ready", runId: undefined, adapterId: undefined, agentId: undefined },
          { adapterId: "hall.second-agent", agentId: "second-agent", executionTrust: "isolated" },
        );
      }).toThrow(TaskStateConflictError);
      expect(store.get("task-1").adapterId).toBe("hall.first-agent");
    });

    it("rejects a stale reassignment after another reassignment already committed at the same observed revision", () => {
      // The two-concurrent-reassignment case, at the TaskStore level: both
      // requests read the task while it was `assigned` with the same
      // adapter and the same revision; only the first commit may win.
      const store = new TaskStore({ maxTasks: 10 });
      store.add(
        makeRecord("task-1", {
          task: makeTask("task-1", { status: "assigned" }),
          runId: undefined,
          adapterId: "hall.old-agent",
          agentId: "old-agent",
        }),
      );
      const revision = store.getRevision("task-1");
      const snapshot = {
        status: "assigned" as const,
        runId: undefined,
        adapterId: "hall.old-agent",
        agentId: "old-agent",
      };
      store.assignIfEligible("task-1", revision, snapshot, {
        adapterId: "hall.winner-agent",
        agentId: "winner-agent",
        executionTrust: "isolated",
      });
      expect(() => {
        store.assignIfEligible("task-1", revision, snapshot, {
          adapterId: "hall.loser-agent",
          agentId: "loser-agent",
          executionTrust: "isolated",
        });
      }).toThrow(TaskStateConflictError);
      expect(store.get("task-1").adapterId).toBe("hall.winner-agent");
    });

    it("rejects assignment on an unknown task", () => {
      const store = new TaskStore({ maxTasks: 10 });
      expect(() => {
        store.assignIfEligible(
          "nonexistent",
          0,
          { status: "ready", runId: undefined, adapterId: undefined, agentId: undefined },
          { adapterId: "hall.mock-agent", agentId: "mock-agent", executionTrust: "isolated" },
        );
      }).toThrow(TaskNotFoundError);
    });

    it("is self-contained: rejects a blocked task even if a caller wrongly claims it observed ready", () => {
      // Defense in depth for the case documented on assignIfEligible's own
      // doc comment: the live-state re-derivation (isFirstAssignment /
      // isReassignment) does not simply trust `expected` — it independently
      // re-checks the live record's actual status.
      const store = new TaskStore({ maxTasks: 10 });
      store.add(makeRecord("task-1", { task: makeTask("task-1", { status: "blocked" }) }));
      expect(() => {
        store.assignIfEligible(
          "task-1",
          store.getRevision("task-1"),
          { status: "ready", runId: undefined, adapterId: undefined, agentId: undefined },
          { adapterId: "hall.mock-agent", agentId: "mock-agent", executionTrust: "isolated" },
        );
      }).toThrow(TaskStateConflictError);
    });

    it("rejects a stale revision even when all four snapshot fields still coincidentally match (the ABA case)", () => {
      // The exact gap a four-field-only compare cannot catch: two real
      // mutations (ready -> blocked -> ready) leave `status` reading
      // "ready" again — identical to the originally observed snapshot —
      // but the task's real history moved, and revision proves it.
      const store = new TaskStore({ maxTasks: 10 });
      store.add(makeReadyRecord("task-1"));
      const staleRevision = store.getRevision("task-1");
      const staleSnapshot = {
        status: "ready" as const,
        runId: undefined,
        adapterId: undefined,
        agentId: undefined,
      };
      store.updateStatus("task-1", "blocked");
      store.updateStatus("task-1", "ready");
      expect(store.get("task-1").task.status).toBe("ready");
      expect(store.getRevision("task-1")).toBe(staleRevision + 2);
      expect(() => {
        store.assignIfEligible("task-1", staleRevision, staleSnapshot, {
          adapterId: "hall.mock-agent",
          agentId: "mock-agent",
          executionTrust: "isolated",
        });
      }).toThrow(TaskStateConflictError);
      // The rejected commit must not have mutated anything.
      expect(store.get("task-1").adapterId).toBeUndefined();
      expect(store.get("task-1").task.status).toBe("ready");
    });

    it("rejects assignment when only the expected revision is stale, independent of the four-field snapshot", () => {
      const store = new TaskStore({ maxTasks: 10 });
      store.add(makeReadyRecord("task-1"));
      const correctSnapshot = {
        status: "ready" as const,
        runId: undefined,
        adapterId: undefined,
        agentId: undefined,
      };
      expect(() => {
        store.assignIfEligible("task-1", 999, correctSnapshot, {
          adapterId: "hall.mock-agent",
          agentId: "mock-agent",
          executionTrust: "isolated",
        });
      }).toThrow(TaskStateConflictError);
    });
  });

  describe("internal task revision", () => {
    it("a new record receives the documented initial revision (0)", () => {
      const store = new TaskStore({ maxTasks: 10 });
      store.add(makeRecord("task-1"));
      expect(store.getRevision("task-1")).toBe(0);
    });

    it("a successful mutation increments revision by exactly one", () => {
      const store = new TaskStore({ maxTasks: 10 });
      store.add(makeRecord("task-1", { task: makeTask("task-1", { status: "assigned" }) }));
      expect(store.getRevision("task-1")).toBe(0);
      store.updateStatus("task-1", "running");
      expect(store.getRevision("task-1")).toBe(1);
    });

    it("a rejected mutation does not increment revision", () => {
      const store = new TaskStore({ maxTasks: 10 });
      store.add(makeRecord("task-1", { task: makeTask("task-1", { status: "completed" }) }));
      expect(store.getRevision("task-1")).toBe(0);
      expect(() => {
        // completed -> running is not a valid transition.
        store.updateStatus("task-1", "running");
      }).toThrow(InvalidTaskTransitionError);
      expect(store.getRevision("task-1")).toBe(0);
    });

    it("two successful sequential mutations produce strictly increasing revisions", () => {
      const store = new TaskStore({ maxTasks: 10 });
      store.add(makeRecord("task-1", { task: makeTask("task-1", { status: "assigned" }) }));
      const r0 = store.getRevision("task-1");
      store.updateStatus("task-1", "running");
      const r1 = store.getRevision("task-1");
      store.setStarted("task-1", "2026-07-16T00:00:00.000Z");
      const r2 = store.getRevision("task-1");
      expect(r1).toBeGreaterThan(r0);
      expect(r2).toBeGreaterThan(r1);
    });

    it("revision is never a key on a public task snapshot from get() or list()", () => {
      const store = new TaskStore({ maxTasks: 10 });
      store.add(makeRecord("task-1"));
      const snapshot = store.get("task-1");
      expect(Object.keys(snapshot)).not.toContain("revision");
      expect(JSON.stringify(snapshot)).not.toContain("revision");
      const [listed] = store.list();
      if (!listed) throw new Error("expected one task");
      expect(Object.keys(listed)).not.toContain("revision");
    });

    it("revision is never reset or reused after further mutations", () => {
      const store = new TaskStore({ maxTasks: 10 });
      store.add(makeRecord("task-1", { task: makeTask("task-1", { status: "assigned" }) }));
      store.updateStatus("task-1", "running");
      store.updateStatus("task-1", "completed");
      expect(store.getRevision("task-1")).toBe(2);
    });
  });
});
