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

    // Phase 15.2 — TOCTOU-safe launch reservation. See
    // `TaskStore.startIfEligible()`'s doc comment for the full contract:
    // revision is the primary concurrency token, the four-field snapshot is
    // secondary defense-in-depth, and the live status/runId are always
    // independently re-derived rather than trusted from the caller.
    describe("startIfEligible", () => {
      function assignedRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
        return makeRecord("task-1", {
          task: makeTask("task-1", { status: "assigned" }),
          adapterId: "hall.adapter-a",
          agentId: "agent-a",
          runId: undefined,
          ...overrides,
        });
      }

      it("succeeds from the exact expected revision and snapshot", () => {
        const store = createStore();
        store.add(assignedRecord());
        const revision = store.getRevision("task-1");
        const record = store.startIfEligible(
          "task-1",
          revision,
          { status: "assigned", runId: undefined, adapterId: "hall.adapter-a", agentId: "agent-a" },
          "run-1",
        );
        expect(record.runId).toBe("run-1");
        expect(record.task.status).toBe("assigned");
      });

      it("rejects a stale expectedRevision", () => {
        const store = createStore();
        store.add(assignedRecord());
        const revision = store.getRevision("task-1");
        // Bump the revision via an unrelated mutation without touching any
        // of the four launch-eligibility fields.
        store.setCancellationRequested("task-1");
        expect(() =>
          store.startIfEligible(
            "task-1",
            revision,
            {
              status: "assigned",
              runId: undefined,
              adapterId: "hall.adapter-a",
              agentId: "agent-a",
            },
            "run-1",
          ),
        ).toThrow(TaskStateConflictError);
      });

      it("rejects a changed status", () => {
        const store = createStore();
        store.add(assignedRecord());
        const revision = store.getRevision("task-1");
        expect(() =>
          store.startIfEligible(
            "task-1",
            revision,
            { status: "ready", runId: undefined, adapterId: "hall.adapter-a", agentId: "agent-a" },
            "run-1",
          ),
        ).toThrow(TaskStateConflictError);
      });

      it("rejects a changed runId", () => {
        const store = createStore();
        store.add(assignedRecord());
        const revision = store.getRevision("task-1");
        expect(() =>
          store.startIfEligible(
            "task-1",
            revision,
            {
              status: "assigned",
              runId: "some-other-run",
              adapterId: "hall.adapter-a",
              agentId: "agent-a",
            },
            "run-1",
          ),
        ).toThrow(TaskStateConflictError);
      });

      it("rejects a changed adapterId", () => {
        const store = createStore();
        store.add(assignedRecord());
        const revision = store.getRevision("task-1");
        expect(() =>
          store.startIfEligible(
            "task-1",
            revision,
            {
              status: "assigned",
              runId: undefined,
              adapterId: "hall.adapter-b",
              agentId: "agent-a",
            },
            "run-1",
          ),
        ).toThrow(TaskStateConflictError);
      });

      it("rejects a changed agentId", () => {
        const store = createStore();
        store.add(assignedRecord());
        const revision = store.getRevision("task-1");
        expect(() =>
          store.startIfEligible(
            "task-1",
            revision,
            {
              status: "assigned",
              runId: undefined,
              adapterId: "hall.adapter-a",
              agentId: "agent-b",
            },
            "run-1",
          ),
        ).toThrow(TaskStateConflictError);
      });

      it("rejects when the task already has an active run — independently re-derived from the live record, even if the expected snapshot still matches", () => {
        const store = createStore();
        store.add(assignedRecord({ runId: "run-existing" }));
        const revision = store.getRevision("task-1");
        expect(() =>
          store.startIfEligible(
            "task-1",
            revision,
            {
              status: "assigned",
              runId: "run-existing",
              adapterId: "hall.adapter-a",
              agentId: "agent-a",
            },
            "run-2",
          ),
        ).toThrow(TaskStateConflictError);
      });

      it("rejects a non-assigned task", () => {
        const store = createStore();
        store.add(makeRecord("task-1", { task: makeTask("task-1", { status: "ready" }) }));
        const revision = store.getRevision("task-1");
        expect(() =>
          store.startIfEligible(
            "task-1",
            revision,
            { status: "ready", runId: undefined, adapterId: undefined, agentId: undefined },
            "run-1",
          ),
        ).toThrow(TaskStateConflictError);
      });

      it("increments the revision exactly once on success", () => {
        const store = createStore();
        store.add(assignedRecord());
        const revision = store.getRevision("task-1");
        store.startIfEligible(
          "task-1",
          revision,
          { status: "assigned", runId: undefined, adapterId: "hall.adapter-a", agentId: "agent-a" },
          "run-1",
        );
        expect(store.getRevision("task-1")).toBe(revision + 1);
      });

      it("a rejected/rolled-back call increments the revision by zero", () => {
        const store = createStore();
        store.add(assignedRecord());
        const revision = store.getRevision("task-1");
        expect(() =>
          store.startIfEligible(
            "task-1",
            revision,
            { status: "ready", runId: undefined, adapterId: "hall.adapter-a", agentId: "agent-a" },
            "run-1",
          ),
        ).toThrow();
        expect(store.getRevision("task-1")).toBe(revision);
      });

      it("of two competing calls with the same expected snapshot, exactly one succeeds", () => {
        const store = createStore();
        store.add(assignedRecord());
        const revision = store.getRevision("task-1");
        const expected = {
          status: "assigned" as const,
          runId: undefined,
          adapterId: "hall.adapter-a",
          agentId: "agent-a",
        };
        const first = store.startIfEligible("task-1", revision, expected, "run-1");
        expect(first.runId).toBe("run-1");
        // Second call still carries the SAME now-stale snapshot the first
        // call captured — the winner's own commit already moved the
        // revision on, so this must be rejected, never last-write-wins.
        expect(() => store.startIfEligible("task-1", revision, expected, "run-2")).toThrow(
          TaskStateConflictError,
        );
      });

      it("never exposes the private revision counter on the record it returns", () => {
        const store = createStore();
        store.add(assignedRecord());
        const revision = store.getRevision("task-1");
        const record = store.startIfEligible(
          "task-1",
          revision,
          { status: "assigned", runId: undefined, adapterId: "hall.adapter-a", agentId: "agent-a" },
          "run-1",
        );
        expect(Object.keys(record)).not.toContain("revision");
      });
    });

    // Phase 15.2 — governed-retry reset. See
    // `TaskStore.prepareRetryIfEligible()`'s doc comment: clears exactly the
    // CURRENT-run terminal projection so a fresh `startTask()` can claim a
    // new run, while `adapterId`/`agentId`/`assignedExecutionTrust` (this is
    // a retry of the SAME assignment, not a new one) and the cumulative
    // event-stream position (`eventCount`/`lastSequence`) are preserved.
    describe("prepareRetryIfEligible", () => {
      function failedRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
        return makeRecord("task-1", {
          task: makeTask("task-1", { status: "failed" }),
          adapterId: "hall.adapter-a",
          agentId: "agent-a",
          runId: "run-failed",
          eventCount: 3,
          lastSequence: 2,
          terminalEventType: "run.failed",
          failure: { code: "TEST_FAILURE", message: "boom", retryable: true },
          startedAt: "2026-01-01T00:00:01.000Z",
          completedAt: "2026-01-01T00:00:02.000Z",
          assignedExecutionTrust: "isolated",
          ...overrides,
        });
      }

      const expectedForFailedRecord = {
        status: "failed",
        runId: "run-failed",
        adapterId: "hall.adapter-a",
        agentId: "agent-a",
      } as const;

      it("accepts only a genuinely failed, retryable task", () => {
        const store = createStore();
        store.add(failedRecord());
        const revision = store.getRevision("task-1");
        const record = store.prepareRetryIfEligible("task-1", revision, expectedForFailedRecord);
        expect(record.task.status).toBe("assigned");
      });

      it("rejects a completed task", () => {
        const store = createStore();
        store.add(makeRecord("task-1", { task: makeTask("task-1", { status: "completed" }) }));
        const revision = store.getRevision("task-1");
        expect(() =>
          store.prepareRetryIfEligible("task-1", revision, {
            status: "completed",
            runId: undefined,
            adapterId: undefined,
            agentId: undefined,
          }),
        ).toThrow(TaskStateConflictError);
      });

      it("rejects a cancelled task", () => {
        const store = createStore();
        store.add(makeRecord("task-1", { task: makeTask("task-1", { status: "cancelled" }) }));
        const revision = store.getRevision("task-1");
        expect(() =>
          store.prepareRetryIfEligible("task-1", revision, {
            status: "cancelled",
            runId: undefined,
            adapterId: undefined,
            agentId: undefined,
          }),
        ).toThrow(TaskStateConflictError);
      });

      it("rejects a running task", () => {
        const store = createStore();
        store.add(makeRecord("task-1", { task: makeTask("task-1", { status: "running" }) }));
        const revision = store.getRevision("task-1");
        expect(() =>
          store.prepareRetryIfEligible("task-1", revision, {
            status: "running",
            runId: undefined,
            adapterId: undefined,
            agentId: undefined,
          }),
        ).toThrow(TaskStateConflictError);
      });

      it("rejects a merely-assigned (not yet run) task", () => {
        const store = createStore();
        store.add(makeRecord("task-1", { task: makeTask("task-1", { status: "assigned" }) }));
        const revision = store.getRevision("task-1");
        expect(() =>
          store.prepareRetryIfEligible("task-1", revision, {
            status: "assigned",
            runId: undefined,
            adapterId: undefined,
            agentId: undefined,
          }),
        ).toThrow(TaskStateConflictError);
      });

      it("rejects a stale expectedRevision", () => {
        const store = createStore();
        store.add(failedRecord());
        const revision = store.getRevision("task-1");
        store.setCancellationRequested("task-1");
        expect(() =>
          store.prepareRetryIfEligible("task-1", revision, expectedForFailedRecord),
        ).toThrow(TaskStateConflictError);
      });

      it("rejects when adapterId drifted from the expected snapshot", () => {
        const store = createStore();
        store.add(failedRecord());
        const revision = store.getRevision("task-1");
        expect(() =>
          store.prepareRetryIfEligible("task-1", revision, {
            ...expectedForFailedRecord,
            adapterId: "hall.adapter-other",
          }),
        ).toThrow(TaskStateConflictError);
      });

      it("rejects when agentId drifted from the expected snapshot", () => {
        const store = createStore();
        store.add(failedRecord());
        const revision = store.getRevision("task-1");
        expect(() =>
          store.prepareRetryIfEligible("task-1", revision, {
            ...expectedForFailedRecord,
            agentId: "agent-other",
          }),
        ).toThrow(TaskStateConflictError);
      });

      // NOTE: unlike `startIfEligible`/`assignIfEligible`, this method's own
      // `isRetryable` check is solely `status === "failed"` — it does not
      // independently re-derive a "no active run" invariant the way the
      // other two do (a `"failed"` task's own `runId` normally holds the ID
      // of the run that just failed, which is expected, not an anomaly).
      // What actually catches a live runId that no longer matches what the
      // caller last observed is the shared four-field snapshot compare —
      // exercised here the same way an adapterId/agentId drift is above.
      it("rejects when the live runId no longer matches the expected snapshot (e.g. another caller's write landed first)", () => {
        const store = createStore();
        store.add(failedRecord());
        const revision = store.getRevision("task-1");
        expect(() =>
          store.prepareRetryIfEligible("task-1", revision, {
            ...expectedForFailedRecord,
            runId: "some-other-run",
          }),
        ).toThrow(TaskStateConflictError);
      });

      it("preserves the cumulative event-stream position (eventCount/lastSequence) across a retry reset", () => {
        const store = createStore();
        store.add(failedRecord());
        const revision = store.getRevision("task-1");
        const record = store.prepareRetryIfEligible("task-1", revision, expectedForFailedRecord);
        expect(record.eventCount).toBe(3);
        expect(record.lastSequence).toBe(2);
      });

      it("preserves adapterId/agentId/assignedExecutionTrust — this is a retry of the same assignment, not a new one", () => {
        const store = createStore();
        store.add(failedRecord());
        const revision = store.getRevision("task-1");
        const record = store.prepareRetryIfEligible("task-1", revision, expectedForFailedRecord);
        expect(record.adapterId).toBe("hall.adapter-a");
        expect(record.agentId).toBe("agent-a");
        expect(record.assignedExecutionTrust).toBe("isolated");
      });

      it("clears exactly the current-run terminal projection: runId, terminalEventType, failure, completedAt, startedAt — and moves status to assigned", () => {
        const store = createStore();
        store.add(failedRecord());
        const revision = store.getRevision("task-1");
        const record = store.prepareRetryIfEligible("task-1", revision, expectedForFailedRecord);
        expect(record.runId).toBeUndefined();
        expect(record.terminalEventType).toBeUndefined();
        expect(record.failure).toBeUndefined();
        expect(record.completedAt).toBeUndefined();
        expect(record.startedAt).toBeUndefined();
        expect(record.task.status).toBe("assigned");
      });

      it("increments the revision exactly once on success", () => {
        const store = createStore();
        store.add(failedRecord());
        const revision = store.getRevision("task-1");
        store.prepareRetryIfEligible("task-1", revision, expectedForFailedRecord);
        expect(store.getRevision("task-1")).toBe(revision + 1);
      });

      it("of two competing calls with the same stale snapshot, exactly one succeeds", () => {
        const store = createStore();
        store.add(failedRecord());
        const revision = store.getRevision("task-1");
        const first = store.prepareRetryIfEligible("task-1", revision, expectedForFailedRecord);
        expect(first.task.status).toBe("assigned");
        expect(() =>
          store.prepareRetryIfEligible("task-1", revision, expectedForFailedRecord),
        ).toThrow(TaskStateConflictError);
      });

      it("a repeated/duplicate request after the first already succeeded is rejected safely, not a crash", () => {
        const store = createStore();
        store.add(failedRecord());
        const revision = store.getRevision("task-1");
        store.prepareRetryIfEligible("task-1", revision, expectedForFailedRecord);
        expect(() =>
          store.prepareRetryIfEligible("task-1", revision, expectedForFailedRecord),
        ).toThrow(TaskStateConflictError);
      });

      it("a rejected call leaves no partial state change: revision, status, runId, adapterId, agentId all unchanged", () => {
        const store = createStore();
        store.add(failedRecord());
        // Capture a now-stale revision, then bump it via an unrelated
        // mutation — every field below is populated (not left at a default
        // `undefined`), so this actually pins that no write escaped the
        // rejected commit's guard, not just that two `undefined`s match.
        const staleRevision = store.getRevision("task-1");
        store.setCancellationRequested("task-1");
        const revisionBefore = store.getRevision("task-1");
        const before = store.get("task-1");
        expect(() =>
          store.prepareRetryIfEligible("task-1", staleRevision, expectedForFailedRecord),
        ).toThrow(TaskStateConflictError);
        expect(store.getRevision("task-1")).toBe(revisionBefore);
        const after = store.get("task-1");
        expect(after.task.status).toBe("failed");
        expect(after.runId).toBe("run-failed");
        expect(after.adapterId).toBe("hall.adapter-a");
        expect(after.agentId).toBe("agent-a");
        expect(after.terminalEventType).toBe(before.terminalEventType);
        expect(after.failure).toEqual(before.failure);
        expect(after.completedAt).toBe(before.completedAt);
        expect(after.startedAt).toBe(before.startedAt);
      });

      it("never exposes the private revision counter on the record it returns", () => {
        const store = createStore();
        store.add(failedRecord());
        const revision = store.getRevision("task-1");
        const record = store.prepareRetryIfEligible("task-1", revision, expectedForFailedRecord);
        expect(Object.keys(record)).not.toContain("revision");
      });
    });
  });
}
