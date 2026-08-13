import { describe, expect, it } from "vitest";
import type {
  CeoPlanStepAttempt,
  CeoPlanStepExecution,
  CeoPlanVersion,
} from "@hall-of-wisdom/protocol";
import type { AdapterSummary, CeoDelegationLink } from "./api-schemas";
import {
  DEFAULT_WORKER_ACTIVITY_FILTERS,
  filterWorkerActivity,
  hasActiveFilters,
  projectWorkerActivity,
  type WorkerActivityFilters,
} from "./ceo-worker-activity";

const now = "2026-08-12T00:00:00.000Z";

function makeVersion(overrides: Partial<CeoPlanVersion> = {}): CeoPlanVersion {
  return {
    planId: "plan-1",
    version: 1,
    objective: "Ship the thing",
    summary: "Summary",
    assumptions: [],
    constraints: [],
    steps: [
      {
        id: "step-1",
        position: 0,
        title: "Write the code",
        objective: "Implement the feature",
        boundedInstructions: "Do it well",
        acceptanceCriteria: [],
        dependencies: [],
        routingSummary: "route",
      },
      {
        id: "step-2",
        position: 1,
        title: "Review the code",
        objective: "Check the work",
        boundedInstructions: "Do it well",
        acceptanceCriteria: [],
        dependencies: [],
        routingSummary: "route",
      },
    ],
    createdAt: now,
    createdBy: "ceo_planner",
    ...overrides,
  } as unknown as CeoPlanVersion;
}

function makeLink(overrides: Partial<CeoDelegationLink> = {}): CeoDelegationLink {
  return {
    planId: "plan-1",
    planVersion: 1,
    stepId: "step-1",
    childTaskId: "task-1",
    adapterId: "hall.claude-code",
    delegatedAt: now,
    ...overrides,
  };
}

function makeExecution(overrides: Partial<CeoPlanStepExecution> = {}): CeoPlanStepExecution {
  return {
    planRunId: "run-1",
    planStepId: "step-1",
    childTaskId: "task-1",
    status: "running",
    attemptCount: 1,
    dependencySummary: {
      totalDependencies: 0,
      completedDependencies: 0,
      failedDependencies: 0,
      cancelledDependencies: 0,
    },
    readinessReason: "ready",
    ...overrides,
  } as unknown as CeoPlanStepExecution;
}

function makeAttempt(overrides: Partial<CeoPlanStepAttempt> = {}): CeoPlanStepAttempt {
  return {
    id: "attempt-1",
    planRunId: "run-1",
    planStepId: "step-1",
    childTaskId: "task-1",
    attemptNumber: 1,
    status: "running",
    triggerReason: "execution_started",
    schedulerSignalId: "signal-1",
    createdAt: now,
    leaseGeneration: 0,
    ...overrides,
  } as unknown as CeoPlanStepAttempt;
}

function makeAdapter(overrides: Partial<AdapterSummary> = {}): AdapterSummary {
  return {
    adapterId: "hall.claude-code",
    displayName: "Claude Code",
    adapterVersion: "1.0.0",
    agentId: "claude-code",
    agentDisplayName: "Claude Code",
    integrationLevel: "native",
    supportedOperatingSystems: ["windows"],
    capabilities: {
      streaming: true,
      cancellation: true,
      sessionResume: true,
      toolEvents: true,
      fileEditing: true,
      shellExecution: true,
      subagents: false,
      mcp: false,
      acp: false,
    },
    installed: true,
    availability: "available",
    declaredCapabilities: [],
    assignable: true,
    executionTrust: "trusted",
    capabilityObservations: [],
    limitations: [],
    detectedAt: now,
    ...overrides,
  } as unknown as AdapterSummary;
}

