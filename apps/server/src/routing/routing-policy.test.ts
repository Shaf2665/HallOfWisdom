import { describe, expect, it } from "vitest";
import type {
  CapabilityId,
  CapabilityObservation,
  TaskRequirements,
} from "@hall-of-wisdom/protocol";
import { evaluateRouting, type RoutingCandidateInput } from "./routing-policy.js";

function observation(
  capability: CapabilityId,
  status: CapabilityObservation["status"],
): CapabilityObservation {
  return {
    capability,
    status,
    safeSummary: `${capability}: ${status}.`,
    evidence: "deterministic_test",
  };
}

const REAL_EDITING_CAPABILITIES: CapabilityId[] = [
  "project.read",
  "project.edit",
  "structured.events",
  "cancellation",
];

function claudeCode(overrides: Partial<RoutingCandidateInput> = {}): RoutingCandidateInput {
  return {
    adapterId: "hall.claude-code",
    displayName: "Claude Code",
    integrationLevel: "structured_cli",
    availability: "available",
    executionTrust: "isolated",
    capabilityObservations: REAL_EDITING_CAPABILITIES.map((c) => observation(c, "verified")),
    ...overrides,
  };
}

function codexTrustedLocal(overrides: Partial<RoutingCandidateInput> = {}): RoutingCandidateInput {
  return {
    adapterId: "hall.codex",
    displayName: "Codex",
    integrationLevel: "structured_cli",
    availability: "available",
    executionTrust: "trusted_local",
    capabilityObservations: REAL_EDITING_CAPABILITIES.map((c) => observation(c, "verified")),
    ...overrides,
  };
}

function mockAgent(overrides: Partial<RoutingCandidateInput> = {}): RoutingCandidateInput {
  return {
    adapterId: "hall.mock-agent",
    displayName: "Mock Agent",
    integrationLevel: "native",
    availability: "available",
    executionTrust: "simulated",
    capabilityObservations: [
      observation("structured.events", "verified"),
      observation("cancellation", "verified"),
    ],
    ...overrides,
  };
}

const ISOLATED_ONLY: TaskRequirements = {
  requiredCapabilities: ["project.read", "project.edit", "structured.events"],
  allowedExecutionTrust: ["isolated"],
};

const ISOLATED_OR_TRUSTED_LOCAL: TaskRequirements = {
  requiredCapabilities: ["project.read", "project.edit", "structured.events"],
  allowedExecutionTrust: ["isolated", "trusted_local"],
};

const SIMULATION_ONLY: TaskRequirements = {
  requiredCapabilities: ["structured.events"],
  allowedExecutionTrust: ["simulated"],
};

