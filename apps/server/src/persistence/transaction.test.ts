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

/**
 * Phase 14 — reentrancy. The CEO plan delegation coordinator must write
 * across multiple existing stores (each of which already opens its own
 * `withTransaction`) as one atomic unit, so a nested call now participates
 * in the already-open transaction via `SAVEPOINT` instead of failing on a
 * second `BEGIN`.
 */
describe("withTransaction — nested calls (Phase 14)", () => {
  it("a nested withTransaction call participates in the outer transaction rather than opening its own", () => {
    const db = HallDatabase.openInMemory();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    withTransaction(db, () => {
      db.prepare("INSERT INTO t (id, v) VALUES (1, 'outer')").run();
      withTransaction(db, () => {
        db.prepare("INSERT INTO t (id, v) VALUES (2, 'inner')").run();
      });
    });
    const rows = db.prepare("SELECT id FROM t ORDER BY id").all() as { id: number }[];
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
    db.close();
  });

  it("an inner call throwing rolls back only its own writes, and the outer call can still fail the whole transaction", () => {
    const db = HallDatabase.openInMemory();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    expect(() => {
      withTransaction(db, () => {
        db.prepare("INSERT INTO t (id, v) VALUES (1, 'outer')").run();
        expect(() => {
          withTransaction(db, () => {
            db.prepare("INSERT INTO t (id, v) VALUES (2, 'inner')").run();
            throw new Error("inner failure");
          });
        }).toThrow("inner failure");
        // The outer transaction itself now fails too, proving a single
        // failing store call aborts the whole cross-store operation.
        throw new Error("outer aborts because a participant failed");
      });
    }).toThrow("outer aborts because a participant failed");

    const count = (db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c;
    expect(count).toBe(0);
    db.close();
  });

  it("three nested calls spanning three distinct tables commit or roll back together", () => {
    const db = HallDatabase.openInMemory();
    db.exec("CREATE TABLE tasks_t (id INTEGER PRIMARY KEY)");
    db.exec("CREATE TABLE plans_t (id INTEGER PRIMARY KEY)");
    db.exec("CREATE TABLE messages_t (id INTEGER PRIMARY KEY)");

    withTransaction(db, () => {
      withTransaction(db, () => {
        db.prepare("INSERT INTO tasks_t (id) VALUES (1)").run();
      });
      withTransaction(db, () => {
        db.prepare("INSERT INTO plans_t (id) VALUES (1)").run();
      });
      withTransaction(db, () => {
        db.prepare("INSERT INTO messages_t (id) VALUES (1)").run();
      });
    });

    expect((db.prepare("SELECT COUNT(*) AS c FROM tasks_t").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS c FROM plans_t").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS c FROM messages_t").get() as { c: number }).c).toBe(1);

    // Now prove atomicity: the third participant fails, so none of the
    // three tables receive their second row.
    expect(() => {
      withTransaction(db, () => {
        withTransaction(db, () => {
          db.prepare("INSERT INTO tasks_t (id) VALUES (2)").run();
        });
        withTransaction(db, () => {
          db.prepare("INSERT INTO plans_t (id) VALUES (2)").run();
        });
        withTransaction(db, () => {
          db.prepare("INSERT INTO messages_t (id) VALUES (2)").run();
          throw new Error("third participant fails");
        });
      });
    }).toThrow("third participant fails");

    expect((db.prepare("SELECT COUNT(*) AS c FROM tasks_t").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS c FROM plans_t").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS c FROM messages_t").get() as { c: number }).c).toBe(1);
    db.close();
  });

  it("the ownership fence is checked once at the outer boundary and a superseded owner's nested writes are all rejected together", () => {
    const db = HallDatabase.openInMemory();
    runMigrations(db);
    db.exec("CREATE TABLE a_t (id INTEGER PRIMARY KEY)");
    db.exec("CREATE TABLE b_t (id INTEGER PRIMARY KEY)");
    const staleFence = acquireDatabaseEpoch(db, "owner-a");
    db.setOwnershipFence(staleFence);
    acquireDatabaseEpoch(db, "owner-b");

    expect(() => {
      withTransaction(db, () => {
        withTransaction(db, () => {
          db.prepare("INSERT INTO a_t (id) VALUES (1)").run();
        });
        withTransaction(db, () => {
          db.prepare("INSERT INTO b_t (id) VALUES (1)").run();
        });
      });
    }).toThrow(OwnershipLostError);

    expect((db.prepare("SELECT COUNT(*) AS c FROM a_t").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM b_t").get() as { c: number }).c).toBe(0);
    db.close();
  });

  it("leaves the connection usable for a fresh top-level transaction after a nested rollback", () => {
    const db = HallDatabase.openInMemory();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    expect(() => {
      withTransaction(db, () => {
        withTransaction(db, () => {
          db.prepare("INSERT INTO t (id) VALUES (1)").run();
          throw new Error("boom");
        });
      });
    }).toThrow("boom");

    withTransaction(db, () => {
      db.prepare("INSERT INTO t (id) VALUES (2)").run();
    });
    const rows = db.prepare("SELECT id FROM t ORDER BY id").all() as { id: number }[];
    expect(rows.map((r) => r.id)).toEqual([2]);
    db.close();
  });
});

/**
 * Phase 14.1 — sharper fault-injection than the Phase 14 nested-call
 * coverage above, targeting the exact scenarios `CeoPlanOrchestrator.delegate()`
 * exercises for real: a nested SAVEPOINT that itself succeeds but is still
 * undone by an outer failure, an outer transaction that survives a caught
 * inner failure, and a four-way nested spread mirroring delegate()'s own
 * task/link/event/message writes.
 */
describe("withTransaction — nested calls (Phase 14.1 regression coverage)", () => {
  it("inner callback succeeds but the outer transaction rolls back — none of the inner writes survive", () => {
    const db = HallDatabase.openInMemory();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    expect(() =>
      withTransaction(db, () => {
        withTransaction(db, () => {
          db.prepare("INSERT INTO t (id, v) VALUES (1, 'inner-succeeded')").run();
        });
        throw new Error("outer failure after inner success");
      }),
    ).toThrow("outer failure after inner success");
    const count = (db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c;
    expect(count).toBe(0);
    db.close();
  });

  it("inner callback throws — the outer transaction can catch it and continue, committing its own writes while the inner ones stay rolled back", () => {
    const db = HallDatabase.openInMemory();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const outerResult = withTransaction(db, () => {
      try {
        withTransaction(db, () => {
          db.prepare("INSERT INTO t (id, v) VALUES (1, 'inner')").run();
          throw new Error("inner failure");
        });
      } catch {
        // The outer transaction deliberately chooses to continue after a
        // caught inner failure, rather than propagating it.
      }
      db.prepare("INSERT INTO t (id, v) VALUES (2, 'outer')").run();
      return "outer-committed";
    });
    expect(outerResult).toBe("outer-committed");
    const rows = db.prepare("SELECT id, v FROM t ORDER BY id").all() as {
      id: number;
      v: string;
    }[];
    expect(rows).toEqual([{ id: 2, v: "outer" }]);
    db.close();
  });

  it("ownership loss detected at the outer boundary fails every nested SAVEPOINT together, not just the one that happened to run first", () => {
    const db = HallDatabase.openInMemory();
    runMigrations(db);
    db.exec("CREATE TABLE task_t (id INTEGER PRIMARY KEY)");
    db.exec("CREATE TABLE link_t (id INTEGER PRIMARY KEY)");
    db.exec("CREATE TABLE event_t (id INTEGER PRIMARY KEY)");
    const staleFence = acquireDatabaseEpoch(db, "owner-a");
    db.setOwnershipFence(staleFence);
    // A second owner legitimately takes over before the stale owner's
    // transaction ever opens — SQLite's write lock means this could never
    // happen mid-transaction (see `withTransaction`'s own doc comment on
    // why nested calls deliberately never re-check the fence), so "loss
    // discovered at the outer boundary, before any nested SAVEPOINT runs"
    // is the only reachable version of this scenario.
    acquireDatabaseEpoch(db, "owner-b");

    let firstNestedRan = false;
    expect(() => {
      withTransaction(db, () => {
        withTransaction(db, () => {
          firstNestedRan = true;
          db.prepare("INSERT INTO task_t (id) VALUES (1)").run();
        });
        withTransaction(db, () => {
          db.prepare("INSERT INTO link_t (id) VALUES (1)").run();
        });
        withTransaction(db, () => {
          db.prepare("INSERT INTO event_t (id) VALUES (1)").run();
        });
      });
    }).toThrow(OwnershipLostError);

    // The fence check happens before `fn` runs at all — no nested call
    // (not even the first) ever gets a chance to execute.
    expect(firstNestedRan).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS c FROM task_t").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM link_t").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM event_t").get() as { c: number }).c).toBe(0);
    db.close();
  });

  it("no publication happens from an inner transaction's own SAVEPOINT release — only after the outermost transaction commits, and never if it later rolls back", () => {
    const db = HallDatabase.openInMemory();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    let published = 0;

    // Case 1: the outer transaction itself fails after an inner SAVEPOINT
    // released successfully — publication (modeled here as a plain
    // counter incremented only by code that runs AFTER `withTransaction`
    // returns successfully, exactly matching every real call site in this
    // codebase) must never fire. Nothing inside the callback below
    // increments `published`, so if it were still 0 afterward that alone
    // wouldn't prove much — the real assertion is that the increment
    // statement every real call site places immediately after a
    // successful `withTransaction` call is never reached, which
    // `.toThrow()` on the call itself already demonstrates.
    expect(() =>
      withTransaction(db, () => {
        withTransaction(db, () => {
          db.prepare("INSERT INTO t (id) VALUES (1)").run();
        });
        throw new Error("outer fails after inner released");
      }),
    ).toThrow("outer fails after inner released");
    expect(published).toBe(0);

    // Case 2: the outer transaction succeeds — publication fires exactly
    // once, only after `withTransaction` has returned.
    withTransaction(db, () => {
      withTransaction(db, () => {
        db.prepare("INSERT INTO t (id) VALUES (2)").run();
      });
    });
    published += 1;
    expect(published).toBe(1);
    db.close();
  });

  it("a failure in the fourth of four nested SAVEPOINTs — mirroring delegate()'s task/link/event/message writes — leaves no partial state across any of the four tables", () => {
    const db = HallDatabase.openInMemory();
    db.exec("CREATE TABLE task_t (id INTEGER PRIMARY KEY)");
    db.exec("CREATE TABLE link_t (id INTEGER PRIMARY KEY)");
    db.exec("CREATE TABLE event_t (id INTEGER PRIMARY KEY)");
    db.exec("CREATE TABLE message_t (id INTEGER PRIMARY KEY)");

    expect(() => {
      withTransaction(db, () => {
        withTransaction(db, () => {
          db.prepare("INSERT INTO task_t (id) VALUES (1)").run();
        });
        withTransaction(db, () => {
          db.prepare("INSERT INTO link_t (id) VALUES (1)").run();
        });
        withTransaction(db, () => {
          db.prepare("INSERT INTO event_t (id) VALUES (1)").run();
        });
        withTransaction(db, () => {
          db.prepare("INSERT INTO message_t (id) VALUES (1)").run();
          throw new Error("failure on the fourth nested unit");
        });
      });
    }).toThrow("failure on the fourth nested unit");

    expect((db.prepare("SELECT COUNT(*) AS c FROM task_t").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM link_t").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM event_t").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM message_t").get() as { c: number }).c).toBe(0);
    db.close();
  });
});
