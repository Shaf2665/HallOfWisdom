import type { CeoPlanStepAttempt, CeoPlanStepExecution, CeoPlanVersion } from "@hall-of-wisdom/protocol";
import type { AdapterSummary, CeoDelegationLink } from "./api-schemas";

/**
 * Pure CEO worker-activity domain logic — no fetching, no DOM, no React.
 * Mirrors the split established by `apps/web/lib/kanban.ts`.
 */

export interface WorkerActivity {
  readonly stepId: string;
  readonly position: number;
  readonly title: string;
  readonly objective: string;
  readonly childTaskId: string;
  readonly status: CeoPlanStepExecution["status"];
  readonly adapterId: string | null;
  readonly adapterDisplayName: string | null;
  readonly attemptCount: number;
  readonly lastFailureCode: string | null;
  readonly lastFailureSummary: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

/** Latest attempt per step, by highest `attemptNumber`. */
function latestAttemptByStep(
  attempts: readonly CeoPlanStepAttempt[],
): ReadonlyMap<string, CeoPlanStepAttempt> {
  const latest = new Map<string, CeoPlanStepAttempt>();
  for (const attempt of attempts) {
    const current = latest.get(attempt.planStepId);
    if (!current || attempt.attemptNumber > current.attemptNumber) {
      latest.set(attempt.planStepId, attempt);
    }
  }
  return latest;
}

/**
 * `stepExecutions` (run-scoped) is the source of truth for which workers
 * exist; `version.steps` and `links` are joined in for display metadata a
 * step execution alone doesn't carry.
 */
export function projectWorkerActivity(
  version: CeoPlanVersion,
  links: readonly CeoDelegationLink[],
  stepExecutions: readonly CeoPlanStepExecution[],
  attempts: readonly CeoPlanStepAttempt[],
  adapters: ReadonlyMap<string, AdapterSummary>,
): readonly WorkerActivity[] {
  const stepsById = new Map(version.steps.map((step) => [step.id, step]));
  const adapterIdByStepId = new Map(links.map((link) => [link.stepId, link.adapterId]));
  const latestAttempts = latestAttemptByStep(attempts);

  return stepExecutions.map((execution) => {
    const step = stepsById.get(execution.planStepId);
    const adapterId = adapterIdByStepId.get(execution.planStepId) ?? null;
    const adapter = adapterId ? (adapters.get(adapterId) ?? null) : null;
    const latestAttempt = latestAttempts.get(execution.planStepId);

    return {
      stepId: execution.planStepId,
      position: step?.position ?? Number.MAX_SAFE_INTEGER,
      title: step?.title ?? execution.planStepId,
      objective: step?.objective ?? "",
      childTaskId: execution.childTaskId,
      status: execution.status,
      adapterId,
      adapterDisplayName: adapter?.displayName ?? null,
      attemptCount: execution.attemptCount,
      lastFailureCode: execution.lastFailureCode ?? null,
      lastFailureSummary: latestAttempt?.safeFailureSummary ?? null,
      startedAt: execution.startedAt ?? null,
      completedAt: execution.completedAt ?? null,
    };
  });
}

export interface WorkerActivityFilters {
  readonly search: string;
  readonly status: CeoPlanStepExecution["status"] | "all";
  /** `"all"` is a sentinel meaning "no adapter filter" — every other value is a real `adapterId`. */
  readonly adapterId: string;
}

export const DEFAULT_WORKER_ACTIVITY_FILTERS: WorkerActivityFilters = {
  search: "",
  status: "all",
  adapterId: "all",
};

export function hasActiveFilters(filters: WorkerActivityFilters): boolean {
  return (
    filters.search.trim().length > 0 || filters.status !== "all" || filters.adapterId !== "all"
  );
}

export function filterWorkerActivity(
  workers: readonly WorkerActivity[],
  filters: WorkerActivityFilters,
): readonly WorkerActivity[] {
  const search = filters.search.trim().toLowerCase();
  return workers.filter((worker) => {
    if (filters.status !== "all" && worker.status !== filters.status) return false;
    if (filters.adapterId !== "all" && worker.adapterId !== filters.adapterId) return false;
    if (search.length > 0) {
      const haystack = `${worker.title} ${worker.objective} ${worker.lastFailureSummary ?? ""}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}
