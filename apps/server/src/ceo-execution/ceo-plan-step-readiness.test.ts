import { describe, expect, it } from "vitest";
import {
  buildDependencyIndex,
  directDependenciesOf,
  directDependentsOf,
  evaluateDependencyReadiness,
} from "./ceo-plan-step-readiness.js";

describe("buildDependencyIndex", () => {
  it("builds dependents as the reverse of dependencies", () => {
    const index = buildDependencyIndex([
      { id: "a", dependencies: [] },
      { id: "b", dependencies: [] },
      { id: "c", dependencies: ["a", "b"] },
      { id: "d", dependencies: ["c"] },
    ]);
    expect(directDependentsOf(index, "a")).toEqual(["c"]);
    expect(directDependentsOf(index, "b")).toEqual(["c"]);
    expect(directDependentsOf(index, "c")).toEqual(["d"]);
    expect(directDependentsOf(index, "d")).toEqual([]);
    expect(directDependenciesOf(index, "c")).toEqual(["a", "b"]);
  });

  it("returns an empty array for a step with no dependents, never undefined", () => {
    const index = buildDependencyIndex([{ id: "solo", dependencies: [] }]);
    expect(directDependentsOf(index, "solo")).toEqual([]);
    expect(directDependentsOf(index, "unknown-step")).toEqual([]);
  });
});

describe("evaluateDependencyReadiness", () => {
  it("a step with no dependencies is immediately ready", () => {
    const result = evaluateDependencyReadiness([], () => undefined);
    expect(result.ready).toBe(true);
    expect(result.reason).toBe("ready");
  });

  it("waits while any dependency has not completed", () => {
    const result = evaluateDependencyReadiness(["a", "b"], (id) =>
      id === "a" ? "completed" : "running",
    );
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("waiting_for_dependencies");
    expect(result.summary.completedDependencies).toBe(1);
  });

  it("is ready once every dependency has completed", () => {
    const result = evaluateDependencyReadiness(["a", "b"], () => "completed");
    expect(result.ready).toBe(true);
    expect(result.reason).toBe("ready");
    expect(result.summary.completedDependencies).toBe(2);
  });

  it("blocks (never silently succeeds) when a dependency failed", () => {
    const result = evaluateDependencyReadiness(["a", "b"], (id) =>
      id === "a" ? "failed" : "completed",
    );
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("blocked_by_failed_dependency");
  });

  it("blocks (never silently succeeds) when a dependency was cancelled", () => {
    const result = evaluateDependencyReadiness(["a", "b"], (id) =>
      id === "a" ? "cancelled" : "completed",
    );
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("blocked_by_cancelled_dependency");
  });

  it("a failed dependency takes precedence over a cancelled one in the reported reason", () => {
    const result = evaluateDependencyReadiness(["a", "b"], (id) =>
      id === "a" ? "failed" : "cancelled",
    );
    expect(result.reason).toBe("blocked_by_failed_dependency");
  });

  it("evaluates exactly one lookup per direct dependency — never scans unrelated steps (efficiency target #1/#3)", () => {
    let calls = 0;
    const dependencyStepIds = ["a", "b", "c"];
    evaluateDependencyReadiness(dependencyStepIds, () => {
      calls += 1;
      return "completed";
    });
    expect(calls).toBe(dependencyStepIds.length);
  });
});

describe("incremental evaluation over a large plan (efficiency target #1)", () => {
  it("evaluating one completed step's direct dependents touches only those dependents, never all 2000 steps in a 100-plan x 20-step universe", () => {
    // Build one 20-step plan (linear chain) as a stand-in for "one of 100
    // plans" — the index itself never sees the other 99 plans at all,
    // which is the actual efficiency property: a per-plan index, not a
    // global one.
    const steps = Array.from({ length: 20 }, (_, i) => ({
      id: `step-${String(i)}`,
      dependencies: i === 0 ? [] : [`step-${String(i - 1)}`],
    }));
    const index = buildDependencyIndex(steps);

    let evaluations = 0;
    const completedStepId = "step-5";
    const dependents = directDependentsOf(index, completedStepId);
    expect(dependents).toEqual(["step-6"]);
    for (const dependentId of dependents) {
      evaluateDependencyReadiness(directDependenciesOf(index, dependentId), () => {
        evaluations += 1;
        return "completed";
      });
    }
    // Exactly one dependent, with exactly one dependency of its own.
    expect(evaluations).toBe(1);
  });
});
