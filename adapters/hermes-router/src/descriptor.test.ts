import { describe, expect, it } from "vitest";
import { hermesRouterDescriptor, HERMES_RUNTIME_CAPABILITIES } from "./descriptor.js";

describe("hermesRouterDescriptor", () => {
  it("declares the Hermes runtime identity and integration contract", () => {
    expect(hermesRouterDescriptor).toMatchObject({
      adapterId: "hall.hermes-router",
      displayName: "Hermes Router",
      adapterVersion: "0.1.0",
      supportedAgent: {
        agentId: "hermes-router",
        displayName: "Hermes Coding Runtime",
        adapterId: "hall.hermes-router",
        adapterVersion: "0.1.0",
      },
      integrationLevel: "structured_cli",
      supportedOperatingSystems: ["windows", "macos", "linux"],
      capabilities: {
        streaming: true,
        cancellation: true,
        sessionResume: false,
        toolEvents: true,
        fileEditing: true,
        shellExecution: true,
        subagents: false,
        mcp: false,
        acp: false,
      },
    });
    expect(hermesRouterDescriptor.declaredCapabilities).toEqual(HERMES_RUNTIME_CAPABILITIES);
  });

  it("does not advertise git inspection or session resumption", () => {
    expect(hermesRouterDescriptor.declaredCapabilities).not.toContain("git.inspect");
    expect(hermesRouterDescriptor.declaredCapabilities).not.toContain("session.resume");
    expect(hermesRouterDescriptor.capabilities.sessionResume).toBe(false);
  });
});
