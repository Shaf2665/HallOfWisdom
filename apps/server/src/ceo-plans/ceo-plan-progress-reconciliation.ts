import type { CeoPlanOrchestrator } from "./ceo-plan-orchestrator.js";

/**
 * Phase 14.1 — idempotent backstop for a missed task-mutation-hook
 * trigger (e.g. a status change that happened while the server was
 * down, or — in theory — a swallowed listener exception). Safe to call
 * any number of times: `synchronizeProgress()` itself no-ops when
 * nothing changed. Called once at startup, after restart recovery,
 * mirroring how restart recovery itself runs exactly once per boot. A
 * single plan's synchronization failing (e.g. a transient store error)
 * does not prevent every other plan from being reconciled.
 */
export function reconcileAllPlanProgress(orchestrator: CeoPlanOrchestrator): void {
  for (const plan of orchestrator.listPlans()) {
    if (plan.status !== "delegated") continue;
    try {
      orchestrator.synchronizeProgress(plan.id);
    } catch {
      // A missed sync here is recoverable on the next reconciliation
      // pass or the next real task mutation — must not abort the loop.
    }
  }
}
