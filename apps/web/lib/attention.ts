import type { CeoPlan, CeoPlanRun, TaskRecord } from "./api-schemas";

export interface AttentionItem {
  readonly id: string;
  readonly reason: string;
  readonly projectLabel: string;
  readonly taskLabel: string;
  readonly recommendedAction: string;
  readonly href: string;
}

/**
 * The single source of truth for "needs your attention", derived purely
 * from already-fetched durable state (tasks, CEO plans, execution runs) —
 * no separate attention persistence. Shared by `/attention`, the nav count,
 * and the Gateway overview so all three can never drift from each other.
 */
export function deriveAttentionItems(
  tasks: readonly TaskRecord[],
  plans: readonly CeoPlan[],
  runs: readonly CeoPlanRun[],
): readonly AttentionItem[] {
  const taskById = new Map(tasks.map((record) => [record.task.taskId, record]));
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const items: AttentionItem[] = [];

  function taskLabelsFor(parentTaskId: string): {
    readonly projectLabel: string;
    readonly taskLabel: string;
  } {
    const record = taskById.get(parentTaskId);
    return {
      projectLabel: record?.task.projectId ?? "Unknown project",
      taskLabel: record?.task.title ?? parentTaskId,
    };
  }

  for (const plan of plans) {
    if (plan.status === "awaiting_approval") {
      items.push({
        id: `plan-approval-${plan.id}`,
        reason: "Plan is awaiting your approval",
        ...taskLabelsFor(plan.parentTaskId),
        recommendedAction: "Review and approve",
        href: `/ceo/${encodeURIComponent(plan.id)}`,
      });
    }
    if (plan.status === "failed") {
      items.push({
        id: `plan-failed-${plan.id}`,
        reason: "Plan failed",
        ...taskLabelsFor(plan.parentTaskId),
        recommendedAction: "Review the full plan",
        href: `/ceo/${encodeURIComponent(plan.id)}`,
      });
    }
  }

  for (const record of tasks) {
    if (record.task.status === "blocked") {
      items.push({
        id: `task-blocked-${record.task.taskId}`,
        reason: "Task is blocked",
        projectLabel: record.task.projectId,
        taskLabel: record.task.title,
        recommendedAction: "Move back to Backlog or Ready to resume",
        href: "/board",
      });
    }
    if (record.task.status === "failed") {
      items.push({
        id: `task-failed-${record.task.taskId}`,
        reason: "Task failed",
        projectLabel: record.task.projectId,
        taskLabel: record.task.title,
        recommendedAction: "Review and decide next step",
        href: "/board",
      });
    }
  }

  for (const run of runs) {
    if (run.status === "awaiting_intervention") {
      const plan = planById.get(run.planId);
      const labels = plan
        ? taskLabelsFor(plan.parentTaskId)
        : { projectLabel: "Unknown project", taskLabel: run.planId };
      items.push({
        id: `run-attention-${run.id}`,
        reason: "Execution needs your attention",
        ...labels,
        recommendedAction: "Review and intervene",
        href: plan ? `/ceo/${encodeURIComponent(plan.id)}` : "/board",
      });
    }
  }

  return items;
}
