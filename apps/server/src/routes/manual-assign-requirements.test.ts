import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentAdapter,
  AgentDetectionResult,
  AvailabilityStatus,
} from "@hall-of-wisdom/agent-adapter-sdk";
import type {
  CapabilityId,
  CapabilityObservation,
  ExecutionTrust,
  TaskRequirements,
} from "@hall-of-wisdom/protocol";
import {
  buildTestApp,
  validDeferredTaskBody,
  type ErrorResponseJson,
  type TaskRecordJson,
} from "../test-support.js";

const ISOLATED_ONLY: TaskRequirements = {
  requiredCapabilities: ["project.read", "project.edit"],
  allowedExecutionTrust: ["isolated"],
};

const TRUSTED_LOCAL_ALLOWED: TaskRequirements = {
  requiredCapabilities: ["project.read", "project.edit"],
  allowedExecutionTrust: ["isolated", "trusted_local"],
};

const SIMULATION_ONLY: TaskRequirements = {
  requiredCapabilities: ["structured.events"],
  allowedExecutionTrust: ["simulated"],
};

function verified(capability: CapabilityId): CapabilityObservation {
  return {
    capability,
    status: "verified",
    safeSummary: "Verified by a deterministic test fixture.",
    evidence: "deterministic_test",
  };
}

function unverified(capability: CapabilityId): CapabilityObservation {
  return {
    capability,
    status: "unverified",
    safeSummary: "Neither confirmed nor denied by this test fixture.",
    evidence: "declared_only",
  };
}

function restricted(capability: CapabilityId): CapabilityObservation {
  return {
    capability,
    status: "restricted",
    safeSummary: "Diagnosed as currently restricted by this test fixture.",
    evidence: "environment_probe",
  };
}

/**
 * A static (non-gated), fully-configurable `AgentAdapter` fake for the
 * manual-assignment compatibility matrix — deliberately simpler than
 * `routing.test.ts`'s gated variant since most scenarios here need only
 * an immediate, fixed `detect()` result, not a controllable race window.
 */
function createFixedAdapter(options: {
  readonly adapterId: string;
  readonly availability?: AvailabilityStatus;
  readonly executionTrust?: ExecutionTrust;
  readonly capabilityObservations?: readonly CapabilityObservation[];
}): AgentAdapter {
  const displayName = options.adapterId;
  return {
    descriptor: {
      adapterId: options.adapterId,
      displayName,
      adapterVersion: "0.0.0",
      integrationLevel: "native",
      supportedOperatingSystems: ["windows", "macos", "linux"],
      supportedAgent: {
        agentId: options.adapterId,
        displayName,
        adapterId: options.adapterId,
        adapterVersion: "0.0.0",
      },
      capabilities: {
        streaming: true,
        cancellation: true,
        sessionResume: false,
        toolEvents: true,
        fileEditing: true,
        shellExecution: false,
        subagents: false,
        mcp: false,
        acp: false,
      },
      declaredCapabilities: ["project.read", "project.edit", "structured.events", "cancellation"],
    },
    detect(): Promise<AgentDetectionResult> {
      return Promise.resolve({
        installed: true,
        availability: options.availability ?? "available",
        executionTrust: options.executionTrust ?? "isolated",
        capabilityObservations: [...(options.capabilityObservations ?? [])],
      });
    },
    startTask(): Promise<never> {
      return Promise.reject(new Error(`${options.adapterId}.startTask must never be called`));
    },
  };
}

/**
 * A gated variant of `createFixedAdapter`, for the concurrency scenarios
 * (a manual assign's `detect()` must stay parked while a competing
 * request mutates the task) — mirrors `routing.test.ts`'s
 * `createRoutingGatedAdapter` pattern.
 */
