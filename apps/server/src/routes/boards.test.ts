import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommunicationBoard, CommunicationMessage } from "@hall-of-wisdom/protocol";
import {
  buildTestApp,
  validDeferredTaskBody,
  type CreateTaskResponseJson,
  type ErrorResponseJson,
} from "../test-support.js";
import { GENERAL_BOARD_ID } from "../boards/board-store.js";

interface ListBoardsResponseJson {
  readonly boards: readonly CommunicationBoard[];
}

interface EnsureBoardResponseJson {
  readonly board: CommunicationBoard;
  readonly messagesPath: string;
  readonly livePath: string;
}

interface ListMessagesResponseJson {
  readonly messages: readonly CommunicationMessage[];
}

describe("REST board routes", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-boards-routes-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("GET /api/v1/boards", () => {
    it("includes the General board", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({ method: "GET", url: "/api/v1/boards" });
      expect(response.statusCode).toBe(200);
      const body = response.json<ListBoardsResponseJson>();
      expect(body.boards.map((board) => board.boardId)).toContain(GENERAL_BOARD_ID);
      expect(body.boards[0]?.boardId).toBe(GENERAL_BOARD_ID);
      await app.close();
    });
  });

  describe("GET /api/v1/boards/:boardId", () => {
    it("succeeds for the General board", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<CommunicationBoard>().kind).toBe("general");
      await app.close();
    });

    it("returns 404 for an unknown board", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({ method: "GET", url: "/api/v1/boards/nonexistent" });
      expect(response.statusCode).toBe(404);
      expect(response.json<ErrorResponseJson>().error.code).toBe("BOARD_NOT_FOUND");
      await app.close();
    });
  });

  describe("POST /api/v1/tasks/:taskId/board", () => {
    async function createDeferredTask(app: Awaited<ReturnType<typeof buildTestApp>>["app"]) {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validDeferredTaskBody(),
      });
      return created.json<CreateTaskResponseJson>();
    }

    it("returns 201 with a board, messagesPath, and livePath when newly created", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const { task } = await createDeferredTask(app);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${task.taskId}/board`,
      });
      expect(response.statusCode).toBe(201);
      const body = response.json<EnsureBoardResponseJson>();
      expect(body.board.kind).toBe("task");
      if (body.board.kind === "task") {
        expect(body.board.taskId).toBe(task.taskId);
      }
      expect(body.messagesPath).toBe(`/api/v1/boards/${body.board.boardId}/messages`);
      expect(body.livePath).toBe(`/api/v1/boards/${body.board.boardId}/messages/live`);
      await app.close();
    });

    it("returns 200 (not 201) and the same board on repeated creation", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const { task } = await createDeferredTask(app);
      const first = await app.inject({ method: "POST", url: `/api/v1/tasks/${task.taskId}/board` });
      const second = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${task.taskId}/board`,
      });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(200);
      expect(second.json<EnsureBoardResponseJson>().board.boardId).toBe(
        first.json<EnsureBoardResponseJson>().board.boardId,
      );
      await app.close();
    });

    it("returns 404 for an unknown task", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tasks/nonexistent/board",
      });
      expect(response.statusCode).toBe(404);
      expect(response.json<ErrorResponseJson>().error.code).toBe("TASK_NOT_FOUND");
      await app.close();
    });

    it("changes no task lifecycle field (status, runId, revision-visible fields all unaffected)", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const { task: before } = await createDeferredTask(app);
      await app.inject({ method: "POST", url: `/api/v1/tasks/${before.taskId}/board` });
      const after = await app.inject({ method: "GET", url: `/api/v1/tasks/${before.taskId}` });
      const afterBody = after.json<CreateTaskResponseJson>();
      expect(afterBody.task.status).toBe(before.status);
      expect(afterBody.runId).toBeUndefined();
      await app.close();
    });

    it("may create a board for a terminal (cancelled) task", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const { task } = await createDeferredTask(app);
      await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${task.taskId}/transition`,
        payload: { targetStatus: "cancelled" },
      });
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${task.taskId}/board`,
      });
      expect(response.statusCode).toBe(201);
      await app.close();
    });
  });

  describe("POST /api/v1/boards/:boardId/messages", () => {
    it("returns 201 with the stored message, including a server-assigned sequence and author", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/messages`,
        payload: { text: "Hello there." },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json<CommunicationMessage>();
      expect(body.sequence).toBe(0);
      expect(body.author).toEqual({ kind: "human", displayName: "Local Operator" });
      expect(body.text).toBe("Hello there.");
      expect(body.boardId).toBe(GENERAL_BOARD_ID);
      await app.close();
    });

    it("rejects a blank message with 400 INVALID_MESSAGE", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/messages`,
        payload: { text: "   " },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorResponseJson>().error.code).toBe("INVALID_MESSAGE");
      await app.close();
    });

    it("rejects an oversized message safely (no stored message, no crash)", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/messages`,
        payload: { text: "x".repeat(4001) },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorResponseJson>().error.code).toBe("INVALID_MESSAGE");
      const list = await app.inject({
        method: "GET",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/messages`,
      });
      expect(list.json<ListMessagesResponseJson>().messages).toHaveLength(0);
      await app.close();
    });

    it("rejects unknown fields", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/messages`,
        payload: { text: "hello", extra: "nope" },
      });
      expect(response.statusCode).toBe(400);
      await app.close();
    });

    it("rejects a client-supplied author (the field does not exist in the accepted shape)", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/messages`,
        payload: { text: "hello", author: { kind: "human", displayName: "Someone Else" } },
      });
      expect(response.statusCode).toBe(400);
      const list = await app.inject({
        method: "GET",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/messages`,
      });
      expect(list.json<ListMessagesResponseJson>().messages).toHaveLength(0);
      await app.close();
    });

    it("returns 404 for an unknown board", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/boards/nonexistent/messages",
        payload: { text: "hello" },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json<ErrorResponseJson>().error.code).toBe("BOARD_NOT_FOUND");
      await app.close();
    });

    it("bounds message-capacity failures with a safe, stable error code", async () => {
      const { app } = await buildTestApp({
        workspaceRoot: tempRoot,
        limits: { maxMessagesPerBoard: 1 },
      });
      await app.inject({
        method: "POST",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/messages`,
        payload: { text: "first" },
      });
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/messages`,
        payload: { text: "second" },
      });
      expect(response.statusCode).toBe(429);
      expect(response.json<ErrorResponseJson>().error.code).toBe("MESSAGE_CAPACITY_REACHED");
      await app.close();
    });

    it("never discloses a stack trace or absolute path in an error response", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/boards/nonexistent/messages",
        payload: { text: "hello" },
      });
      const serialized = JSON.stringify(response.json());
      expect(serialized).not.toMatch(/at .*\(.*:\d+:\d+\)/);
      expect(serialized).not.toContain(tempRoot);
      expect(serialized).not.toMatch(/[A-Za-z]:\\/);
      await app.close();
    });
  });

  describe("GET /api/v1/boards/:boardId/messages", () => {
    async function postMessage(
      app: Awaited<ReturnType<typeof buildTestApp>>["app"],
      text: string,
    ): Promise<void> {
      await app.inject({
        method: "POST",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/messages`,
        payload: { text },
      });
    }

    it("returns messages in sequence order", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      await postMessage(app, "one");
      await postMessage(app, "two");
      await postMessage(app, "three");
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/messages`,
      });
      const body = response.json<ListMessagesResponseJson>();
      expect(body.messages.map((message) => message.sequence)).toEqual([0, 1, 2]);
      expect(body.messages.map((message) => message.text)).toEqual(["one", "two", "three"]);
      await app.close();
    });

    it("afterSequence filters to only messages with a greater sequence", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      await postMessage(app, "one");
      await postMessage(app, "two");
      await postMessage(app, "three");
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/messages?afterSequence=1`,
      });
      const body = response.json<ListMessagesResponseJson>();
      expect(body.messages.map((message) => message.sequence)).toEqual([2]);
      await app.close();
    });

    it("validates afterSequence as a non-negative integer", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/messages?afterSequence=-1`,
      });
      expect(response.statusCode).toBe(400);
      const nonNumeric = await app.inject({
        method: "GET",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/messages?afterSequence=abc`,
      });
      expect(nonNumeric.statusCode).toBe(400);
      await app.close();
    });
  });

  describe("CORS on board routes", () => {
    const ALLOWED_ORIGIN = "http://127.0.0.1:3000";

    it("an allowed Origin receives CORS headers on a board route", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot, webOrigin: ALLOWED_ORIGIN });
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/boards",
        headers: { origin: ALLOWED_ORIGIN },
      });
      expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
      await app.close();
    });

    it("an Origin-less request (PowerShell/curl-style) continues to work on a board route", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot, webOrigin: ALLOWED_ORIGIN });
      const response = await app.inject({ method: "GET", url: "/api/v1/boards" });
      expect(response.statusCode).toBe(200);
      await app.close();
    });
  });
});
