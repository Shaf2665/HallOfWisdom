import { describe, expect, it } from "vitest";
import {
  ceoPlanExecutionEventSchema,
  ceoPlanExecutionInterventionSchema,
  ceoPlanExecutionModeSchema,
  ceoPlanExecutionPolicySchema,
  ceoPlanExecutionSignalSchema,
  ceoPlanRunSchema,
  ceoPlanRunStatusSchema,
  ceoPlanStepAttemptSchema,
  ceoPlanStepExecutionSchema,
  DEFAULT_CEO_PLAN_EXECUTION_POLICY,
  parseCeoPlanExecutionPolicy,
} from "./ceo-execution.js";
import { ProtocolValidationError } from "./errors.js";

const TS = "2026-07-31T12:00:00.000Z";

describe("ceoPlanExecutionPolicySchema", () => {
  it("accepts the documented conservative defaults", () => {
    expect(() => parseCeoPlanExecutionPolicy(DEFAULT_CEO_PLAN_EXECUTION_POLICY)).not.toThrow();
  });

  it("rejects maxConcurrentSteps below the floor", () => {
    const result = ceoPlanExecutionPolicySchema.safeParse({
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      maxConcurrentSteps: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects maxConcurrentSteps above the ceiling", () => {
    const result = ceoPlanExecutionPolicySchema.safeParse({
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      maxConcurrentSteps: 5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects maxAttemptsPerStep out of range", () => {
    expect(
      ceoPlanExecutionPolicySchema.safeParse({
        ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
        maxAttemptsPerStep: 4,
      }).success,
    ).toBe(false);
    expect(
      ceoPlanExecutionPolicySchema.safeParse({
        ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
        maxAttemptsPerStep: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects a negative retryBackoffSeconds", () => {
    const result = ceoPlanExecutionPolicySchema.safeParse({
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      retryBackoffSeconds: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unbounded retryBackoffSeconds", () => {
    const result = ceoPlanExecutionPolicySchema.safeParse({
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      retryBackoffSeconds: 999_999,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unbounded maxPlanElapsedSeconds / maxStepElapsedSeconds", () => {
    expect(
      ceoPlanExecutionPolicySchema.safeParse({
        ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
        maxPlanElapsedSeconds: 999_999_999,
      }).success,
    ).toBe(false);
    expect(
      ceoPlanExecutionPolicySchema.safeParse({
        ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
        maxStepElapsedSeconds: 999_999_999,
      }).success,
    ).toBe(false);
  });

  it("rejects an adapter concurrency override out of the 1-4 bound", () => {
    const result = ceoPlanExecutionPolicySchema.safeParse({
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      adapterConcurrencyOverrides: { "hall.mock-agent": 5 },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a bounded adapter concurrency override", () => {
    const result = ceoPlanExecutionPolicySchema.safeParse({
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      adapterConcurrencyOverrides: { "hall.mock-agent": 2 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown field (.strict())", () => {
    const result = ceoPlanExecutionPolicySchema.safeParse({
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      estimatedCostUsd: 5,
    });
    expect(result.success).toBe(false);
  });

  it("throws ProtocolValidationError, not a raw ZodError, on failure", () => {
    expect(() =>
      parseCeoPlanExecutionPolicy({ ...DEFAULT_CEO_PLAN_EXECUTION_POLICY, maxConcurrentSteps: 0 }),
    ).toThrow(ProtocolValidationError);
  });
});

describe("ceoPlanExecutionModeSchema", () => {
  it("accepts manual and autonomous", () => {
    expect(ceoPlanExecutionModeSchema.safeParse("manual").success).toBe(true);
    expect(ceoPlanExecutionModeSchema.safeParse("autonomous").success).toBe(true);
  });

  it("rejects an invalid execution mode", () => {
    expect(ceoPlanExecutionModeSchema.safeParse("auto").success).toBe(false);
  });
});

describe("ceoPlanRunStatusSchema", () => {
  it("accepts every documented status", () => {
    for (const status of [
      "configured",
      "running",
      "paused",
      "awaiting_intervention",
      "completed",
      "failed",
      "cancelled",
    ]) {
      expect(ceoPlanRunStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it("rejects an invalid run status", () => {
    expect(ceoPlanRunStatusSchema.safeParse("archived").success).toBe(false);
  });
});

function run(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "run-1",
    planId: "plan-1",
    planVersion: 1,
    status: "configured",
    executionMode: "autonomous",
    policySnapshot: DEFAULT_CEO_PLAN_EXECUTION_POLICY,
    createdAt: TS,
    activeGeneration: 0,
    recoveryClassification: "none",
    ...overrides,
  };
}

describe("ceoPlanRunSchema", () => {
  it("accepts a valid minimal run", () => {
    expect(ceoPlanRunSchema.safeParse(run()).success).toBe(true);
  });

  it("rejects an unknown field, including a leaked internal revision", () => {
    expect(ceoPlanRunSchema.safeParse(run({ internalRevision: 3 })).success).toBe(false);
  });

  it("rejects a leaked owner or lease token field", () => {
    expect(ceoPlanRunSchema.safeParse(run({ ownerToken: "x" })).success).toBe(false);
    expect(ceoPlanRunSchema.safeParse(run({ claimLease: "x" })).success).toBe(false);
  });

  it("rejects a leaked absolute/private path field", () => {
    expect(ceoPlanRunSchema.safeParse(run({ dataDir: "C:\\secret" })).success).toBe(false);
  });

  it("rejects a non-positive planVersion", () => {
    expect(ceoPlanRunSchema.safeParse(run({ planVersion: 0 })).success).toBe(false);
  });

  it("rejects a negative activeGeneration", () => {
    expect(ceoPlanRunSchema.safeParse(run({ activeGeneration: -1 })).success).toBe(false);
  });
});

function stepExecution(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    planRunId: "run-1",
    planStepId: "step-1",
    childTaskId: "task-1",
    status: "ready",
    attemptCount: 0,
    dependencySummary: {
      totalDependencies: 0,
      completedDependencies: 0,
      failedDependencies: 0,
      cancelledDependencies: 0,
    },
    readinessReason: "ready",
    ...overrides,
  };
}

describe("ceoPlanStepExecutionSchema", () => {
  it("accepts a valid minimal step execution", () => {
    expect(ceoPlanStepExecutionSchema.safeParse(stepExecution()).success).toBe(true);
  });

  it("rejects an invalid execution status", () => {
    expect(ceoPlanStepExecutionSchema.safeParse(stepExecution({ status: "bogus" })).success).toBe(
      false,
    );
  });

  it("rejects an invalid readiness reason", () => {
    expect(
      ceoPlanStepExecutionSchema.safeParse(stepExecution({ readinessReason: "because" })).success,
    ).toBe(false);
  });

  it("rejects a second, independently-mutable status field shadowing the task status", () => {
    expect(
      ceoPlanStepExecutionSchema.safeParse(stepExecution({ taskStatus: "running" })).success,
    ).toBe(false);
  });
});

function attempt(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "attempt-1",
    planRunId: "run-1",
    planStepId: "step-1",
    childTaskId: "task-1",
    attemptNumber: 1,
    status: "claimed",
    triggerReason: "execution_started",
    schedulerSignalId: "signal-1",
    createdAt: TS,
    leaseGeneration: 0,
    ...overrides,
  };
}

describe("ceoPlanStepAttemptSchema", () => {
  it("accepts a valid minimal attempt", () => {
    expect(ceoPlanStepAttemptSchema.safeParse(attempt()).success).toBe(true);
  });

  it("rejects an invalid attempt status", () => {
    expect(ceoPlanStepAttemptSchema.safeParse(attempt({ status: "queued" })).success).toBe(false);
  });

  it("rejects a non-positive attemptNumber", () => {
    expect(ceoPlanStepAttemptSchema.safeParse(attempt({ attemptNumber: 0 })).success).toBe(false);
  });

  it("rejects an excessive safeFailureSummary", () => {
    expect(
      ceoPlanStepAttemptSchema.safeParse(attempt({ safeFailureSummary: "x".repeat(501) })).success,
    ).toBe(false);
  });

  it("rejects a leaked internal owner/lease field", () => {
    expect(ceoPlanStepAttemptSchema.safeParse(attempt({ ownerFence: "x" })).success).toBe(false);
  });
});

function signal(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "signal-1",
    planRunId: "run-1",
    generation: 0,
    reasons: ["execution_started"],
    priority: "normal",
    availableAt: TS,
    createdAt: TS,
    updatedAt: TS,
    state: "pending",
    attemptCount: 0,
    ...overrides,
  };
}

describe("ceoPlanExecutionSignalSchema", () => {
  it("accepts a valid minimal signal", () => {
    expect(ceoPlanExecutionSignalSchema.safeParse(signal()).success).toBe(true);
  });

  it("rejects an invalid signal reason", () => {
    expect(
      ceoPlanExecutionSignalSchema.safeParse(signal({ reasons: ["because_i_said_so"] })).success,
    ).toBe(false);
  });

  it("rejects duplicate signal reasons", () => {
    expect(
      ceoPlanExecutionSignalSchema.safeParse(
        signal({ reasons: ["execution_started", "execution_started"] }),
      ).success,
    ).toBe(false);
  });

  it("rejects an empty reasons array", () => {
    expect(ceoPlanExecutionSignalSchema.safeParse(signal({ reasons: [] })).success).toBe(false);
  });

  it("rejects more than the bounded reason count", () => {
    const reasons = [
      "execution_started",
      "dependency_completed",
      "dependency_failed",
      "task_terminal",
      "operator_resumed",
      "capacity_available",
      "retry_due",
      "adapter_availability_changed",
      "startup_reconciliation",
      "periodic_reconciliation",
      "operator_manual_retry",
    ];
    expect(ceoPlanExecutionSignalSchema.safeParse(signal({ reasons })).success).toBe(false);
  });

  it("rejects an invalid signal state", () => {
    expect(ceoPlanExecutionSignalSchema.safeParse(signal({ state: "leased" })).success).toBe(false);
  });

  it("rejects a leaked claim lease or internal revision", () => {
    expect(ceoPlanExecutionSignalSchema.safeParse(signal({ claimLease: "x" })).success).toBe(false);
    expect(ceoPlanExecutionSignalSchema.safeParse(signal({ internalRevision: 1 })).success).toBe(
      false,
    );
  });
});

describe("ceoPlanExecutionInterventionSchema", () => {
  function intervention(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "intervention-1",
      planRunId: "run-1",
      type: "pause",
      actor: "human:local-operator",
      createdAt: TS,
      ...overrides,
    };
  }

  it("accepts a valid minimal intervention", () => {
    expect(ceoPlanExecutionInterventionSchema.safeParse(intervention()).success).toBe(true);
  });

  it("rejects an invalid intervention type", () => {
    expect(
      ceoPlanExecutionInterventionSchema.safeParse(intervention({ type: "skip_step" })).success,
    ).toBe(false);
  });

  it("rejects a non-operator actor (browser cannot forge system/recovery)", () => {
    expect(
      ceoPlanExecutionInterventionSchema.safeParse(intervention({ actor: "system:ceo-scheduler" }))
        .success,
    ).toBe(false);
  });
});

describe("ceoPlanExecutionEventSchema", () => {
  function event(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      planRunId: "run-1",
      sequence: 0,
      type: "ceo.execution.started",
      actor: "system:ceo-scheduler",
      payload: {},
      timestamp: TS,
      ...overrides,
    };
  }

  it("accepts a valid minimal event", () => {
    expect(ceoPlanExecutionEventSchema.safeParse(event()).success).toBe(true);
  });

  it("accepts every documented event type", () => {
    const types = [
      "ceo.execution.configured",
      "ceo.execution.started",
      "ceo.execution.paused",
      "ceo.execution.resumed",
      "ceo.execution.cancelled",
      "ceo.execution.completed",
      "ceo.execution.failed",
      "ceo.execution.recovery_paused",
      "ceo.execution.signal_queued",
      "ceo.execution.signal_coalesced",
      "ceo.execution.step_ready",
      "ceo.execution.step_claimed",
      "ceo.execution.step_started",
      "ceo.execution.step_completed",
      "ceo.execution.step_failed",
      "ceo.execution.retry_scheduled",
      "ceo.execution.retry_requested",
      "ceo.execution.circuit_opened",
      "ceo.execution.emergency_stop_requested",
    ];
    for (const type of types) {
      expect(ceoPlanExecutionEventSchema.safeParse(event({ type })).success).toBe(true);
    }
  });

  it("rejects an unknown event type", () => {
    expect(
      ceoPlanExecutionEventSchema.safeParse(event({ type: "ceo.execution.bogus" })).success,
    ).toBe(false);
  });

  it("rejects a task-run actor with an unsafe/unbounded id", () => {
    expect(
      ceoPlanExecutionEventSchema.safeParse(event({ actor: "task-run:" + "x".repeat(200) }))
        .success,
    ).toBe(false);
  });

  it("accepts a well-formed task-run actor", () => {
    expect(
      ceoPlanExecutionEventSchema.safeParse(event({ actor: "task-run:abc-123" })).success,
    ).toBe(true);
  });

  it("rejects a browser-style free-form actor string", () => {
    expect(ceoPlanExecutionEventSchema.safeParse(event({ actor: "browser:anyone" })).success).toBe(
      false,
    );
  });

  it("rejects a payload exceeding the bounded key count", () => {
    const payload: Record<string, string> = {};
    for (let i = 0; i < 26; i += 1) payload[`k${String(i)}`] = "v";
    expect(ceoPlanExecutionEventSchema.safeParse(event({ payload })).success).toBe(false);
  });

  it("rejects a negative sequence", () => {
    expect(ceoPlanExecutionEventSchema.safeParse(event({ sequence: -1 })).success).toBe(false);
  });
});