function createGatedFixedAdapter(
  adapterId: string,
  fixedResult: Omit<AgentDetectionResult, "installed">,
): {
  adapter: AgentAdapter;
  waitForParked(count: number, timeoutMs?: number): Promise<void>;
  release(count?: number): void;
} {
  let parked = 0;
  const releasers: (() => void)[] = [];

  const adapter: AgentAdapter = {
    descriptor: {
      adapterId,
      displayName: adapterId,
      adapterVersion: "0.0.0",
      integrationLevel: "native",
      supportedOperatingSystems: ["windows", "macos", "linux"],
      supportedAgent: {
        agentId: adapterId,
        displayName: adapterId,
        adapterId,
        adapterVersion: "0.0.0",
      },
      capabilities: {
        streaming: true,
        cancellation: true,
        sessionResume: false,
        toolEvents: true,
        fileEditing: true,
        shellExecution: false,
        subagents: false,
        mcp: false,
        acp: false,
      },
      declaredCapabilities: ["project.read", "project.edit", "structured.events", "cancellation"],
    },
    detect(): Promise<AgentDetectionResult> {
      parked += 1;
      return new Promise((resolve) => {
        releasers.push(() => {
          resolve({ installed: true, ...fixedResult });
        });
      });
    },
    startTask(): Promise<never> {
      return Promise.reject(new Error(`${adapterId}.startTask must never be called`));
    },
  };

  return {
    adapter,
    async waitForParked(count, timeoutMs = 2000) {
      const start = Date.now();
      while (parked < count) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `only ${String(parked)}/${String(count)} calls parked within ${String(timeoutMs)}ms`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    // Releases the most-recently-parked `count` calls (defaults to
    // releasing all of them), leaving any earlier-parked calls still
    // parked — lets a test deterministically unblock a later, competing
    // caller (e.g. a route-and-assign's own candidate-detection sweep)
    // while leaving an earlier caller (e.g. the original manual-assign
    // request under test) still parked, so ordering between them is a
    // controlled fact, not an incidental race.
    release(count = Infinity) {
      const toRelease = count >= releasers.length ? releasers.splice(0) : releasers.splice(-count);
      parked -= toRelease.length;
      for (const resolve of toRelease) resolve();
    },
  };
}

async function createDeferred(
  app: Awaited<ReturnType<typeof buildTestApp>>["app"],
  overrides: Record<string, unknown> = {},
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: validDeferredTaskBody(overrides),
  });
}

async function createReadyTask(
  app: Awaited<ReturnType<typeof buildTestApp>>["app"],
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const created = await createDeferred(app, overrides);
  const { task } = created.json<TaskRecordJson>();
  await app.inject({
    method: "POST",
    url: `/api/v1/tasks/${task.taskId}/transition`,
    payload: { targetStatus: "ready" },
  });
  return task.taskId;
}

