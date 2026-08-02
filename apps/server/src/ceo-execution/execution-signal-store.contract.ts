import { describe, expect, it } from "vitest";
import type { ExecutionSignalStorePort } from "./execution-signal-store-port.js";

const NOW = "2026-07-31T12:00:00.000Z";
const LATER = "2026-07-31T12:05:00.000Z";
const EARLIER = "2026-07-31T11:55:00.000Z";

/**
 * Behavioral contract every `ExecutionSignalStorePort` implementation must
 * satisfy — run once against `InMemoryExecutionSignalStore` and once
 * against `SqliteExecutionSignalStore` (real, migrated, in-memory
 * `HallDatabase`).
 */
export function runExecutionSignalStoreContractTests(
  label: string,
  buildStore: () => ExecutionSignalStorePort,
): void {
  describe(`ExecutionSignalStorePort contract — ${label}`, () => {
    it("enqueue creates a brand-new pending signal", () => {
      const store = buildStore();
      const result = store.enqueue({
        signalId: "sig-1",
        planRunId: "run-1",
        planStepId: "step-1",
        generation: 0,
        reason: "execution_started",
        priority: "normal",
        availableAt: NOW,
        now: NOW,
      });
      expect(result.created).toBe(true);
      expect(result.signal.state).toBe("pending");
      expect(result.signal.reasons).toEqual(["execution_started"]);
    });

    it("coalesces a second enqueue for the same (run, step, generation) into one pending signal", () => {
      const store = buildStore();
      store.enqueue({
        signalId: "sig-1",
        planRunId: "run-1",
        planStepId: "step-1",
        generation: 0,
        reason: "execution_started",
        priority: "normal",
        availableAt: NOW,
        now: NOW,
      });
      const second = store.enqueue({
        signalId: "sig-2",
        planRunId: "run-1",
        planStepId: "step-1",
        generation: 0,
        reason: "dependency_completed",
        priority: "normal",
        availableAt: LATER,
        now: LATER,
      });
      expect(second.created).toBe(false);
      expect(store.listSignalsForRun("run-1")).toHaveLength(1);
      expect(store.listSignalsForRun("run-1")[0]?.reasons).toEqual([
        "execution_started",
        "dependency_completed",
      ]);
    });

    it("merging never duplicates an already-present reason", () => {
      const store = buildStore();
      store.enqueue({
        signalId: "sig-1",
        planRunId: "run-1",
        planStepId: "step-1",
        generation: 0,
        reason: "execution_started",
        priority: "normal",
        availableAt: NOW,
        now: NOW,
      });
      store.enqueue({
        signalId: "sig-2",
        planRunId: "run-1",
        planStepId: "step-1",
        generation: 0,
        reason: "execution_started",
        priority: "normal",
        availableAt: LATER,
        now: LATER,
      });
      expect(store.listSignalsForRun("run-1")[0]?.reasons).toEqual(["execution_started"]);
    });

    it("coalesced merge uses the earliest availableAt and never downgrades priority", () => {
      const store = buildStore();
      store.enqueue({
        signalId: "sig-1",
        planRunId: "run-1",
        planStepId: "step-1",
        generation: 0,
        reason: "execution_started",
        priority: "normal",
        availableAt: LATER,
        now: NOW,
      });
      const second = store.enqueue({
        signalId: "sig-2",
        planRunId: "run-1",
        planStepId: "step-1",
        generation: 0,
        reason: "retry_due",
        priority: "high",
        availableAt: EARLIER,
        now: LATER,
      });
      expect(second.signal.availableAt).toBe(EARLIER);
      expect(second.signal.priority).toBe("high");
    });

    it("a plan-level signal (undefined planStepId) does not coalesce with a step-scoped one in the same run", () => {
      const store = buildStore();
      store.enqueue({
        signalId: "sig-1",
        planRunId: "run-1",
        planStepId: undefined,
        generation: 0,
        reason: "capacity_available",
        priority: "normal",
        availableAt: NOW,
        now: NOW,
      });
      const stepScoped = store.enqueue({
        signalId: "sig-2",
        planRunId: "run-1",
        planStepId: "step-1",
        generation: 0,
        reason: "dependency_completed",
        priority: "normal",
        availableAt: NOW,
        now: NOW,
      });
      expect(stepScoped.created).toBe(true);
      expect(store.listSignalsForRun("run-1")).toHaveLength(2);
    });

    it("a different generation never coalesces with an older one — treated as a distinct signal", () => {
      const store = buildStore();
      store.enqueue({
        signalId: "sig-1",
        planRunId: "run-1",
        planStepId: "step-1",
        generation: 0,
        reason: "execution_started",
        priority: "normal",
        availableAt: NOW,
        now: NOW,
      });
      const nextGen = store.enqueue({
        signalId: "sig-2",
        planRunId: "run-1",
        planStepId: "step-1",
        generation: 1,
        reason: "operator_resumed",
        priority: "normal",
        availableAt: NOW,
        now: NOW,
      });
      expect(nextGen.created).toBe(true);
    });

    it("claimNext returns undefined when nothing is eligible", () => {
      const store = buildStore();
      expect(
        store.claimNext({ now: NOW, ownerToken: "o-1", leaseSeconds: 30, eligibleRunIds: [] }),
      ).toBeUndefined();
    });

    it("claimNext claims the one pending signal and marks it claimed", () => {
      const store = buildStore();
      store.enqueue({
        signalId: "sig-1",
        planRunId: "run-1",
        planStepId: "step-1",
        generation: 0,
        reason: "execution_started",
        priority: "normal",
        availableAt: NOW,
        now: NOW,
      });
      const claimed = store.claimNext({
        now: NOW,
        ownerToken: "o-1",
        leaseSeconds: 30,
        eligibleRunIds: ["run-1"],
      });
      expect(claimed?.signal.state).toBe("claimed");
      expect(store.getSignal("sig-1")?.state).toBe("claimed");
    });

    it("a not-yet-available signal (availableAt in the future) is never claimed", () => {
      const store = buildStore();
      store.enqueue({
        signalId: "sig-1",
        planRunId: "run-1",
        planStepId: "step-1",
        generation: 0,
        reason: "retry_due",
        priority: "normal",
        availableAt: LATER,
        now: NOW,
      });
      const claimed = store.claimNext({
        now: NOW,
        ownerToken: "o-1",
        leaseSeconds: 30,
        eligibleRunIds: ["run-1"],
      });
      expect(claimed).toBeUndefined();
    });

    it("claimNext prefers high priority over creation order", () => {
      const store = buildStore();
      store.enqueue({
        signalId: "sig-1",
        planRunId: "run-1",
        planStepId: "step-1",
        generation: 0,
        reason: "execution_started",
        priority: "normal",
        availableAt: NOW,
        now: NOW,
      });
      store.enqueue({
        signalId: "sig-2",
        planRunId: "run-1",
        planStepId: "step-2",
        generation: 0,
        reason: "retry_due",
        priority: "high",
        availableAt: NOW,
        now: LATER,
      });
      const claimed = store.claimNext({
        now: LATER,
        ownerToken: "o-1",
        leaseSeconds: 30,
        eligibleRunIds: ["run-1"],
      });
      expect(claimed?.signal.id).toBe("sig-2");
    });

    it("a second concurrent claim attempt never claims the same signal twice", () => {
      const store = buildStore();
      store.enqueue({
        signalId: "sig-1",
        planRunId: "run-1",
        planStepId: "step-1",
        generation: 0,
        reason: "execution_started",
        priority: "normal",
        availableAt: NOW,
        now: NOW,
      });
      const first = store.claimNext({
        now: NOW,
        ownerToken: "o-1",
        leaseSeconds: 30,
        eligibleRunIds: ["run-1"],
      });
      const second = store.claimNext({
        now: NOW,
        ownerToken: "o-2",
        leaseSeconds: 30,
        eligibleRunIds: ["run-1"],
      });
      expect(first?.signal.id).toBe("sig-1");
      expect(second).toBeUndefined();
    });

    it("markProcessed with the correct lease finalizes the signal", () => {
      const store = buildStore();
      store.enqueue({
        signalId: "sig-1",
        planRunId: "run-1",
        planStepId: "step-1",
        generation: 0,
        reason: "execution_started",
        priority: "normal",
        availableAt: NOW,
        now: NOW,
      });
      const claimed = store.claimNext({
        now: NOW,
        ownerToken: "o-1",
        leaseSeconds: 30,
        eligibleRunIds: ["run-1"],
      });
      store.markProcessed("sig-1", claimed?.claimLease ?? "", LATER);
      expect(store.getSignal("sig-1")?.state).toBe("processed");
    });

    it("markProcessed with the wrong lease is a no-op", () => {
      const store = buildStore();
      store.enqueue({
        signalId: "sig-1",
        planRunId: "run-1",
        planStepId: "step-1",
        generation: 0,
        reason: "execution_started",
        priority: "normal",
        availableAt: NOW,
        now: NOW,
      });
      store.claimNext({ now: NOW, ownerToken: "o-1", leaseSeconds: 30, eligibleRunIds: ["run-1"] });
      store.markProcessed("sig-1", "wrong-lease", LATER);
      expect(store.getSignal("sig-1")?.state).toBe("claimed");
    });

    it("releaseExpiredClaims returns an expired claim to pending, reclaimable again", () => {
      const store = buildStore();
      store.enqueue({
        signalId: "sig-1",
        planRunId: "run-1",
        planStepId: "step-1",
        generation: 0,
        reason: "execution_started",
        priority: "normal",
        availableAt: NOW,
        now: NOW,
      });
      store.claimNext({ now: NOW, ownerToken: "o-1", leaseSeconds: 1, eligibleRunIds: ["run-1"] });
      const farLater = "2026-07-31T12:10:00.000Z";
      const released = store.releaseExpiredClaims(farLater);
      expect(released).toBe(1);
      const reclaimed = store.claimNext({
        now: farLater,
        ownerToken: "o-2",
        leaseSeconds: 30,
        eligibleRunIds: ["run-1"],
      });
      expect(reclaimed?.signal.id).toBe("sig-1");
    });

    it("cancelSignalsForRun cancels every pending/claimed signal for that run only", () => {
      const store = buildStore();
      store.enqueue({
        signalId: "sig-1",
        planRunId: "run-1",
        planStepId: "step-1",
        generation: 0,
        reason: "execution_started",
        priority: "normal",
        availableAt: NOW,
        now: NOW,
      });
      store.enqueue({
        signalId: "sig-2",
        planRunId: "run-2",
        planStepId: "step-1",
        generation: 0,
        reason: "execution_started",
        priority: "normal",
        availableAt: NOW,
        now: NOW,
      });
      const cancelled = store.cancelSignalsForRun("run-1", LATER);
      expect(cancelled).toBe(1);
      expect(store.getSignal("sig-1")?.state).toBe("cancelled");
      expect(store.getSignal("sig-2")?.state).toBe("pending");
    });

    it("claimNext never claims a signal outside the eligible run set", () => {
      const store = buildStore();
      store.enqueue({
        signalId: "sig-1",
        planRunId: "run-1",
        planStepId: "step-1",
        generation: 0,
        reason: "execution_started",
        priority: "normal",
        availableAt: NOW,
        now: NOW,
      });
      const claimed = store.claimNext({
        now: NOW,
        ownerToken: "o-1",
        leaseSeconds: 30,
        eligibleRunIds: ["run-2"],
      });
      expect(claimed).toBeUndefined();
    });

    it("countByState reports bounded pending/claimed counts", () => {
      const store = buildStore();
      store.enqueue({
        signalId: "sig-1",
        planRunId: "run-1",
        planStepId: "step-1",
        generation: 0,
        reason: "execution_started",
        priority: "normal",
        availableAt: NOW,
        now: NOW,
      });
      store.enqueue({
        signalId: "sig-2",
        planRunId: "run-1",
        planStepId: "step-2",
        generation: 0,
        reason: "execution_started",
        priority: "normal",
        availableAt: NOW,
        now: NOW,
      });
      store.claimNext({ now: NOW, ownerToken: "o-1", leaseSeconds: 30, eligibleRunIds: ["run-1"] });
      expect(store.countByState()).toEqual({ pending: 1, claimed: 1 });
    });
  });
}
