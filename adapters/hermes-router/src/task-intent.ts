import type { TaskRequirements } from "@hall-of-wisdom/protocol";

/**
 * A small, best-effort hint about what kind of workload a task is. Derived
 * only from data Hall already computes (`TaskRequirements.requiredCapabilities`)
 * — never a model or provider name. Hermes Router remains solely responsible
 * for deciding what (if anything) to do with this hint; a Hermes runner that
 * doesn't understand `task_intent` is expected to ignore it.
 *
 * Only "coding", "review", and "general" are ever derived today:
 * - "planning" is unreachable — CEO plan generation is a deterministic,
 *   adapter-free process (`CeoPlanOrchestrator`/`CeoPlannerPort`) that never
 *   calls an adapter, so there is no delegated task to route as "planning".
 * - "debug" is unreachable — a step-retry's `triggerReason` (e.g.
 *   `retry_due`) is known to `CeoPlanExecutionScheduler` but isn't threaded
 *   through `TaskOrchestrator.startTask(taskId)` to the point an
 *   `AgentTaskInput` is built, so a retry can't be distinguished here today.
 * - "vision" is unreachable — no capability id represents multimodal/image
 *   input, and the communication-board attachment subsystem is entirely
 *   separate from delegated CEO tasks.
 */
export const TASK_INTENTS = ["planning", "coding", "review", "debug", "vision", "general"] as const;
export type TaskIntent = (typeof TASK_INTENTS)[number];

export const DEFAULT_TASK_INTENT: TaskIntent = "general";

/**
 * A task requiring edits or command execution is coding-shaped; one
 * requiring only read/inspect access is review-shaped; anything else
 * (including no declared requirements at all) falls back to "general" —
 * the same default an unconfigured Hermes routing setup would use.
 */
export function deriveTaskIntent(requirements: TaskRequirements | undefined): TaskIntent {
  const capabilities = requirements?.requiredCapabilities ?? [];
  if (capabilities.includes("project.edit") || capabilities.includes("command.execute")) {
    return "coding";
  }
  if (capabilities.includes("project.read") || capabilities.includes("git.inspect")) {
    return "review";
  }
  return DEFAULT_TASK_INTENT;
}
