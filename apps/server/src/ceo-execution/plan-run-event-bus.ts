import type { CeoPlanExecutionEvent } from "@hall-of-wisdom/protocol";

export type PlanRunEventListener = (event: CeoPlanExecutionEvent) => void;

export interface PlanRunEventBusOptions {
  readonly maxSubscribersPerRun: number;
}

export class PlanRunEventSubscriberLimitReachedError extends Error {
  constructor(runId: string, limit: number) {
    super(
      `CEO plan run "${runId}" has reached its configured subscriber limit (${String(limit)}).`,
    );
    this.name = "PlanRunEventSubscriberLimitReachedError";
  }
}

/**
 * Per-run pub/sub fanning a plan run's execution events out to connected
 * WebSocket clients — the Phase 15 analogue of `ceo-plan-events.ts`'s
 * `CeoPlanEventBus`, kept as its own dedicated class (not a shared
 * generic, not the same channel `CeoPlanEventBus`/`MessageBus`/`EventBus`
 * use) so execution events never mix with task normalized events,
 * comparison events, CEO plan-definition events, or Board messages — the
 * kickoff's "dedicated CEO execution stream" requirement.
 *
 * `publish()` must only ever be called strictly after the mutation that
 * produced the event has already committed (durable mode:
 * `withTransaction` has returned; ephemeral mode: the atomic span has
 * returned without throwing) — never from inside a transaction/atomic
 * span, and never at all if that span rolled back. See
 * `ceo-plan-run-store-port.ts#appendEvent`'s own persisted-sequence
 * guarantee: this bus only ever fans out events that already have a
 * durable row.
 */
export class PlanRunEventBus {
  readonly #listenersByRunId = new Map<string, Set<PlanRunEventListener>>();
  readonly #maxSubscribersPerRun: number;

  constructor(options: PlanRunEventBusOptions) {
    this.#maxSubscribersPerRun = options.maxSubscribersPerRun;
  }

  subscribe(runId: string, listener: PlanRunEventListener): () => void {
    let listeners = this.#listenersByRunId.get(runId);
    if (!listeners) {
      listeners = new Set();
      this.#listenersByRunId.set(runId, listeners);
    }
    if (listeners.size >= this.#maxSubscribersPerRun) {
      throw new PlanRunEventSubscriberLimitReachedError(runId, this.#maxSubscribersPerRun);
    }
    listeners.add(listener);

    return () => {
      const current = this.#listenersByRunId.get(runId);
      current?.delete(listener);
      if (current?.size === 0) {
        this.#listenersByRunId.delete(runId);
      }
    };
  }

  publish(runId: string, event: CeoPlanExecutionEvent): void {
    const listeners = this.#listenersByRunId.get(runId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A single failing subscriber must never prevent delivery to the
        // others or crash the caller — same discipline as MessageBus/CeoPlanEventBus.
      }
    }
  }

  subscriberCount(runId: string): number {
    return this.#listenersByRunId.get(runId)?.size ?? 0;
  }
}
