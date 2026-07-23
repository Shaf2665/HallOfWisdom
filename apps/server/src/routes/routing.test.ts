import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AgentDetectionResult } from "@hall-of-wisdom/agent-adapter-sdk";
import {
  buildTestApp,
  validDeferredTaskBody,
  type ErrorResponseJson,
  type TaskRecordJson,
} from "../test-support.js";

const ISOLATED_ONLY = {
  requiredCapabilities: ["project.read", "project.edit"],
  allowedExecutionTrust: ["isolated"],
} as const;

const SIMULATION_ONLY = {
  requiredCapabilities: ["structured.events"],
  allowedExecutionTrust: ["simulated"],
} as const;

interface RoutingAnalysisResponseJson {
  readonly taskId: string;
  readonly requiredCapabilities: readonly string[];
  readonly allowedExecutionTrust: readonly string[];
  readonly candidates: readonly {
    readonly adapterId: string;
    readonly rank?: number;
    readonly assignable: boolean;
    readonly executionTrust: string;
  }[];
  readonly recommendedAdapterId?: string;
  readonly explanation: string;
  readonly generatedAt: string;
}

interface RouteAndAssignResponseJson {
  readonly record: TaskRecordJson & { readonly task: { readonly requirements?: unknown } };
  readonly routingExplanation: string;
  readonly generatedAt: string;
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

/**
 * A locally-controlled `AgentAdapter` whose `detect()` parks until
 * `release()` is called, like `test-support.ts`'s shared
 * `createGatedAdapter`, but with a full Phase 11 detection result
 * (`executionTrust`/`capabilityObservations`) the shared helper doesn't
 * provide — needed here to make this adapter genuinely routing-eligible.
 */
function createRoutingGatedAdapter(adapterId = "hall.gated-routing-agent"): {
  adapter: AgentAdapter;
  waitForParked(count: number, timeoutMs?: number): Promise<void>;
  release(overrides?: Partial<AgentDetectionResult>): void;
} {
  let parked = 0;
  let releasers: ((result: AgentDetectionResult) => void)[] = [];

  const adapter: AgentAdapter = {
    descriptor: {
      adapterId,
      displayName: "Gated Routing Agent",
      adapterVersion: "0.0.0",
      integrationLevel: "native",
      supportedOperatingSystems: ["windows", "macos", "linux"],
      supportedAgent: {
        agentId: "gated-routing-agent",
        displayName: "Gated Routing Agent",
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
        releasers.push(resolve);
      });
    },
    startTask(): Promise<never> {
      return Promise.reject(new Error("GatedRoutingAdapter.startTask must never be called"));
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
    release(overrides = {}) {
      const toRelease = releasers;
      releasers = [];
      parked -= toRelease.length;
      for (const resolve of toRelease) {
        resolve({
          installed: true,
          availability: "available",
          executionTrust: "isolated",
          capabilityObservations: [
            {
              capability: "project.read",
              status: "verified",
              safeSummary: "Verified.",
              evidence: "deterministic_test",
            },
            {
              capability: "project.edit",
              status: "verified",
              safeSummary: "Verified.",
              evidence: "deterministic_test",
            },
          ],
          ...overrides,
        });
      }
    },
  };
}

describe("Phase 11 routing routes", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-routing-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("POST /api/v1/tasks/:taskId/routing-analysis", () => {
    it("is read-only: does not mutate task status, revision, or create any run/events", async () => {
      const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app, { requirements: SIMULATION_ONLY });
      const revisionBefore = harness.taskStore.getRevision(taskId);

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/routing-analysis`,
      });

      expect(response.statusCode).toBe(200);
      const record = harness.taskStore.get(taskId);
      expect(record.task.status).toBe("ready");
      expect(record.runId).toBeUndefined();
      expect(record.eventCount).toBe(0);
      expect(harness.taskStore.getRevision(taskId)).toBe(revisionBefore);
      await app.close();
    });

    it("recommends Mock Agent for a simulation-only task", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app, { requirements: SIMULATION_ONLY });

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/routing-analysis`,
      });
      const body = response.json<RoutingAnalysisResponseJson>();
      expect(body.recommendedAdapterId).toBe("hall.mock-agent");
      expect(body.taskId).toBe(taskId);
      await app.close();
    });

