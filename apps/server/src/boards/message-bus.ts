import type { CommunicationMessage } from "@hall-of-wisdom/protocol";

export type MessageListener = (message: CommunicationMessage) => void;

export interface MessageBusOptions {
  readonly maxSubscribersPerBoard: number;
}

export class MessageSubscriberLimitReachedError extends Error {
  constructor(boardId: string, limit: number) {
    super(`Board "${boardId}" has reached its configured subscriber limit (${String(limit)}).`);
    this.name = "MessageSubscriberLimitReachedError";
  }
}

/**
 * Simple per-board pub/sub used to fan a board's live messages out to every
 * connected WebSocket — the same shape as `events/event-bus.ts`'s
 * `EventBus`, kept as a separate class (not a generic/shared base) so the
 * two domains (agent execution events vs. human discussion messages) never
 * blur into one "generic pub/sub" abstraction that could accidentally let
 * one kind of payload flow through the other's channel.
 */
export class MessageBus {
  readonly #listenersByBoardId = new Map<string, Set<MessageListener>>();
  readonly #maxSubscribersPerBoard: number;

  constructor(options: MessageBusOptions) {
    this.#maxSubscribersPerBoard = options.maxSubscribersPerBoard;
  }

  subscribe(boardId: string, listener: MessageListener): () => void {
    let listeners = this.#listenersByBoardId.get(boardId);
    if (!listeners) {
      listeners = new Set();
      this.#listenersByBoardId.set(boardId, listeners);
    }
    if (listeners.size >= this.#maxSubscribersPerBoard) {
      throw new MessageSubscriberLimitReachedError(boardId, this.#maxSubscribersPerBoard);
    }
    listeners.add(listener);

    return () => {
      const current = this.#listenersByBoardId.get(boardId);
      current?.delete(listener);
      if (current?.size === 0) {
        this.#listenersByBoardId.delete(boardId);
      }
    };
  }

  publish(boardId: string, message: CommunicationMessage): void {
    const listeners = this.#listenersByBoardId.get(boardId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(message);
      } catch {
        // A single failing subscriber (e.g. a socket mid-close) must not
        // prevent delivery to the others or crash the caller (the route
        // handling the POST that triggered this publish).
      }
    }
  }

  subscriberCount(boardId: string): number {
    return this.#listenersByBoardId.get(boardId)?.size ?? 0;
  }
}