describe("evaluateRouting — eligibility gate", () => {
  it("excludes an adapter whose availability is not 'available'", () => {
    const result = evaluateRouting(ISOLATED_ONLY, [claudeCode({ availability: "unsupported" })]);
    expect(result.candidates[0]?.assignable).toBe(false);
    expect(result.recommendedAdapterId).toBeUndefined();
  });

  it("excludes an adapter missing a required capability entirely", () => {
    const result = evaluateRouting(ISOLATED_ONLY, [
      claudeCode({ capabilityObservations: [observation("structured.events", "verified")] }),
    ]);
    expect(result.candidates[0]?.missingCapabilities).toContain("project.edit");
    expect(result.recommendedAdapterId).toBeUndefined();
  });

  it("excludes an adapter whose required capability is only 'declared', not verified", () => {
    const result = evaluateRouting(ISOLATED_ONLY, [
      claudeCode({
        capabilityObservations: [
          observation("project.read", "verified"),
          observation("project.edit", "declared"),
          observation("structured.events", "verified"),
        ],
      }),
    ]);
    expect(result.candidates[0]?.missingCapabilities).toEqual(["project.edit"]);
    expect(result.recommendedAdapterId).toBeUndefined();
  });

  it("excludes an adapter whose required capability is 'restricted'", () => {
    const result = evaluateRouting(ISOLATED_ONLY, [
      claudeCode({
        capabilityObservations: [
          observation("project.read", "verified"),
          observation("project.edit", "restricted"),
          observation("structured.events", "verified"),
        ],
      }),
    ]);
    expect(result.candidates[0]?.restrictedCapabilities).toEqual(["project.edit"]);
    expect(result.recommendedAdapterId).toBeUndefined();
  });

  it("excludes an adapter whose execution trust is not in the allowed list", () => {
    const result = evaluateRouting(ISOLATED_ONLY, [codexTrustedLocal()]);
    expect(result.candidates[0]?.trustAllowed).toBe(false);
    expect(result.recommendedAdapterId).toBeUndefined();
  });

  it("excludes Mock Agent from a real-implementation task without special-casing its adapterId — it simply never verifies project.edit", () => {
    const result = evaluateRouting(ISOLATED_OR_TRUSTED_LOCAL, [mockAgent()]);
    expect(result.candidates[0]?.missingCapabilities).toContain("project.edit");
    expect(result.recommendedAdapterId).toBeUndefined();
  });

  it("excludes Mock Agent from any task that does not allow 'simulated' trust, even with a matching capability set", () => {
    const result = evaluateRouting(
      { requiredCapabilities: ["structured.events"], allowedExecutionTrust: ["isolated"] },
      [mockAgent()],
    );
    expect(result.candidates[0]?.trustAllowed).toBe(false);
    expect(result.recommendedAdapterId).toBeUndefined();
  });

  it("recommends Mock Agent for a simulation-only task", () => {
    const result = evaluateRouting(SIMULATION_ONLY, [mockAgent()]);
    expect(result.recommendedAdapterId).toBe("hall.mock-agent");
  });

  it("an empty requiredCapabilities list still requires trust to match", () => {
    const result = evaluateRouting(
      { requiredCapabilities: [], allowedExecutionTrust: ["isolated"] },
      [mockAgent()],
    );
    expect(result.recommendedAdapterId).toBeUndefined();
  });
});

describe("evaluateRouting — worked examples from the kickoff", () => {
  it("isolated-only implementation task: Claude recommended, Codex and Mock excluded", () => {
    const result = evaluateRouting(ISOLATED_ONLY, [claudeCode(), codexTrustedLocal(), mockAgent()]);
    expect(result.recommendedAdapterId).toBe("hall.claude-code");
    const codex = result.candidates.find((c) => c.adapterId === "hall.codex");
    const mock = result.candidates.find((c) => c.adapterId === "hall.mock-agent");
    expect(codex?.rank).toBeUndefined();
    expect(mock?.rank).toBeUndefined();
  });

  it("trusted-local-allowed implementation task: Claude ranked first (safer trust), Codex a secondary candidate, Mock excluded", () => {
    const result = evaluateRouting(ISOLATED_OR_TRUSTED_LOCAL, [
      claudeCode(),
      codexTrustedLocal(),
      mockAgent(),
    ]);
    expect(result.recommendedAdapterId).toBe("hall.claude-code");
    const claude = result.candidates.find((c) => c.adapterId === "hall.claude-code");
    const codex = result.candidates.find((c) => c.adapterId === "hall.codex");
    const mock = result.candidates.find((c) => c.adapterId === "hall.mock-agent");
    expect(claude?.rank).toBe(1);
    expect(codex?.rank).toBe(2);
    expect(mock?.rank).toBeUndefined();
  });

  it("simulation task: Mock recommended, real providers excluded since simulated is the only allowed trust", () => {
    const result = evaluateRouting(SIMULATION_ONLY, [
      claudeCode(),
      codexTrustedLocal(),
      mockAgent(),
    ]);
    expect(result.recommendedAdapterId).toBe("hall.mock-agent");
  });

  it("if no adapter qualifies, returns no recommendation and a non-empty explanation, never lowering requirements", () => {
    const result = evaluateRouting(ISOLATED_ONLY, [codexTrustedLocal(), mockAgent()]);
    expect(result.recommendedAdapterId).toBeUndefined();
    expect(result.explanation.length).toBeGreaterThan(0);
    expect(result.explanation).not.toContain("hall.codex");
  });
});

