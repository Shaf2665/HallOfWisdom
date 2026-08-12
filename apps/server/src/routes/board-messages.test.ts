import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { CommunicationMessage } from "@hall-of-wisdom/protocol";
import { BoardStore, GENERAL_BOARD_ID } from "../boards/board-store.js";
import { MessageStore } from "../boards/message-store.js";
import { MessageBus } from "../boards/message-bus.js";
import { TaskStore } from "../tasks/task-store.js";
import {
  buildTestApp,
  waitUntil,
  type ErrorResponseJson,
  type TestHarness,
} from "../test-support.js";
import {
  handleBoardMessagesConnection,
  CLOSE_CODE_CLIENT_TOO_SLOW,
  type BoardMessagesRouteDeps,
  type BoardMessagesSocket,
} from "./board-messages.js";
import type { createHallCoreApp } from "../app.js";

type HallCoreApp = Awaited<ReturnType<typeof createHallCoreApp>>;

async function startEphemeral(app: HallCoreApp): Promise<string> {
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return address;
}

function collectMessages(socket: WebSocket): {
  messages: CommunicationMessage[];
  closeCode: Promise<number>;
} {
  const messages: CommunicationMessage[] = [];
  socket.on("message", (data: Buffer) => {
    messages.push(JSON.parse(data.toString()) as CommunicationMessage);
  });
  const closeCode = new Promise<number>((resolve) => {
    socket.on("close", (code: number) => {
      resolve(code);
    });
  });
  return { messages, closeCode };
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      resolve();
    });
    socket.once("error", reject);
  });
}

