import { describe, expect, it } from "vitest";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { acquireDatabaseEpoch } from "../persistence/database-ownership-fence.js";
import { OwnershipLostError } from "../persistence/persistence-errors.js";
import { defineCeoPlanStoreContractTests } from "./ceo-plan-store-contract.js";
import { SqliteCeoPlanStore } from "./sqlite-ceo-plan-store.js";

function migratedDb(): HallDatabase {
  const db = HallDatabase.openInMemory();
  runMigrations(db);
  return db;
}

defineCeoPlanStoreContractTests("SqliteCeoPlanStore", () => {
  const db = migratedDb();
  return new SqliteCeoPlanStore({ db });
});

describe("SqliteCeoPlanStore — durable-specific behavior", () => {
  it("plan and version rows survive being reopened against the same on-disk shape (in-memory SQLite semantics, not a JS object)", () => {
    const db = migratedDb();
    const store = new SqliteCeoPlanStore({ db });
    store.createPlan({
      planId: "plan-1",
      parentTaskId: "task-1",
      createdBy: "ceo_planner",
      createdAt: "2026-01-01T00:00:00.000Z",
      content: {
        objective: "Fix it",
        summary: "One step",
        assumptions: [],
        constraints: [],
        steps: [
          {
            id: "step-1",
            position: 0,
            title: "Investigate",
            objective: "Find root cause",
            boundedInstructions: "Read logs",
            acceptanceCriteria: ["Documented"],
            dependencies: [],
            routingSummary: "n/a",
          },
        ],
      },
      contentHash: "a".repeat(64),
    });
    // Read via a second store instance sharing the same real SQLite
    // connection/database, not a cached JS reference.
    const secondHandle = new SqliteCeoPlanStore({ db });
    expect(secondHandle.getPlan("plan-1").id).toBe("plan-1");
    db.close();
  });

  it("a fenced write is rejected once this instance's ownership epoch has been superseded, and creates no plan row", () => {
    const db = migratedDb();
    const staleFence = acquireDatabaseEpoch(db, "owner-a");
    db.setOwnershipFence(staleFence);
    acquireDatabaseEpoch(db, "owner-b");

    const store = new SqliteCeoPlanStore({ db });
    expect(() =>
      store.createPlan({
        planId: "plan-rejected",
        parentTaskId: "task-1",
        createdBy: "ceo_planner",
        createdAt: "2026-01-01T00:00:00.000Z",
        content: {
          objective: "Fix it",
          summary: "One step",
          assumptions: [],
          constraints: [],
          steps: [
            {
              id: "step-1",
              position: 0,
              title: "Investigate",
              objective: "Find root cause",
              boundedInstructions: "Read logs",
              acceptanceCriteria: ["Documented"],
              dependencies: [],
              routingSummary: "n/a",
            },
          ],
        },
        contentHash: "a".repeat(64),
      }),
    ).toThrow(OwnershipLostError);

    const count = (db.prepare("SELECT COUNT(*) AS c FROM ceo_plans").get() as { c: number }).c;
    expect(count).toBe(0);
    db.close();
  });

  it("a fenced approval decision is rejected and never writes an approval row when this instance's epoch has been superseded", () => {
    const db = migratedDb();
    const store = new SqliteCeoPlanStore({ db });
    store.createPlan({
      planId: "plan-1",
      parentTaskId: "task-1",
      createdBy: "ceo_planner",
      createdAt: "2026-01-01T00:00:00.000Z",
      content: {
        objective: "Fix it",
        summary: "One step",
        assumptions: [],
        constraints: [],
        steps: [
          {
            id: "step-1",
            position: 0,
            title: "Investigate",
            objective: "Find root cause",
            boundedInstructions: "Read logs",
            acceptanceCriteria: ["Documented"],
            dependencies: [],
            routingSummary: "n/a",
          },
        ],
      },
      contentHash: "a".repeat(64),
    });
    store.submit({ planId: "plan-1", expectedRevision: store.getRevision("plan-1") });

    const staleFence = acquireDatabaseEpoch(db, "owner-a");
    db.setOwnershipFence(staleFence);
    acquireDatabaseEpoch(db, "owner-b");

    expect(() =>
      store.decideApproval({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        planVersion: 1,
        contentHash: "a".repeat(64),
        decision: "approve",
        operatorNote: undefined,
        decidedAt: "2026-01-01T00:10:00.000Z",
      }),
    ).toThrow(OwnershipLostError);

    const count = (db.prepare("SELECT COUNT(*) AS c FROM ceo_approvals").get() as { c: number }).c;
    expect(count).toBe(0);
    db.close();
  });

  it("re-validates steps_json through the strict public schema on read and rejects a hand-corrupted row", () => {
    const db = migratedDb();
    const store = new SqliteCeoPlanStore({ db });
    store.createPlan({
      planId: "plan-1",
      parentTaskId: "task-1",
      createdBy: "ceo_planner",
      createdAt: "2026-01-01T00:00:00.000Z",
      content: {
        objective: "Fix it",
        summary: "One step",
        assumptions: [],
        constraints: [],
        steps: [
          {
            id: "step-1",
            position: 0,
            title: "Investigate",
            objective: "Find root cause",
            boundedInstructions: "Read logs",
            acceptanceCriteria: ["Documented"],
            dependencies: [],
            routingSummary: "n/a",
          },
        ],
      },
      contentHash: "a".repeat(64),
    });
    // Simulate corruption bypassing the store entirely (e.g. manual DB edit).
    db.prepare("UPDATE ceo_plan_versions SET steps_json = ? WHERE plan_id = ? AND version = 1").run(
      JSON.stringify([{ id: "step-1", position: 0, dependencies: ["step-1"] }]),
      "plan-1",
    );
    expect(() => store.getVersion("plan-1", 1)).toThrow();
    db.close();
  });
});
