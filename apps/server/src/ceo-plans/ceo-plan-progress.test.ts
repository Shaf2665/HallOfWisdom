import { describe, expect, it } from "vitest";
import type { CeoPlanVersion } from "@hall-of-wisdom/protocol";
import { TaskStore } from "../tasks/task-store.js";
import type { TaskRecord } from "../tasks/task-record.js";
import { deriveCeoPlanProgress, derivePlanTerminalOutcome } from "./ceo-plan-progress.js";
import type { DelegationLink } from "./ceo-plan-store-port.js";

function makeVersion(steps: CeoPlanVersion["steps"]): CeoPlanVersion {
  return {
    planId: "plan-1",
    version: 1,
    objective: "obj",
    summary: "sum",
    assumptions: [],
    constraints: [],
    steps,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "ceo_planner",
    contentHash: "a".repeat(64),
  };
}

function step(id: string, dependencies: string[] = []): CeoPlanVersion["steps"][number] {
  return {
    id,
    position: 0,
    title: "t",
    objective: "o",
    boundedInstructions: "i",
    acceptanceCriteria: ["c"],
    dependencies,
    routingSummary: "n/a",
  };
}

function addChildTask(
  taskStore: TaskStore,
  taskId: string,
  status: TaskRecord["task"]["status"],
): void {
  taskStore.add({
    task: {
      taskId,
      projectId: "p1",
      title: "child",
      description: "d",
      priority: "normal",
      status,
      dependencyTaskIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    runId: undefined,
    adapterId: "hall.mock-agent",
    agentId: "mock-agent",
    eventCount: 0,
    lastSequence: undefined,
    terminalEventType: undefined,
    failure: undefined,
    cancellationRequested: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: undefined,
    completedAt: undefined,
    assignedExecutionTrust: "simulated",
  });
}

describe("deriveCeoPlanProgress", () => {
  it("all children unstarted (assigned) with no dependencies are ready_to_start", () => {
    const taskStore = new TaskStore({ maxTasks: 100 });
    addChildTask(taskStore, "t1", "assigned");
    addChildTask(taskStore, "t2", "assigned");
    const version = makeVersion([step("s1"), step("s2")]);
    const links: DelegationLink[] = [
      {
        planId: "plan-1",
        planVersion: 1,
        stepId: "s1",
        childTaskId: "t1",
        adapterId: "hall.mock-agent",
        delegatedAt: "x",
      },
      {
        planId: "plan-1",
        planVersion: 1,
        stepId: "s2",
        childTaskId: "t2",
        adapterId: "hall.mock-agent",
        delegatedAt: "x",
      },
    ];
    const progress = deriveCeoPlanProgress(version, links, taskStore);
    expect(progress.notStarted).toBe(2);
    expect(progress.steps.every((s) => s.status === "ready_to_start")).toBe(true);
  });

  it("one running, one completed, one failed are reported correctly", () => {
    const taskStore = new TaskStore({ maxTasks: 100 });
    addChildTask(taskStore, "t1", "running");
    addChildTask(taskStore, "t2", "completed");
    addChildTask(taskStore, "t3", "failed");
    const version = makeVersion([step("s1"), step("s2"), step("s3")]);
    const links: DelegationLink[] = [
      {
        planId: "plan-1",
        planVersion: 1,
        stepId: "s1",
        childTaskId: "t1",
        adapterId: "a",
        delegatedAt: "x",
      },
      {
        planId: "plan-1",
        planVersion: 1,
        stepId: "s2",
        childTaskId: "t2",
        adapterId: "a",
        delegatedAt: "x",
      },
      {
        planId: "plan-1",
        planVersion: 1,
        stepId: "s3",
        childTaskId: "t3",
        adapterId: "a",
        delegatedAt: "x",
      },
    ];
    const progress = deriveCeoPlanProgress(version, links, taskStore);
    expect(progress.running).toBe(1);
    expect(progress.completed).toBe(1);
    expect(progress.failed).toBe(1);
  });

  it("a dependent step waits for its dependency, then becomes ready once the dependency completes", () => {
    const taskStore = new TaskStore({ maxTasks: 100 });
    addChildTask(taskStore, "t1", "running");
    addChildTask(taskStore, "t2", "assigned");
    const version = makeVersion([step("s1"), step("s2", ["s1"])]);
    const links: DelegationLink[] = [
      {
        planId: "plan-1",
        planVersion: 1,
        stepId: "s1",
        childTaskId: "t1",
        adapterId: "a",
        delegatedAt: "x",
      },
      {
        planId: "plan-1",
        planVersion: 1,
        stepId: "s2",
        childTaskId: "t2",
        adapterId: "a",
        delegatedAt: "x",
      },
    ];
    const waiting = deriveCeoPlanProgress(version, links, taskStore);
    expect(waiting.steps.find((s) => s.stepId === "s2")?.status).toBe("waiting_for_dependencies");

    const taskStore2 = new TaskStore({ maxTasks: 100 });
    addChildTask(taskStore2, "t1", "completed");
    addChildTask(taskStore2, "t2", "assigned");
    const ready = deriveCeoPlanProgress(version, links, taskStore2);
    expect(ready.steps.find((s) => s.stepId === "s2")?.status).toBe("ready_to_start");
  });

  it("a dependent step is blocked when its dependency failed", () => {
    const taskStore = new TaskStore({ maxTasks: 100 });
    addChildTask(taskStore, "t1", "failed");
    addChildTask(taskStore, "t2", "assigned");
    const version = makeVersion([step("s1"), step("s2", ["s1"])]);
    const links: DelegationLink[] = [
      {
        planId: "plan-1",
        planVersion: 1,
        stepId: "s1",
        childTaskId: "t1",
        adapterId: "a",
        delegatedAt: "x",
      },
      {
        planId: "plan-1",
        planVersion: 1,
        stepId: "s2",
        childTaskId: "t2",
        adapterId: "a",
        delegatedAt: "x",
      },
    ];
    const progress = deriveCeoPlanProgress(version, links, taskStore);
    expect(progress.steps.find((s) => s.stepId === "s2")?.status).toBe("blocked");
  });

  it("all completed yields a completed terminal outcome", () => {
    const taskStore = new TaskStore({ maxTasks: 100 });
    addChildTask(taskStore, "t1", "completed");
    addChildTask(taskStore, "t2", "completed");
    const version = makeVersion([step("s1"), step("s2")]);
    const links: DelegationLink[] = [
      {
        planId: "plan-1",
        planVersion: 1,
        stepId: "s1",
        childTaskId: "t1",
        adapterId: "a",
        delegatedAt: "x",
      },
      {
        planId: "plan-1",
        planVersion: 1,
        stepId: "s2",
        childTaskId: "t2",
        adapterId: "a",
        delegatedAt: "x",
      },
    ];
    const progress = deriveCeoPlanProgress(version, links, taskStore);
    expect(derivePlanTerminalOutcome(progress)).toBe("completed");
  });

  it("any failure yields a failed terminal outcome even while a sibling is still running", () => {
    const taskStore = new TaskStore({ maxTasks: 100 });
    addChildTask(taskStore, "t1", "failed");
    addChildTask(taskStore, "t2", "running");
    const version = makeVersion([step("s1"), step("s2")]);
    const links: DelegationLink[] = [
      {
        planId: "plan-1",
        planVersion: 1,
        stepId: "s1",
        childTaskId: "t1",
        adapterId: "a",
        delegatedAt: "x",
      },
      {
        planId: "plan-1",
        planVersion: 1,
        stepId: "s2",
        childTaskId: "t2",
        adapterId: "a",
        delegatedAt: "x",
      },
    ];
    const progress = deriveCeoPlanProgress(version, links, taskStore);
    expect(derivePlanTerminalOutcome(progress)).toBe("failed");
  });

  it("no terminal outcome while work remains in progress with no failures", () => {
    const taskStore = new TaskStore({ maxTasks: 100 });
    addChildTask(taskStore, "t1", "completed");
    addChildTask(taskStore, "t2", "running");
    const version = makeVersion([step("s1"), step("s2")]);
    const links: DelegationLink[] = [
      {
        planId: "plan-1",
        planVersion: 1,
        stepId: "s1",
        childTaskId: "t1",
        adapterId: "a",
        delegatedAt: "x",
      },
      {
        planId: "plan-1",
        planVersion: 1,
        stepId: "s2",
        childTaskId: "t2",
        adapterId: "a",
        delegatedAt: "x",
      },
    ];
    const progress = deriveCeoPlanProgress(version, links, taskStore);
    expect(derivePlanTerminalOutcome(progress)).toBeUndefined();
  });

  it("never mutates the underlying task records while deriving progress", () => {
    const taskStore = new TaskStore({ maxTasks: 100 });
    addChildTask(taskStore, "t1", "running");
    const before = JSON.stringify(taskStore.get("t1"));
    const version = makeVersion([step("s1")]);
    const links: DelegationLink[] = [
      {
        planId: "plan-1",
        planVersion: 1,
        stepId: "s1",
        childTaskId: "t1",
        adapterId: "a",
        delegatedAt: "x",
      },
    ];
    deriveCeoPlanProgress(version, links, taskStore);
    expect(JSON.stringify(taskStore.get("t1"))).toBe(before);
  });

  it("an unrelated task never affects the plan's derived progress", () => {
    const taskStore = new TaskStore({ maxTasks: 100 });
    addChildTask(taskStore, "t1", "completed");
    addChildTask(taskStore, "unrelated-task", "failed");
    const version = makeVersion([step("s1")]);
    const links: DelegationLink[] = [
      {
        planId: "plan-1",
        planVersion: 1,
        stepId: "s1",
        childTaskId: "t1",
        adapterId: "a",
        delegatedAt: "x",
      },
    ];
    const progress = deriveCeoPlanProgress(version, links, taskStore);
    expect(progress.completed).toBe(1);
    expect(progress.failed).toBe(0);
  });
});
