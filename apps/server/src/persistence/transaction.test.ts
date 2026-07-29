import { describe, expect, it } from "vitest";
import { HallDatabase } from "./database.js";
import { withTransaction } from "./transaction.js";
import { runMigrations } from "./migration-runner.js";
import { acquireDatabaseEpoch } from "./database-ownership-fence.js";
import { OwnershipLostError } from "./persistence-errors.js";

describe("withTransaction", () => {
  it("commits every write when fn succeeds", () => {
    const db = HallDatabase.openInMemory();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    withTransaction(db, () => {
      db.prepare("INSERT INTO t (id, v) VALUES (1, 'a')").run();
      db.prepare("INSERT INTO t (id, v) VALUES (2, 'b')").run();
    });
    const count = (db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c;
    expect(count).toBe(2);
    db.close();
  });

  it("rolls back every write and rethrows when fn throws partway through", () => {
    const db = HallDatabase.openInMemory();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    db.prepare("INSERT INTO t (id, v) VALUES (1, 'pre-existing')").run();

    expect(() => {
      withTransaction(db, () => {
        db.prepare("INSERT INTO t (id, v) VALUES (2, 'should-not-survive')").run();
        throw new Error("simulated failure mid-transaction");
      });
    }).toThrow("simulated failure mid-transaction");

    const rows = db.prepare("SELECT id FROM t ORDER BY id").all() as { id: number }[];
    expect(rows.map((r) => r.id)).toEqual([1]);
    db.close();
  });

  it("returns fn's return value on success", () => {
    const db = HallDatabase.openInMemory();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const result = withTransaction(db, () => {
      db.prepare("INSERT INTO t (id) VALUES (1)").run();
      return "done";
    });
    expect(result).toBe("done");
    db.close();
  });

  it("leaves the database usable for a subsequent transaction after a rollback", () => {
    const db = HallDatabase.openInMemory();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    expect(() => {
      withTransaction(db, () => {
        throw new Error("boom");
      });
    }).toThrow("boom");

    withTransaction(db, () => {
      db.prepare("INSERT INTO t (id) VALUES (1)").run();
    });
    const count = (db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c;
    expect(count).toBe(1);
    db.close();
  });
});

/**
 * Phase 13.2 — durable ownership fencing, exercised directly at
 * `withTransaction`'s level rather than through any one repository, since
 * every repository in the codebase routes through this exact function
 * (see this phase's kickoff, §3: "one fenced transaction boundary, not
 * per-repository checks"). A test proving the fence here is a test
 * proving it for every table `withTransaction` ever touches.
 */
describe("withTransaction — ownership fencing", () => {
  function migratedDb(): HallDatabase {
    const db = HallDatabase.openInMemory();
    runMigrations(db);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    return db;
  }

  // Kickoff §5, item 17 — ephemeral mode (no fence ever set) requires no
  // fencing at all: this is exactly today's pre-Phase-13.2 behavior,
  // unchanged.
  it("performs no fence check at all when no ownership fence has been set on the database", () => {
    const db = migratedDb();
    expect(db.ownershipFence).toBeUndefined();
    withTransaction(db, () => {
      db.prepare("INSERT INTO t (id, v) VALUES (1, 'a')").run();
    });
    const count = (db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c;
    expect(count).toBe(1);
    db.close();
  });

  it("succeeds normally once a fence is set and no takeover has happened", () => {
    const db = migratedDb();
    const fence = acquireDatabaseEpoch(db, "owner-a");
    db.setOwnershipFence(fence);
    withTransaction(db, () => {
      db.prepare("INSERT INTO t (id, v) VALUES (1, 'a')").run();
    });
    const count = (db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c;
    expect(count).toBe(1);
    db.close();
  });

  // Kickoff §5, item 4 (the core guarantee) — a former owner whose epoch
  // has been superseded can never again commit a durable mutation,
  // regardless of what its own in-process state believes.
  it("rejects a mutation with OwnershipLostError once this instance's fence has been superseded", () => {
    const db = migratedDb();
    const staleFence = acquireDatabaseEpoch(db, "owner-a");
    db.setOwnershipFence(staleFence);
    // A different instance takes over — same database connection here
    // only for test convenience; in production this is a second process
    // against the same on-disk file, which is exactly what the frozen-owner
    // process test (kickoff §6) proves against real separate connections.
    acquireDatabaseEpoch(db, "owner-b");

    expect(() => {
      withTransaction(db, () => {
        db.prepare("INSERT INTO t (id, v) VALUES (1, 'should-not-survive')").run();
      });
    }).toThrow(OwnershipLostError);
    db.close();
  });

  // Kickoff §5, item 19 — the rollback is real: nothing the rejected
  // transaction attempted to write is left behind.
  it("rolls back every write attempted inside a rejected fenced transaction", () => {
    const db = migratedDb();
    const staleFence = acquireDatabaseEpoch(db, "owner-a");
    db.setOwnershipFence(staleFence);
    acquireDatabaseEpoch(db, "owner-b");

    expect(() => {
      withTransaction(db, () => {
        db.prepare("INSERT INTO t (id, v) VALUES (1, 'a')").run();
        db.prepare("INSERT INTO t (id, v) VALUES (2, 'b')").run();
      });
    }).toThrow(OwnershipLostError);

    const count = (db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c;
    expect(count).toBe(0);
    db.close();
  });

  // Kickoff §5, item 20 — a rejected transaction leaves revision/sequence
  // counters exactly where they were; nothing partially advances.
  it("leaves a pre-existing row's revision-style counter unchanged after rejection", () => {
    const db = migratedDb();
    db.exec("CREATE TABLE counters (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL)");
    db.prepare("INSERT INTO counters (id, revision) VALUES (1, 0)").run();

    const staleFence = acquireDatabaseEpoch(db, "owner-a");
    db.setOwnershipFence(staleFence);
    acquireDatabaseEpoch(db, "owner-b");

    expect(() => {
      withTransaction(db, () => {
        db.prepare("UPDATE counters SET revision = revision + 1 WHERE id = 1").run();
      });
    }).toThrow(OwnershipLostError);

    const row = db.prepare("SELECT revision FROM counters WHERE id = 1").get() as {
      revision: number;
    };
    expect(row.revision).toBe(0);
    db.close();
  });

  // Kickoff §5, items 9 & 10 — a rejected mutation never reaches the point
  // where a caller could publish an event or update an in-memory
  // projection, because both of those always happen strictly after
  // `withTransaction` returns successfully throughout this codebase (the
  // "persistence-before-publication" invariant — see
  // `events/persistence-before-publication.test.ts`). Proven directly here
  // for the generic caller shape every repository/orchestrator uses.
  it("never reaches code that runs after a successful commit when the fence rejects the transaction", () => {
    const db = migratedDb();
    const staleFence = acquireDatabaseEpoch(db, "owner-a");
    db.setOwnershipFence(staleFence);
    acquireDatabaseEpoch(db, "owner-b");

    let publishedEvent = false;
    let inMemoryProjection = 0;

    expect(() => {
      withTransaction(db, () => {
        db.prepare("INSERT INTO t (id, v) VALUES (1, 'a')").run();
      });
      // Unreachable once the fence rejects — matches every real call site
      // in this codebase, where publication/projection updates are always
      // the statement immediately after a successful `withTransaction`.
      inMemoryProjection += 1;
      publishedEvent = true;
    }).toThrow(OwnershipLostError);

    expect(publishedEvent).toBe(false);
    expect(inMemoryProjection).toBe(0);
    db.close();
  });

  it("leaves the database usable by the new owner after rejecting the former owner's transaction", () => {
    const db = migratedDb();
    const staleFence = acquireDatabaseEpoch(db, "owner-a");
    db.setOwnershipFence(staleFence);
    const newFence = acquireDatabaseEpoch(db, "owner-b");

    expect(() => {
      withTransaction(db, () => {
        db.prepare("INSERT INTO t (id, v) VALUES (1, 'rejected')").run();
      });
    }).toThrow(OwnershipLostError);

    // The new owner's own connection (fence set to `newFence`) is
    // unaffected by the former owner's rejected attempt.
    const newOwnerDb = db;
    newOwnerDb.setOwnershipFence(newFence);
    withTransaction(newOwnerDb, () => {
      newOwnerDb.prepare("INSERT INTO t (id, v) VALUES (2, 'accepted')").run();
    });

    const rows = db.prepare("SELECT id, v FROM t ORDER BY id").all() as {
      id: number;
      v: string;
    }[];
    expect(rows).toEqual([{ id: 2, v: "accepted" }]);
    db.close();
  });
});
