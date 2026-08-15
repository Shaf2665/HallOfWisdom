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

  it("accepts a full Phase 11 result with execution trust, capability observations, and limitations", () => {
    const result = {
      installed: true,
      availability: "available" as const,
      executionTrust: "isolated" as const,
      capabilityObservations: [
        {
          capability: "project.edit" as const,
          status: "verified" as const,
          safeSummary: "Verified through an isolated fixture edit.",
          evidence: "isolated_smoke_test" as const,
        },
      ],
      limitations: ["Runs with --safe-mode; some interactive features are disabled."],
    };
    expect(parseAgentDetectionResult(result)).toEqual(result);
  });

  it("rejects an invalid execution trust value", () => {
    const result = agentDetectionResultSchema.safeParse({
      installed: true,
      availability: "available",
      executionTrust: "codex_bypass",
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than 9 capability observations", () => {
    const observations = Array.from({ length: 10 }, () => ({
      capability: "structured.events" as const,
      status: "verified" as const,
      safeSummary: "Verified.",
      evidence: "deterministic_test" as const,
    }));
    const result = agentDetectionResultSchema.safeParse({
      installed: true,
      availability: "available",
      capabilityObservations: observations,
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than 6 limitations", () => {
    const result = agentDetectionResultSchema.safeParse({
      installed: true,
      availability: "available",
      limitations: Array.from({ length: 7 }, (_, index) => `Limitation ${String(index)}.`),
    });
    expect(result.success).toBe(false);
  });
});
