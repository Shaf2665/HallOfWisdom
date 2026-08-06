import { afterEach, describe, expect, it, vi } from "vitest";
import { HallDatabase } from "./database.js";
import { runMigrations } from "./migration-runner.js";
import { ConfigurationFingerprintMismatchError } from "./persistence-errors.js";
import { checkOrRecordConfigurationFingerprint } from "./server-metadata-repository.js";

const openDatabases: HallDatabase[] = [];
afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close();
});

function openMigratedDatabase(): HallDatabase {
  const db = HallDatabase.openInMemory();
  runMigrations(db);
  openDatabases.push(db);
  return db;
}

function insertAgentWorktreeRow(
  db: HallDatabase,
  input: { readonly worktreeId: string; readonly worktreePath: string },
): void {
  db.prepare(
    `INSERT INTO agent_worktrees (
      worktree_id, hall_task_id, hall_agent_run_id, source_repository_root,
      source_working_directory_relative_path, base_commit, worktree_path,
      status, created_at, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, 0)`,
  ).run(
    input.worktreeId,
    `task-${input.worktreeId}`,
    `run-${input.worktreeId}`,
    "C:\\safe\\repo",
    ".",
    "0".repeat(40),
    input.worktreePath,
    "2026-08-06T00:00:00.000Z",
  );
}

