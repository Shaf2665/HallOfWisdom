import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerSystemStorageRoute } from "./system.js";
import { HIGHEST_KNOWN_SCHEMA_VERSION } from "../persistence/migrations.js";
import type { RecoverySummary } from "../recovery/restart-recovery.js";

interface SystemStorageResponseBody {
  readonly mode: string;
  readonly ready: boolean;
  readonly schemaVersion: number | null;
  readonly startedAt: string;
  readonly previousShutdown: string | null;
  readonly recovery: Record<string, unknown> | null;
}

const SAMPLE_RECOVERY: RecoverySummary = {
  bootId: "boot-1",
  previousShutdown: "unclean",
  tasksScanned: 3,
  taskEventProjectionsRepaired: 1,
  taskTerminalOutcomesReplayed: 1,
  interruptedTaskRunCount: 1,
  comparisonsScanned: 2,
  interruptedPreparationCount: 0,
  interruptedCleanupCount: 0,
  comparisonEventProjectionsRepaired: 0,
  comparisonTerminalOutcomesReplayed: 0,
  interruptedCandidateRunCount: 0,
  worktreeHealthCounts: {
    healthy: 1,
    interrupted: 0,
    workspace_missing: 0,
    workspace_unverified: 0,
    cleanup_required: 0,
    unsafe_path: 0,
  },
  orphanWorktreeCount: 0,
};

describe("GET /api/v1/system/storage", () => {
  it("reports in-memory mode with no recovery data when storage was never durable", async () => {
    const app = Fastify();
    registerSystemStorageRoute(app, { mode: "in-memory", startedAt: Date.now() });

    const response = await app.inject({ method: "GET", url: "/api/v1/system/storage" });
    expect(response.statusCode).toBe(200);
    const body = response.json<SystemStorageResponseBody>();
    expect(body).toMatchObject({
      mode: "in-memory",
      ready: true,
      schemaVersion: null,
      previousShutdown: null,
      recovery: null,
    });
    expect(typeof body.startedAt).toBe("string");
    await app.close();
  });

  it("reports durable mode with the schema version and recovery summary", async () => {
    const app = Fastify();
    registerSystemStorageRoute(app, {
      mode: "durable",
      startedAt: Date.now(),
      recovery: SAMPLE_RECOVERY,
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/system/storage" });
    expect(response.statusCode).toBe(200);
    const body = response.json<SystemStorageResponseBody>();
    expect(body.mode).toBe("durable");
    expect(body.schemaVersion).toBe(HIGHEST_KNOWN_SCHEMA_VERSION);
    expect(body.previousShutdown).toBe("unclean");
    expect(body.recovery).toEqual({
      tasksScanned: 3,
      taskEventProjectionsRepaired: 1,
      taskTerminalOutcomesReplayed: 1,
      interruptedTaskRunCount: 1,
      comparisonsScanned: 2,
      interruptedPreparationCount: 0,
      interruptedCleanupCount: 0,
      comparisonEventProjectionsRepaired: 0,
      comparisonTerminalOutcomesReplayed: 0,
      interruptedCandidateRunCount: 0,
      worktreeHealthCounts: SAMPLE_RECOVERY.worktreeHealthCounts,
      orphanWorktreeCount: 0,
    });
    // Never a path, PID, or bootId.
    expect(JSON.stringify(body)).not.toContain("boot-1");
    await app.close();
  });

  it("never includes the ownership fence (owner token or epoch) in a durable response", async () => {
    const app = Fastify();
    registerSystemStorageRoute(app, {
      mode: "durable",
      startedAt: Date.now(),
      recovery: SAMPLE_RECOVERY,
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/system/storage" });
    const raw = response.body;
    expect(raw).not.toContain("owner_token");
    expect(raw).not.toContain("ownerToken");
    expect(raw).not.toContain("epoch");
    expect(raw).not.toContain("heartbeat_at");
    expect(raw).not.toContain("heartbeatAt");
    await app.close();
  });
});