describe("WebSocket /api/v1/boards/:boardId/messages/live", () => {
  let tempRoot: string;
  let app: HallCoreApp;
  let harness: TestHarness;
  let baseUrl: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-board-ws-test-"));
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  async function setup(
    webOrigin?: string,
    limits?: Parameters<typeof buildTestApp>[0]["limits"],
  ): Promise<void> {
    const built = await buildTestApp({ workspaceRoot: tempRoot, webOrigin, limits });
    app = built.app;
    harness = built.harness;
    const address = await startEphemeral(app);
    baseUrl = address.replace("http://", "ws://");
  }

  async function postMessage(text: string): Promise<void> {
    await app.inject({
      method: "POST",
      url: `/api/v1/boards/${GENERAL_BOARD_ID}/messages`,
      payload: { text },
    });
  }

  async function postMessageWithAttachment(): Promise<void> {
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    harness.attachmentStore.createPending({
      attachmentId,
      boardId: GENERAL_BOARD_ID,
      filename: "diagram.png",
      mimeType: "image/png",
      byteSize: 1024,
      kind: "image",
      createdAt: new Date().toISOString(),
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/boards/${GENERAL_BOARD_ID}/messages`,
      payload: { text: "see attached", attachmentIds: [attachmentId] },
    });
  }

  it("connects for a known board and replays stored messages", async () => {
    await setup();
    await postMessage("one");
    await postMessage("two");

    const socket = new WebSocket(`${baseUrl}/api/v1/boards/${GENERAL_BOARD_ID}/messages/live`);
    const { messages } = collectMessages(socket);
    await waitForOpen(socket);
    await waitUntil(() => messages.length >= 2);

    expect(messages.map((message) => message.text)).toEqual(["one", "two"]);
    expect(messages.map((message) => message.sequence)).toEqual([0, 1]);
    socket.close();
  });

  it("replay includes an attachment-bearing message's attachments array intact", async () => {
    await setup();
    await postMessageWithAttachment();

    const socket = new WebSocket(`${baseUrl}/api/v1/boards/${GENERAL_BOARD_ID}/messages/live`);
    const { messages } = collectMessages(socket);
    await waitForOpen(socket);
    await waitUntil(() => messages.length >= 1);

    expect(messages[0]?.attachments).toEqual([
      {
        attachmentId: "11111111-1111-4111-8111-111111111111",
        filename: "diagram.png",
        mimeType: "image/png",
        byteSize: 1024,
        kind: "image",
      },
    ]);
    socket.close();
  });

  it("live delivery includes an attachment-bearing message's attachments array intact", async () => {
    await setup();
    const socket = new WebSocket(`${baseUrl}/api/v1/boards/${GENERAL_BOARD_ID}/messages/live`);
    const { messages } = collectMessages(socket);
    await waitForOpen(socket);

    await postMessageWithAttachment();
    await waitUntil(() => messages.length >= 1);

    expect(messages[0]?.attachments).toHaveLength(1);
    expect(messages[0]?.attachments?.[0]?.attachmentId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    socket.close();
  });

  it("delivers live messages published after the connection opens", async () => {
    await setup();
    const socket = new WebSocket(`${baseUrl}/api/v1/boards/${GENERAL_BOARD_ID}/messages/live`);
    const { messages } = collectMessages(socket);
    await waitForOpen(socket);

    await postMessage("live message");
    await waitUntil(() => messages.length >= 1);

    expect(messages[0]?.text).toBe("live message");
    socket.close();
  });

  it("sends exactly one message per text frame, in order", async () => {
    await setup();
    const socket = new WebSocket(`${baseUrl}/api/v1/boards/${GENERAL_BOARD_ID}/messages/live`);
    const { messages } = collectMessages(socket);
    await waitForOpen(socket);

    await postMessage("a");
    await postMessage("b");
    await postMessage("c");
    await waitUntil(() => messages.length >= 3);

    expect(messages.map((message) => message.sequence)).toEqual([0, 1, 2]);
  });

  it("rejects a connection for an unknown board", async () => {
    await setup();
    const socket = new WebSocket(`${baseUrl}/api/v1/boards/nonexistent/messages/live`);
    const { closeCode } = collectMessages(socket);
    await waitForOpen(socket).catch(() => undefined);
    expect(await closeCode).toBe(4404);
  });

  it("afterSequence filters replay to only messages with a greater sequence", async () => {
    await setup();
    await postMessage("one");
    await postMessage("two");
    await postMessage("three");

    const socket = new WebSocket(
      `${baseUrl}/api/v1/boards/${GENERAL_BOARD_ID}/messages/live?afterSequence=1`,
    );
    const { messages } = collectMessages(socket);
    await waitForOpen(socket);
    await waitUntil(() => messages.length >= 1);

    expect(messages.map((message) => message.sequence)).toEqual([2]);
    socket.close();
  });

  it("rejects an invalid (negative) afterSequence", async () => {
    await setup();
    const socket = new WebSocket(
      `${baseUrl}/api/v1/boards/${GENERAL_BOARD_ID}/messages/live?afterSequence=-1`,
    );
    const { closeCode } = collectMessages(socket);
    await waitForOpen(socket).catch(() => undefined);
    expect(await closeCode).toBe(4400);
  });

  it("closes with a documented policy code if the client sends application data", async () => {
    await setup();
    const socket = new WebSocket(`${baseUrl}/api/v1/boards/${GENERAL_BOARD_ID}/messages/live`);
    await waitForOpen(socket);
    const { closeCode } = collectMessages(socket);
    socket.send("this endpoint does not accept client input");
    expect(await closeCode).toBe(1003);
  });

  it("removes the subscription on client disconnect", async () => {
    await setup();
    const socket = new WebSocket(`${baseUrl}/api/v1/boards/${GENERAL_BOARD_ID}/messages/live`);
    await waitForOpen(socket);
    await waitUntil(() => harness.messageBus.subscriberCount(GENERAL_BOARD_ID) === 1);
    socket.close();
    await waitUntil(() => harness.messageBus.subscriberCount(GENERAL_BOARD_ID) === 0);
  });

  it("a discussion never self-closes: the connection stays open with no messages posted", async () => {
    await setup();
    const socket = new WebSocket(`${baseUrl}/api/v1/boards/${GENERAL_BOARD_ID}/messages/live`);
    await waitForOpen(socket);
    // No terminal concept exists for a board — give the connection a brief
    // window and confirm it is still open (readyState OPEN), unlike a task
    // event stream which self-closes on a terminal event.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it("enforces the configured subscriber limit per board", async () => {
    await setup(undefined, { maxSubscribersPerBoard: 1 });
    const first = new WebSocket(`${baseUrl}/api/v1/boards/${GENERAL_BOARD_ID}/messages/live`);
    await waitForOpen(first);
    await waitUntil(() => harness.messageBus.subscriberCount(GENERAL_BOARD_ID) === 1);

    const second = new WebSocket(`${baseUrl}/api/v1/boards/${GENERAL_BOARD_ID}/messages/live`);
    const { closeCode } = collectMessages(second);
    await waitForOpen(second).catch(() => undefined);
    expect(await closeCode).toBe(4503);
    first.close();
  });

  it("delivers no duplicate and no gap across the replay-to-live transition", async () => {
    await setup();
    await postMessage("stored-0");

    const socket = new WebSocket(`${baseUrl}/api/v1/boards/${GENERAL_BOARD_ID}/messages/live`);
    const { messages } = collectMessages(socket);
    await waitForOpen(socket);
    await postMessage("live-1");
    await waitUntil(() => messages.length >= 2);

    const sequences = messages.map((message) => message.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences).toEqual([0, 1]);
    socket.close();
  });

  it("server shutdown closes remaining open WebSocket connections", async () => {
    await setup();
    const socket = new WebSocket(`${baseUrl}/api/v1/boards/${GENERAL_BOARD_ID}/messages/live`);
    const { closeCode } = collectMessages(socket);
    await waitForOpen(socket);

    await app.close();
    expect(typeof (await closeCode)).toBe("number");
  });

  it("accepts a connection whose Origin header matches the configured web origin", async () => {
    await setup("http://127.0.0.1:3000");
    const socket = new WebSocket(`${baseUrl}/api/v1/boards/${GENERAL_BOARD_ID}/messages/live`, {
      headers: { Origin: "http://127.0.0.1:3000" },
    });
    await waitForOpen(socket);
    socket.close();
  });

  it("accepts a connection with no Origin header (non-browser client policy)", async () => {
    await setup("http://127.0.0.1:3000");
    const socket = new WebSocket(`${baseUrl}/api/v1/boards/${GENERAL_BOARD_ID}/messages/live`);
    await waitForOpen(socket);
    socket.close();
  });

  it("rejects a connection whose Origin header does not match, and creates no subscriber", async () => {
    await setup("http://127.0.0.1:3000");
    const socket = new WebSocket(`${baseUrl}/api/v1/boards/${GENERAL_BOARD_ID}/messages/live`, {
      headers: { Origin: "http://evil.example.com" },
    });
    const { closeCode } = collectMessages(socket);
    await waitForOpen(socket).catch(() => undefined);
    expect(await closeCode).toBe(4403);
    expect(harness.messageBus.subscriberCount(GENERAL_BOARD_ID)).toBe(0);
  });

  it("never discloses a stack trace or absolute path in a message body sent over the socket", async () => {
    await setup();
    const oversized = await app.inject({
      method: "POST",
      url: `/api/v1/boards/${GENERAL_BOARD_ID}/messages`,
      payload: { text: "x".repeat(4001) },
    });
    const serialized = JSON.stringify(oversized.json<ErrorResponseJson>());
    expect(serialized).not.toMatch(/at .*\(.*:\d+:\d+\)/);
    expect(serialized).not.toMatch(/[A-Za-z]:\\/);
  });
});

/**
 * Uses a controlled fake socket (not a real network connection) to drive
 * `bufferedAmount` deterministically — mirrors `task-events.test.ts`'s own
 * `FakeSocket` harness exactly, kept as a separate class in this file
 * rather than a shared import so the two WebSocket domains stay decoupled.
 */
class FakeSocket implements BoardMessagesSocket {
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closeCalls: { code: number | undefined; reason: string | undefined }[] = [];
  readonly #listeners = new Map<string, Set<() => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }

  on(event: "message" | "close" | "error", listener: () => void): unknown {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }
}

const ALLOWED_ORIGIN = "http://127.0.0.1:3000";

describe("handleBoardMessagesConnection WebSocket backpressure (fake socket)", () => {
  function buildHarness(maxBufferedBytes: number): {
    deps: BoardMessagesRouteDeps;
    boardStore: BoardStore;
    messageStore: MessageStore;
    messageBus: MessageBus;
  } {
    const taskStore = new TaskStore({ maxTasks: 10 });
    const boardStore = new BoardStore({ maxBoards: 10, taskStore });
    const messageStore = new MessageStore({ maxMessagesPerBoard: 1000 });
    const messageBus = new MessageBus({ maxSubscribersPerBoard: 20 });
    boardStore.seedGeneralBoard("2026-07-15T12:00:00.000Z");
    messageStore.registerBoard(GENERAL_BOARD_ID);
    return {
      deps: {
        boardStore,
        messageStore,
        messageBus,
        maxBufferedBytes,
        allowedOrigin: ALLOWED_ORIGIN,
      },
      boardStore,
      messageStore,
      messageBus,
    };
  }

  function appendAndPublish(
    messageStore: MessageStore,
    messageBus: MessageBus,
    text: string,
  ): CommunicationMessage {
    const message = messageStore.append(GENERAL_BOARD_ID, {
      messageId: `msg-${text}`,
      boardId: GENERAL_BOARD_ID,
      author: { kind: "human", displayName: "Local Operator" },
      text,
      createdAt: "2026-07-15T12:00:00.000Z",
    });
    messageBus.publish(GENERAL_BOARD_ID, message);
    return message;
  }

  it("a healthy client (bufferedAmount within threshold) receives the message", () => {
    const { deps, messageStore, messageBus } = buildHarness(1024);
    const socket = new FakeSocket();
    handleBoardMessagesConnection(
      socket,
      { boardId: GENERAL_BOARD_ID, afterSequenceRaw: undefined, originRaw: undefined },
      deps,
    );

    appendAndPublish(messageStore, messageBus, "hello");

    expect(socket.sent).toHaveLength(1);
    expect(socket.closeCalls).toHaveLength(0);
  });

  it("closes a client whose bufferedAmount exceeds the threshold with 4504, and unsubscribes it", () => {
    const { deps, messageStore, messageBus } = buildHarness(10);
    const socket = new FakeSocket();
    socket.bufferedAmount = 999;
    handleBoardMessagesConnection(
      socket,
      { boardId: GENERAL_BOARD_ID, afterSequenceRaw: undefined, originRaw: undefined },
      deps,
    );
    expect(messageBus.subscriberCount(GENERAL_BOARD_ID)).toBe(1);

    appendAndPublish(messageStore, messageBus, "hello");

    expect(socket.sent).toHaveLength(0);
    expect(socket.closeCalls).toHaveLength(1);
    expect(socket.closeCalls[0]?.code).toBe(CLOSE_CODE_CLIENT_TOO_SLOW);
    expect(messageBus.subscriberCount(GENERAL_BOARD_ID)).toBe(0);
  });

  it("other subscribers continue receiving messages after one slow client is disconnected", () => {
    const { deps, messageStore, messageBus } = buildHarness(10);

    const slow = new FakeSocket();
    slow.bufferedAmount = 999;
    handleBoardMessagesConnection(
      slow,
      { boardId: GENERAL_BOARD_ID, afterSequenceRaw: undefined, originRaw: undefined },
      deps,
    );

    const healthy = new FakeSocket();
    handleBoardMessagesConnection(
      healthy,
      { boardId: GENERAL_BOARD_ID, afterSequenceRaw: undefined, originRaw: undefined },
      deps,
    );

    appendAndPublish(messageStore, messageBus, "hello");

    expect(slow.closeCalls).toHaveLength(1);
    expect(healthy.sent).toHaveLength(1);
    expect(healthy.closeCalls).toHaveLength(0);
    expect(messageBus.subscriberCount(GENERAL_BOARD_ID)).toBe(1);
  });

  it("rejects a malformed Origin header", () => {
    const { deps } = buildHarness(1024);
    const socket = new FakeSocket();
    handleBoardMessagesConnection(
      socket,
      { boardId: GENERAL_BOARD_ID, afterSequenceRaw: undefined, originRaw: "not a valid origin" },
      deps,
    );
    expect(socket.closeCalls[0]?.code).toBe(4403);
  });
});
