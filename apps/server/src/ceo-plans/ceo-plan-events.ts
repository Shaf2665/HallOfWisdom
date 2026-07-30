import type { CeoPlanEvent } from "@hall-of-wisdom/protocol";

export type CeoPlanEventListener = (event: CeoPlanEvent) => void;

export interface CeoPlanEventBusOptions {
  readonly maxSubscribersPerPlan: number;
}

export class CeoPlanEventSubscriberLimitReachedError extends Error {
  constructor(planId: string, limit: number) {
    super(`CEO plan "${planId}" has reached its configured subscriber limit (${String(limit)}).`);
    this.name = "CeoPlanEventSubscriberLimitReachedError";
  }
}

/**
 * Per-plan pub/sub fanning a plan's events out to connected WebSocket
 * clients — deliberately the same shape as `boards/message-bus.ts`'s
 * `MessageBus` and `events/event-bus.ts`'s `EventBus`, kept as its own
 * class (not a shared generic) so CEO plan events, board messages, and
 * agent-run events never share one channel a bug could cross-wire
 * (Phase 14 kickoff, "Do not mix task, Board, comparison and CEO-plan
 * event streams"). `publish()` is only ever called by
 * `ceo-plan-orchestrator.ts`, strictly after the mutation that produced
 * the event has already committed — see that module's doc comment on
 * "publication occurs only after commit."
 */
export class CeoPlanEventBus {
  readonly #listenersByPlanId = new Map<string, Set<CeoPlanEventListener>>();
  readonly #maxSubscribersPerPlan: number;

  constructor(options: CeoPlanEventBusOptions) {
    this.#maxSubscribersPerPlan = options.maxSubscribersPerPlan;
  }

  subscribe(planId: string, listener: CeoPlanEventListener): () => void {
    let listeners = this.#listenersByPlanId.get(planId);
    if (!listeners) {
      listeners = new Set();
      this.#listenersByPlanId.set(planId, listeners);
    }
    if (listeners.size >= this.#maxSubscribersPerPlan) {
      throw new CeoPlanEventSubscriberLimitReachedError(planId, this.#maxSubscribersPerPlan);
    }
    listeners.add(listener);

    return () => {
      const current = this.#listenersByPlanId.get(planId);
      current?.delete(listener);
      if (current?.size === 0) {
        this.#listenersByPlanId.delete(planId);
      }
    };
  }

  publish(planId: string, event: CeoPlanEvent): void {
    const listeners = this.#listenersByPlanId.get(planId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A single failing subscriber must never prevent delivery to the
        // others or crash the caller — same discipline as MessageBus.
      }
    }
  }

  subscriberCount(planId: string): number {
    return this.#listenersByPlanId.get(planId)?.size ?? 0;
  }
}
