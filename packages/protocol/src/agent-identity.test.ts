import { describe, expect, it } from "vitest";
import { agentIdentitySchema, parseAgentIdentity } from "./agent-identity.js";
import { ProtocolValidationError } from "./errors.js";

const validIdentity = {
  agentId: "agent-claude-1",
  displayName: "Claude Code",
  adapterId: "claude-code",
  adapterVersion: "1.2.3",
  provider: "Anthropic",
};

describe("agentIdentitySchema", () => {
  it("accepts a valid agent identity", () => {
    expect(parseAgentIdentity(validIdentity)).toEqual(validIdentity);
  });

  it("accepts a valid identity without the optional provider field", () => {
    const { provider: _provider, ...withoutProvider } = validIdentity;
    expect(parseAgentIdentity(withoutProvider)).toEqual(withoutProvider);
  });

  it("rejects a missing required identifier", () => {
    const { agentId: _agentId, ...missingAgentId } = validIdentity;
    expect(() => parseAgentIdentity(missingAgentId)).toThrow(ProtocolValidationError);
  });

  it("rejects unexpected fields at this strict validation boundary", () => {
    const result = agentIdentitySchema.safeParse({
      ...validIdentity,
      unexpectedField: "should not be accepted",
    });
    expect(result.success).toBe(false);
  });
});
