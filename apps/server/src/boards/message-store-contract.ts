import { describe, expect, it } from "vitest";
import type { MessageAttachment } from "@hall-of-wisdom/protocol";
import { BoardNotFoundError, MessageCapacityReachedError } from "../errors/app-error.js";
import type { MessageStorePort } from "./message-store-port.js";

const AUTHOR = { kind: "human" as const, displayName: "Operator" };

const ATTACHMENT: MessageAttachment = {
  attachmentId: "attachment-1",
  filename: "diagram.png",
  mimeType: "image/png",
  byteSize: 1024,
  kind: "image",
};

export interface MessageStoreContractHarness {
  readonly store: MessageStorePort;
  /** Creates a real board row for the durable backend to reference; a no-op for the in-memory backend. */
  readonly createBoard: (boardId: string) => void;
}

/**
 * Behavioral contract every `MessageStorePort` implementation must
 * satisfy — run once against the in-memory `MessageStore` and once
 * against `SqliteMessageStore` (Phase 13's durable-mode sibling). Each
 * test calls `createHarness` exactly once, getting a fresh store (and, for
 * the durable backend, a fresh database) isolated from every other test.
 */
export function defineMessageStoreContractTests(
  label: string,
  createHarness: (maxMessagesPerBoard?: number) => MessageStoreContractHarness,
): void {
  describe(`MessageStorePort contract (${label})`, () => {
    it("appends messages with a store-assigned, monotonically increasing sequence", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      store.registerBoard("board-1");
      const first = store.append("board-1", {
        messageId: "msg-1",
        boardId: "board-1",
        author: AUTHOR,
        text: "hello",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const second = store.append("board-1", {
        messageId: "msg-2",
        boardId: "board-1",
        author: AUTHOR,
        text: "world",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      expect(first.sequence).toBe(0);
      expect(second.sequence).toBe(1);
    });

    it("rejects a boardId mismatch between the argument and the input", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      store.registerBoard("board-1");
      expect(() =>
        store.append("board-1", {
          messageId: "msg-1",
          boardId: "different-board",
          author: AUTHOR,
          text: "hello",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      ).toThrow();
    });

    it("rejects appending to an unknown board", () => {
      const { store } = createHarness();
      expect(() =>
        store.append("does-not-exist", {
          messageId: "msg-1",
          boardId: "does-not-exist",
          author: AUTHOR,
          text: "hello",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      ).toThrow(BoardNotFoundError);
    });

    it("enforces maxMessagesPerBoard", () => {
      const { store, createBoard } = createHarness(1);
      createBoard("board-1");
      store.registerBoard("board-1");
      store.append("board-1", {
        messageId: "msg-1",
        boardId: "board-1",
        author: AUTHOR,
        text: "hello",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(() =>
        store.append("board-1", {
          messageId: "msg-2",
          boardId: "board-1",
          author: AUTHOR,
          text: "world",
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
      ).toThrow(MessageCapacityReachedError);
    });

    it("list(afterSequence) returns only messages strictly after the given sequence, in order", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      store.registerBoard("board-1");
      for (let i = 0; i < 3; i += 1) {
        store.append("board-1", {
          messageId: `msg-${String(i)}`,
          boardId: "board-1",
          author: AUTHOR,
          text: `message ${String(i)}`,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
      }
      expect(store.list("board-1", 0).map((m) => m.sequence)).toEqual([1, 2]);
    });

    it("nextSequence reflects the current message count", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      store.registerBoard("board-1");
      expect(store.nextSequence("board-1")).toBe(0);
      store.append("board-1", {
        messageId: "msg-1",
        boardId: "board-1",
        author: AUTHOR,
        text: "hello",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(store.nextSequence("board-1")).toBe(1);
    });

    it("appends and returns a message with attachments intact", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      store.registerBoard("board-1");
      const message = store.append("board-1", {
        messageId: "msg-1",
        boardId: "board-1",
        author: AUTHOR,
        text: "see attached",
        attachments: [ATTACHMENT],
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(message.attachments).toEqual([ATTACHMENT]);
    });

    it("list() returns attachments intact for a stored message", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      store.registerBoard("board-1");
      store.append("board-1", {
        messageId: "msg-1",
        boardId: "board-1",
        author: AUTHOR,
        text: "see attached",
        attachments: [ATTACHMENT],
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const [message] = store.list("board-1");
      expect(message?.attachments).toEqual([ATTACHMENT]);
    });

    it("omits the attachments field entirely (never an empty array) when none are given", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      store.registerBoard("board-1");
      const message = store.append("board-1", {
        messageId: "msg-1",
        boardId: "board-1",
        author: AUTHOR,
        text: "plain text",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(message.attachments).toBeUndefined();
      expect(Object.keys(message)).not.toContain("attachments");
    });

    it("omits the attachments field when an empty array is explicitly given", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      store.registerBoard("board-1");
      const message = store.append("board-1", {
        messageId: "msg-1",
        boardId: "board-1",
        author: AUTHOR,
        text: "plain text",
        attachments: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(message.attachments).toBeUndefined();
      expect(Object.keys(message)).not.toContain("attachments");
    });

    it("an attachments-only message (blank text) can be appended and listed", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      store.registerBoard("board-1");
      const message = store.append("board-1", {
        messageId: "msg-1",
        boardId: "board-1",
        author: AUTHOR,
        text: "",
        attachments: [ATTACHMENT],
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(message.text).toBe("");
      expect(message.attachments).toEqual([ATTACHMENT]);
    });

    it("two different boards have completely independent message histories", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-a");
      createBoard("board-b");
      store.registerBoard("board-a");
      store.registerBoard("board-b");
      store.append("board-a", {
        messageId: "msg-1",
        boardId: "board-a",
        author: AUTHOR,
        text: "only on a",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(store.list("board-b")).toHaveLength(0);
    });
  });
}
