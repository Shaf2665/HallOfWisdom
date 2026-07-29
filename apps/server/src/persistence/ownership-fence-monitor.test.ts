import { describe, expect, it, vi } from "vitest";
import { HallDatabase } from "./database.js";
import { runMigrations } from "./migration-runner.js";
import { acquireDatabaseEpoch } from "./database-ownership-fence.js";
import { startOwnershipFenceMonitor } from "./ownership-fence-monitor.js";

function migratedDb(): HallDatabase {
  const db = HallDatabase.openInMemory();
  runMigrations(db);
  return db;
}

describe("startOwnershipFenceMonitor", () => {
  it("never calls onOwnershipLost while this instance remains the current owner", async () => {
    vi.useFakeTimers();
    try {
      const db = migratedDb();
      const fence = acquireDatabaseEpoch(db, "owner-a");
      const onOwnershipLost = vi.fn();
      const handle = startOwnershipFenceMonitor({ db, fence, intervalMs: 10, onOwnershipLost });

      await vi.advanceTimersByTimeAsync(100);
      expect(onOwnershipLost).not.toHaveBeenCalled();

      handle.stop();
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  // Kickoff §4 — the heartbeat process must itself detect that the lock
  // (here: the database fence) no longer belongs to the current owner,
  // and that must trigger controlled shutdown. Proven directly at the
  // monitor level: once another owner takes over, the very next tick
  // calls `onOwnershipLost` exactly once.
  it("calls onOwnershipLost exactly once, on the first tick after another owner takes over", async () => {
    vi.useFakeTimers();
    try {
      const db = migratedDb();
      const fence = acquireDatabaseEpoch(db, "owner-a");
      const onOwnershipLost = vi.fn();
      const handle = startOwnershipFenceMonitor({ db, fence, intervalMs: 10, onOwnershipLost });

      acquireDatabaseEpoch(db, "owner-b");

      await vi.advanceTimersByTimeAsync(50);
      expect(onOwnershipLost).toHaveBeenCalledTimes(1);

      // The timer stops itself after firing — advancing further never
      // calls it again.
      await vi.advanceTimersByTimeAsync(100);
      expect(onOwnershipLost).toHaveBeenCalledTimes(1);

      handle.stop();
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() prevents any future onOwnershipLost call, even after displacement", async () => {
    vi.useFakeTimers();
    try {
      const db = migratedDb();
      const fence = acquireDatabaseEpoch(db, "owner-a");
      const onOwnershipLost = vi.fn();
      const handle = startOwnershipFenceMonitor({ db, fence, intervalMs: 10, onOwnershipLost });

      handle.stop();
      acquireDatabaseEpoch(db, "owner-b");
      await vi.advanceTimersByTimeAsync(100);

      expect(onOwnershipLost).not.toHaveBeenCalled();
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a single failed tick (closed database) never throws out of the timer and never falsely reports ownership loss", async () => {
    vi.useFakeTimers();
    try {
      const db = migratedDb();
      const fence = acquireDatabaseEpoch(db, "owner-a");
      const onOwnershipLost = vi.fn();
      const handle = startOwnershipFenceMonitor({ db, fence, intervalMs: 10, onOwnershipLost });

      db.close();
      await vi.advanceTimersByTimeAsync(100);

      expect(onOwnershipLost).not.toHaveBeenCalled();
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
