import { describe, expect, it } from "vitest";
import { agentAdapterDescriptorSchema, parseAgentAdapterDescriptor } from "./descriptor.js";

const validDescriptor = {
  adapterId: "hall.mock-agent",
  displayName: "Mock Agent",
  adapterVersion: "0.1.0",
  supportedAgent: {
    agentId: "mock-agent",
    displayName: "Mock Agent",
    adapterId: "hall.mock-agent",
    adapterVersion: "0.1.0",
  },
  capabilities: {
    streaming: true,
    cancellation: true,
    sessionResume: false,
    toolEvents: true,
    fileEditing: false,
    shellExecution: false,
    subagents: false,
    mcp: false,
    acp: false,
  },
  integrationLevel: "native" as const,
  supportedOperatingSystems: ["windows", "macos", "linux"] as const,
};

describe("agentAdapterDescriptorSchema", () => {
  it("accepts a valid descriptor", () => {
    expect(parseAgentAdapterDescriptor(validDescriptor)).toEqual(validDescriptor);
  });

  it("rejects an invalid integration level", () => {
    const result = agentAdapterDescriptorSchema.safeParse({
      ...validDescriptor,
      integrationLevel: "telepathic",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty supportedOperatingSystems array", () => {
    const result = agentAdapterDescriptorSchema.safeParse({
      ...validDescriptor,
      supportedOperatingSystems: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a duplicated operating system entry", () => {
    const result = agentAdapterDescriptorSchema.safeParse({
      ...validDescriptor,
      supportedOperatingSystems: ["windows", "windows"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unexpected fields at this strict validation boundary", () => {
    const result = agentAdapterDescriptorSchema.safeParse({
      ...validDescriptor,
      unexpectedField: "nope",
    });
    expect(result.success).toBe(false);
  });
});
