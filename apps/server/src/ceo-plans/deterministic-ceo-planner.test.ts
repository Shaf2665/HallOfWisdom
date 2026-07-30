import { describe, expect, it } from "vitest";
import type { HallTask } from "@hall-of-wisdom/protocol";
import { defineCeoPlannerContractTests } from "./ceo-planner-contract.js";
import {
  createDeterministicCeoPlanner,
  DETERMINISTIC_CEO_PLANNER_ID,
} from "./deterministic-ceo-planner.js";

defineCeoPlannerContractTests("deterministic planner", createDeterministicCeoPlanner);

function makeTask(overrides: Partial<HallTask> = {}): HallTask {
  return {
    taskId: "task-1",
    projectId: "project-1",
    title: "Fix the login redirect bug",
    description: "Users are redirected to /404 instead of /dashboard after a successful login.",
    priority: "normal",
    status: "backlog",
    dependencyTaskIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("createDeterministicCeoPlanner", () => {
  it("reports a stable, recognizable planner id", () => {
    expect(createDeterministicCeoPlanner().plannerId).toBe(DETERMINISTIC_CEO_PLANNER_ID);
    expect(DETERMINISTIC_CEO_PLANNER_ID).toBe("ceo_planner.deterministic");
  });

  it("blocks with a clear, safe reason when the task has no description at all", () => {
    const result = createDeterministicCeoPlanner().generatePlan({
      parentTask: makeTask({ description: "" }),
      routingCandidates: [],
      planningInstructions: undefined,
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.reason).toContain("no description");
    }
  });

  it("blocks the same way for a whitespace-only description", () => {
    const result = createDeterministicCeoPlanner().generatePlan({
      parentTask: makeTask({ description: "   \n  " }),
      routingCandidates: [],
      planningInstructions: undefined,
    });
    expect(result.kind).toBe("blocked");
  });

  it("produces exactly three steps (investigate, implement, verify) for a task with a real description", () => {
    const result = createDeterministicCeoPlanner().generatePlan({
      parentTask: makeTask(),
      routingCandidates: [],
      planningInstructions: undefined,
    });
    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") return;
    expect(result.draft.steps).toHaveLength(3);
    expect(result.draft.steps.at(0)?.title).toContain("Investigate");
    expect(result.draft.steps.at(1)?.title).toContain("Implement");
    expect(result.draft.steps.at(2)?.title).toContain("Verify");
  });

  it("chains the three steps as a strict linear dependency (implement depends on investigate, verify depends on implement)", () => {
    const result = createDeterministicCeoPlanner().generatePlan({
      parentTask: makeTask(),
      routingCandidates: [],
      planningInstructions: undefined,
    });
    if (result.kind !== "plan") return;
    expect(result.draft.steps.at(0)?.dependsOnStepIndex).toEqual([]);
    expect(result.draft.steps.at(1)?.dependsOnStepIndex).toEqual([0]);
    expect(result.draft.steps.at(2)?.dependsOnStepIndex).toEqual([1]);
  });

  it("copies the task's own description into step instructions verbatim rather than fabricating new content", () => {
    const description = "A very specific, real bug: the redirect goes to /404 not /dashboard.";
    const result = createDeterministicCeoPlanner().generatePlan({
      parentTask: makeTask({ description }),
      routingCandidates: [],
      planningInstructions: undefined,
    });
    if (result.kind !== "plan") return;
    expect(result.draft.steps.at(0)?.boundedInstructions).toContain(description);
    expect(result.draft.steps.at(1)?.boundedInstructions).toContain(description);
  });

  it("truncates an oversized description rather than exceeding the bounded instructions length", () => {
    const description = "x".repeat(5000);
    const result = createDeterministicCeoPlanner().generatePlan({
      parentTask: makeTask({ description }),
      routingCandidates: [],
      planningInstructions: undefined,
    });
    if (result.kind !== "plan") return;
    for (const step of result.draft.steps.slice(0, 2)) {
      expect(step.boundedInstructions.length).toBeLessThanOrEqual(2000);
    }
  });

  it("echoes bounded operator planning instructions into the plan's constraints verbatim, never interpreting them as commands", () => {
    const result = createDeterministicCeoPlanner().generatePlan({
      parentTask: makeTask(),
      routingCandidates: [],
      planningInstructions: "Keep the fix minimal; do not refactor unrelated code.",
    });
    if (result.kind !== "plan") return;
    expect(result.draft.constraints.join(" ")).toContain(
      "Keep the fix minimal; do not refactor unrelated code.",
    );
  });

  it("never sets a step's requirements when the parent task has none, and never invents a recommendation", () => {
    const result = createDeterministicCeoPlanner().generatePlan({
      parentTask: makeTask(),
      routingCandidates: [],
      planningInstructions: undefined,
    });
    if (result.kind !== "plan") return;
    for (const step of result.draft.steps) {
      expect(step.requirements).toBeUndefined();
      expect(step.recommendedAdapterId).toBeUndefined();
    }
  });
});
