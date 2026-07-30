import { describe, expect, it } from "vitest";
import {
  canonicalCeoPlanContent,
  ceoApprovalSchema,
  ceoPlanEventSchema,
  ceoPlanVersionSchema,
  MAX_CEO_PLAN_STEPS,
  parseCeoApproval,
  parseCeoPlanVersion,
  type CeoPlanContentInput,
} from "./ceo-plan.js";
import { ProtocolValidationError } from "./errors.js";

const HASH_A = "a".repeat(64);

function step(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "step-1",
    position: 0,
    title: "Investigate the failing test",
    objective: "Understand why the suite fails on main.",
    boundedInstructions: "Run the suite locally and read the stack trace.",
    acceptanceCriteria: ["Root cause identified and written down."],
    dependencies: [],
    routingSummary: "No adapter recommendation yet.",
    ...overrides,
  };
}

function version(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    planId: "plan-1",
    version: 1,
    objective: "Fix the failing suite.",
    summary: "One step: investigate the failure.",
    assumptions: [],
    constraints: [],
    steps: [step()],
    createdAt: "2026-07-15T12:00:00.000Z",
    createdBy: "ceo_planner" as const,
    contentHash: HASH_A,
    ...overrides,
  };
}

describe("ceoPlanVersionSchema", () => {
  it("accepts a valid, minimal single-step plan version", () => {
    expect(() => parseCeoPlanVersion(version())).not.toThrow();
  });

  it("rejects an invalid status on a full plan object shape via ceoPlanSchema-adjacent field", () => {
    const result = ceoPlanVersionSchema.safeParse(version({ version: 0 }));
    expect(result.success).toBe(false);
  });

  it("rejects duplicate step ids", () => {
    const v = version({
      steps: [step({ id: "dup", position: 0 }), step({ id: "dup", position: 1 })],
    });
    const result = ceoPlanVersionSchema.safeParse(v);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("duplicate step id");
  });

  it("rejects duplicate step positions", () => {
    const v = version({
      steps: [step({ id: "a", position: 0 }), step({ id: "b", position: 0 })],
    });
    const result = ceoPlanVersionSchema.safeParse(v);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("duplicate step position");
  });

  it("rejects an unknown dependency id", () => {
    const v = version({ steps: [step({ dependencies: ["ghost"] })] });
    const result = ceoPlanVersionSchema.safeParse(v);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("unknown dependency");
  });

  it("rejects a self-dependency", () => {
    const v = version({ steps: [step({ id: "a", dependencies: ["a"] })] });
    const result = ceoPlanVersionSchema.safeParse(v);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("must not depend on itself");
  });

  it("rejects a duplicate dependency entry within one step", () => {
    const v = version({
      steps: [
        step({ id: "a", position: 0 }),
        step({ id: "b", position: 1, dependencies: ["a", "a"] }),
      ],
    });
    const result = ceoPlanVersionSchema.safeParse(v);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("duplicate dependency");
  });

  it("rejects a two-step dependency cycle", () => {
    const v = version({
      steps: [
        step({ id: "a", position: 0, dependencies: ["b"] }),
        step({ id: "b", position: 1, dependencies: ["a"] }),
      ],
    });
    const result = ceoPlanVersionSchema.safeParse(v);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("dependency cycle");
  });

  it("rejects a longer transitive dependency cycle (a -> b -> c -> a)", () => {
    const v = version({
      steps: [
        step({ id: "a", position: 0, dependencies: ["c"] }),
        step({ id: "b", position: 1, dependencies: ["a"] }),
        step({ id: "c", position: 2, dependencies: ["b"] }),
      ],
    });
    const result = ceoPlanVersionSchema.safeParse(v);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("dependency cycle");
  });

  it("accepts a valid, acyclic dependency chain", () => {
    const v = version({
      steps: [
        step({ id: "a", position: 0 }),
        step({ id: "b", position: 1, dependencies: ["a"] }),
        step({ id: "c", position: 2, dependencies: ["a", "b"] }),
      ],
    });
    expect(() => parseCeoPlanVersion(v)).not.toThrow();
  });

  it("rejects more than the maximum number of steps", () => {
    const steps = Array.from({ length: MAX_CEO_PLAN_STEPS + 1 }, (_, i) =>
      step({ id: `s${String(i)}`, position: i }),
    );
    const result = ceoPlanVersionSchema.safeParse(version({ steps }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("must not exceed 20 steps");
  });

  it("rejects an over-long step title", () => {
    const v = version({ steps: [step({ title: "x".repeat(201) })] });
    expect(() => parseCeoPlanVersion(v)).toThrow(ProtocolValidationError);
  });

  it("rejects an over-long step objective/instructions", () => {
    const v = version({ steps: [step({ objective: "x".repeat(2001) })] });
    expect(() => parseCeoPlanVersion(v)).toThrow(ProtocolValidationError);
  });

  it("rejects more than 20 acceptance criteria on one step", () => {
    const acceptanceCriteria = Array.from({ length: 21 }, (_, i) => `criterion ${String(i)}`);
    const v = version({ steps: [step({ acceptanceCriteria })] });
    expect(() => parseCeoPlanVersion(v)).toThrow(ProtocolValidationError);
  });

  it("rejects more than 20 dependencies on one step", () => {
    const others = Array.from({ length: 21 }, (_, i) =>
      step({ id: `d${String(i)}`, position: i + 1 }),
    );
    const dependencies = others.map((s) => s.id);
    const v = version({ steps: [step({ id: "main", position: 0, dependencies }), ...others] });
    const result = ceoPlanVersionSchema.safeParse(v);
    expect(result.success).toBe(false);
  });

  it("rejects an invalid capability requirement", () => {
    const v = version({
      steps: [
        step({
          requirements: {
            requiredCapabilities: ["not.a.real.capability"],
            allowedExecutionTrust: ["isolated"],
          },
        }),
      ],
    });
    expect(() => parseCeoPlanVersion(v)).toThrow(ProtocolValidationError);
  });

  it("rejects an invalid execution trust value in requirements", () => {
    const v = version({
      steps: [
        step({ requirements: { requiredCapabilities: [], allowedExecutionTrust: ["nonsense"] } }),
      ],
    });
    expect(() => parseCeoPlanVersion(v)).toThrow(ProtocolValidationError);
  });

  it("rejects an invalid content-hash representation (wrong length, uppercase, non-hex)", () => {
    expect(() => parseCeoPlanVersion(version({ contentHash: "not-a-hash" }))).toThrow(
      ProtocolValidationError,
    );
    expect(() => parseCeoPlanVersion(version({ contentHash: HASH_A.toUpperCase() }))).toThrow(
      ProtocolValidationError,
    );
    expect(() => parseCeoPlanVersion(version({ contentHash: HASH_A.slice(0, 63) }))).toThrow(
      ProtocolValidationError,
    );
  });

  it("rejects an internal revision field on the public schema (strict unknown-field rejection)", () => {
    expect(() => parseCeoPlanVersion({ ...version(), internalRevision: 3 })).toThrow(
      ProtocolValidationError,
    );
  });

  it("rejects any other unknown field (strict unknown-field rejection)", () => {
    expect(() => parseCeoPlanVersion({ ...version(), extra: "nope" })).toThrow(
      ProtocolValidationError,
    );
    expect(() =>
      parseCeoPlanVersion(version({ steps: [step({ dataDir: "/should/not/exist" })] })),
    ).toThrow(ProtocolValidationError);
  });
});

describe("ceoApprovalSchema", () => {
  const validApproval = {
    planId: "plan-1",
    planVersion: 1,
    decision: "approve" as const,
    decidedAt: "2026-07-15T12:00:00.000Z",
    contentHash: HASH_A,
  };

  it("accepts a valid approval", () => {
    expect(() => parseCeoApproval(validApproval)).not.toThrow();
  });

  it("accepts a valid rejection with an operator note", () => {
    expect(() =>
      parseCeoApproval({
        ...validApproval,
        decision: "reject",
        operatorNote: "Needs another step.",
      }),
    ).not.toThrow();
  });

  it("rejects an invalid decision value", () => {
    const result = ceoApprovalSchema.safeParse({ ...validApproval, decision: "maybe" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid version number (zero or negative)", () => {
    expect(ceoApprovalSchema.safeParse({ ...validApproval, planVersion: 0 }).success).toBe(false);
    expect(ceoApprovalSchema.safeParse({ ...validApproval, planVersion: -1 }).success).toBe(false);
  });

  it("rejects an invalid content-hash representation", () => {
    expect(ceoApprovalSchema.safeParse({ ...validApproval, contentHash: "abc" }).success).toBe(
      false,
    );
  });

  it("never contains an internal revision or any unknown field (strict)", () => {
    expect(ceoApprovalSchema.safeParse({ ...validApproval, internalRevision: 1 }).success).toBe(
      false,
    );
  });
});

describe("ceoPlanEventSchema", () => {
  const validEvent = {
    planId: "plan-1",
    sequence: 0,
    type: "ceo.plan.created" as const,
    payload: { stepCount: 3 },
    timestamp: "2026-07-15T12:00:00.000Z",
  };

  it("accepts a valid event", () => {
    expect(ceoPlanEventSchema.safeParse(validEvent).success).toBe(true);
  });

  it("rejects an unknown event type", () => {
    const result = ceoPlanEventSchema.safeParse({ ...validEvent, type: "ceo.plan.exploded" });
    expect(result.success).toBe(false);
  });

  it("rejects a negative sequence", () => {
    expect(ceoPlanEventSchema.safeParse({ ...validEvent, sequence: -1 }).success).toBe(false);
  });

  it("rejects an unbounded/oversized payload", () => {
    const payload = Object.fromEntries(
      Array.from({ length: 26 }, (_, i) => [`k${String(i)}`, "v"]),
    );
    expect(ceoPlanEventSchema.safeParse({ ...validEvent, payload }).success).toBe(false);
  });

  it("never contains a filesystem path or owner-token-shaped field (strict, no such field exists)", () => {
    const result = ceoPlanEventSchema.safeParse({ ...validEvent, dataDir: "/tmp/whatever" });
    expect(result.success).toBe(false);
  });
});

describe("canonicalCeoPlanContent", () => {
  const base: CeoPlanContentInput = {
    objective: "Fix the bug",
    summary: "One step",
    assumptions: [],
    constraints: [],
    steps: [
      {
        id: "s1",
        position: 0,
        title: "Investigate",
        objective: "Find root cause",
        boundedInstructions: "Read logs",
        acceptanceCriteria: ["Root cause documented"],
        dependencies: [],
        routingSummary: "n/a",
      },
    ],
  };

  it("produces the same string for logically identical content regardless of key order", () => {
    const reordered = {
      steps: base.steps,
      constraints: base.constraints,
      assumptions: base.assumptions,
      summary: base.summary,
      objective: base.objective,
    };
    expect(canonicalCeoPlanContent(base)).toBe(canonicalCeoPlanContent(reordered));
  });

  it("produces a different string when any step field changes", () => {
    const changed: CeoPlanContentInput = {
      objective: base.objective,
      summary: base.summary,
      assumptions: base.assumptions,
      constraints: base.constraints,
      steps: [
        {
          id: "s1",
          position: 0,
          title: "Investigate",
          objective: "Find root cause",
          boundedInstructions: "Read logs and check CI",
          acceptanceCriteria: ["Root cause documented"],
          dependencies: [],
          routingSummary: "n/a",
        },
      ],
    };
    expect(canonicalCeoPlanContent(base)).not.toBe(canonicalCeoPlanContent(changed));
  });

  it("produces a different string when the selected adapter changes", () => {
    function withSelectedAdapter(selectedAdapterId: string): CeoPlanContentInput {
      return {
        objective: base.objective,
        summary: base.summary,
        assumptions: base.assumptions,
        constraints: base.constraints,
        steps: [
          {
            id: "s1",
            position: 0,
            title: "Investigate",
            objective: "Find root cause",
            boundedInstructions: "Read logs",
            acceptanceCriteria: ["Root cause documented"],
            dependencies: [],
            routingSummary: "n/a",
            selectedAdapterId,
          },
        ],
      };
    }
    expect(canonicalCeoPlanContent(withSelectedAdapter("hall.claude-code"))).not.toBe(
      canonicalCeoPlanContent(withSelectedAdapter("hall.codex")),
    );
  });

  it("is stable across repeated calls with the same input (no hidden nondeterminism)", () => {
    expect(canonicalCeoPlanContent(base)).toBe(canonicalCeoPlanContent(base));
  });
});
