import { describe, expect, it } from "vitest";
import {
  capabilityIdSchema,
  capabilityObservationSchema,
  parseCapabilityObservation,
  parseTaskRequirements,
  taskRequirementsSchema,
} from "./capability.js";
import { ProtocolValidationError } from "./errors.js";

describe("capabilityIdSchema", () => {
  it("accepts every documented capability id", () => {
    const ids = [
      "project.read",
      "project.edit",
      "command.execute",
      "git.inspect",
      "structured.events",
      "cancellation",
      "session.resume",
      "network.access",
    ];
    for (const id of ids) {
      expect(capabilityIdSchema.safeParse(id).success).toBe(true);
    }
  });

  it("rejects a provider-named capability id", () => {
    expect(capabilityIdSchema.safeParse("codex.edit").success).toBe(false);
  });

  it("rejects an unknown capability id", () => {
    expect(capabilityIdSchema.safeParse("project.delete").success).toBe(false);
  });
});

const validObservation = {
  capability: "project.edit" as const,
  status: "verified" as const,
  safeSummary: "Verified through an isolated fixture edit.",
  evidence: "isolated_smoke_test" as const,
};

describe("capabilityObservationSchema", () => {
  it("accepts a valid observation", () => {
    expect(parseCapabilityObservation(validObservation)).toEqual(validObservation);
  });

  it("rejects an unknown status", () => {
    const result = capabilityObservationSchema.safeParse({
      ...validObservation,
      status: "confirmed",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown evidence category", () => {
    const result = capabilityObservationSchema.safeParse({
      ...validObservation,
      evidence: "operator_said_so",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty safeSummary", () => {
    const result = capabilityObservationSchema.safeParse({ ...validObservation, safeSummary: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an oversized safeSummary", () => {
    const result = capabilityObservationSchema.safeParse({
      ...validObservation,
      safeSummary: "x".repeat(301),
    });
    expect(result.success).toBe(false);
  });

  it("rejects unexpected fields at this strict boundary", () => {
    const result = capabilityObservationSchema.safeParse({
      ...validObservation,
      executablePath: "/bin/x",
    });
    expect(result.success).toBe(false);
  });

  it("throws ProtocolValidationError via parseCapabilityObservation on invalid input", () => {
    expect(() => parseCapabilityObservation({ ...validObservation, status: "bogus" })).toThrow(
      ProtocolValidationError,
    );
  });
});

const validRequirements = {
  requiredCapabilities: ["project.read", "project.edit", "structured.events"],
  allowedExecutionTrust: ["isolated"],
};

describe("taskRequirementsSchema", () => {
  it("accepts valid requirements", () => {
    expect(parseTaskRequirements(validRequirements)).toEqual(validRequirements);
  });

  it("accepts an empty requiredCapabilities array", () => {
    const result = taskRequirementsSchema.safeParse({
      requiredCapabilities: [],
      allowedExecutionTrust: ["simulated"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a requiredCapabilities array with a duplicate entry", () => {
    const result = taskRequirementsSchema.safeParse({
      requiredCapabilities: ["project.edit", "project.edit"],
      allowedExecutionTrust: ["isolated"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an allowedExecutionTrust array with a duplicate entry", () => {
    const result = taskRequirementsSchema.safeParse({
      requiredCapabilities: [],
      allowedExecutionTrust: ["isolated", "isolated"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty allowedExecutionTrust array — at least one trust level must be allowed", () => {
    const result = taskRequirementsSchema.safeParse({
      requiredCapabilities: [],
      allowedExecutionTrust: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown execution trust value", () => {
    const result = taskRequirementsSchema.safeParse({
      requiredCapabilities: [],
      allowedExecutionTrust: ["claude_safe"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unexpected fields at this strict boundary", () => {
    const result = taskRequirementsSchema.safeParse({
      ...validRequirements,
      maximumExecutionTrust: "isolated",
    });
    expect(result.success).toBe(false);
  });
});
