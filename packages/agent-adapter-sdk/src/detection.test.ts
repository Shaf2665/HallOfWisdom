import { describe, expect, it } from "vitest";
import { agentDetectionResultSchema, parseAgentDetectionResult } from "./detection.js";

describe("agentDetectionResultSchema", () => {
  it("accepts a minimal available result", () => {
    const result = { installed: true, availability: "available" as const };
    expect(parseAgentDetectionResult(result)).toEqual(result);
  });

  it("accepts a full result with executable path, version, and diagnostic message", () => {
    const result = {
      installed: true,
      executablePath: "/usr/local/bin/mock-agent",
      detectedVersion: "0.1.0",
      availability: "available" as const,
      diagnosticMessage: "Detected via PATH lookup.",
    };
    expect(parseAgentDetectionResult(result)).toEqual(result);
  });

  it("accepts an uninstalled result", () => {
    const result = { installed: false, availability: "unavailable" as const };
    expect(agentDetectionResultSchema.safeParse(result).success).toBe(true);
  });

  it("rejects an invalid availability status", () => {
    const result = agentDetectionResultSchema.safeParse({
      installed: true,
      availability: "napping",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unexpected fields, so a credential-like field cannot be smuggled in", () => {
    const result = agentDetectionResultSchema.safeParse({
      installed: true,
      availability: "available",
      apiKey: "sk-should-not-be-here",
    });
    expect(result.success).toBe(false);
  });
});
