import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildTestApp,
  createGatedAdapter,
  validCreateTaskBody,
  validDeferredTaskBody,
  waitUntil,
  type CreateTaskResponseJson,
  type ErrorResponseJson,
  type TaskRecordJson,
} from "../test-support.js";

async function createDeferred(
  app: Awaited<ReturnType<typeof buildTestApp>>["app"],
  overrides: Record<string, unknown> = {},
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: validDeferredTaskBody(overrides),
  });
  return response;
}

/** Creates a deferred task and manually moves it to `ready`. */
async function createReadyTask(app: Awaited<ReturnType<typeof buildTestApp>>["app"]) {
  const created = await createDeferred(app);
  const { task } = created.json<TaskRecordJson>();
  await app.inject({
    method: "POST",
    url: `/api/v1/tasks/${task.taskId}/transition`,
    payload: { targetStatus: "ready" },
  });
  return task.taskId;
}

/** Creates a ready task and assigns it to Mock Agent. */
async function createAssignedTask(app: Awaited<ReturnType<typeof buildTestApp>>["app"]) {
  const taskId = await createReadyTask(app);
  await app.inject({
    method: "POST",
    url: `/api/v1/tasks/${taskId}/assign`,
    payload: { adapterId: "hall.mock-agent" },
  });
  return taskId;
}

