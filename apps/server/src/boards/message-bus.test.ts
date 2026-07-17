import { describe, expect, it, vi } from "vitest";
import type { CommunicationMessage } from "@hall-of-wisdom/protocol";
import { MessageBus, MessageSubscriberLimitReachedError } from "./message-bus.js";

function makeMessage(sequence: number): CommunicationMessage {
  return {
    messageId: `msg-${String(sequence)}`,
    boardId: "board-1",
    sequence,
    author: { kind: "human", displayName: "Local Operator" },
    text: "hello",
    createdAt: "2026-07-15T12:00:00.000Z",
  };
}

describe("MessageBus", () => {
  it("delivers a published message to a subscribed listener", () => {
    const bus = new MessageBus({ maxSubscribersPerBoard: 10 });
    const listener = vi.fn();
    bus.subscribe("board-1", listener);
    bus.publish("board-1", makeMessage(0));
    expect(listener).toHaveBeenCalledWith(makeMessage(0));
  });

  it("does not deliver to a listener subscribed to a different board", () => {
    const bus = new MessageBus({ maxSubscribersPerBoard: 10 });
    const listener = vi.fn();
    bus.subscribe("board-2", listener);
    bus.publish("board-1", makeMessage(0));
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops delivering after unsubscribe", () => {
    const bus = new MessageBus({ maxSubscribersPerBoard: 10 });
    const listener = vi.fn();
    const unsubscribe = bus.subscribe("board-1", listener);
    unsubscribe();
    bus.publish("board-1", makeMessage(0));
    expect(listener).not.toHaveBeenCalled();
  });

  it("delivers to multiple subscribers independently", () => {
    const bus = new MessageBus({ maxSubscribersPerBoard: 10 });
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe("board-1", a);
    bus.subscribe("board-1", b);
    bus.publish("board-1", makeMessage(0));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("a throwing listener does not prevent delivery to other listeners or crash publish", () => {
    const bus = new MessageBus({ maxSubscribersPerBoard: 10 });
    const throwing = vi.fn(() => {
      throw new Error("simulated send failure");
    });
    const healthy = vi.fn();
    bus.subscribe("board-1", throwing);
    bus.subscribe("board-1", healthy);
    expect(() => {
      bus.publish("board-1", makeMessage(0));
    }).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it("enforces the configured subscriber limit per board", () => {
    const bus = new MessageBus({ maxSubscribersPerBoard: 2 });
    bus.subscribe("board-1", vi.fn());
    bus.subscribe("board-1", vi.fn());
    expect(() => bus.subscribe("board-1", vi.fn())).toThrow(MessageSubscriberLimitReachedError);
  });

  it("publishing to a board with no subscribers is a safe no-op", () => {
    const bus = new MessageBus({ maxSubscribersPerBoard: 10 });
    expect(() => {
      bus.publish("board-with-nobody-listening", makeMessage(0));
    }).not.toThrow();
  });

  it("reports the current subscriber count", () => {
    const bus = new MessageBus({ maxSubscribersPerBoard: 10 });
    expect(bus.subscriberCount("board-1")).toBe(0);
    const unsubscribe = bus.subscribe("board-1", vi.fn());
    expect(bus.subscriberCount("board-1")).toBe(1);
    unsubscribe();
    expect(bus.subscriberCount("board-1")).toBe(0);
  });
});
