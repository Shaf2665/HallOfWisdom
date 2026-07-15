import { describe, expect, it } from "vitest";
import { mockAgentConfigSchema, parseMockAgentConfig } from "./config.js";

describe("mockAgentConfigSchema", () => {
  it("applies sensible defaults for an empty configuration", () => {
    const config = parseMockAgentConfig({});
    expect(config).toEqual({
      scenario: "success",
      progressMessageCount: 2,
      stepDelayMs: 0,
      failureRetryable: false,
    });
  });

  it("accepts a fully specified configuration", () => {
    const config = parseMockAgentConfig({
      scenario: "failure",
      progressMessageCount: 1,
      stepDelayMs: 5,
      failureRetryable: true,
      completionSummary: "n/a for failure",
    });
    expect(config.scenario).toBe("failure");
    expect(config.failureRetryable).toBe(true);
  });

  it("rejects an invalid scenario value", () => {
    expect(() => parseMockAgentConfig({ scenario: "sabotage" })).toThrow();
  });

  it("rejects a negative progressMessageCount", () => {
    expect(mockAgentConfigSchema.safeParse({ progressMessageCount: -1 }).success).toBe(false);
  });

  it("rejects a progressMessageCount above the bound", () => {
    expect(mockAgentConfigSchema.safeParse({ progressMessageCount: 21 }).success).toBe(false);
  });

  it("rejects a stepDelayMs above the bound", () => {
    expect(mockAgentConfigSchema.safeParse({ stepDelayMs: 5001 }).success).toBe(false);
  });

  it("rejects an excessively long completionSummary", () => {
    expect(mockAgentConfigSchema.safeParse({ completionSummary: "x".repeat(2001) }).success).toBe(
      false,
    );
  });

  it("rejects unexpected fields at this strict validation boundary", () => {
    expect(mockAgentConfigSchema.safeParse({ unexpectedField: true }).success).toBe(false);
  });
});
