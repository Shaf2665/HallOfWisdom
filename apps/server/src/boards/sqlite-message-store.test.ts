import { afterEach, describe, expect, it } from "vitest";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { CorruptRecordError } from "../persistence/persistence-errors.js";
import { SqliteMessageStore } from "./sqlite-message-store.js";
import { defineMessageStoreContractTests } from "./message-store-contract.js";

const openDatabases: HallDatabase[] = [];
function openMigratedDatabase(): HallDatabase {
  const db = HallDatabase.openInMemory();
  runMigrations(db);
  openDatabases.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close();
});

function insertBoardRow(db: HallDatabase, boardId: string): void {
  db.prepare(
    `INSERT INTO boards (board_id, kind, title, created_at, updated_at, message_count)
     VALUES (?, 'general', 'Test board', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0)`,
  ).run(boardId);
}

defineMessageStoreContractTests("SqliteMessageStore", (maxMessagesPerBoard = 1000) => {
  const db = openMigratedDatabase();
  return {
    store: new SqliteMessageStore({ db, maxMessagesPerBoard }),
    createBoard: (boardId: string) => {
      insertBoardRow(db, boardId);
    },
  };
});

describe("SqliteMessageStore — SQLite-specific behavior", () => {
  it("rejects malformed stored author JSON with CorruptRecordError", () => {
    const db = openMigratedDatabase();
    insertBoardRow(db, "board-1");
    const store = new SqliteMessageStore({ db, maxMessagesPerBoard: 100 });
    store.registerBoard("board-1");
    store.append("board-1", {
      messageId: "msg-1",
      boardId: "board-1",
      author: { kind: "human", displayName: "Operator" },
      text: "hello",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    db.exec(`UPDATE messages SET author_json = 'not valid json{{{'`);
    expect(() => store.list("board-1")).toThrow(CorruptRecordError);
  });

  it("rejects malformed stored attachments JSON with CorruptRecordError", () => {
    const db = openMigratedDatabase();
    insertBoardRow(db, "board-1");
    const store = new SqliteMessageStore({ db, maxMessagesPerBoard: 100 });
    store.registerBoard("board-1");
    store.append("board-1", {
      messageId: "msg-1",
      boardId: "board-1",
      author: { kind: "human", displayName: "Operator" },
      text: "hello",
      attachments: [
        { attachmentId: "a1", filename: "f.png", mimeType: "image/png", byteSize: 10, kind: "image" },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    db.exec(`UPDATE messages SET attachments_json = 'not valid json{{{'`);
    expect(() => store.list("board-1")).toThrow(CorruptRecordError);
  });

  it("attachments persist across a fresh SqliteMessageStore instance reopening the same database", () => {
    const db = HallDatabase.openInMemory();
    runMigrations(db);
    openDatabases.push(db);
    insertBoardRow(db, "board-1");
    const storeA = new SqliteMessageStore({ db, maxMessagesPerBoard: 100 });
    storeA.registerBoard("board-1");
    storeA.append("board-1", {
      messageId: "msg-1",
      boardId: "board-1",
      author: { kind: "human", displayName: "Operator" },
      text: "see attached",
      attachments: [
        { attachmentId: "a1", filename: "f.png", mimeType: "image/png", byteSize: 10, kind: "image" },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const storeB = new SqliteMessageStore({ db, maxMessagesPerBoard: 100 });
    const [message] = storeB.list("board-1");
    expect(message?.attachments).toEqual([
      { attachmentId: "a1", filename: "f.png", mimeType: "image/png", byteSize: 10, kind: "image" },
    ]);
  });

  it("messages persist across a fresh SqliteMessageStore instance reopening the same database", () => {
    const db = HallDatabase.openInMemory();
    runMigrations(db);
    openDatabases.push(db);
    insertBoardRow(db, "board-1");
    const storeA = new SqliteMessageStore({ db, maxMessagesPerBoard: 100 });
    storeA.registerBoard("board-1");
    storeA.append("board-1", {
      messageId: "msg-1",
      boardId: "board-1",
      author: { kind: "human", displayName: "Operator" },
      text: "hello",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const storeB = new SqliteMessageStore({ db, maxMessagesPerBoard: 100 });
    expect(storeB.list("board-1")).toHaveLength(1);
    expect(storeB.nextSequence("board-1")).toBe(1);
  });
});
