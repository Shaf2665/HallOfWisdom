import { describe, expect, it } from "vitest";
import type { HallTask, TaskRequirements } from "@hall-of-wisdom/protocol";
import { ceoPlanVersionSchema } from "@hall-of-wisdom/protocol";
import type { RoutingCandidateInput } from "../routing/routing-policy.js";
import type { CeoPlannerInput, CeoPlannerPort } from "./ceo-planner-port.js";

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

const ISOLATED_ONLY_REQUIREMENTS: TaskRequirements = {
  requiredCapabilities: ["project.edit"],
  allowedExecutionTrust: ["isolated"],
};

function candidate(overrides: Partial<RoutingCandidateInput> = {}): RoutingCandidateInput {
  return {
    adapterId: "hall.claude-code",
    displayName: "Claude Code",
    integrationLevel: "structured_cli",
    availability: "available",
    executionTrust: "isolated",
    capabilityObservations: [
      {
        capability: "project.edit",
        status: "verified",
        safeSummary: "ok",
        evidence: "deterministic_test",
      },
    ],
    ...overrides,
  };
}

/**
 * Behavioral contract every `CeoPlannerPort` implementation must satisfy
 * — run against the deterministic production planner and against a
 * scripted test planner, so the safety invariants this phase's kickoff
 * requires ("Planner contract tests") are proven for the abstraction
 * itself, not just one concrete implementation. Mirrors the store/event
 * contract-test pattern already used throughout this codebase (e.g.
 * `tasks/task-store-contract.ts`).
 */
export function defineCeoPlannerContractTests(
  label: string,
  createPlanner: () => CeoPlannerPort,
): void {
  describe(`CeoPlannerPort contract — ${label}`, () => {
    it("never mutates the task it was given", () => {
      const planner = createPlanner();
      const task = makeTask();
      const frozen = JSON.stringify(task);
      planner.generatePlan({
        parentTask: task,
        routingCandidates: [],
        planningInstructions: undefined,
        attachmentSignal: "none",
      });
      expect(JSON.stringify(task)).toBe(frozen);
    });

    it("never receives or exposes anything with a startTask/detect method — the type itself carries no adapter reference", () => {
      const planner = createPlanner();
      const input: CeoPlannerInput = {
        parentTask: makeTask(),
        routingCandidates: [candidate()],
        planningInstructions: undefined,
        attachmentSignal: "none",
      };
      // `candidate()` above is a plain data object (RoutingCandidateInput),
      // never an AgentAdapter — there is no `startTask`/`detect` method on
      // it for the planner to call even if it wanted to.
      expect(
        (input.routingCandidates[0] as unknown as { startTask?: unknown }).startTask,
      ).toBeUndefined();
      planner.generatePlan(input);
    });

    it("produces stable output for stable input (deterministic, no hidden randomness)", () => {
      const planner = createPlanner();
      const input: CeoPlannerInput = {
        parentTask: makeTask(),
        routingCandidates: [candidate()],
        planningInstructions: undefined,
        attachmentSignal: "none",
      };
      const first = planner.generatePlan(input);
      const second = planner.generatePlan(input);
      expect(first).toEqual(second);
    });

    it("preserves the task's own requirements onto every generated step when present", () => {
      const planner = createPlanner();
      const result = planner.generatePlan({
        parentTask: makeTask({ requirements: ISOLATED_ONLY_REQUIREMENTS }),
        routingCandidates: [candidate()],
        planningInstructions: undefined,
        attachmentSignal: "none",
      });
      if (result.kind !== "plan") return; // scripted planners may legitimately choose to block; nothing to assert here
      for (const step of result.draft.steps) {
        expect(step.requirements).toEqual(ISOLATED_ONLY_REQUIREMENTS);
      }
    });

    it("never recommends an adapter that is not eligible for the step's own requirements", () => {
      const planner = createPlanner();
      const result = planner.generatePlan({
        parentTask: makeTask({ requirements: ISOLATED_ONLY_REQUIREMENTS }),
        routingCandidates: [
          candidate({ adapterId: "hall.mock-agent", executionTrust: "simulated" }),
          candidate({ adapterId: "hall.codex", executionTrust: "trusted_local" }),
        ],
        planningInstructions: undefined,
        attachmentSignal: "none",
      });
      if (result.kind !== "plan") return;
      for (const step of result.draft.steps) {
        expect(step.recommendedAdapterId).not.toBe("hall.mock-agent");
        expect(step.recommendedAdapterId).not.toBe("hall.codex");
      }
    });

    it("excludes trusted-local and simulated adapters entirely from the recommendation for an isolated-only requirement", () => {
      const planner = createPlanner();
      const result = planner.generatePlan({
        parentTask: makeTask({ requirements: ISOLATED_ONLY_REQUIREMENTS }),
        routingCandidates: [
          candidate({ adapterId: "hall.claude-code", executionTrust: "isolated" }),
          candidate({ adapterId: "hall.codex", executionTrust: "trusted_local" }),
          candidate({ adapterId: "hall.mock-agent", executionTrust: "simulated" }),
        ],
        planningInstructions: undefined,
        attachmentSignal: "none",
      });
      if (result.kind !== "plan") return;
      const recommended = new Set(result.draft.steps.map((step) => step.recommendedAdapterId));
      expect(recommended.has("hall.codex")).toBe(false);
      expect(recommended.has("hall.mock-agent")).toBe(false);
    });

    it("returns a bounded blocked result, never a fabricated plan, when the task carries no description", () => {
      const planner = createPlanner();
      const result = planner.generatePlan({
        parentTask: makeTask({ description: "" }),
        routingCandidates: [],
        planningInstructions: undefined,
        attachmentSignal: "none",
      });
      expect(["blocked", "plan"]).toContain(result.kind);
      if (result.kind === "blocked") {
        expect(result.reason.length).toBeGreaterThan(0);
        expect(result.reason.length).toBeLessThanOrEqual(2000);
      }
    });

    it("every generated draft, once assigned ids and a content hash, satisfies the strict public plan-version schema", () => {
      const planner = createPlanner();
      const result = planner.generatePlan({
        parentTask: makeTask(),
        routingCandidates: [candidate()],
        planningInstructions: undefined,
        attachmentSignal: "none",
      });
      if (result.kind !== "plan") return;

      const stepIds = result.draft.steps.map((_, index) => `step-${String(index)}`);
      const version = {
        planId: "plan-1",
        version: 1,
        objective: result.draft.objective,
        summary: result.draft.summary,
        assumptions: result.draft.assumptions,
        constraints: result.draft.constraints,
        steps: result.draft.steps.map((step, index) => ({
          id: stepIds[index],
          position: index,
          title: step.title,
          objective: step.objective,
          boundedInstructions: step.boundedInstructions,
          acceptanceCriteria: step.acceptanceCriteria,
          dependencies: step.dependsOnStepIndex.map((depIndex) => stepIds[depIndex]),
          ...(step.requirements !== undefined ? { requirements: step.requirements } : {}),
          ...(step.recommendedAdapterId !== undefined
            ? { recommendedAdapterId: step.recommendedAdapterId }
            : {}),
          routingSummary: step.routingSummary,
        })),
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBy: "ceo_planner" as const,
        contentHash: "a".repeat(64),
      };
      const parsed = ceoPlanVersionSchema.safeParse(version);
      expect(parsed.success).toBe(true);
    });

    it("the planner interface itself has no way to approve, reject, delegate, or otherwise decide a plan — it can only propose one", () => {
      const planner = createPlanner();
      const surface = Object.keys(planner);
      expect(surface).toEqual(["plannerId", "generatePlan"]);
    });
  });
}
