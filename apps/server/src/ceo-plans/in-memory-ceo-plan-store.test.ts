import { describe, expect, it } from "vitest";
import type { CeoPlanVersionContent, CreatePlanInput } from "./ceo-plan-store-port.js";
import { defineCeoPlanStoreContractTests } from "./ceo-plan-store-contract.js";
import { InMemoryCeoPlanStore } from "./in-memory-ceo-plan-store.js";

defineCeoPlanStoreContractTests("in-memory CeoPlanStore", () => new InMemoryCeoPlanStore());

function content(overrides: Partial<CeoPlanVersionContent> = {}): CeoPlanVersionContent {
  return {
    objective: "Fix the bug",
    summary: "One step",
    assumptions: [],
    constraints: [],
    steps: [
      {
        id: "step-1",
        position: 0,
        title: "Investigate",
        objective: "Find the root cause",
        boundedInstructions: "Read the logs",
        acceptanceCriteria: ["Root cause documented"],
        dependencies: [],
        routingSummary: "n/a",
      },
    ],
    ...overrides,
  };
}

function createInput(overrides: Partial<CreatePlanInput> = {}): CreatePlanInput {
  return {
    planId: "plan-1",
    parentTaskId: "task-1",
    createdBy: "ceo_planner",
    createdAt: "2026-01-01T00:00:00.000Z",
    content: content(),
    contentHash: "a".repeat(64),
    ...overrides,
  };
}

describe("InMemoryCeoPlanStore — snapshot/restore (Phase 14.1 — ephemeral atomic delegation)", () => {
  it("restore() undoes a plan created after the snapshot", () => {
    const store = new InMemoryCeoPlanStore();
    const snap = store.snapshot();
    store.createPlan(createInput());
    store.restore(snap);
    expect(() => store.getPlan("plan-1")).toThrow();
  });

  it("restore() reverts an in-place array push (createVersion/appendEvent) on a pre-existing plan — the regression case a shallow Map clone would miss", () => {
    const store = new InMemoryCeoPlanStore();
    store.createPlan(createInput());
    store.appendEvent("plan-1", "ceo.plan.created", {}, "2026-01-01T00:00:00.000Z");
    const snap = store.snapshot();

    store.createVersion({
      planId: "plan-1",
      expectedRevision: store.getRevision("plan-1"),
      createdBy: "operator",
      createdAt: "2026-01-01T00:05:00.000Z",
      content: content({ summary: "v2" }),
      contentHash: "b".repeat(64),
    });
    store.appendEvent("plan-1", "ceo.plan.version_created", {}, "2026-01-01T00:05:00.000Z");

    store.restore(snap);

    expect(store.listVersions("plan-1")).toHaveLength(1);
    expect(store.listEvents("plan-1")).toHaveLength(1);
    expect(store.getPlan("plan-1").activeVersion).toBe(1);
    expect(store.getRevision("plan-1")).toBe(0);
  });
});
