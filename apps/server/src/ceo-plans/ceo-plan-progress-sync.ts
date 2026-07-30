import { createHash } from "node:crypto";
import type { CeoPlanEvent } from "@hall-of-wisdom/protocol";
import type { TaskStorePort } from "../tasks/task-store-port.js";
import type { CeoPlanStorePort } from "./ceo-plan-store-port.js";
import type { CeoPlanEventBus } from "./ceo-plan-events.js";
import { deriveCeoPlanProgress, derivePlanTerminalOutcome } from "./ceo-plan-progress.js";

export interface ProgressSyncResult {
  readonly changed: boolean;
  readonly event: CeoPlanEvent | undefined;
}

export interface SynchronizePlanProgressDeps {
  readonly planStore: CeoPlanStorePort;
  readonly taskStore: TaskStorePort;
  readonly runAtomicUnit: <T>(fn: () => T) => T;
  readonly planEventBus: CeoPlanEventBus;
}

/** Deterministic, order-stable — steps are already in a fixed order from the version's own step array, never resorted here. */
function fingerprintOf(
  steps: readonly { readonly stepId: string; readonly status: string }[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(steps.map((s) => [s.stepId, s.status])))
    .digest("hex");
}

/**
 * Phase 14.1 — the event-driven, idempotent progress synchronizer that
 * replaces the old Phase 14 `refreshProgress()`'s mutating half. Never
 * called from a route (routes call `CeoPlanOrchestrator.getPlanWithProgress`,
 * a pure read) — only by the task-mutation hook, after a linked child
 * task's status genuinely changes, and by the startup reconciliation
 * pass. Idempotent: derives progress fresh, compares its fingerprint
 * against the plan's own stored one, and no-ops when unchanged — a
 * duplicate or out-of-order trigger (e.g. the hook firing twice for the
 * same underlying change, or the reconciliation pass re-checking a plan
 * the hook already handled) never appends a second event for the same
 * transition. A plan not currently `delegated` has nothing to
 * synchronize (a plan already `completed`/`failed` is a one-time,
 * terminal transition, never revisited — see `derivePlanTerminalOutcome`'s
 * doc comment for the exact policy this implements).
 */
export function synchronizePlanProgress(
  planId: string,
  deps: SynchronizePlanProgressDeps,
): ProgressSyncResult {
  const plan = deps.planStore.getPlan(planId);
  if (plan.status !== "delegated") {
    return { changed: false, event: undefined };
  }

  const version = deps.planStore.getVersion(planId, plan.activeVersion);
  const links = deps.planStore.listDelegationLinks(planId);
  const progress = deriveCeoPlanProgress(version, links, deps.taskStore);
  const fingerprint = fingerprintOf(progress.steps);
  if (fingerprint === deps.planStore.getLastProgressFingerprint(planId)) {
    return { changed: false, event: undefined };
  }

  const outcome = derivePlanTerminalOutcome(progress);
  const now = new Date().toISOString();
  const eventType =
    outcome === "completed"
      ? "ceo.plan.completed"
      : outcome === "failed"
        ? "ceo.plan.failed"
        : "ceo.plan.progress_changed";

  const result = deps.runAtomicUnit(() =>
    deps.planStore.syncProgress({
      planId,
      expectedRevision: deps.planStore.getRevision(planId),
      fingerprint,
      now,
      eventType,
      eventPayload: {
        completed: progress.completed,
        running: progress.running,
        failed: progress.failed,
        blocked: progress.blocked,
        totalSteps: progress.totalSteps,
      },
      ...(outcome !== undefined ? { newStatus: outcome } : {}),
    }),
  );

  // Publish strictly after commit — same discipline as delegate().
  deps.planEventBus.publish(planId, result.event);
  return { changed: true, event: result.event };
}
