import { describe, expect, it, vi } from "vitest";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { EventBus, SubscriberLimitReachedError } from "./event-bus.js";

function makeEvent(sequence: number): NormalizedAgentEvent {
  return {
    protocolVersion: "0.1",
    eventId: `event-${String(sequence)}`,
    runId: "run-1",
    taskId: "task-1",
    agentId: "mock-agent",
    timestamp: "2026-07-15T12:00:00.000Z",
    sequence,
    type: "message.delta",
    payload: { text: "progress" },
  };
}

describe("EventBus", () => {
  it("delivers a published event to a subscribed listener", () => {
    const bus = new EventBus({ maxSubscribersPerTask: 10 });
    const listener = vi.fn();
    bus.subscribe("task-1", listener);
    bus.publish("task-1", makeEvent(0));
    expect(listener).toHaveBeenCalledWith(makeEvent(0));
  });

  it("does not deliver to a listener subscribed to a different task", () => {
    const bus = new EventBus({ maxSubscribersPerTask: 10 });
    const listener = vi.fn();
    bus.subscribe("task-2", listener);
    bus.publish("task-1", makeEvent(0));
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops delivering after unsubscribe", () => {
    const bus = new EventBus({ maxSubscribersPerTask: 10 });
    const listener = vi.fn();
    const unsubscribe = bus.subscribe("task-1", listener);
    unsubscribe();
    bus.publish("task-1", makeEvent(0));
    expect(listener).not.toHaveBeenCalled();
  });

  it("delivers to multiple subscribers independently", () => {
    const bus = new EventBus({ maxSubscribersPerTask: 10 });
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe("task-1", a);
    bus.subscribe("task-1", b);
    bus.publish("task-1", makeEvent(0));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("a throwing listener does not prevent delivery to other listeners or crash publish", () => {
    const bus = new EventBus({ maxSubscribersPerTask: 10 });
    const throwing = vi.fn(() => {
      throw new Error("simulated send failure");
    });
    const healthy = vi.fn();
    bus.subscribe("task-1", throwing);
    bus.subscribe("task-1", healthy);
    expect(() => {
      bus.publish("task-1", makeEvent(0));
    }).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it("enforces the configured subscriber limit per task", () => {
    const bus = new EventBus({ maxSubscribersPerTask: 2 });
    bus.subscribe("task-1", vi.fn());
    bus.subscribe("task-1", vi.fn());
    expect(() => bus.subscribe("task-1", vi.fn())).toThrow(SubscriberLimitReachedError);
  });

  it("publishing to a task with no subscribers is a safe no-op", () => {
    const bus = new EventBus({ maxSubscribersPerTask: 10 });
    expect(() => {
      bus.publish("task-with-nobody-listening", makeEvent(0));
    }).not.toThrow();
  });

  it("reports the current subscriber count", () => {
    const bus = new EventBus({ maxSubscribersPerTask: 10 });
    expect(bus.subscriberCount("task-1")).toBe(0);
    const unsubscribe = bus.subscribe("task-1", vi.fn());
    expect(bus.subscriberCount("task-1")).toBe(1);
    unsubscribe();
    expect(bus.subscriberCount("task-1")).toBe(0);
  });
});
