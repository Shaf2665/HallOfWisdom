import { describe, expect, it } from "vitest";
import type { CeoPlanEvent } from "@hall-of-wisdom/protocol";
import { TaskStore } from "../tasks/task-store.js";
import { InMemoryCeoPlanStore } from "./in-memory-ceo-plan-store.js";
import { CeoPlanEventBus } from "./ceo-plan-events.js";
import { synchronizePlanProgress } from "./ceo-plan-progress-sync.js";

function buildDeps() {
  const taskStore = new TaskStore({ maxTasks: 100 });
  const planStore = new InMemoryCeoPlanStore();
  const planEventBus = new CeoPlanEventBus({ maxSubscribersPerPlan: 20 });
  const runAtomicUnit = <T>(fn: () => T): T => fn();
  return { taskStore, planStore, planEventBus, runAtomicUnit };
}

function addChildTask(
  taskStore: TaskStore,
  taskId: string,
  status: "assigned" | "running" | "completed" | "failed",
) {
  taskStore.add({
    task: {
      taskId,
      projectId: "project-1",
      title: "Child step",
      description: "A step.",
      priority: "normal",
      status: "assigned",
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
  if (status !== "assigned") {
    if (status === "running") {
      taskStore.updateStatus(taskId, "running");
    } else {
      taskStore.updateStatus(taskId, "running");
      taskStore.updateStatus(taskId, status);
    }
  }
}

function delegateOneStepPlan(deps: ReturnType<typeof buildDeps>, childTaskId: string) {
  const { planStore } = deps;
  const { plan } = planStore.createPlan({
    planId: "plan-1",
    parentTaskId: "parent-1",
    createdBy: "ceo_planner",
    createdAt: "2026-01-01T00:00:00.000Z",
    content: {
      objective: "obj",
      summary: "sum",
      assumptions: [],
      constraints: [],
      steps: [
        {
          id: "step-1",
          position: 0,
          title: "Step 1",
          objective: "Do it",
          boundedInstructions: "Do it well",
          acceptanceCriteria: ["Done"],
          dependencies: [],
          routingSummary: "n/a",
        },
      ],
    },
    contentHash: "a".repeat(64),
  });
  planStore.submit({ planId: plan.id, expectedRevision: planStore.getRevision(plan.id) });
  planStore.decideApproval({
    planId: plan.id,
    expectedRevision: planStore.getRevision(plan.id),
    planVersion: 1,
    contentHash: "a".repeat(64),
    decision: "approve",
    operatorNote: undefined,
    decidedAt: "2026-01-01T00:01:00.000Z",
  });
  planStore.recordDelegation({
    planId: plan.id,
    expectedRevision: planStore.getRevision(plan.id),
    approvedVersion: 1,
    approvedContentHash: "a".repeat(64),
    links: [{ stepId: "step-1", childTaskId, adapterId: "hall.mock-agent" }],
    delegatedAt: "2026-01-01T00:02:00.000Z",
  });
  return plan.id;
}

describe("synchronizePlanProgress", () => {
  it("is a no-op for a plan not currently delegated", () => {
    const deps = buildDeps();
    const { plan } = deps.planStore.createPlan({
      planId: "plan-1",
      parentTaskId: "parent-1",
      createdBy: "ceo_planner",
      createdAt: "2026-01-01T00:00:00.000Z",
      content: { objective: "obj", summary: "sum", assumptions: [], constraints: [], steps: [] },
      contentHash: "a".repeat(64),
    });
    const result = synchronizePlanProgress(plan.id, deps);
    expect(result.changed).toBe(false);
    expect(deps.planStore.listEvents(plan.id)).toHaveLength(0);
  });

  it("is idempotent: a second call with no real change appends no second event", () => {
    const deps = buildDeps();
    addChildTask(deps.taskStore, "child-1", "running");
    const planId = delegateOneStepPlan(deps, "child-1");

    const first = synchronizePlanProgress(planId, deps);
    expect(first.changed).toBe(true);
    expect(first.event?.type).toBe("ceo.plan.progress_changed");

    const second = synchronizePlanProgress(planId, deps);
    expect(second.changed).toBe(false);
    expect(second.event).toBeUndefined();
    expect(deps.planStore.listEvents(planId)).toHaveLength(1);
  });

  it("transitions the plan to completed and appends exactly one terminal event once every child completes", () => {
    const deps = buildDeps();
    addChildTask(deps.taskStore, "child-1", "completed");
    const planId = delegateOneStepPlan(deps, "child-1");

    const result = synchronizePlanProgress(planId, deps);
    expect(result.changed).toBe(true);
    expect(result.event?.type).toBe("ceo.plan.completed");
    expect(deps.planStore.getPlan(planId).status).toBe("completed");

    const again = synchronizePlanProgress(planId, deps);
    expect(again.changed).toBe(false);
  });

  it("transitions the plan to failed as soon as a child task fails", () => {
    const deps = buildDeps();
    addChildTask(deps.taskStore, "child-1", "failed");
    const planId = delegateOneStepPlan(deps, "child-1");

    const result = synchronizePlanProgress(planId, deps);
    expect(result.event?.type).toBe("ceo.plan.failed");
    expect(deps.planStore.getPlan(planId).status).toBe("failed");
  });

  it("publishes the event to a subscriber", () => {
    const deps = buildDeps();
    addChildTask(deps.taskStore, "child-1", "running");
    const planId = delegateOneStepPlan(deps, "child-1");

    const received: CeoPlanEvent[] = [];
    deps.planEventBus.subscribe(planId, (event) => received.push(event));

    synchronizePlanProgress(planId, deps);
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("ceo.plan.progress_changed");
  });

  it("never rewrites the underlying child task's own state", () => {
    const deps = buildDeps();
    addChildTask(deps.taskStore, "child-1", "running");
    const planId = delegateOneStepPlan(deps, "child-1");

    synchronizePlanProgress(planId, deps);
    expect(deps.taskStore.get("child-1").task.status).toBe("running");
  });
});
