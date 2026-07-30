import { describe, expect, it } from "vitest";
import { communicationMessageSchema } from "@hall-of-wisdom/protocol";
import { BoardNotFoundError, MessageBoardIdentityMismatchError } from "../errors/app-error.js";
import { MessageStore } from "./message-store.js";

const LOCAL_OPERATOR = { kind: "human" as const, displayName: "Local Operator" };

function newStore(maxMessagesPerBoard = 1000): MessageStore {
  const store = new MessageStore({ maxMessagesPerBoard });
  store.registerBoard("board-1");
  return store;
}

describe("MessageStore", () => {
  it("gives the first message sequence zero", () => {
    const store = newStore();
    const message = store.append("board-1", {
      messageId: "msg-1",
      boardId: "board-1",
      author: LOCAL_OPERATOR,
      text: "hello",
      createdAt: "2026-07-15T12:00:00.000Z",
    });
    expect(message.sequence).toBe(0);
  });

  it("assigns strictly contiguous sequences for successive appends", () => {
    const store = newStore();
    const sequences = Array.from(
      { length: 5 },
      (_, index) =>
        store.append("board-1", {
          messageId: `msg-${String(index)}`,
          boardId: "board-1",
          author: LOCAL_OPERATOR,
          text: `message ${String(index)}`,
          createdAt: "2026-07-15T12:00:00.000Z",
        }).sequence,
    );
    expect(sequences).toEqual([0, 1, 2, 3, 4]);
  });

  it("assigns unique sequences to concurrent-looking appends (no await between read and write)", () => {
    const store = newStore();
    // Simulates two "concurrent" requests handled back-to-back within the
    // same synchronous tick — append() performs no I/O and awaits nothing,
    // so this is representative of genuine concurrent POSTs.
    const first = store.append("board-1", {
      messageId: "msg-a",
      boardId: "board-1",
      author: LOCAL_OPERATOR,
      text: "a",
      createdAt: "2026-07-15T12:00:00.000Z",
    });
    const second = store.append("board-1", {
      messageId: "msg-b",
      boardId: "board-1",
      author: LOCAL_OPERATOR,
      text: "b",
      createdAt: "2026-07-15T12:00:00.000Z",
    });
    expect(new Set([first.sequence, second.sequence]).size).toBe(2);
    expect([first.sequence, second.sequence].sort()).toEqual([0, 1]);
  });

  it("rejects append to an unknown board", () => {
    const store = newStore();
    expect(() => {
      store.append("unknown-board", {
        messageId: "msg-1",
        boardId: "unknown-board",
        author: LOCAL_OPERATOR,
        text: "hello",
        createdAt: "2026-07-15T12:00:00.000Z",
      });
    }).toThrow(BoardNotFoundError);
  });

  it("rejects list() for an unknown board", () => {
    const store = newStore();
    expect(() => store.list("unknown-board")).toThrow(BoardNotFoundError);
  });

  it("enforces the configured message capacity per board", () => {
    const store = newStore(2);
    store.append("board-1", {
      messageId: "msg-1",
      boardId: "board-1",
      author: LOCAL_OPERATOR,
      text: "one",
      createdAt: "2026-07-15T12:00:00.000Z",
    });
    store.append("board-1", {
      messageId: "msg-2",
      boardId: "board-1",
      author: LOCAL_OPERATOR,
      text: "two",
      createdAt: "2026-07-15T12:00:00.000Z",
    });
    expect(() => {
      store.append("board-1", {
        messageId: "msg-3",
        boardId: "board-1",
        author: LOCAL_OPERATOR,
        text: "three",
        createdAt: "2026-07-15T12:00:00.000Z",
      });
    }).toThrow(/capacity/i);
  });

  it("a failed append (capacity reached) does not change the stored message count", () => {
    const store = newStore(1);
    store.append("board-1", {
      messageId: "msg-1",
      boardId: "board-1",
      author: LOCAL_OPERATOR,
      text: "one",
      createdAt: "2026-07-15T12:00:00.000Z",
    });
    expect(() => {
      store.append("board-1", {
        messageId: "msg-2",
        boardId: "board-1",
        author: LOCAL_OPERATOR,
        text: "two",
        createdAt: "2026-07-15T12:00:00.000Z",
      });
    }).toThrow();
    expect(store.list("board-1")).toHaveLength(1);
    expect(store.nextSequence("board-1")).toBe(1);
  });

  it("rejects a cross-board identity mismatch (input.boardId disagrees with the target boardId)", () => {
    const store = newStore();
    store.registerBoard("board-2");
    expect(() => {
      store.append("board-1", {
        messageId: "msg-1",
        boardId: "board-2",
        author: LOCAL_OPERATOR,
        text: "hello",
        createdAt: "2026-07-15T12:00:00.000Z",
      });
    }).toThrow(MessageBoardIdentityMismatchError);
  });

  it("never lets a message appended to one board appear in another board's list", () => {
    const store = newStore();
    store.registerBoard("board-2");
    store.append("board-1", {
      messageId: "msg-1",
      boardId: "board-1",
      author: LOCAL_OPERATOR,
      text: "for board 1",
      createdAt: "2026-07-15T12:00:00.000Z",
    });
    expect(store.list("board-2")).toHaveLength(0);
  });

  it("afterSequence returns only messages with a strictly greater sequence", () => {
    const store = newStore();
    for (let index = 0; index < 5; index += 1) {
      store.append("board-1", {
        messageId: `msg-${String(index)}`,
        boardId: "board-1",
        author: LOCAL_OPERATOR,
        text: `message ${String(index)}`,
        createdAt: "2026-07-15T12:00:00.000Z",
      });
    }
    const afterTwo = store.list("board-1", 2);
    expect(afterTwo.map((message) => message.sequence)).toEqual([3, 4]);
  });

  it("omitting afterSequence returns every stored message", () => {
    const store = newStore();
    store.append("board-1", {
      messageId: "msg-1",
      boardId: "board-1",
      author: LOCAL_OPERATOR,
      text: "one",
      createdAt: "2026-07-15T12:00:00.000Z",
    });
    expect(store.list("board-1")).toHaveLength(1);
  });

  it("returns defensive copies that cannot mutate stored state", () => {
    const store = newStore();
    const stored = store.append("board-1", {
      messageId: "msg-1",
      boardId: "board-1",
      author: LOCAL_OPERATOR,
      text: "original",
      createdAt: "2026-07-15T12:00:00.000Z",
    });
    const mutable = stored as { text: string };
    mutable.text = "mutated";
    expect(store.list("board-1")[0]?.text).toBe("original");
  });

  it("stores exactly the author it is given (author assignment is the caller's responsibility, not this store's)", () => {
    const store = newStore();
    const message = store.append("board-1", {
      messageId: "msg-1",
      boardId: "board-1",
      author: LOCAL_OPERATOR,
      text: "hello",
      createdAt: "2026-07-15T12:00:00.000Z",
    });
    expect(message.author).toEqual(LOCAL_OPERATOR);
  });

  it("every stored message passes protocol-level validation", () => {
    const store = newStore();
    for (let index = 0; index < 3; index += 1) {
      store.append("board-1", {
        messageId: `msg-${String(index)}`,
        boardId: "board-1",
        author: LOCAL_OPERATOR,
        text: `message ${String(index)}`,
        createdAt: "2026-07-15T12:00:00.000Z",
      });
    }
    for (const message of store.list("board-1")) {
      expect(communicationMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  it("registerBoard is idempotent", () => {
    const store = newStore();
    store.registerBoard("board-1");
    store.registerBoard("board-1");
    const message = store.append("board-1", {
      messageId: "msg-1",
      boardId: "board-1",
      author: LOCAL_OPERATOR,
      text: "hello",
      createdAt: "2026-07-15T12:00:00.000Z",
    });
    expect(message.sequence).toBe(0);
  });

  describe("snapshot/restore (Phase 14.1 — ephemeral atomic delegation)", () => {
    it("restore() undoes messages appended after the snapshot", () => {
      const store = newStore();
      store.append("board-1", {
        messageId: "msg-1",
        boardId: "board-1",
        author: LOCAL_OPERATOR,
        text: "before snapshot",
        createdAt: "2026-07-15T12:00:00.000Z",
      });
      const snap = store.snapshot();

      store.append("board-1", {
        messageId: "msg-2",
        boardId: "board-1",
        author: LOCAL_OPERATOR,
        text: "after snapshot",
        createdAt: "2026-07-15T12:01:00.000Z",
      });

      store.restore(snap);

      const messages = store.list("board-1");
      expect(messages).toHaveLength(1);
      expect(messages[0]?.text).toBe("before snapshot");
      // The next append after a restore reuses the sequence the rolled-back
      // message occupied — proving the store's own bookkeeping (not just
      // the visible list) was genuinely rolled back, not just filtered.
      const next = store.append("board-1", {
        messageId: "msg-3",
        boardId: "board-1",
        author: LOCAL_OPERATOR,
        text: "third",
        createdAt: "2026-07-15T12:02:00.000Z",
      });
      expect(next.sequence).toBe(1);
    });

    it("restore() undoes registerBoard() called after the snapshot", () => {
      const store = newStore();
      const snap = store.snapshot();
      store.registerBoard("board-2");
      store.restore(snap);
      expect(() => store.list("board-2")).toThrow(BoardNotFoundError);
    });
  });
});