describe("evaluateRouting — determinism and no hidden preference", () => {
  it("produces identical output for the same input across repeated calls", () => {
    const candidates = [claudeCode(), codexTrustedLocal(), mockAgent()];
    const first = evaluateRouting(ISOLATED_OR_TRUSTED_LOCAL, candidates);
    const second = evaluateRouting(ISOLATED_OR_TRUSTED_LOCAL, candidates);
    expect(second).toEqual(first);
  });

  it("never mutates the requirements object passed in", () => {
    const requirements: TaskRequirements = {
      requiredCapabilities: ["project.edit"],
      allowedExecutionTrust: ["isolated"],
    };
    const frozen = structuredClone(requirements);
    evaluateRouting(requirements, [claudeCode()]);
    expect(requirements).toEqual(frozen);
  });

  it("breaks a tie between two equally-eligible, equally-trusted, equally-integrated candidates by adapterId alone", () => {
    const a = claudeCode({ adapterId: "hall.zzz-agent", displayName: "ZZZ Agent" });
    const b = claudeCode({ adapterId: "hall.aaa-agent", displayName: "AAA Agent" });
    const result = evaluateRouting(ISOLATED_ONLY, [a, b]);
    expect(result.recommendedAdapterId).toBe("hall.aaa-agent");
  });

  it("ranks by trust safety (isolated before trusted_local) even when adapterId ordering would suggest otherwise", () => {
    const isolatedButLastAlphabetically = claudeCode({ adapterId: "hall.zzz-isolated" });
    const trustedLocalButFirstAlphabetically = codexTrustedLocal({
      adapterId: "hall.aaa-trusted-local",
    });
    const result = evaluateRouting(ISOLATED_OR_TRUSTED_LOCAL, [
      trustedLocalButFirstAlphabetically,
      isolatedButLastAlphabetically,
    ]);
    expect(result.recommendedAdapterId).toBe("hall.zzz-isolated");
  });

  it("ranking never reads adapterId or provider for anything except the documented final tie-break", () => {
    // Two candidates identical except adapterId — if ranking used adapterId
    // for anything other than the final tie-break, changing displayName
    // alone (unrelated to the documented rules) would change the outcome.
    // It must not.
    const a = claudeCode({ adapterId: "hall.a", displayName: "Totally Different Name" });
    const b = claudeCode({ adapterId: "hall.b" });
    const resultA = evaluateRouting(ISOLATED_ONLY, [a, b]).recommendedAdapterId;
    const resultB = evaluateRouting(ISOLATED_ONLY, [
      { ...a, displayName: "Another Name Entirely" },
      b,
    ]).recommendedAdapterId;
    expect(resultA).toBe(resultB);
  });
});

describe("evaluateRouting — ranking tie-breaks beyond trust", () => {
  it("prefers a deeper integration level (native) over a shallower one (structured_cli) when trust ties", () => {
    const structuredCli = claudeCode({
      adapterId: "hall.structured",
      integrationLevel: "structured_cli",
    });
    const native = claudeCode({ adapterId: "hall.native", integrationLevel: "native" });
    const result = evaluateRouting(ISOLATED_ONLY, [structuredCli, native]);
    expect(result.recommendedAdapterId).toBe("hall.native");
  });

  it("prefers a candidate with verified cancellation over one without, when trust and integration level tie", () => {
    const withoutCancellation = claudeCode({
      adapterId: "hall.no-cancel",
      capabilityObservations: [
        observation("project.read", "verified"),
        observation("project.edit", "verified"),
        observation("structured.events", "verified"),
      ],
    });
    const withCancellation = claudeCode({ adapterId: "hall.with-cancel" });
    const result = evaluateRouting(ISOLATED_ONLY, [withoutCancellation, withCancellation]);
    expect(result.recommendedAdapterId).toBe("hall.with-cancel");
  });
});

describe("evaluateRouting — candidate shape", () => {
  it("every candidate is returned, including excluded ones, each with a safeReason", () => {
    const result = evaluateRouting(ISOLATED_ONLY, [claudeCode(), codexTrustedLocal(), mockAgent()]);
    expect(result.candidates).toHaveLength(3);
    for (const candidate of result.candidates) {
      expect(candidate.safeReason.length).toBeGreaterThan(0);
    }
  });

  it("safeReason never contains raw provider output — only the fixed template text", () => {
    const result = evaluateRouting(ISOLATED_ONLY, [codexTrustedLocal()]);
    const codex = result.candidates[0];
    expect(codex?.safeReason).not.toContain("codex exec");
    expect(codex?.safeReason).not.toContain("CODEX_HOME");
  });
});