describe("checkOrRecordConfigurationFingerprint", () => {
  it("records the fingerprint on first use rather than comparing", () => {
    const db = openMigratedDatabase();
    expect(() => {
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/ws",
        comparisonRoot: "/cmp",
        agentWorktreeRoot: undefined,
      });
    }).not.toThrow();
  });

  it("passes when the same roots are supplied again", () => {
    const db = openMigratedDatabase();
    checkOrRecordConfigurationFingerprint(db, {
      workspaceRoot: "/ws",
      comparisonRoot: "/cmp",
      agentWorktreeRoot: undefined,
    });
    expect(() => {
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/ws",
        comparisonRoot: "/cmp",
        agentWorktreeRoot: undefined,
      });
    }).not.toThrow();
  });

  it("fails closed when workspaceRoot differs from what was previously recorded", () => {
    const db = openMigratedDatabase();
    checkOrRecordConfigurationFingerprint(db, {
      workspaceRoot: "/ws",
      comparisonRoot: undefined,
      agentWorktreeRoot: undefined,
    });
    expect(() => {
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/different-ws",
        comparisonRoot: undefined,
        agentWorktreeRoot: undefined,
      });
    }).toThrow(ConfigurationFingerprintMismatchError);
  });

  it("fails closed when comparisonRoot differs from what was previously recorded", () => {
    const db = openMigratedDatabase();
    checkOrRecordConfigurationFingerprint(db, {
      workspaceRoot: "/ws",
      comparisonRoot: "/cmp",
      agentWorktreeRoot: undefined,
    });
    expect(() => {
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/ws",
        comparisonRoot: "/different-cmp",
        agentWorktreeRoot: undefined,
      });
    }).toThrow(ConfigurationFingerprintMismatchError);
  });

  it("allows a startup that omits comparisonRoot entirely even though one was previously recorded", () => {
    const db = openMigratedDatabase();
    checkOrRecordConfigurationFingerprint(db, {
      workspaceRoot: "/ws",
      comparisonRoot: "/cmp",
      agentWorktreeRoot: undefined,
    });
    expect(() => {
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/ws",
        comparisonRoot: undefined,
        agentWorktreeRoot: undefined,
      });
    }).not.toThrow();
  });

  it("records a comparisonRoot supplied for the first time on a database that only ever had workspaceRoot recorded", () => {
    const db = openMigratedDatabase();
    checkOrRecordConfigurationFingerprint(db, {
      workspaceRoot: "/ws",
      comparisonRoot: undefined,
      agentWorktreeRoot: undefined,
    });
    checkOrRecordConfigurationFingerprint(db, {
      workspaceRoot: "/ws",
      comparisonRoot: "/cmp",
      agentWorktreeRoot: undefined,
    });
    expect(() => {
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/ws",
        comparisonRoot: "/different-cmp",
        agentWorktreeRoot: undefined,
      });
    }).toThrow(ConfigurationFingerprintMismatchError);
  });

  describe("agentWorktreeRoot (Phase 16.5)", () => {
    it("a database without isolated worktrees may omit agentWorktreeRoot indefinitely", () => {
      const db = openMigratedDatabase();
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/ws",
        comparisonRoot: undefined,
        agentWorktreeRoot: undefined,
      });
      expect(() => {
        checkOrRecordConfigurationFingerprint(db, {
          workspaceRoot: "/ws",
          comparisonRoot: undefined,
          agentWorktreeRoot: undefined,
        });
      }).not.toThrow();
    });

    it("records the first valid supplied canonical root (first enablement, no existing rows)", () => {
      const db = openMigratedDatabase();
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/ws",
        comparisonRoot: undefined,
        agentWorktreeRoot: undefined,
      });
      expect(() => {
        checkOrRecordConfigurationFingerprint(db, {
          workspaceRoot: "/ws",
          comparisonRoot: undefined,
          agentWorktreeRoot: "C:\\hall-owned",
        });
      }).not.toThrow();
    });

    it("passes on restart with the exact same recorded root", () => {
      const db = openMigratedDatabase();
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/ws",
        comparisonRoot: undefined,
        agentWorktreeRoot: "C:\\hall-owned",
      });
      expect(() => {
        checkOrRecordConfigurationFingerprint(db, {
          workspaceRoot: "/ws",
          comparisonRoot: undefined,
          agentWorktreeRoot: "C:\\hall-owned",
        });
      }).not.toThrow();
    });

    it("fails closed when a different root is supplied than what was recorded", () => {
      const db = openMigratedDatabase();
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/ws",
        comparisonRoot: undefined,
        agentWorktreeRoot: "C:\\hall-owned",
      });
      expect(() => {
        checkOrRecordConfigurationFingerprint(db, {
          workspaceRoot: "/ws",
          comparisonRoot: undefined,
          agentWorktreeRoot: "C:\\different-owned",
        });
      }).toThrow(ConfigurationFingerprintMismatchError);
    });

    it("fails closed when a previously recorded root is omitted entirely, unlike comparisonRoot", () => {
      const db = openMigratedDatabase();
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/ws",
        comparisonRoot: undefined,
        agentWorktreeRoot: "C:\\hall-owned",
      });
      expect(() => {
        checkOrRecordConfigurationFingerprint(db, {
          workspaceRoot: "/ws",
          comparisonRoot: undefined,
          agentWorktreeRoot: undefined,
        });
      }).toThrow(ConfigurationFingerprintMismatchError);
    });

    it("accepts a supplied root on a legacy database whose existing worktree rows all reconstruct under it", () => {
      const db = openMigratedDatabase();
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/ws",
        comparisonRoot: undefined,
        agentWorktreeRoot: undefined,
      });
      insertAgentWorktreeRow(db, {
        worktreeId: "wt-1",
        worktreePath: "C:\\hall-owned\\wt_wt-1",
      });
      insertAgentWorktreeRow(db, {
        worktreeId: "wt-2",
        worktreePath: "C:\\hall-owned\\wt_wt-2",
      });
      expect(() => {
        checkOrRecordConfigurationFingerprint(db, {
          workspaceRoot: "/ws",
          comparisonRoot: undefined,
          agentWorktreeRoot: "C:\\hall-owned",
        });
      }).not.toThrow();
      // Recorded, not merely tolerated once — a subsequent boot with a
      // different root must now fail.
      expect(() => {
        checkOrRecordConfigurationFingerprint(db, {
          workspaceRoot: "/ws",
          comparisonRoot: undefined,
          agentWorktreeRoot: "C:\\different-owned",
        });
      }).toThrow(ConfigurationFingerprintMismatchError);
    });

    it("rejects a supplied root on a legacy database whose rows do not reconstruct under it, and does not record it", () => {
      const db = openMigratedDatabase();
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/ws",
        comparisonRoot: undefined,
        agentWorktreeRoot: undefined,
      });
      insertAgentWorktreeRow(db, {
        worktreeId: "wt-1",
        worktreePath: "C:\\some-other-root\\wt_wt-1",
      });
      expect(() => {
        checkOrRecordConfigurationFingerprint(db, {
          workspaceRoot: "/ws",
          comparisonRoot: undefined,
          agentWorktreeRoot: "C:\\hall-owned",
        });
      }).toThrow(ConfigurationFingerprintMismatchError);
      // Never derives or guesses a root from the mismatching stored path —
      // the field stays unrecorded, so a later, genuinely correct root is
      // still free to be recorded (bootstrapping was not silently
      // consumed by the failed attempt).
      expect(() => {
        checkOrRecordConfigurationFingerprint(db, {
          workspaceRoot: "/ws",
          comparisonRoot: undefined,
          agentWorktreeRoot: "C:\\some-other-root",
        });
      }).not.toThrow();
    });

    it("bootstraps successfully on a legacy database with no worktree rows at all", () => {
      const db = openMigratedDatabase();
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/ws",
        comparisonRoot: undefined,
        agentWorktreeRoot: undefined,
      });
      expect(() => {
        checkOrRecordConfigurationFingerprint(db, {
          workspaceRoot: "/ws",
          comparisonRoot: undefined,
          agentWorktreeRoot: "C:\\hall-owned",
        });
      }).not.toThrow();
    });

    it("matches a legacy row using platform-correct (Windows case-insensitive) path comparison", () => {
      const db = openMigratedDatabase();
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/ws",
        comparisonRoot: undefined,
        agentWorktreeRoot: undefined,
      });
      insertAgentWorktreeRow(db, {
        worktreeId: "wt-1",
        worktreePath: "C:\\Hall-Owned\\WT_wt-1",
      });
      expect(() => {
        checkOrRecordConfigurationFingerprint(db, {
          workspaceRoot: "/ws",
          comparisonRoot: undefined,
          agentWorktreeRoot: "c:\\hall-owned",
        });
      }).not.toThrow();
    });
  });

  describe("legacy omitted-root rejection (post-merge Phase 16.5 hardening)", () => {
    it("rejects an omitted root on a legacy database whose agent_worktrees rows predate any recorded root", () => {
      const db = openMigratedDatabase();
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/ws",
        comparisonRoot: undefined,
        agentWorktreeRoot: undefined,
      });
      insertAgentWorktreeRow(db, {
        worktreeId: "wt-1",
        worktreePath: "C:\\hall-owned\\wt_wt-1",
      });
      expect(() => {
        checkOrRecordConfigurationFingerprint(db, {
          workspaceRoot: "/ws",
          comparisonRoot: undefined,
          agentWorktreeRoot: undefined,
        });
      }).toThrow(ConfigurationFingerprintMismatchError);
    });

    it("does not record a root as a side effect of a rejected omitted-root startup", () => {
      const db = openMigratedDatabase();
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/ws",
        comparisonRoot: undefined,
        agentWorktreeRoot: undefined,
      });
      insertAgentWorktreeRow(db, {
        worktreeId: "wt-1",
        worktreePath: "C:\\hall-owned\\wt_wt-1",
      });
      expect(() => {
        checkOrRecordConfigurationFingerprint(db, {
          workspaceRoot: "/ws",
          comparisonRoot: undefined,
          agentWorktreeRoot: undefined,
        });
      }).toThrow(ConfigurationFingerprintMismatchError);

      const row = db
        .prepare(
          "SELECT value FROM server_metadata WHERE key = 'configFingerprint.agentWorktreeRoot'",
        )
        .get();
      expect(row).toBeUndefined();
    });

    it("remains recoverable — a later startup with the exact proven root still succeeds after a rejected omission", () => {
      const db = openMigratedDatabase();
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/ws",
        comparisonRoot: undefined,
        agentWorktreeRoot: undefined,
      });
      insertAgentWorktreeRow(db, {
        worktreeId: "wt-1",
        worktreePath: "C:\\hall-owned\\wt_wt-1",
      });
      expect(() => {
        checkOrRecordConfigurationFingerprint(db, {
          workspaceRoot: "/ws",
          comparisonRoot: undefined,
          agentWorktreeRoot: undefined,
        });
      }).toThrow(ConfigurationFingerprintMismatchError);

      expect(() => {
        checkOrRecordConfigurationFingerprint(db, {
          workspaceRoot: "/ws",
          comparisonRoot: undefined,
          agentWorktreeRoot: "C:\\hall-owned",
        });
      }).not.toThrow();
    });
  });

  describe("atomic fingerprint writes (post-merge Phase 16.5 hardening)", () => {
    it("rolls back every key from one call when the write of the second key fails (existing database, comparisonRoot then agentWorktreeRoot)", () => {
      const db = openMigratedDatabase();
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/ws",
        comparisonRoot: undefined,
        agentWorktreeRoot: undefined,
      });

      let insertCount = 0;
      const originalPrepare = db.prepare.bind(db);
      const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
        if (sql.includes("INSERT INTO server_metadata")) {
          insertCount += 1;
          if (insertCount === 2) {
            throw new Error("simulated write failure on the second key");
          }
        }
        return originalPrepare(sql);
      });

      try {
        expect(() => {
          checkOrRecordConfigurationFingerprint(db, {
            workspaceRoot: "/ws",
            comparisonRoot: "/cmp",
            agentWorktreeRoot: "C:\\hall-owned",
          });
        }).toThrow();
      } finally {
        spy.mockRestore();
      }

      const rows = db
        .prepare("SELECT key FROM server_metadata WHERE key LIKE 'configFingerprint.%'")
        .all() as { key: string }[];
      expect(rows.map((row) => row.key).sort()).toEqual(["configFingerprint.workspaceRoot"]);
    });

    it("rolls back every key from one call when the write of the third key fails (brand-new database, all three fields at once)", () => {
      const db = openMigratedDatabase();

      let insertCount = 0;
      const originalPrepare = db.prepare.bind(db);
      const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
        if (sql.includes("INSERT INTO server_metadata")) {
          insertCount += 1;
          if (insertCount === 3) {
            throw new Error("simulated write failure on the third key");
          }
        }
        return originalPrepare(sql);
      });

      try {
        expect(() => {
          checkOrRecordConfigurationFingerprint(db, {
            workspaceRoot: "/ws",
            comparisonRoot: "/cmp",
            agentWorktreeRoot: "C:\\hall-owned",
          });
        }).toThrow();
      } finally {
        spy.mockRestore();
      }

      const rows = db
        .prepare("SELECT key FROM server_metadata WHERE key LIKE 'configFingerprint.%'")
        .all() as { key: string }[];
      expect(rows).toEqual([]);
    });
  });

  describe("fully missing fingerprint case (post-merge Phase 16.5 hardening — final review correction)", () => {
    it("rejects an omitted root on a completely fresh database (no fingerprint keys recorded at all) that already has agent_worktrees rows", () => {
      const db = openMigratedDatabase();
      // No prior checkOrRecordConfigurationFingerprint call whatsoever —
      // not even workspaceRoot has ever been recorded. Simulates a
      // database where migrations ran and a worktree row was inserted
      // (e.g. by an older code path) before the fingerprint was ever
      // durably recorded even once.
      insertAgentWorktreeRow(db, {
        worktreeId: "wt-1",
        worktreePath: "C:\\hall-owned\\wt_wt-1",
      });
      expect(() => {
        checkOrRecordConfigurationFingerprint(db, {
          workspaceRoot: "/ws",
          comparisonRoot: undefined,
          agentWorktreeRoot: undefined,
        });
      }).toThrow(ConfigurationFingerprintMismatchError);
    });

    it("does not write any fingerprint key — including workspaceRoot — on that rejection", () => {
      const db = openMigratedDatabase();
      insertAgentWorktreeRow(db, {
        worktreeId: "wt-1",
        worktreePath: "C:\\hall-owned\\wt_wt-1",
      });
      expect(() => {
        checkOrRecordConfigurationFingerprint(db, {
          workspaceRoot: "/ws",
          comparisonRoot: undefined,
          agentWorktreeRoot: undefined,
        });
      }).toThrow(ConfigurationFingerprintMismatchError);

      const rows = db
        .prepare("SELECT key FROM server_metadata WHERE key LIKE 'configFingerprint.%'")
        .all() as { key: string }[];
      expect(rows).toEqual([]);
    });

    it("remains recoverable — a later call with the exact proven root still succeeds", () => {
      const db = openMigratedDatabase();
      insertAgentWorktreeRow(db, {
        worktreeId: "wt-1",
        worktreePath: "C:\\hall-owned\\wt_wt-1",
      });
      expect(() => {
        checkOrRecordConfigurationFingerprint(db, {
          workspaceRoot: "/ws",
          comparisonRoot: undefined,
          agentWorktreeRoot: undefined,
        });
      }).toThrow(ConfigurationFingerprintMismatchError);

      expect(() => {
        checkOrRecordConfigurationFingerprint(db, {
          workspaceRoot: "/ws",
          comparisonRoot: undefined,
          agentWorktreeRoot: "C:\\hall-owned",
        });
      }).not.toThrow();
    });

    it("a completely new, empty database (no rows at all) with an omitted root still succeeds", () => {
      const db = openMigratedDatabase();
      expect(() => {
        checkOrRecordConfigurationFingerprint(db, {
          workspaceRoot: "/ws",
          comparisonRoot: undefined,
          agentWorktreeRoot: undefined,
        });
      }).not.toThrow();
      const rows = db
        .prepare("SELECT key FROM server_metadata WHERE key LIKE 'configFingerprint.%'")
        .all() as { key: string }[];
      expect(rows.map((row) => row.key).sort()).toEqual(["configFingerprint.workspaceRoot"]);
    });
  });
});