    it("excludes Mock Agent and returns no recommendation for an isolated-only real-editing task", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app, { requirements: ISOLATED_ONLY });

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/routing-analysis`,
      });
      const body = response.json<RoutingAnalysisResponseJson>();
      expect(body.recommendedAdapterId).toBeUndefined();
      expect(body.explanation.length).toBeGreaterThan(0);
      await app.close();
    });

    it("accepts a body override even for a task with no persisted requirements", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app);

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/routing-analysis`,
        payload: { requirements: SIMULATION_ONLY },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<RoutingAnalysisResponseJson>().recommendedAdapterId).toBe(
        "hall.mock-agent",
      );
      await app.close();
    });

    it("400s with TASK_REQUIREMENTS_NOT_SET when neither the task nor the request carries requirements", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app);

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/routing-analysis`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorResponseJson>().error.code).toBe("TASK_REQUIREMENTS_NOT_SET");
      await app.close();
    });

    it("404s for an unknown task", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tasks/does-not-exist/routing-analysis",
      });
      expect(response.statusCode).toBe(404);
      await app.close();
    });

    it("never exposes executablePath, raw diagnostics, or the internal task revision", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app, { requirements: SIMULATION_ONLY });

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/routing-analysis`,
      });
      expect(response.body).not.toContain("executablePath");
      expect(response.body).not.toContain("revision");
      await app.close();
    });
  });

  describe("POST /api/v1/tasks/:taskId/route-and-assign", () => {
    it("assigns only — no run, no eventsPath, status becomes assigned", async () => {
      const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app, { requirements: SIMULATION_ONLY });

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/route-and-assign`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<RouteAndAssignResponseJson>();
      expect(body.record.task.status).toBe("assigned");
      expect(body.record.runId).toBeUndefined();
      expect(body.record.adapterId).toBe("hall.mock-agent");
      expect(response.body).not.toContain("eventsPath");

      const record = harness.taskStore.get(taskId);
      expect(record.runId).toBeUndefined();
      expect(record.eventCount).toBe(0);
      await app.close();
    });

    it("persists the requirements it routed against onto the task", async () => {
      const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app);

      await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/route-and-assign`,
        payload: { requirements: SIMULATION_ONLY },
      });

      const record = harness.taskStore.get(taskId);
      expect(record.task.requirements).toEqual(SIMULATION_ONLY);
      expect(record.assignedExecutionTrust).toBe("simulated");
      await app.close();
    });

    it("returns 409 NO_ROUTING_CANDIDATE when no adapter qualifies, and does not assign", async () => {
      const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app, { requirements: ISOLATED_ONLY });

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/route-and-assign`,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json<ErrorResponseJson>().error.code).toBe("NO_ROUTING_CANDIDATE");

      const record = harness.taskStore.get(taskId);
      expect(record.task.status).toBe("ready");
      expect(record.adapterId).toBeUndefined();
      await app.close();
    });

    it("400s with TASK_REQUIREMENTS_NOT_SET when neither the task nor the request carries requirements", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/route-and-assign`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorResponseJson>().error.code).toBe("TASK_REQUIREMENTS_NOT_SET");
      await app.close();
    });

    it("409s for a backlog task — route-and-assign requires ready (or reassignable-assigned), like manual assign", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const created = await createDeferred(app, { requirements: SIMULATION_ONLY });
      const { task } = created.json<TaskRecordJson>();

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${task.taskId}/route-and-assign`,
      });
      expect(response.statusCode).toBe(409);
      await app.close();
    });

    it("never starts execution: no events, no WebSocket-visible run, even moments after assignment", async () => {
      const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app, { requirements: SIMULATION_ONLY });
      await app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/route-and-assign` });

      await new Promise((resolve) => setTimeout(resolve, 20));
      const record = harness.taskStore.get(taskId);
      expect(record.runId).toBeUndefined();
      expect(record.eventCount).toBe(0);
      await app.close();
    });

    it("concurrent route-and-assign requests: exactly one wins, the other receives 409", async () => {
      const gated = createRoutingGatedAdapter();
      const { app, harness } = await buildTestApp({
        workspaceRoot: tempRoot,
        additionalAdapters: [gated.adapter],
      });
      const requirements = {
        requiredCapabilities: ["project.edit"],
        allowedExecutionTrust: ["isolated"],
      };
      const taskId = await createReadyTask(app, { requirements });

      const first = app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/route-and-assign` });
      const second = app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/route-and-assign`,
      });
      await gated.waitForParked(2);
      gated.release();

      const [responseA, responseB] = await Promise.all([first, second]);
      const statuses = [responseA.statusCode, responseB.statusCode].sort();
      // One succeeds (200), the other loses the race — either because the
      // task's revision moved (409 TASK_STATE_CONFLICT) or, in principle,
      // any other safe rejection; it must never be a second silent 200.
      expect(statuses[0]).toBe(200);
      expect(statuses[1]).not.toBe(200);

      const record = harness.taskStore.get(taskId);
      expect(record.adapterId).toBe(gated.adapter.descriptor.adapterId);
      await app.close();
    });

    it("route-and-assign racing a manual /assign: never corrupts state, and a second winner reflects a real, current reassignment", async () => {
      // Unlike two route-and-assign calls racing each other (previous
      // test), this pairing has no shared gate forcing a simultaneous
      // release: the manual /assign path is never blocked by `gated`, so
      // either request's synchronous prefix (revision snapshot) may run
      // before or after the other's commit, depending on Fastify's own
      // request-dispatch scheduling — not something this test controls or
      // should assume a fixed order for. Both interleavings are safe:
      //
      // 1. Manual assign's snapshot is captured BEFORE route-and-assign
      //    commits: manual assign then loses the revision race and gets
      //    409 once it tries to commit against a now-stale snapshot
      //    (proven deterministically by the previous test's identical
      //    mechanism).
      // 2. Manual assign's snapshot is captured AFTER route-and-assign
      //    already committed: manual assign correctly observes the
      //    now-`assigned`, not-yet-started task and legitimately
      //    reassigns it — `assignTask()`'s documented, pre-existing
      //    reassign-before-start behavior (see its doc comment), not a
      //    race-safety violation. `assignIfEligible`'s revision + 4-field
      //    check still guards this: it only succeeds because manual
      //    assign's own snapshot was fresh, not stale.
      //
      // Either way, exactly one request can ever be a *stale* commit
      // attempt, and `assignIfEligible` never lets a stale one through —
      // this test asserts that real guarantee instead of assuming a
      // specific winner.
      const gated = createRoutingGatedAdapter();
      const { app, harness } = await buildTestApp({
        workspaceRoot: tempRoot,
        additionalAdapters: [gated.adapter],
      });
      const requirements = {
        requiredCapabilities: ["project.edit"],
        allowedExecutionTrust: ["isolated"],
      };
      const taskId = await createReadyTask(app, { requirements });

      const routeAndAssign = app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/route-and-assign`,
      });
      const manualAssign = app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/assign`,
        payload: { adapterId: "hall.mock-agent" },
      });
      await gated.waitForParked(1);
      // The manual assign path resolves Mock Agent's own detect() (always
      // instant/available) independently of this gate; releasing here
      // only unblocks route-and-assign's candidate detection.
      gated.release();

      const [routedResponse, manualResponse] = await Promise.all([routeAndAssign, manualAssign]);
      const record = harness.taskStore.get(taskId);

      // At least one must succeed; neither may fail with anything other
      // than the expected stale-revision conflict.
      expect([routedResponse.statusCode, manualResponse.statusCode]).toContain(200);
      for (const status of [routedResponse.statusCode, manualResponse.statusCode]) {
        expect([200, 409]).toContain(status);
      }

      // No corruption regardless of interleaving: the final record is
      // always a clean, complete assignment to exactly one of the two
      // candidates — never a torn mix of one request's adapterId with the
      // other's agentId, and never left un-assigned when at least one
      // request reported success.
      expect(record.task.status).toBe("assigned");
      expect(record.runId).toBeUndefined();
      if (manualResponse.statusCode === 200) {
        expect(record.adapterId).toBe("hall.mock-agent");
        expect(record.assignedExecutionTrust).toBe("simulated");
        // Known, deliberate behavior — not a bug this test is pinning as
        // acceptable, but flagging so it is never silently assumed away:
        // manual `/assign` never validates the adapter it is given against
        // `task.requirements` (only route-and-assign's own policy check
        // does that, before it ever picks a candidate). If manual assign
        // is the last request to commit, the task's `requirements` field
        // is left exactly as route-and-assign set it
        // (`allowedExecutionTrust: ["isolated"]`) even though the adapter
        // actually assigned (Mock Agent, `simulated`) does not itself
        // satisfy that requirement. Manual assign is an unconstrained
        // operator override, by design — see `assignTask()`'s doc
        // comment — not a second enforcement point for `requirements`.
        expect(record.task.requirements?.allowedExecutionTrust).toEqual(["isolated"]);
      } else {
        expect(routedResponse.statusCode).toBe(200);
        expect(record.adapterId).toBe(gated.adapter.descriptor.adapterId);
        expect(record.assignedExecutionTrust).toBe("isolated");
      }
      await app.close();
    });

    it("a lifecycle change during detection (task cancelled mid-flight) causes route-and-assign to lose safely", async () => {
      const gated = createRoutingGatedAdapter();
      const { app, harness } = await buildTestApp({
        workspaceRoot: tempRoot,
        additionalAdapters: [gated.adapter],
      });
      const requirements = {
        requiredCapabilities: ["project.edit"],
        allowedExecutionTrust: ["isolated"],
      };
      const taskId = await createReadyTask(app, { requirements });

      const routeAndAssign = app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/route-and-assign`,
      });
      await gated.waitForParked(1);
      await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/transition`,
        payload: { targetStatus: "blocked" },
      });
      gated.release();

      const response = await routeAndAssign;
      expect(response.statusCode).not.toBe(200);
      const record = harness.taskStore.get(taskId);
      expect(record.task.status).toBe("blocked");
      expect(record.adapterId).toBeUndefined();
      await app.close();
    });
  });
});
