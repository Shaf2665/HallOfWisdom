import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildTestApp,
  validCreateTaskBody,
  waitUntil,
  type CreateTaskResponseJson,
  type ErrorResponseJson,
  type TaskRecordJson,
} from "../test-support.js";

interface CancelResponseJson {
  readonly taskId: string;
  readonly cancellationRequested: boolean;
  readonly alreadyRequested: boolean;
}

describe("REST task routes", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-routes-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("POST /api/v1/tasks", () => {
    it("returns 202 with a task snapshot, runId, and eventsPath for a valid request", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validCreateTaskBody(),
      });
      expect(response.statusCode).toBe(202);
      const body = response.json<CreateTaskResponseJson>();
      expect(body.task.status).toBe("assigned");
      expect(typeof body.runId).toBe("string");
      expect(body.eventsPath).toBe(`/api/v1/tasks/${body.task.taskId}/events`);
      await app.close();
    });

    it("returns before the (delayed) task completes", async () => {
      const { app } = await buildTestApp({
        workspaceRoot: tempRoot,
        mockAgentConfig: { scenario: "success", stepDelayMs: 100 },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validCreateTaskBody(),
      });
      const body = response.json<CreateTaskResponseJson>();
      expect(body.task.status).toBe("assigned");
      await app.close();
    });

    it("rejects an absolute workingDirectory with 400", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validCreateTaskBody({ workingDirectory: tempRoot }),
      });
      expect(response.statusCode).toBe(400);
      const body = response.json<ErrorResponseJson>();
      expect(body.error.code).toBe("WORKSPACE_VALIDATION_FAILED");
      await app.close();
    });

    it("rejects a traversal attempt with 400", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validCreateTaskBody({ workingDirectory: "../outside" }),
      });
      expect(response.statusCode).toBe(400);
      await app.close();
    });

    it("never discloses the configured workspace root's absolute path in a validation error", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validCreateTaskBody({ workingDirectory: "../outside" }),
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain(tempRoot);
      await app.close();
    });

    it("rejects unknown fields with 400", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validCreateTaskBody({ notARealField: true }),
      });
      expect(response.statusCode).toBe(400);
      const body = response.json<ErrorResponseJson>();
      expect(body.error.code).toBe("INVALID_REQUEST");
      await app.close();
    });

    it("rejects an empty title with 400", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validCreateTaskBody({ title: "" }),
      });
      expect(response.statusCode).toBe(400);
      await app.close();
    });

    it("rejects an invalid priority with 400", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validCreateTaskBody({ priority: "extremely-urgent" }),
      });
      expect(response.statusCode).toBe(400);
      await app.close();
    });

    it("rejects an unknown adapter with 404", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validCreateTaskBody({ adapterId: "hall.nonexistent" }),
      });
      expect(response.statusCode).toBe(404);
      const body = response.json<ErrorResponseJson>();
      expect(body.error.code).toBe("ADAPTER_NOT_FOUND");
      await app.close();
    });

    it("rejects malformed JSON with a safe 400", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        headers: { "content-type": "application/json" },
        payload: "{not valid json",
      });
      expect(response.statusCode).toBe(400);
      await app.close();
    });

    it("enforces the configured task-capacity limit with 429", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot, limits: { maxTasks: 1 } });
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validCreateTaskBody(),
      });
      expect(first.statusCode).toBe(202);
      const second = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validCreateTaskBody(),
      });
      expect(second.statusCode).toBe(429);
      await app.close();
    });

    it("rejects an oversized request body with 413", async () => {
      const { app } = await buildTestApp({
        workspaceRoot: tempRoot,
        limits: { maxBodyBytes: 100 },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validCreateTaskBody({ description: "x".repeat(1000) }),
      });
      expect(response.statusCode).toBe(413);
      await app.close();
    });
  });

  describe("GET /api/v1/tasks", () => {
    it("returns tasks in deterministic order", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validCreateTaskBody({ title: "first" }),
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validCreateTaskBody({ title: "second" }),
      });
      const response = await app.inject({ method: "GET", url: "/api/v1/tasks" });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ tasks: TaskRecordJson[] }>();
      expect(body.tasks.map((record) => record.task.title)).toEqual(["first", "second"]);
      await app.close();
    });
  });

  describe("GET /api/v1/tasks/:taskId", () => {
    it("returns the correct task", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validCreateTaskBody(),
      });
      const { task } = created.json<CreateTaskResponseJson>();
      const response = await app.inject({ method: "GET", url: `/api/v1/tasks/${task.taskId}` });
      expect(response.statusCode).toBe(200);
      const body = response.json<TaskRecordJson>();
      expect(body.task.taskId).toBe(task.taskId);
      await app.close();
    });

    it("returns 404 for an unknown task", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({ method: "GET", url: "/api/v1/tasks/nonexistent" });
      expect(response.statusCode).toBe(404);
      const body = response.json<ErrorResponseJson>();
      expect(body.error.code).toBe("TASK_NOT_FOUND");
      await app.close();
    });
  });

  describe("POST /api/v1/tasks/:taskId/cancel", () => {
    it("returns 202 for an active task", async () => {
      const { app, harness } = await buildTestApp({
        workspaceRoot: tempRoot,
        mockAgentConfig: { scenario: "cancellable", progressMessageCount: 5, stepDelayMs: 30 },
      });
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validCreateTaskBody(),
      });
      const { task } = created.json<CreateTaskResponseJson>();
      await waitUntil(() => harness.taskStore.get(task.taskId).eventCount >= 1);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${task.taskId}/cancel`,
      });
      expect(response.statusCode).toBe(202);
      await app.close();
    });

    it("repeated pending cancellation is idempotent (still 202)", async () => {
      const { app, harness } = await buildTestApp({
        workspaceRoot: tempRoot,
        mockAgentConfig: { scenario: "cancellable", progressMessageCount: 5, stepDelayMs: 30 },
      });
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validCreateTaskBody(),
      });
      const { task } = created.json<CreateTaskResponseJson>();
      await waitUntil(() => harness.taskStore.get(task.taskId).eventCount >= 1);
      // Fire both cancel requests concurrently (rather than sequentially
      // awaited) so this doesn't race against how quickly Mock Agent's
      // cancellation itself resolves — the orchestrator-level idempotency
      // guarantee (synchronous, non-racy) is separately tested in
      // task-orchestrator.test.ts; this test only needs the HTTP layer to
      // surface whichever outcome the orchestrator already guarantees.
      const [first, second] = await Promise.all([
        app.inject({ method: "POST", url: `/api/v1/tasks/${task.taskId}/cancel` }),
        app.inject({ method: "POST", url: `/api/v1/tasks/${task.taskId}/cancel` }),
      ]);
      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(202);
      const bodies = [first, second].map((response) => response.json<CancelResponseJson>());
      // Exactly one of the two concurrent requests is the "first" one.
      expect(bodies.filter((body) => body.alreadyRequested)).toHaveLength(1);
      await app.close();
    });

    it("returns 404 for an unknown task", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tasks/nonexistent/cancel",
      });
      expect(response.statusCode).toBe(404);
      await app.close();
    });

    it("returns 409 for a completed task", async () => {
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
        url: `/api/v1/tasks/${task.taskId}/cancel`,
      });
      expect(response.statusCode).toBe(409);
      const body = response.json<ErrorResponseJson>();
      expect(body.error.code).toBe("TASK_STATE_CONFLICT");
      await app.close();
    });

    it("returns 409 for a failed task", async () => {
      const { app, harness } = await buildTestApp({
        workspaceRoot: tempRoot,
        mockAgentConfig: { scenario: "failure" },
      });
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validCreateTaskBody(),
      });
      const { task } = created.json<CreateTaskResponseJson>();
      await waitUntil(() => harness.taskStore.get(task.taskId).task.status === "failed");
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${task.taskId}/cancel`,
      });
      expect(response.statusCode).toBe(409);
      await app.close();
    });

    it("returns 409 for an already-cancelled task", async () => {
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
      await waitUntil(() => harness.taskStore.get(task.taskId).eventCount >= 1);
      await app.inject({ method: "POST", url: `/api/v1/tasks/${task.taskId}/cancel` });
      await waitUntil(() => harness.taskStore.get(task.taskId).task.status === "cancelled");
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${task.taskId}/cancel`,
      });
      expect(response.statusCode).toBe(409);
      await app.close();
    });
  });
});
