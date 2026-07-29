import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseClosedError } from "./persistence-errors.js";
import { HallDatabase } from "./database.js";

describe("HallDatabase", () => {
  let dataDir: string | undefined;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it("opens an in-memory database and executes statements", () => {
    const db = HallDatabase.openInMemory();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    db.prepare("INSERT INTO t (id) VALUES (?)").run(1);
    const row = db.prepare("SELECT id FROM t WHERE id = ?").get(1);
    expect(row).toEqual({ id: 1 });
    db.close();
  });

  it("creates the database file only under the given dataDir (durable mode)", () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hall-db-test-"));
    const db = HallDatabase.open({ dataDir, busyTimeoutMs: 2000 });
    expect(db.filePath).toBe(path.join(dataDir, "hall-core.db"));
    expect(fs.existsSync(db.filePath ?? "")).toBe(true);
    db.close();
  });

  it("enables foreign key enforcement", () => {
    const db = HallDatabase.openInMemory();
    db.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
    db.exec("CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))");
    expect(() => {
      db.prepare("INSERT INTO child (id, parent_id) VALUES (1, 999)").run();
    }).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("close() is idempotent", () => {
    const db = HallDatabase.openInMemory();
    db.close();
    expect(() => {
      db.close();
    }).not.toThrow();
    expect(db.closed).toBe(true);
  });

  it("rejects use after close with DatabaseClosedError, never a raw SQLite error", () => {
    const db = HallDatabase.openInMemory();
    db.close();
    expect(() => db.prepare("SELECT 1")).toThrow(DatabaseClosedError);
    expect(() => {
      db.exec("SELECT 1");
    }).toThrow(DatabaseClosedError);
  });

  it("extension loading remains disabled — this wrapper never passes enableLoadExtension", () => {
    const db = HallDatabase.openInMemory();
    expect(() => {
      db.prepare("SELECT load_extension('does-not-matter')").get();
    }).toThrow(/not authorized/);
    db.close();
  });
});