function assign(
  app: Awaited<ReturnType<typeof buildTestApp>>["app"],
  taskId: string,
  adapterId: string,
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/tasks/${taskId}/assign`,
    payload: { adapterId },
  });
}

describe("Manual assignment requirements validation (Phase 11.1)", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-assign-requirements-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  // 1. No-requirements task can be manually assigned as before.
  it("assigns a no-requirements task exactly as before (unaffected by this feature)", async () => {
    const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
    const taskId = await createReadyTask(app);

    const response = await assign(app, taskId, "hall.mock-agent");
    expect(response.statusCode).toBe(200);
    const record = harness.taskStore.get(taskId);
    expect(record.task.status).toBe("assigned");
    expect(record.adapterId).toBe("hall.mock-agent");
    await app.close();
  });

  // 2. Compatible manual assignment succeeds.
  it("assigns a requirements-compatible adapter successfully", async () => {
    const compatible = createFixedAdapter({
      adapterId: "hall.compatible-isolated",
      executionTrust: "isolated",
      capabilityObservations: [verified("project.read"), verified("project.edit")],
    });
    const { app, harness } = await buildTestApp({
      workspaceRoot: tempRoot,
      additionalAdapters: [compatible],
    });
    const taskId = await createReadyTask(app, { requirements: ISOLATED_ONLY });

    const response = await assign(app, taskId, "hall.compatible-isolated");
    expect(response.statusCode).toBe(200);
    expect(harness.taskStore.get(taskId).adapterId).toBe("hall.compatible-isolated");
    await app.close();
  });

  // 3. Compatible reassignment before start succeeds.
  it("allows a compatible reassignment before the task starts", async () => {
    const first = createFixedAdapter({
      adapterId: "hall.compatible-isolated-a",
      executionTrust: "isolated",
      capabilityObservations: [verified("project.read"), verified("project.edit")],
    });
    const second = createFixedAdapter({
      adapterId: "hall.compatible-isolated-b",
      executionTrust: "isolated",
      capabilityObservations: [verified("project.read"), verified("project.edit")],
    });
    const { app, harness } = await buildTestApp({
      workspaceRoot: tempRoot,
      additionalAdapters: [first, second],
    });
    const taskId = await createReadyTask(app, { requirements: ISOLATED_ONLY });

    const firstResponse = await assign(app, taskId, "hall.compatible-isolated-a");
    expect(firstResponse.statusCode).toBe(200);
    const secondResponse = await assign(app, taskId, "hall.compatible-isolated-b");
    expect(secondResponse.statusCode).toBe(200);
    const record = harness.taskStore.get(taskId);
    expect(record.adapterId).toBe("hall.compatible-isolated-b");
    expect(record.task.status).toBe("assigned");
    await app.close();
  });

  // 4 & 5. Assignment creates no run, no events.
  it("creates no run and no events on a successful (re)assignment", async () => {
    const compatible = createFixedAdapter({
      adapterId: "hall.compatible-isolated",
      executionTrust: "isolated",
      capabilityObservations: [verified("project.read"), verified("project.edit")],
    });
    const { app, harness } = await buildTestApp({
      workspaceRoot: tempRoot,
      additionalAdapters: [compatible],
    });
    const taskId = await createReadyTask(app, { requirements: ISOLATED_ONLY });

    await assign(app, taskId, "hall.compatible-isolated");
    const record = harness.taskStore.get(taskId);
    expect(record.runId).toBeUndefined();
    expect(record.eventCount).toBe(0);
    await app.close();
  });

  // 6. Isolated-only task accepts isolated Claude(-shaped) adapter.
  it("accepts an isolated adapter for an isolated-only task", async () => {
    const claudeShaped = createFixedAdapter({
      adapterId: "hall.claude-shaped",
      executionTrust: "isolated",
      capabilityObservations: [verified("project.read"), verified("project.edit")],
    });
    const { app } = await buildTestApp({
      workspaceRoot: tempRoot,
      additionalAdapters: [claudeShaped],
    });
    const taskId = await createReadyTask(app, { requirements: ISOLATED_ONLY });

    const response = await assign(app, taskId, "hall.claude-shaped");
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  // 7. Isolated-only task rejects trusted-local Codex(-shaped) adapter.
  it("rejects a trusted-local adapter for an isolated-only task", async () => {
    const codexShaped = createFixedAdapter({
      adapterId: "hall.codex-shaped",
      executionTrust: "trusted_local",
      capabilityObservations: [verified("project.read"), verified("project.edit")],
    });
    const { app, harness } = await buildTestApp({
      workspaceRoot: tempRoot,
      additionalAdapters: [codexShaped],
    });
    const taskId = await createReadyTask(app, { requirements: ISOLATED_ONLY });

    const response = await assign(app, taskId, "hall.codex-shaped");
    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorResponseJson>().error.code).toBe("ADAPTER_REQUIREMENTS_MISMATCH");
    expect(harness.taskStore.get(taskId).task.status).toBe("ready");
    await app.close();
  });

  // 8. Isolated-only task rejects simulated Mock Agent.
  it("rejects Mock Agent (simulated) for an isolated-only task", async () => {
    const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
    const taskId = await createReadyTask(app, { requirements: ISOLATED_ONLY });

    const response = await assign(app, taskId, "hall.mock-agent");
    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorResponseJson>().error.code).toBe("ADAPTER_REQUIREMENTS_MISMATCH");
    expect(harness.taskStore.get(taskId).task.status).toBe("ready");
    await app.close();
  });

  // 9. Trusted-local-allowed task accepts trusted-local Codex(-shaped) adapter.
  it("accepts a trusted-local adapter when the task allows trusted-local execution", async () => {
    const codexShaped = createFixedAdapter({
      adapterId: "hall.codex-shaped",
      executionTrust: "trusted_local",
      capabilityObservations: [verified("project.read"), verified("project.edit")],
    });
    const { app } = await buildTestApp({
      workspaceRoot: tempRoot,
      additionalAdapters: [codexShaped],
    });
    const taskId = await createReadyTask(app, { requirements: TRUSTED_LOCAL_ALLOWED });

    const response = await assign(app, taskId, "hall.codex-shaped");
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  // 10. Simulation task accepts Mock Agent.
  it("accepts Mock Agent for a simulation-only task", async () => {
    const { app } = await buildTestApp({ workspaceRoot: tempRoot });
    const taskId = await createReadyTask(app, { requirements: SIMULATION_ONLY });

    const response = await assign(app, taskId, "hall.mock-agent");
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  // 11. Missing capability returns 409.
  it("returns 409 when a required capability has no observation at all", async () => {
    const noObservations = createFixedAdapter({
      adapterId: "hall.no-observations",
      executionTrust: "isolated",
      capabilityObservations: [],
    });
    const { app } = await buildTestApp({
      workspaceRoot: tempRoot,
      additionalAdapters: [noObservations],
    });
    const taskId = await createReadyTask(app, { requirements: ISOLATED_ONLY });

    const response = await assign(app, taskId, "hall.no-observations");
    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorResponseJson>().error.code).toBe("ADAPTER_REQUIREMENTS_MISMATCH");
    await app.close();
  });

  // 12. Unverified capability returns 409.
  it("returns 409 when a required capability is only 'unverified'", async () => {
    const unverifiedAdapter = createFixedAdapter({
      adapterId: "hall.unverified-caps",
      executionTrust: "isolated",
      capabilityObservations: [unverified("project.read"), unverified("project.edit")],
    });
    const { app } = await buildTestApp({
      workspaceRoot: tempRoot,
      additionalAdapters: [unverifiedAdapter],
    });
    const taskId = await createReadyTask(app, { requirements: ISOLATED_ONLY });

    const response = await assign(app, taskId, "hall.unverified-caps");
    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorResponseJson>().error.code).toBe("ADAPTER_REQUIREMENTS_MISMATCH");
    await app.close();
  });

  // 13. Restricted capability returns 409.
  it("returns 409 when a required capability is 'restricted'", async () => {
    const restrictedAdapter = createFixedAdapter({
      adapterId: "hall.restricted-caps",
      executionTrust: "isolated",
      capabilityObservations: [restricted("project.read"), restricted("project.edit")],
    });
    const { app } = await buildTestApp({
      workspaceRoot: tempRoot,
      additionalAdapters: [restrictedAdapter],
    });
    const taskId = await createReadyTask(app, { requirements: ISOLATED_ONLY });

    const response = await assign(app, taskId, "hall.restricted-caps");
    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorResponseJson>().error.code).toBe("ADAPTER_REQUIREMENTS_MISMATCH");
    await app.close();
  });

  // 14. Unavailable adapter returns the existing safe failure (not the new
  // requirements-mismatch code) — the availability check still runs first.
  it("returns the existing ADAPTER_UNAVAILABLE failure for an unavailable adapter, even on a task with requirements", async () => {
    const unavailableAdapter = createFixedAdapter({
      adapterId: "hall.unavailable-adapter",
      availability: "unsupported",
      executionTrust: "unavailable",
      capabilityObservations: [],
    });
    const { app, harness } = await buildTestApp({
      workspaceRoot: tempRoot,
      additionalAdapters: [unavailableAdapter],
    });
    const taskId = await createReadyTask(app, { requirements: ISOLATED_ONLY });

    const response = await assign(app, taskId, "hall.unavailable-adapter");
    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorResponseJson>().error.code).toBe("ADAPTER_UNAVAILABLE");
    expect(harness.taskStore.get(taskId).task.status).toBe("ready");
    await app.close();
  });

  // 15. Task requirements changing during detection returns 409 — induced
  // through a real revision-bumping path (a competing route-and-assign
  // that changes both the winning adapter and the task's requirements),
  // not a raw store poke.
  it("rejects a manual assign whose requirements snapshot went stale mid-detection, via the revision guard", async () => {
    const gatedIsolated = createGatedFixedAdapter("hall.gated-isolated", {
      availability: "available",
      executionTrust: "isolated",
      capabilityObservations: [verified("project.read"), verified("project.edit")],
    });
    const { app, harness } = await buildTestApp({
      workspaceRoot: tempRoot,
      additionalAdapters: [gatedIsolated.adapter],
    });
    const taskId = await createReadyTask(app, { requirements: ISOLATED_ONLY });

    const manualAssign = assign(app, taskId, "hall.gated-isolated");
    await gatedIsolated.waitForParked(1); // manual assign's own detect() call (#1) parked

    // A competing route-and-assign, with a different requirements
    // override, is issued next. Its own candidate detection also calls
    // the still-registered gated adapter's detect() (a second, distinct
    // call, #2) — deliberately release *only* that second call, leaving
    // the manual assign's original call (#1) still parked, so
    // route-and-assign is guaranteed to run to completion — a real,
    // observable revision-bumping commit, not a direct store write —
    // strictly before the manual assign's stale snapshot is ever acted
    // on. (Releasing both at once here would race the two committing
    // handlers against each other with no guaranteed order — the point
    // of this test is specifically to prove what happens when the
    // requirements change *before* the manual assign's own commit
    // attempt, not to leave that to chance.)
    const routeAndAssign = app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/route-and-assign`,
      payload: { requirements: SIMULATION_ONLY },
    });
    await gatedIsolated.waitForParked(2);
    gatedIsolated.release(1);

    const routeAndAssignResponse = await routeAndAssign;
    expect(routeAndAssignResponse.statusCode).toBe(200);

    // Now release the manual assign's original, still-parked call (#1).
    gatedIsolated.release();
    const manualResponse = await manualAssign;

    // Rejected — but via the revision guard (a stale-state conflict), not
    // a requirements mismatch: evaluated against the snapshot it actually
    // read, the gated isolated adapter *did* satisfy the original
    // ISOLATED_ONLY requirements. The rejection reason is that the task
    // moved on while detection was in flight, not that the adapter itself
    // was ever incompatible with what this request observed.
    expect(manualResponse.statusCode).toBe(409);
    expect(manualResponse.json<ErrorResponseJson>().error.code).toBe("TASK_STATE_CONFLICT");

    const record = harness.taskStore.get(taskId);
    expect(record.adapterId).toBe("hall.mock-agent");
    expect(record.task.requirements?.allowedExecutionTrust).toEqual(["simulated"]);
    await app.close();
  });

  // 16. Task moving to Blocked during detection returns 409.
  it("rejects a manual assign when the task moves to Blocked mid-detection", async () => {
    const gatedIsolated = createGatedFixedAdapter("hall.gated-isolated", {
      availability: "available",
      executionTrust: "isolated",
      capabilityObservations: [verified("project.read"), verified("project.edit")],
    });
    const { app, harness } = await buildTestApp({
      workspaceRoot: tempRoot,
      additionalAdapters: [gatedIsolated.adapter],
    });
    const taskId = await createReadyTask(app, { requirements: ISOLATED_ONLY });

    const manualAssign = assign(app, taskId, "hall.gated-isolated");
    await gatedIsolated.waitForParked(1);

    const transitionResponse = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/transition`,
      payload: { targetStatus: "blocked" },
    });
    expect(transitionResponse.statusCode).toBe(200);

    gatedIsolated.release();
    const manualResponse = await manualAssign;
    expect(manualResponse.statusCode).toBe(409);
    expect(manualResponse.json<ErrorResponseJson>().error.code).toBe("TASK_STATE_CONFLICT");
    expect(harness.taskStore.get(taskId).task.status).toBe("blocked");
    await app.close();
  });

  // 17. Task being cancelled during detection returns 409.
  it("rejects a manual assign when the task is cancelled mid-detection", async () => {
    const gatedIsolated = createGatedFixedAdapter("hall.gated-isolated", {
      availability: "available",
      executionTrust: "isolated",
      capabilityObservations: [verified("project.read"), verified("project.edit")],
    });
    const { app, harness } = await buildTestApp({
      workspaceRoot: tempRoot,
      additionalAdapters: [gatedIsolated.adapter],
    });
    const taskId = await createReadyTask(app, { requirements: ISOLATED_ONLY });

    const manualAssign = assign(app, taskId, "hall.gated-isolated");
    await gatedIsolated.waitForParked(1);

    const cancelResponse = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/transition`,
      payload: { targetStatus: "cancelled" },
    });
    expect(cancelResponse.statusCode).toBe(200);

    gatedIsolated.release();
    const manualResponse = await manualAssign;
    expect(manualResponse.statusCode).toBe(409);
    expect(manualResponse.json<ErrorResponseJson>().error.code).toBe("TASK_STATE_CONFLICT");
    expect(harness.taskStore.get(taskId).task.status).toBe("cancelled");
    await app.close();
  });

  // 18. Another assignment winning on the same revision returns 409.
  it("lets exactly one of two concurrent manual assigns win, the other gets 409 TASK_STATE_CONFLICT", async () => {
    const gatedA = createGatedFixedAdapter("hall.gated-a", {
      availability: "available",
      executionTrust: "isolated",
      capabilityObservations: [verified("project.read"), verified("project.edit")],
    });
    const gatedB = createGatedFixedAdapter("hall.gated-b", {
      availability: "available",
      executionTrust: "isolated",
      capabilityObservations: [verified("project.read"), verified("project.edit")],
    });
    const { app, harness } = await buildTestApp({
      workspaceRoot: tempRoot,
      additionalAdapters: [gatedA.adapter, gatedB.adapter],
    });
    const taskId = await createReadyTask(app, { requirements: ISOLATED_ONLY });

    const first = assign(app, taskId, "hall.gated-a");
    const second = assign(app, taskId, "hall.gated-b");
    await gatedA.waitForParked(1);
    await gatedB.waitForParked(1);
    gatedA.release();
    gatedB.release();

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    const statuses = [firstResponse.statusCode, secondResponse.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = firstResponse.statusCode === 409 ? firstResponse : secondResponse;
    expect(loser.json<ErrorResponseJson>().error.code).toBe("TASK_STATE_CONFLICT");
    expect(harness.taskStore.get(taskId).adapterId).toMatch(/^hall\.gated-[ab]$/);
    await app.close();
  });

  // 19. A later fresh compatible reassignment may succeed.
  it("allows a later, fresh, compatible reassignment (not a race) to succeed", async () => {
    const first = createFixedAdapter({
      adapterId: "hall.compatible-isolated-a",
      executionTrust: "isolated",
      capabilityObservations: [verified("project.read"), verified("project.edit")],
    });
    const second = createFixedAdapter({
      adapterId: "hall.compatible-isolated-b",
      executionTrust: "isolated",
      capabilityObservations: [verified("project.read"), verified("project.edit")],
    });
    const { app, harness } = await buildTestApp({
      workspaceRoot: tempRoot,
      additionalAdapters: [first, second],
    });
    const taskId = await createReadyTask(app, { requirements: ISOLATED_ONLY });

    const firstResponse = await assign(app, taskId, "hall.compatible-isolated-a");
    expect(firstResponse.statusCode).toBe(200);

    const secondResponse = await assign(app, taskId, "hall.compatible-isolated-b");
    expect(secondResponse.statusCode).toBe(200);
    expect(harness.taskStore.get(taskId).adapterId).toBe("hall.compatible-isolated-b");
    await app.close();
  });

  // 20. A later fresh incompatible reassignment is rejected.
  it("rejects a later, fresh, incompatible reassignment attempt", async () => {
    const compatible = createFixedAdapter({
      adapterId: "hall.compatible-isolated",
      executionTrust: "isolated",
      capabilityObservations: [verified("project.read"), verified("project.edit")],
    });
    const { app, harness } = await buildTestApp({
      workspaceRoot: tempRoot,
      additionalAdapters: [compatible],
    });
    const taskId = await createReadyTask(app, { requirements: ISOLATED_ONLY });

    const firstResponse = await assign(app, taskId, "hall.compatible-isolated");
    expect(firstResponse.statusCode).toBe(200);

    // Mock Agent is simulated and never declares project.edit — does not
    // satisfy the still-in-force ISOLATED_ONLY requirements.
    const secondResponse = await assign(app, taskId, "hall.mock-agent");
    expect(secondResponse.statusCode).toBe(409);
    expect(secondResponse.json<ErrorResponseJson>().error.code).toBe(
      "ADAPTER_REQUIREMENTS_MISMATCH",
    );
    // The rejected attempt must not have overwritten the existing,
    // compatible assignment.
    expect(harness.taskStore.get(taskId).adapterId).toBe("hall.compatible-isolated");
    await app.close();
  });

  // 21. Task revision remains private.
  it("never exposes the internal task revision in an assign response", async () => {
    const { app } = await buildTestApp({ workspaceRoot: tempRoot });
    const taskId = await createReadyTask(app);

    const response = await assign(app, taskId, "hall.mock-agent");
    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(response.json())).not.toMatch(/revision/i);
    await app.close();
  });

  // 22. Browser-supplied capability/trust claims are ignored or rejected.
  it("rejects a request body that tries to smuggle capability/trust/requirements fields", async () => {
    const { app } = await buildTestApp({ workspaceRoot: tempRoot });
    const taskId = await createReadyTask(app, { requirements: ISOLATED_ONLY });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/assign`,
      payload: {
        adapterId: "hall.mock-agent",
        executionTrust: "isolated",
        capabilityObservations: [verified("project.edit")],
        requirements: SIMULATION_ONLY,
      },
    });
    // Rejected by the existing `.strict()` assign-request schema — never
    // reaches the eligibility check with attacker-supplied capability
    // claims at all.
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  // 23. Generic orchestrator code contains no provider-specific branch.
  it("TaskOrchestrator's source contains no provider-specific adapterId branch", () => {
    const orchestratorPath = fileURLToPath(
      new URL("../tasks/task-orchestrator.ts", import.meta.url),
    );
    const source = fs.readFileSync(orchestratorPath, "utf8");
    expect(source).not.toMatch(/hall\.mock-agent/);
    expect(source).not.toMatch(/hall\.codex/);
    expect(source).not.toMatch(/hall\.claude-code/);
  });
});