describe("Kanban planning workflow (Phase 7)", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-kanban-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("deferred task creation", () => {
    it("returns 201", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await createDeferred(app);
      expect(response.statusCode).toBe(201);
      await app.close();
    });

    it("initial status is backlog", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await createDeferred(app);
      expect(response.json<TaskRecordJson>().task.status).toBe("backlog");
      await app.close();
    });

    it("creates no runId", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await createDeferred(app);
      expect(response.json<TaskRecordJson>().runId).toBeUndefined();
      await app.close();
    });

    it("creates no eventsPath", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await createDeferred(app);
      expect(response.json<Record<string, unknown>>().eventsPath).toBeUndefined();
      await app.close();
    });

    it("starts no adapter execution", async () => {
      const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await createDeferred(app);
      const { task } = response.json<TaskRecordJson>();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(harness.taskStore.get(task.taskId).eventCount).toBe(0);
      await app.close();
    });

    it("allows adapterId to be absent", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await createDeferred(app);
      expect(response.json<TaskRecordJson>().adapterId).toBeUndefined();
      await app.close();
    });

    it("defaults to immediate mode when executionMode is omitted", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validCreateTaskBody(),
      });
      expect(response.statusCode).toBe(202);
      expect(response.json<CreateTaskResponseJson>().task.status).toBe("assigned");
      await app.close();
    });

    it("immediate mode still returns 202 with eventsPath", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validCreateTaskBody({ executionMode: "immediate" }),
      });
      expect(response.statusCode).toBe(202);
      expect(typeof response.json<CreateTaskResponseJson>().eventsPath).toBe("string");
      await app.close();
    });

    it("rejects an invalid executionMode", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await createDeferred(app, { executionMode: "sometime-later" });
      expect(response.statusCode).toBe(400);
      await app.close();
    });

    it("rejects unknown fields", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await createDeferred(app, { mockScenario: "failure" });
      expect(response.statusCode).toBe(400);
      await app.close();
    });

    it("rejects an adapterId on a deferred request", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await createDeferred(app, { adapterId: "hall.mock-agent" });
      expect(response.statusCode).toBe(400);
      await app.close();
    });
  });

  describe("manual transitions", () => {
    it("backlog -> ready succeeds", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const { task } = (await createDeferred(app)).json<TaskRecordJson>();
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${task.taskId}/transition`,
        payload: { targetStatus: "ready" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<TaskRecordJson>().task.status).toBe("ready");
      await app.close();
    });

    it("backlog -> blocked succeeds", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const { task } = (await createDeferred(app)).json<TaskRecordJson>();
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${task.taskId}/transition`,
        payload: { targetStatus: "blocked" },
      });
      expect(response.statusCode).toBe(200);
      await app.close();
    });

    it("ready -> backlog succeeds", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/transition`,
        payload: { targetStatus: "backlog" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<TaskRecordJson>().task.status).toBe("backlog");
      await app.close();
    });

    it("ready -> blocked succeeds", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/transition`,
        payload: { targetStatus: "blocked" },
      });
      expect(response.statusCode).toBe(200);
      await app.close();
    });

    it("blocked -> ready succeeds", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const { task } = (await createDeferred(app)).json<TaskRecordJson>();
      await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${task.taskId}/transition`,
        payload: { targetStatus: "blocked" },
      });
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${task.taskId}/transition`,
        payload: { targetStatus: "ready" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<TaskRecordJson>().task.status).toBe("ready");
      await app.close();
    });

    it("assigned -> ready clears the assignment", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createAssignedTask(app);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/transition`,
        payload: { targetStatus: "ready" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<TaskRecordJson>();
      expect(body.task.status).toBe("ready");
      expect(body.adapterId).toBeUndefined();
      expect(body.agentId).toBeUndefined();
      await app.close();
    });

    it("rejects a manual move to running", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/transition`,
        payload: { targetStatus: "running" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json<ErrorResponseJson>().error.code).toBe("INVALID_TASK_TRANSITION");
      await app.close();
    });

    it("rejects a manual move to completed", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const { task } = (await createDeferred(app)).json<TaskRecordJson>();
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${task.taskId}/transition`,
        payload: { targetStatus: "completed" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json<ErrorResponseJson>().error.code).toBe("INVALID_TASK_TRANSITION");
      await app.close();
    });

    it("rejects a transition on an actively running task", async () => {
      const { app, harness } = await buildTestApp({
        workspaceRoot: tempRoot,
        mockAgentConfig: { scenario: "cancellable", progressMessageCount: 5, stepDelayMs: 20 },
      });
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validCreateTaskBody(),
      });
      const { task } = created.json<CreateTaskResponseJson>();
      await waitUntil(() => harness.taskStore.get(task.taskId).task.status === "running");
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${task.taskId}/transition`,
        payload: { targetStatus: "blocked" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json<ErrorResponseJson>().error.code).toBe("ACTIVE_TASK_TRANSITION_DENIED");
      await app.close();
    });

    it("rejects a transition on a terminal task", async () => {
      const { app, harness } = await buildTestApp({
        workspaceRoot: tempRoot,
        mockAgentConfig: { scenario: "success" },
      });
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validCreateTaskBody(),
      });
      const { task } = created.json<CreateTaskResponseJson>();
      await waitUntil(() => harness.taskStore.get(task.taskId).task.status === "completed");
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${task.taskId}/transition`,
        payload: { targetStatus: "backlog" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json<ErrorResponseJson>().error.code).toBe("TASK_STATE_CONFLICT");
      await app.close();
    });

    it("returns 404 for an unknown task", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tasks/nonexistent/transition",
        payload: { targetStatus: "ready" },
      });
      expect(response.statusCode).toBe(404);
      await app.close();
    });

    it("changes updatedAt", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const { task: created } = (await createDeferred(app)).json<TaskRecordJson>();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${created.taskId}/transition`,
        payload: { targetStatus: "ready" },
      });
      const { task: updated } = response.json<TaskRecordJson>();
      expect(updated.updatedAt).not.toBe(created.updatedAt);
      await app.close();
    });

    it("creates no run event for a planning transition", async () => {
      const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
      const { task } = (await createDeferred(app)).json<TaskRecordJson>();
      await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${task.taskId}/transition`,
        payload: { targetStatus: "ready" },
      });
      expect(harness.taskStore.get(task.taskId).eventCount).toBe(0);
      await app.close();
    });

    it("cancelling a planning task creates no run.cancelled event", async () => {
      const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
      const { task } = (await createDeferred(app)).json<TaskRecordJson>();
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${task.taskId}/transition`,
        payload: { targetStatus: "cancelled" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<TaskRecordJson>().task.status).toBe("cancelled");
      expect(harness.taskStore.get(task.taskId).eventCount).toBe(0);
      await app.close();
    });
  });

  describe("agent assignment", () => {
    it("assigns a ready task", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/assign`,
        payload: { adapterId: "hall.mock-agent" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<TaskRecordJson>();
      expect(body.task.status).toBe("assigned");
      expect(body.adapterId).toBe("hall.mock-agent");
      expect(body.agentId).toBe("mock-agent");
      await app.close();
    });

    it("rejects assigning a backlog task", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const { task } = (await createDeferred(app)).json<TaskRecordJson>();
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${task.taskId}/assign`,
        payload: { adapterId: "hall.mock-agent" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json<ErrorResponseJson>().error.code).toBe("TASK_STATE_CONFLICT");
      await app.close();
    });

    it("rejects an unknown adapter", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/assign`,
        payload: { adapterId: "hall.does-not-exist" },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json<ErrorResponseJson>().error.code).toBe("ADAPTER_NOT_FOUND");
      await app.close();
    });

    it("rejects an unavailable adapter", async () => {
      const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
      harness.registry.register({
        descriptor: {
          adapterId: "hall.busy-agent",
          displayName: "Busy Agent",
          adapterVersion: "0.0.0",
          integrationLevel: "native",
          supportedOperatingSystems: ["windows", "macos", "linux"],
          supportedAgent: {
            agentId: "busy-agent",
            displayName: "Busy Agent",
            adapterId: "hall.busy-agent",
            adapterVersion: "0.0.0",
          },
          capabilities: {
            streaming: true,
            cancellation: true,
            sessionResume: false,
            toolEvents: true,
            fileEditing: false,
            shellExecution: false,
            subagents: false,
            mcp: false,
            acp: false,
          },
        },
        detect: () => Promise.resolve({ installed: true, availability: "busy" }),
        startTask: () => Promise.reject(new Error("must not be called")),
      });
      const taskId = await createReadyTask(app);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/assign`,
        payload: { adapterId: "hall.busy-agent" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json<ErrorResponseJson>().error.code).toBe("ADAPTER_UNAVAILABLE");
      await app.close();
    });

    it("accepts a valid relative working directory", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/assign`,
        payload: { adapterId: "hall.mock-agent", workingDirectory: "." },
      });
      expect(response.statusCode).toBe(200);
      await app.close();
    });

    it("rejects an absolute working directory", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/assign`,
        payload: { adapterId: "hall.mock-agent", workingDirectory: tempRoot },
      });
      expect(response.statusCode).toBe(400);
      // This message legitimately echoes the client's own supplied string
      // back (see `#resolveWorkingDirectory`'s `path.isAbsolute` branch) —
      // that is not a server-side leak, only a rejection of the exact
      // value the client itself already sent. The *canonical, workspace-
      // resolved* absolute path is a different thing entirely and is
      // never included here or anywhere else — see "never returns the
      // canonical absolute path in the response" below, which covers the
      // one code path that ever computes one.
      expect(response.json<ErrorResponseJson>().error.code).toBe("WORKSPACE_VALIDATION_FAILED");
      await app.close();
    });

    it("rejects a traversal attempt", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/assign`,
        payload: { adapterId: "hall.mock-agent", workingDirectory: "../outside" },
      });
      expect(response.statusCode).toBe(400);
      await app.close();
    });

    it("never returns the canonical absolute path in the response", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/assign`,
        payload: { adapterId: "hall.mock-agent", workingDirectory: "." },
      });
      const text = response.body;
      expect(text).not.toContain(tempRoot.replace(/\\/g, "\\\\"));
      await app.close();
    });

    it("creates no run", async () => {
      const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app);
      await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/assign`,
        payload: { adapterId: "hall.mock-agent" },
      });
      expect(harness.taskStore.get(taskId).runId).toBeUndefined();
      expect(harness.taskStore.get(taskId).eventCount).toBe(0);
      await app.close();
    });

    it("allows reassignment before start", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createAssignedTask(app);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/assign`,
        payload: { adapterId: "hall.mock-agent", workingDirectory: "." },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<TaskRecordJson>().task.status).toBe("assigned");
      await app.close();
    });

    it("rejects assignment after the task has started", async () => {
      const { app, harness } = await buildTestApp({
        workspaceRoot: tempRoot,
        mockAgentConfig: { scenario: "cancellable", progressMessageCount: 5, stepDelayMs: 20 },
      });
      const taskId = await createAssignedTask(app);
      await app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/start` });
      await waitUntil(() => harness.taskStore.get(taskId).runId !== undefined);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/assign`,
        payload: { adapterId: "hall.mock-agent" },
      });
      expect(response.statusCode).toBe(409);
      await app.close();
    });

    it("concurrent assignment calls: exactly one succeeds, the other receives a conflict, and no mixed state is left (Phase 7.1)", async () => {
      // Uses two gated adapters (rather than Mock Agent twice) so the test
      // is deterministic: `detect()` on Mock Agent resolves near-instantly,
      // so which of two concurrent requests "wins" would depend on
      // incidental Promise-microtask ordering rather than the policy under
      // test. Here both requests are held open inside their `detect()`
      // await — the exact window `assignIfEligible()` closes — until both
      // are confirmed parked, then released together, forcing the overlap
      // every time.
      const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app);
      const gatedA = createGatedAdapter("hall.gated-agent-a");
      const gatedB = createGatedAdapter("hall.gated-agent-b");
      harness.registry.register(gatedA.adapter);
      harness.registry.register(gatedB.adapter);

      const firstPromise = app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/assign`,
        payload: { adapterId: "hall.gated-agent-a" },
      });
      const secondPromise = app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/assign`,
        payload: { adapterId: "hall.gated-agent-b" },
      });

      await gatedA.controller.waitForParked(1);
      await gatedB.controller.waitForParked(1);
      gatedA.controller.release();
      gatedB.controller.release();

      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      const statusCodes = [first.statusCode, second.statusCode].sort();
      expect(statusCodes).toEqual([200, 409]);

      const record = harness.taskStore.get(taskId);
      expect(record.task.status).toBe("assigned");
      // Exactly one deterministic adapter identity is stored — not a mix.
      expect(["hall.gated-agent-a", "hall.gated-agent-b"]).toContain(record.adapterId);
      expect(record.runId).toBeUndefined();

      const conflictResponse = first.statusCode === 409 ? first : second;
      expect(conflictResponse.json<ErrorResponseJson>().error.code).toBe("TASK_STATE_CONFLICT");
      await app.close();
    });

    it("an assignment pending during Ready -> Blocked loses the race: the task remains Blocked, no assignment is stored, no run is created", async () => {
      const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app);
      const gated = createGatedAdapter();
      harness.registry.register(gated.adapter);

      const assignPromise = app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/assign`,
        payload: { adapterId: "hall.gated-agent" },
      });
      await gated.controller.waitForParked(1);

      const transitionResponse = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/transition`,
        payload: { targetStatus: "blocked" },
      });
      expect(transitionResponse.statusCode).toBe(200);
      expect(transitionResponse.json<TaskRecordJson>().task.status).toBe("blocked");

      gated.controller.release();
      const assignResponse = await assignPromise;

      expect(assignResponse.statusCode).toBe(409);
      expect(assignResponse.json<ErrorResponseJson>().error.code).toBe("TASK_STATE_CONFLICT");
      const record = harness.taskStore.get(taskId);
      expect(record.task.status).toBe("blocked");
      expect(record.adapterId).toBeUndefined();
      expect(record.runId).toBeUndefined();
      expect(record.eventCount).toBe(0);
      await app.close();
    });

    it("an assignment pending during Ready -> Cancelled loses the race: the task remains Cancelled with no run.cancelled event", async () => {
      const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app);
      const gated = createGatedAdapter();
      harness.registry.register(gated.adapter);

      const assignPromise = app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/assign`,
        payload: { adapterId: "hall.gated-agent" },
      });
      await gated.controller.waitForParked(1);

      const transitionResponse = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/transition`,
        payload: { targetStatus: "cancelled" },
      });
      expect(transitionResponse.statusCode).toBe(200);
      expect(transitionResponse.json<TaskRecordJson>().task.status).toBe("cancelled");

      gated.controller.release();
      const assignResponse = await assignPromise;

      expect(assignResponse.statusCode).toBe(409);
      const record = harness.taskStore.get(taskId);
      expect(record.task.status).toBe("cancelled");
      expect(record.adapterId).toBeUndefined();
      expect(record.runId).toBeUndefined();
      // No run ever existed for this planning task, so there is no
      // run.cancelled event (or any event at all) to have been created.
      expect(record.eventCount).toBe(0);
      await app.close();
    });

    it("an ABA sequence (Ready -> Blocked -> Ready) defeats a stale assignment even though the four-field snapshot matches again (Phase 7.2)", async () => {
      // This is the exact gap Phase 7.1's four-field compare-and-set could
      // not close: after a Ready -> Blocked -> Ready round trip, `status`
      // reads "ready" again — identical to what the pending assignment
      // originally observed — but the task's real history moved twice.
      // Only the internal revision counter (bumped by both transitions)
      // can tell the two situations apart. This test must fail against a
      // four-field-only implementation and pass with revision checking.
      const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app);
      const gated = createGatedAdapter();
      harness.registry.register(gated.adapter);

      const assignPromise = app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/assign`,
        payload: { adapterId: "hall.gated-agent" },
      });
      await gated.controller.waitForParked(1);

      const toBlocked = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/transition`,
        payload: { targetStatus: "blocked" },
      });
      expect(toBlocked.statusCode).toBe(200);
      const backToReady = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/transition`,
        payload: { targetStatus: "ready" },
      });
      expect(backToReady.statusCode).toBe(200);
      expect(backToReady.json<TaskRecordJson>().task.status).toBe("ready");

      gated.controller.release();
      const assignResponse = await assignPromise;

      expect(assignResponse.statusCode).toBe(409);
      expect(assignResponse.json<ErrorResponseJson>().error.code).toBe("TASK_STATE_CONFLICT");
      const record = harness.taskStore.get(taskId);
      expect(record.task.status).toBe("ready");
      expect(record.adapterId).toBeUndefined();
      expect(record.runId).toBeUndefined();
      expect(record.eventCount).toBe(0);
      await app.close();
    });

    it("an ABA sequence within the Assigned lifecycle (assigned -> ready -> reassigned to the same adapter) defeats a stale reassignment (Phase 7.2)", async () => {
      // A racer begins reassigning an already-assigned task via a gated
      // adapter; while its detect() is parked, the task is moved away
      // (assigned -> ready, which clears the assignment) and then
      // reassigned back to the SAME original adapter through a separate,
      // ordinary (non-gated) request — restoring status/runId/adapterId/
      // agentId to exactly what the racer originally observed. Only
      // revision distinguishes "nothing happened" from "this happened
      // twice."
      const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createAssignedTask(app); // assigned to hall.mock-agent
      const gated = createGatedAdapter();
      harness.registry.register(gated.adapter);

      const racerPromise = app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/assign`,
        payload: { adapterId: "hall.gated-agent" },
      });
      await gated.controller.waitForParked(1);

      const toReady = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/transition`,
        payload: { targetStatus: "ready" },
      });
      expect(toReady.statusCode).toBe(200);
      expect(toReady.json<TaskRecordJson>().adapterId).toBeUndefined();

      const reassigned = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/assign`,
        payload: { adapterId: "hall.mock-agent" },
      });
      expect(reassigned.statusCode).toBe(200);
      const reassignedBody = reassigned.json<TaskRecordJson>();
      expect(reassignedBody.task.status).toBe("assigned");
      expect(reassignedBody.adapterId).toBe("hall.mock-agent");

      gated.controller.release();
      const racerResponse = await racerPromise;

      expect(racerResponse.statusCode).toBe(409);
      const record = harness.taskStore.get(taskId);
      expect(record.task.status).toBe("assigned");
      // The winner's adapter (from the ordinary reassignment above) must
      // survive untouched — the stale racer must never have committed.
      expect(record.adapterId).toBe("hall.mock-agent");
      expect(record.runId).toBeUndefined();
      await app.close();
    });

    it("never returns an internal revision field in the JSON response body", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/assign`,
        payload: { adapterId: "hall.mock-agent" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body.toLowerCase()).not.toContain("revision");
      const listResponse = await app.inject({ method: "GET", url: "/api/v1/tasks" });
      expect(listResponse.body.toLowerCase()).not.toContain("revision");
      await app.close();
    });
  });

  describe("starting an assigned task", () => {
    it("starts and returns 202", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createAssignedTask(app);
      const response = await app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/start` });
      expect(response.statusCode).toBe(202);
      await app.close();
    });

    it("creates exactly one run", async () => {
      const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createAssignedTask(app);
      await app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/start` });
      expect(harness.taskStore.get(taskId).runId).toBeDefined();
      await app.close();
    });

    it("includes eventsPath in the response", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createAssignedTask(app);
      const response = await app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/start` });
      expect(response.json<CreateTaskResponseJson>().eventsPath).toBe(
        `/api/v1/tasks/${taskId}/events`,
      );
      await app.close();
    });

    it("remains assigned until run.started arrives", async () => {
      const { app } = await buildTestApp({
        workspaceRoot: tempRoot,
        mockAgentConfig: { scenario: "cancellable", progressMessageCount: 5, stepDelayMs: 50 },
      });
      const taskId = await createAssignedTask(app);
      const response = await app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/start` });
      expect(response.json<CreateTaskResponseJson>().task.status).toBe("assigned");
      await app.close();
    });

    it("moves to running once run.started arrives", async () => {
      const { app, harness } = await buildTestApp({
        workspaceRoot: tempRoot,
        mockAgentConfig: { scenario: "cancellable", progressMessageCount: 5, stepDelayMs: 20 },
      });
      const taskId = await createAssignedTask(app);
      await app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/start` });
      await waitUntil(() => harness.taskStore.get(taskId).task.status === "running");
      expect(harness.taskStore.get(taskId).task.status).toBe("running");
      await app.close();
    });

    it("reaches completed for the success scenario", async () => {
      const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createAssignedTask(app);
      await app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/start` });
      await waitUntil(() => harness.taskStore.get(taskId).task.status === "completed");
      expect(harness.taskStore.get(taskId).task.status).toBe("completed");
      await app.close();
    });

    it("duplicate concurrent start requests create only one run", async () => {
      const { app } = await buildTestApp({
        workspaceRoot: tempRoot,
        mockAgentConfig: { scenario: "cancellable", progressMessageCount: 5, stepDelayMs: 20 },
      });
      const taskId = await createAssignedTask(app);
      const [first, second] = await Promise.all([
        app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/start` }),
        app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/start` }),
      ]);
      const statusCodes = [first.statusCode, second.statusCode].sort();
      expect(statusCodes).toEqual([202, 409]);
      const runIds = new Set(
        [first, second]
          .filter((response) => response.statusCode === 202)
          .map((response) => response.json<CreateTaskResponseJson>().runId),
      );
      expect(runIds.size).toBe(1);
      await app.close();
    });

    it("a ready (unassigned) task cannot start", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app);
      const response = await app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/start` });
      expect(response.statusCode).toBe(409);
      await app.close();
    });

    it("a blocked task cannot start", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const { task } = (await createDeferred(app)).json<TaskRecordJson>();
      await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${task.taskId}/transition`,
        payload: { targetStatus: "blocked" },
      });
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${task.taskId}/start`,
      });
      expect(response.statusCode).toBe(409);
      await app.close();
    });

    it("a terminal task cannot start", async () => {
      const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createAssignedTask(app);
      await app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/start` });
      await waitUntil(() => harness.taskStore.get(taskId).task.status === "completed");
      const response = await app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/start` });
      expect(response.statusCode).toBe(409);
      await app.close();
    });

    it("an adapter that becomes unavailable between assign and start prevents start and leaves the task assigned with no runId", async () => {
      const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createReadyTask(app);
      // Available during /assign, unavailable during /start — a stateful
      // fake, since Mock Agent itself is always available and cannot
      // exercise this path.
      let available = true;
      harness.registry.register({
        descriptor: {
          adapterId: "hall.flaky-agent",
          displayName: "Flaky Agent",
          adapterVersion: "0.0.0",
          integrationLevel: "native",
          supportedOperatingSystems: ["windows", "macos", "linux"],
          supportedAgent: {
            agentId: "flaky-agent",
            displayName: "Flaky Agent",
            adapterId: "hall.flaky-agent",
            adapterVersion: "0.0.0",
          },
          capabilities: {
            streaming: true,
            cancellation: true,
            sessionResume: false,
            toolEvents: true,
            fileEditing: false,
            shellExecution: false,
            subagents: false,
            mcp: false,
            acp: false,
          },
        },
        detect: () =>
          Promise.resolve({ installed: true, availability: available ? "available" : "busy" }),
        startTask: () => Promise.reject(new Error("must not be called")),
      });
      const assignResponse = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/assign`,
        payload: { adapterId: "hall.flaky-agent" },
      });
      expect(assignResponse.statusCode).toBe(200);

      available = false;
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/start`,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json<ErrorResponseJson>().error.code).toBe("ADAPTER_UNAVAILABLE");
      expect(harness.taskStore.get(taskId).task.status).toBe("assigned");
      expect(harness.taskStore.get(taskId).runId).toBeUndefined();
      await app.close();
    });

    it("active-run resources are cleaned up after completion", async () => {
      const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
      const taskId = await createAssignedTask(app);
      await app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/start` });
      await waitUntil(() => harness.taskStore.get(taskId).task.status === "completed");
      // No direct accessor for the orchestrator's private active-run maps;
      // the black-box proof is that a cancellation attempt on the now-
      // terminal task safely reports a conflict rather than hanging or
      // touching a stale controller.
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/cancel`,
      });
      expect(response.statusCode).toBe(409);
      await app.close();
    });
  });
});
