import { afterEach, describe, expect, it } from "vitest";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { CorruptRecordError } from "../persistence/persistence-errors.js";
import { SqliteAttachmentStore } from "./sqlite-attachment-store.js";
import { defineAttachmentStoreContractTests } from "./attachment-store-contract.js";

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

defineAttachmentStoreContractTests("SqliteAttachmentStore", () => {
  const db = openMigratedDatabase();
  return {
    store: new SqliteAttachmentStore({ db }),
    createBoard: (boardId: string) => {
      insertBoardRow(db, boardId);
    },
  };
});

describe("SqliteAttachmentStore — SQLite-specific behavior", () => {
  it("rejects an upload targeting an unknown board (foreign key)", () => {
    const db = openMigratedDatabase();
    const store = new SqliteAttachmentStore({ db });
    expect(() =>
      { store.createPending({
        attachmentId: "11111111-1111-4111-8111-111111111111",
        boardId: "does-not-exist",
        filename: "f.png",
        mimeType: "image/png",
        byteSize: 10,
        kind: "image",
        createdAt: "2026-01-01T00:00:00.000Z",
      }); },
    ).toThrow();
  });

  it("rejects malformed stored attachment metadata with CorruptRecordError", () => {
    const db = openMigratedDatabase();
    insertBoardRow(db, "board-1");
    const store = new SqliteAttachmentStore({ db });
    store.createPending({
      attachmentId: "11111111-1111-4111-8111-111111111111",
      boardId: "board-1",
      filename: "f.png",
      mimeType: "image/png",
      byteSize: 10,
      kind: "image",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    db.exec(`UPDATE attachments SET byte_size = -1`);
    expect(() =>
      store.resolvePending("board-1", ["11111111-1111-4111-8111-111111111111"]),
    ).toThrow(CorruptRecordError);
  });

  it("attachments persist across a fresh SqliteAttachmentStore instance reopening the same database", () => {
    const db = HallDatabase.openInMemory();
    runMigrations(db);
    openDatabases.push(db);
    insertBoardRow(db, "board-1");
    const storeA = new SqliteAttachmentStore({ db });
    storeA.createPending({
      attachmentId: "11111111-1111-4111-8111-111111111111",
      boardId: "board-1",
      filename: "f.png",
      mimeType: "image/png",
      byteSize: 10,
      kind: "image",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    storeA.link("board-1", ["11111111-1111-4111-8111-111111111111"], "msg-1");

    const storeB = new SqliteAttachmentStore({ db });
    expect(storeB.getLinked("board-1", "11111111-1111-4111-8111-111111111111")).toEqual({
      attachmentId: "11111111-1111-4111-8111-111111111111",
      filename: "f.png",
      mimeType: "image/png",
      byteSize: 10,
      kind: "image",
    });
  });
});
