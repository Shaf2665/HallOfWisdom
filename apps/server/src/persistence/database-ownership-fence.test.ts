import { describe, expect, it } from "vitest";
import { HallDatabase } from "./database.js";
import { runMigrations } from "./migration-runner.js";
import {
  acquireDatabaseEpoch,
  readCurrentDatabaseOwnership,
  touchDatabaseOwnershipHeartbeat,
} from "./database-ownership-fence.js";

function migratedDb(): HallDatabase {
  const db = HallDatabase.openInMemory();
  runMigrations(db);
  return db;
}

describe("acquireDatabaseEpoch", () => {
  // Kickoff §5, item 1.
  it("the initial owner of a brand-new database receives epoch 1", () => {
    const db = migratedDb();
    const fence = acquireDatabaseEpoch(db, "owner-a");
    expect(fence).toEqual({ ownerToken: "owner-a", epoch: 1 });
    expect(readCurrentDatabaseOwnership(db)).toEqual({ ownerToken: "owner-a", epoch: 1 });
    db.close();
  });

  // Kickoff §5, item 2 — a graceful reacquisition (same or different
  // process, same data directory) always receives the next epoch, never
  // reuses the previous one.
  it("a subsequent acquisition against the same database receives the next epoch", () => {
    const db = migratedDb();
    acquireDatabaseEpoch(db, "owner-a");
    const second = acquireDatabaseEpoch(db, "owner-a-restarted");
    expect(second).toEqual({ ownerToken: "owner-a-restarted", epoch: 2 });
    db.close();
  });

  // Kickoff §5, item 3 — a stale takeover (a different instance entirely)
  // also always receives a strictly greater epoch than whatever was
  // recorded before it, regardless of why the previous owner is gone.
  it("a stale takeover by a different owner token receives a strictly greater epoch", () => {
    const db = migratedDb();
    const first = acquireDatabaseEpoch(db, "owner-a");
    const takeover = acquireDatabaseEpoch(db, "owner-b");
    expect(takeover.epoch).toBeGreaterThan(first.epoch);
    expect(takeover.ownerToken).toBe("owner-b");
    db.close();
  });

  // Kickoff §5, item 16 — independent data directories (here: independent
  // in-memory databases, which is the same isolation this function cares
  // about) never share or influence each other's epoch sequence.
  it("independent databases maintain independent epoch sequences", () => {
    const dbOne = migratedDb();
    const dbTwo = migratedDb();
    acquireDatabaseEpoch(dbOne, "owner-1a");
    acquireDatabaseEpoch(dbOne, "owner-1b");
    const two = acquireDatabaseEpoch(dbTwo, "owner-2a");
    expect(two.epoch).toBe(1);
    dbOne.close();
    dbTwo.close();
  });

  it("runs unfenced — acquiring an epoch never itself throws OwnershipLostError, even called repeatedly", () => {
    const db = migratedDb();
    expect(() => {
      acquireDatabaseEpoch(db, "owner-a");
      acquireDatabaseEpoch(db, "owner-b");
      acquireDatabaseEpoch(db, "owner-c");
    }).not.toThrow();
    db.close();
  });
});

describe("readCurrentDatabaseOwnership", () => {
  it("returns undefined for a freshly migrated database with no owner acquired yet", () => {
    const db = migratedDb();
    expect(readCurrentDatabaseOwnership(db)).toBeUndefined();
    db.close();
  });
});

describe("touchDatabaseOwnershipHeartbeat", () => {
  it("updates heartbeat_at for the current owner without changing the epoch", () => {
    const db = migratedDb();
    const fence = acquireDatabaseEpoch(db, "owner-a");
    expect(() => {
      touchDatabaseOwnershipHeartbeat(db, fence);
    }).not.toThrow();
    expect(readCurrentDatabaseOwnership(db)).toEqual(fence);
    db.close();
  });

  // Diagnostic-only and self-limiting: a stale caller's heartbeat touch is
  // silently a no-op (the WHERE clause matches nothing) rather than
  // resurrecting a lost fence or throwing.
  it("is a silent no-op when the caller's fence no longer matches the current owner", () => {
    const db = migratedDb();
    const staleFence = acquireDatabaseEpoch(db, "owner-a");
    const current = acquireDatabaseEpoch(db, "owner-b");
    expect(() => {
      touchDatabaseOwnershipHeartbeat(db, staleFence);
    }).not.toThrow();
    expect(readCurrentDatabaseOwnership(db)).toEqual(current);
    db.close();
  });
});
