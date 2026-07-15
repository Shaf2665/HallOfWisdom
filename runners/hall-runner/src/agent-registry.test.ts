import { describe, expect, it } from "vitest";
import type { AgentAdapter } from "@hall-of-wisdom/agent-adapter-sdk";
import { AgentRegistry } from "./agent-registry.js";
import { DuplicateAdapterError, UnknownAdapterError } from "./errors.js";
import { FakeAdapter } from "./test-support.js";

describe("AgentRegistry", () => {
  it("registers and resolves an adapter by adapterId", () => {
    const registry = new AgentRegistry();
    const adapter = new FakeAdapter({ adapterId: "hall.fake-agent" });
    registry.register(adapter);
    expect(registry.resolve("hall.fake-agent")).toBe(adapter);
  });

  it("lists descriptors for every registered adapter", () => {
    const registry = new AgentRegistry();
    registry.register(new FakeAdapter({ adapterId: "hall.fake-agent-a" }));
    registry.register(new FakeAdapter({ adapterId: "hall.fake-agent-b" }));
    const ids = registry.listDescriptors().map((descriptor) => descriptor.adapterId);
    expect(ids.sort()).toEqual(["hall.fake-agent-a", "hall.fake-agent-b"]);
  });

  it("rejects registering a duplicate adapterId", () => {
    const registry = new AgentRegistry();
    registry.register(new FakeAdapter({ adapterId: "hall.fake-agent" }));
    expect(() => {
      registry.register(new FakeAdapter({ adapterId: "hall.fake-agent" }));
    }).toThrow(DuplicateAdapterError);
  });

  it("rejects resolving an unknown adapterId", () => {
    const registry = new AgentRegistry();
    expect(() => registry.resolve("hall.nonexistent")).toThrow(UnknownAdapterError);
  });

  it("stores and returns adapters strictly through the AgentAdapter interface", () => {
    const registry = new AgentRegistry();
    const adapter: AgentAdapter = new FakeAdapter({ adapterId: "hall.fake-agent" });
    registry.register(adapter);
    const resolved: AgentAdapter = registry.resolve("hall.fake-agent");
    expect(typeof resolved.detect).toBe("function");
    expect(typeof resolved.startTask).toBe("function");
    expect(resolved.descriptor.adapterId).toBe("hall.fake-agent");
  });
});
