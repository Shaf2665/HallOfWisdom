import { describe, expect, it } from "vitest";
import { agentCapabilitiesSchema } from "./agent-capabilities.js";

const validCapabilities = {
  streaming: true,
  cancellation: true,
  sessionResume: false,
  toolEvents: true,
  fileEditing: true,
  shellExecution: false,
  subagents: false,
  mcp: false,
  acp: false,
};

describe("agentCapabilitiesSchema", () => {
  it("accepts a valid capability set", () => {
    expect(agentCapabilitiesSchema.safeParse(validCapabilities).success).toBe(true);
  });

  it("rejects a missing capability rather than assuming a default", () => {
    const { mcp: _mcp, ...missingMcp } = validCapabilities;
    expect(agentCapabilitiesSchema.safeParse(missingMcp).success).toBe(false);
  });
});
