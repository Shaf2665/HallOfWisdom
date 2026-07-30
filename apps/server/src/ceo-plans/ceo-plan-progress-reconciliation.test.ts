import { describe, expect, it, vi } from "vitest";
import { reconcileAllPlanProgress } from "./ceo-plan-progress-reconciliation.js";
import type { CeoPlanOrchestrator } from "./ceo-plan-orchestrator.js";

function fakeOrchestrator(
  plans: { id: string; status: string }[],
): CeoPlanOrchestrator & { synchronizeProgress: ReturnType<typeof vi.fn> } {
  const synchronizeProgress = vi.fn();
  return {
    listPlans: () => plans,
    synchronizeProgress,
  } as unknown as CeoPlanOrchestrator & { synchronizeProgress: ReturnType<typeof vi.fn> };
}

describe("reconcileAllPlanProgress", () => {
  it("calls synchronizeProgress only for delegated plans, skipping every other status", () => {
    const orchestrator = fakeOrchestrator([
      { id: "plan-draft", status: "draft" },
      { id: "plan-delegated-1", status: "delegated" },
      { id: "plan-approved", status: "approved" },
      { id: "plan-delegated-2", status: "delegated" },
      { id: "plan-completed", status: "completed" },
      { id: "plan-failed", status: "failed" },
      { id: "plan-cancelled", status: "cancelled" },
    ]);

    reconcileAllPlanProgress(orchestrator);

    expect(orchestrator.synchronizeProgress).toHaveBeenCalledTimes(2);
    expect(orchestrator.synchronizeProgress).toHaveBeenCalledWith("plan-delegated-1");
    expect(orchestrator.synchronizeProgress).toHaveBeenCalledWith("plan-delegated-2");
  });

  it("is a no-op when there are no plans at all", () => {
    const orchestrator = fakeOrchestrator([]);
    expect(() => {
      reconcileAllPlanProgress(orchestrator);
    }).not.toThrow();
    expect(orchestrator.synchronizeProgress).not.toHaveBeenCalled();
  });

  it("continues reconciling remaining plans even if one synchronizeProgress call throws", () => {
    const orchestrator = fakeOrchestrator([
      { id: "plan-a", status: "delegated" },
      { id: "plan-b", status: "delegated" },
    ]);
    orchestrator.synchronizeProgress.mockImplementationOnce(() => {
      throw new Error("boom");
    });

    expect(() => {
      reconcileAllPlanProgress(orchestrator);
    }).not.toThrow();
    expect(orchestrator.synchronizeProgress).toHaveBeenCalledTimes(2);
  });
});