describe("projectWorkerActivity", () => {
  it("joins step executions with plan steps, links, adapters, and latest attempt", () => {
    const version = makeVersion();
    const links = [makeLink()];
    const stepExecutions = [makeExecution()];
    const attempts = [
      makeAttempt({ attemptNumber: 1, safeFailureSummary: "first try" }),
      makeAttempt({ attemptNumber: 2, safeFailureSummary: "second try" }),
    ];
    const adapters = new Map([["hall.claude-code", makeAdapter()]]);

    const [worker] = projectWorkerActivity(version, links, stepExecutions, attempts, adapters);

    expect(worker).toMatchObject({
      stepId: "step-1",
      position: 0,
      title: "Write the code",
      objective: "Implement the feature",
      childTaskId: "task-1",
      status: "running",
      adapterId: "hall.claude-code",
      adapterDisplayName: "Claude Code",
      attemptCount: 1,
      lastFailureSummary: "second try",
    });
  });

  it("falls back gracefully when a step execution has no matching plan step", () => {
    const version = makeVersion();
    const stepExecutions = [makeExecution({ planStepId: "step-missing", childTaskId: "task-9" })];

    const [worker] = projectWorkerActivity(version, [], stepExecutions, [], new Map());

    expect(worker?.title).toBe("step-missing");
    expect(worker?.objective).toBe("");
    expect(worker?.adapterId).toBeNull();
    expect(worker?.adapterDisplayName).toBeNull();
  });

  it("omits the adapter badge when the adapter id is unresolved", () => {
    const version = makeVersion();
    const links = [makeLink({ adapterId: "hall.unknown" })];
    const stepExecutions = [makeExecution()];

    const [worker] = projectWorkerActivity(version, links, stepExecutions, [], new Map());

    expect(worker?.adapterId).toBe("hall.unknown");
    expect(worker?.adapterDisplayName).toBeNull();
  });

  it("surfaces null timestamps and error fields independently until present", () => {
    const version = makeVersion();
    const stepExecutions = [
      makeExecution({ startedAt: undefined, completedAt: undefined, lastFailureCode: undefined }),
    ];

    const [worker] = projectWorkerActivity(version, [], stepExecutions, [], new Map());

    expect(worker?.startedAt).toBeNull();
    expect(worker?.completedAt).toBeNull();
    expect(worker?.lastFailureCode).toBeNull();
    expect(worker?.lastFailureSummary).toBeNull();
  });

  it("reflects status changes across re-projections (e.g. running -> failed)", () => {
    const version = makeVersion();
    const running = [makeExecution({ status: "running" })];
    const failed = [
      makeExecution({ status: "failed", lastFailureCode: "adapter_error", completedAt: now }),
    ];

    expect(projectWorkerActivity(version, [], running, [], new Map())[0]?.status).toBe("running");
    const [failedWorker] = projectWorkerActivity(version, [], failed, [], new Map());
    expect(failedWorker?.status).toBe("failed");
    expect(failedWorker?.lastFailureCode).toBe("adapter_error");
    expect(failedWorker?.completedAt).toBe(now);
  });
});

describe("hasActiveFilters", () => {
  it("is false for the default filters", () => {
    expect(hasActiveFilters(DEFAULT_WORKER_ACTIVITY_FILTERS)).toBe(false);
  });

  it("is true when any filter deviates from default", () => {
    expect(hasActiveFilters({ ...DEFAULT_WORKER_ACTIVITY_FILTERS, search: "x" })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_WORKER_ACTIVITY_FILTERS, status: "running" })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_WORKER_ACTIVITY_FILTERS, adapterId: "hall.codex" })).toBe(
      true,
    );
  });
});

describe("filterWorkerActivity", () => {
  const version = makeVersion();
  const workers = projectWorkerActivity(
    version,
    [makeLink({ stepId: "step-1", adapterId: "hall.claude-code" }), makeLink({ stepId: "step-2", childTaskId: "task-2", adapterId: "hall.codex" })],
    [
      makeExecution({ planStepId: "step-1", childTaskId: "task-1", status: "running" }),
      makeExecution({ planStepId: "step-2", childTaskId: "task-2", status: "failed" }),
    ],
    [],
    new Map([
      ["hall.claude-code", makeAdapter()],
      ["hall.codex", makeAdapter({ adapterId: "hall.codex", displayName: "Codex" })],
    ]),
  );

  it("filters by status", () => {
    const filters: WorkerActivityFilters = { ...DEFAULT_WORKER_ACTIVITY_FILTERS, status: "failed" };
    expect(filterWorkerActivity(workers, filters).map((w) => w.stepId)).toEqual(["step-2"]);
  });

  it("filters by adapter", () => {
    const filters: WorkerActivityFilters = {
      ...DEFAULT_WORKER_ACTIVITY_FILTERS,
      adapterId: "hall.codex",
    };
    expect(filterWorkerActivity(workers, filters).map((w) => w.stepId)).toEqual(["step-2"]);
  });

  it("filters by search across title/objective/failure summary", () => {
    const filters: WorkerActivityFilters = { ...DEFAULT_WORKER_ACTIVITY_FILTERS, search: "review" };
    expect(filterWorkerActivity(workers, filters).map((w) => w.stepId)).toEqual(["step-2"]);
  });

  it("returns everything when no filters are active", () => {
    expect(filterWorkerActivity(workers, DEFAULT_WORKER_ACTIVITY_FILTERS)).toHaveLength(2);
  });
});
