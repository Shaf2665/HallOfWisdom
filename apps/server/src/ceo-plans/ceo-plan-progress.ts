import type { CeoPlanVersion } from "@hall-of-wisdom/protocol";
import type { TaskRecord } from "../tasks/task-record.js";
import type { TaskStorePort } from "../tasks/task-store-port.js";
import type { DelegationLink } from "./ceo-plan-store-port.js";

/**
 * Phase 14 kickoff, "Plan progress tracking" — deliberately not a new
 * task status (`Avoid adding a new task status unless strictly
 * necessary`). Every one of these is *derived*, fresh, from a step's
 * linked child task's own authoritative `TaskStatus` plus its
 * dependencies' derived statuses — never a second, independently
 * mutable execution state stored anywhere.
 */
export type CeoPlanStepProgressStatus =
  | "waiting_for_dependencies"
  | "ready_to_start"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

export interface CeoPlanStepProgress {
  readonly stepId: string;
  readonly childTaskId: string | undefined;
  readonly status: CeoPlanStepProgressStatus;
}

export interface CeoPlanProgressSummary {
  readonly totalSteps: number;
  readonly completed: number;
  readonly running: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly blocked: number;
  readonly notStarted: number;
  readonly steps: readonly CeoPlanStepProgress[];
}

const RUNNING_TASK_STATUSES = new Set(["running", "reviewing", "waiting_for_approval"]);

/**
 * Derives each step's progress from its linked child task's live status
 * and its dependencies' own derived statuses — never rewrites a child
 * task's own state (kickoff: "Do not rewrite child-task state merely to
 * make the plan summary appear consistent"). A step with no delegation
 * link yet (the plan has not been delegated) is reported
 * `waiting_for_dependencies` for every step, which is the correct,
 * conservative answer for "nothing has been delegated" — callers only
 * meaningfully consult this once `plan.status === "delegated"` (or a
 * later terminal state reached from it).
 */
export function deriveCeoPlanProgress(
  version: CeoPlanVersion,
  links: readonly DelegationLink[],
  taskStore: TaskStorePort,
): CeoPlanProgressSummary {
  const childTaskIdByStepId = new Map(links.map((link) => [link.stepId, link.childTaskId]));
  const recordByStepId = new Map<string, TaskRecord | undefined>();
  for (const step of version.steps) {
    const childTaskId = childTaskIdByStepId.get(step.id);
    recordByStepId.set(step.id, childTaskId !== undefined ? taskStore.get(childTaskId) : undefined);
  }

  function statusFor(step: CeoPlanVersion["steps"][number]): CeoPlanStepProgressStatus {
    const record = recordByStepId.get(step.id);
    const childTaskId = childTaskIdByStepId.get(step.id);
    if (record === undefined || childTaskId === undefined) return "waiting_for_dependencies";

    const taskStatus = record.task.status;
    if (taskStatus === "completed") return "completed";
    if (taskStatus === "failed") return "failed";
    if (taskStatus === "cancelled") return "cancelled";
    if (RUNNING_TASK_STATUSES.has(taskStatus)) return "running";

    // backlog / ready / assigned / blocked, not yet started — readiness
    // depends entirely on the dependency steps' own derived statuses.
    if (step.dependencies.length === 0) return "ready_to_start";
    const dependencyStatuses = step.dependencies.map((depStepId) => {
      const depStep = version.steps.find((s) => s.id === depStepId);
      return depStep !== undefined ? statusFor(depStep) : "blocked";
    });
    if (dependencyStatuses.some((s) => s === "failed" || s === "cancelled" || s === "blocked")) {
      return "blocked";
    }
    if (dependencyStatuses.every((s) => s === "completed")) return "ready_to_start";
    return "waiting_for_dependencies";
  }

  const steps: CeoPlanStepProgress[] = version.steps.map((step) => ({
    stepId: step.id,
    childTaskId: childTaskIdByStepId.get(step.id),
    status: statusFor(step),
  }));

  return {
    totalSteps: steps.length,
    completed: steps.filter((s) => s.status === "completed").length,
    running: steps.filter((s) => s.status === "running").length,
    failed: steps.filter((s) => s.status === "failed").length,
    cancelled: steps.filter((s) => s.status === "cancelled").length,
    blocked: steps.filter((s) => s.status === "blocked").length,
    notStarted: steps.filter(
      (s) => s.status === "waiting_for_dependencies" || s.status === "ready_to_start",
    ).length,
    steps,
  };
}

/**
 * Plan completion policy (kickoff: "Document the exact policy" — this is
 * that documentation, in code): `"completed"` only once every single
 * child task has itself completed successfully; `"failed"` as soon as
 * *any* child task reaches `failed` or `cancelled`, even while siblings
 * are still pending — Phase 14 builds no operator-continuation policy
 * (kickoff, "Known Phase-14 Limitations": no automatic replanning, no
 * cascading cancellation), so a failed/cancelled step is treated as
 * immediately fatal to the plan's own tracked outcome rather than
 * silently waited out. `undefined` means "still in progress, no terminal
 * outcome yet" — the caller leaves the plan's own status as `delegated`.
 */
export function derivePlanTerminalOutcome(
  progress: CeoPlanProgressSummary,
): "completed" | "failed" | undefined {
  if (progress.totalSteps > 0 && progress.completed === progress.totalSteps) return "completed";
  if (progress.failed > 0 || progress.cancelled > 0 || progress.blocked > 0) return "failed";
  return undefined;
}
