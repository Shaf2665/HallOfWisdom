import { describe, expect, it } from "vitest";
import type { HallTask } from "@hall-of-wisdom/protocol";
import { TaskStateConflictError, TaskNotFoundError } from "../errors/app-error.js";
import type { TaskRecord } from "./task-record.js";
import type { TaskStorePort } from "./task-store-port.js";

function makeTask(taskId: string, overrides: Partial<HallTask> = {}): HallTask {
  return {
    taskId,
    projectId: "project-1",
    title: "Contract test task",
    description: "",
    priority: "normal",
    status: "ready",
    dependencyTaskIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeRecord(taskId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task: makeTask(taskId),
    runId: undefined,
    adapterId: undefined,
    agentId: undefined,
    eventCount: 0,
    lastSequence: undefined,
    terminalEventType: undefined,
    failure: undefined,
    cancellationRequested: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: undefined,
    completedAt: undefined,
    assignedExecutionTrust: undefined,
    ...overrides,
  };
}

/**
 * Behavioral contract every `TaskStorePort` implementation must satisfy —
 * run once against the in-memory `TaskStore` and once against
 * `SqliteTaskStore` (Phase 13's durable-mode sibling). See
 * `docs/architecture/0013-durable-persistence-and-recovery.md`, "Storage
 * ports" for why both backends share one behavioral suite instead of two
 * independently-written ones.
 */
export function defineTaskStoreContractTests(
  label: string,
  createStore: () => TaskStorePort,
): void {
  describe(`TaskStorePort contract (${label})`, () => {
    it("successful mutation increments the revision exactly once", () => {
      const store = createStore();
      store.add(makeRecord("task-1"));
      const r0 = store.getRevision("task-1");
      store.updateStatus("task-1", "backlog");
      expect(store.getRevision("task-1")).toBe(r0 + 1);
    });

    it("a rejected mutation does not increment the revision", () => {
      const store = createStore();
      store.add(makeRecord("task-1", { task: makeTask("task-1", { status: "backlog" }) }));
      const r0 = store.getRevision("task-1");
      expect(() => {
        store.updateStatus("task-1", "completed");
      }).toThrow();
      expect(store.getRevision("task-1")).toBe(r0);
    });

    it("assignIfEligible rejects a stale expectedRevision (compare-and-swap)", () => {
      const store = createStore();
      store.add(makeRecord("task-1"));
      const revision = store.getRevision("task-1");
      store.assignIfEligible(
        "task-1",
        revision,
        { status: "ready", runId: undefined, adapterId: undefined, agentId: undefined },
        { adapterId: "hall.mock-agent", agentId: "mock-agent", executionTrust: "simulated" },
      );
      // Stale revision — the task has already moved past `revision`.
      expect(() =>
        store.assignIfEligible(
          "task-1",
          revision,
          { status: "ready", runId: undefined, adapterId: undefined, agentId: undefined },
          { adapterId: "hall.mock-agent", agentId: "mock-agent", executionTrust: "simulated" },
        ),
      ).toThrow(TaskStateConflictError);
    });

    it("ABA protection: a round trip back to an outwardly identical four-field snapshot still invalidates a stale revision", () => {
      const store = createStore();
      store.add(makeRecord("task-1", { task: makeTask("task-1", { status: "ready" }) }));
      const revision = store.getRevision("task-1");
      // Ready -> Blocked -> Ready: four-field snapshot ends up identical to
      // the original, but revision has moved on.
      store.updateStatus("task-1", "blocked");
      store.updateStatus("task-1", "ready");
      expect(() =>
        store.assignIfEligible(
          "task-1",
          revision,
          { status: "ready", runId: undefined, adapterId: undefined, agentId: undefined },
          { adapterId: "hall.mock-agent", agentId: "mock-agent", executionTrust: "simulated" },
        ),
      ).toThrow(TaskStateConflictError);
    });

    it("assignIfEligible succeeds on first assignment and moves status to assigned", () => {
      const store = createStore();
      store.add(makeRecord("task-1"));
      const revision = store.getRevision("task-1");
      const record = store.assignIfEligible(
        "task-1",
        revision,
        { status: "ready", runId: undefined, adapterId: undefined, agentId: undefined },
        { adapterId: "hall.mock-agent", agentId: "mock-agent", executionTrust: "isolated" },
      );
      expect(record.task.status).toBe("assigned");
      expect(record.adapterId).toBe("hall.mock-agent");
      expect(record.assignedExecutionTrust).toBe("isolated");
    });

    it("requirement-safe reassignment: reassigning a not-yet-started assigned task preserves status", () => {
      const store = createStore();
      store.add(makeRecord("task-1"));
      let revision = store.getRevision("task-1");
      store.assignIfEligible(
        "task-1",
        revision,
        { status: "ready", runId: undefined, adapterId: undefined, agentId: undefined },
        { adapterId: "hall.adapter-a", agentId: "agent-a", executionTrust: "isolated" },
      );
      revision = store.getRevision("task-1");
      const record = store.assignIfEligible(
        "task-1",
        revision,
        { status: "assigned", runId: undefined, adapterId: "hall.adapter-a", agentId: "agent-a" },
        { adapterId: "hall.adapter-b", agentId: "agent-b", executionTrust: "trusted_local" },
      );
      expect(record.task.status).toBe("assigned");
      expect(record.adapterId).toBe("hall.adapter-b");
    });

    it("setRunId rejects a second concurrent claim once a runId is already set", () => {
      const store = createStore();
      store.add(makeRecord("task-1"));
      store.setRunId("task-1", "run-1");
      expect(() => {
        store.setRunId("task-1", "run-2");
      }).toThrow(TaskStateConflictError);
      expect(store.get("task-1").runId).toBe("run-1");
    });

    it("get/list throw TaskNotFoundError for an unknown task, never a raw storage error", () => {
      const store = createStore();
      expect(() => store.get("does-not-exist")).toThrow(TaskNotFoundError);
    });

    it("list() returns tasks in insertion order", () => {
      const store = createStore();
      store.add(makeRecord("task-1"));
      store.add(makeRecord("task-2"));
      store.add(makeRecord("task-3"));
      expect(store.list().map((r) => r.task.taskId)).toEqual(["task-1", "task-2", "task-3"]);
    });

    it("get()/list() never expose working directory or revision", () => {
      const store = createStore();
      store.add(makeRecord("task-1"));
      store.setWorkingDirectory("task-1", "packages/protocol");
      const record = store.get("task-1");
      expect(JSON.stringify(record)).not.toContain("packages/protocol");
      expect(Object.keys(record)).not.toContain("revision");
      const [listed] = store.list();
      expect(JSON.stringify(listed)).not.toContain("packages/protocol");
    });

    it("working directory round-trips through the internal-only accessor", () => {
      const store = createStore();
      store.add(makeRecord("task-1"));
      expect(store.getWorkingDirectory("task-1")).toBeUndefined();
      store.setWorkingDirectory("task-1", "some/relative/path");
      expect(store.getWorkingDirectory("task-1")).toBe("some/relative/path");
    });

    it("setCompleted persists a structured failure that round-trips exactly", () => {
      const store = createStore();
      store.add(makeRecord("task-1"));
      store.setCompleted("task-1", "2026-01-02T00:00:00.000Z", "run.failed", {
        code: "TEST_FAILURE",
        message: "boom",
        retryable: false,
      });
      const record = store.get("task-1");
      expect(record.failure).toEqual({ code: "TEST_FAILURE", message: "boom", retryable: false });
      expect(record.terminalEventType).toBe("run.failed");
    });

    it("task requirements persist and round-trip through their own schema", () => {
      const store = createStore();
      store.add(
        makeRecord("task-1", {
          task: makeTask("task-1", {
            requirements: {
              requiredCapabilities: ["project.read", "project.edit"],
              allowedExecutionTrust: ["isolated"],
            },
          }),
        }),
      );
      const record = store.get("task-1");
      expect(record.task.requirements).toEqual({
        requiredCapabilities: ["project.read", "project.edit"],
        allowedExecutionTrust: ["isolated"],
      });
    });

    // Phase 14 — the CEO plan delegation coordinator pre-checks this
    // before creating any child task, so it must accurately reflect the
    // store's real remaining headroom, including going to exactly 0 (not
    // negative) once capacity is reached.
    it("remainingCapacity() reflects add()s and never goes negative", () => {
      const store = createStore();
      const before = store.remainingCapacity();
      store.add(makeRecord("task-1"));
      expect(store.remainingCapacity()).toBe(before - 1);
    });
  });
}
