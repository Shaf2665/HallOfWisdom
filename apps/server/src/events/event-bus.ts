import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";

export type EventListener = (event: NormalizedAgentEvent) => void;

export interface EventBusOptions {
  readonly maxSubscribersPerTask: number;
}

export class SubscriberLimitReachedError extends Error {
  constructor(taskId: string, limit: number) {
    super(`Task "${taskId}" has reached its configured subscriber limit (${String(limit)}).`);
    this.name = "SubscriberLimitReachedError";
  }
}

/**
 * Simple per-task pub/sub used to fan a task's live events out to every
 * connected WebSocket. One listener throwing (a send failure, a bug) is
 * caught and logged-nowhere-on-purpose here — the WebSocket route is
 * responsible for its own error handling; `publish` must never let one
 * bad subscriber prevent delivery to the others or crash the caller
 * (`TaskOrchestrator`).
 */
export class EventBus {
  readonly #listenersByTaskId = new Map<string, Set<EventListener>>();
  readonly #maxSubscribersPerTask: number;

  constructor(options: EventBusOptions) {
    this.#maxSubscribersPerTask = options.maxSubscribersPerTask;
  }

  subscribe(taskId: string, listener: EventListener): () => void {
    let listeners = this.#listenersByTaskId.get(taskId);
    if (!listeners) {
      listeners = new Set();
      this.#listenersByTaskId.set(taskId, listeners);
    }
    if (listeners.size >= this.#maxSubscribersPerTask) {
      throw new SubscriberLimitReachedError(taskId, this.#maxSubscribersPerTask);
    }
    listeners.add(listener);

    return () => {
      const current = this.#listenersByTaskId.get(taskId);
      current?.delete(listener);
      if (current?.size === 0) {
        this.#listenersByTaskId.delete(taskId);
      }
    };
  }

  publish(taskId: string, event: NormalizedAgentEvent): void {
    const listeners = this.#listenersByTaskId.get(taskId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A single failing subscriber (e.g. a socket mid-close) must not
        // prevent delivery to the others or crash task execution.
      }
    }
  }

  subscriberCount(taskId: string): number {
    return this.#listenersByTaskId.get(taskId)?.size ?? 0;
  }
}
