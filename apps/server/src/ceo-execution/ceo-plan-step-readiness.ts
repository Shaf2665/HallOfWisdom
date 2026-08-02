import type {
  CeoPlanStepDependencySummary,
  CeoPlanStepExecutionStatus,
  CeoPlanStepReadinessReason,
} from "@hall-of-wisdom/protocol";

/**
 * Deterministic adjacency index over one immutable plan version's steps —
 * a projection, never an independent source of truth (rebuilt whenever
 * the underlying plan version could have changed: composition startup,
 * durable recovery, or a new execution run being configured; never
 * mutated in place). Keeping `dependents` and `dependencies` as separate
 * maps is what lets the scheduler answer "what does this step unblock?"
 * in O(1) instead of scanning every step's own dependency list on every
 * signal (see `docs/architecture/0015-...md`, "Incremental dependency
 * index").
 */
export interface DependencyIndex {
  readonly dependents: ReadonlyMap<string, readonly string[]>;
  readonly dependencies: ReadonlyMap<string, readonly string[]>;
  readonly allStepIds: readonly string[];
}

export interface DependencyIndexStepInput {
  readonly id: string;
  readonly dependencies: readonly string[];
}

export function buildDependencyIndex(steps: readonly DependencyIndexStepInput[]): DependencyIndex {
  const dependents = new Map<string, string[]>();
  const dependencies = new Map<string, string[]>();
  for (const step of steps) {
    dependencies.set(step.id, [...step.dependencies]);
    if (!dependents.has(step.id)) dependents.set(step.id, []);
  }
  for (const step of steps) {
    for (const dependencyId of step.dependencies) {
      const existing = dependents.get(dependencyId);
      if (existing) existing.push(step.id);
      else dependents.set(dependencyId, [step.id]);
    }
  }
  return { dependents, dependencies, allStepIds: steps.map((s) => s.id) };
}

/** O(1) lookup of a step's direct dependents — the only steps a completed/failed/cancelled step's own transition can ever affect. */
export function directDependentsOf(index: DependencyIndex, stepId: string): readonly string[] {
  return index.dependents.get(stepId) ?? [];
}

export function directDependenciesOf(index: DependencyIndex, stepId: string): readonly string[] {
  return index.dependencies.get(stepId) ?? [];
}

export interface DependencyReadiness {
  readonly ready: boolean;
  readonly reason: Extract<
    CeoPlanStepReadinessReason,
    | "ready"
    | "waiting_for_dependencies"
    | "blocked_by_failed_dependency"
    | "blocked_by_cancelled_dependency"
  >;
  readonly summary: CeoPlanStepDependencySummary;
}

/**
 * Pure, bounded-cost dependency readiness check for exactly one step:
 * evaluates only that step's own direct dependency ids (never the whole
 * plan), matching the efficiency target's "evaluate only the affected
 * step" requirement. A cancelled or skipped dependency is never silently
 * treated as success — either one blocks the step exactly like a failure
 * does (kickoff, "Dependency-aware scheduling": "Do not automatically
 * treat a skipped or cancelled dependency as success").
 */
export function evaluateDependencyReadiness(
  dependencyStepIds: readonly string[],
  getStepStatus: (stepId: string) => CeoPlanStepExecutionStatus | undefined,
): DependencyReadiness {
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  for (const dependencyId of dependencyStepIds) {
    const status = getStepStatus(dependencyId);
    if (status === "completed") completed += 1;
    else if (status === "failed") failed += 1;
    else if (status === "cancelled") cancelled += 1;
  }
  const summary: CeoPlanStepDependencySummary = {
    totalDependencies: dependencyStepIds.length,
    completedDependencies: completed,
    failedDependencies: failed,
    cancelledDependencies: cancelled,
  };
  if (failed > 0) return { ready: false, reason: "blocked_by_failed_dependency", summary };
  if (cancelled > 0) return { ready: false, reason: "blocked_by_cancelled_dependency", summary };
  if (completed === dependencyStepIds.length) return { ready: true, reason: "ready", summary };
  return { ready: false, reason: "waiting_for_dependencies", summary };
}
