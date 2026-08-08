import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { HALL_CONFIG_DIR_ENV_OVERRIDE } from "@hall-of-wisdom/hall-config";
import { HallDatabase } from "../persistence/database.js";
import { EXIT_VERIFICATION_INCOMPLETE } from "../config/server-config.js";
import {
  attemptStart,
  killAndWait,
  requireBuiltDist,
  spawnRealServerCapturingOutput,
  waitForExit,
} from "./process-test-support.js";

/**
 * This proves `--verify-only` end to end through the REAL built binary
 * (`node dist/server.js --verify-only ...`), not just in-process unit
 * calls (see `../verify-only/run-verify-only.test.ts` and
 * `../server.test.ts` for those) — matching this directory's existing
 * process-test convention.
 *
 * Isolation note: `server.ts` unconditionally calls `tryLoadConfig()`
 * (from `@hall-of-wisdom/hall-config`), which by default reads
 * `%LOCALAPPDATA%\HallOfWisdom\config.json` (Windows) or the platform
 * equivalent. None of `process-test-support.ts`'s spawn helpers
 * (`spawnRealServer`, `spawnRealServerCapturingOutput`, `attemptStart`,
 * etc.) accept an `env` override — they all call Node's `spawn(...)`
 * without an `env` option, which means the child inherits `process.env`
 * of THIS test process at spawn time (Node's documented default). Every
 * `it()` below therefore points `process.env[HALL_CONFIG_DIR_ENV_OVERRIDE]`
 * at a fresh, never-created directory under that test's own `tempRoot`
 * before spawning anything, and restores the original value in
 * `afterEach` — the same pattern `server.test.ts` uses for its in-process
 * `runServer()` calls, just relying on env inheritance instead of a
 * direct function argument since these are real child processes. This
 * guarantees a developer machine that has ever run the real
 * `install.ps1` (and so has a real persisted config on disk) cannot make
 * these tests flaky or order-dependent.
 */
describe("--verify-only against the real built binary", () => {
  beforeAll(() => {
    requireBuiltDist();
  });

  let tempRoot: string;
  let originalHallConfigDirEnv: string | undefined;
  const spawned: ChildProcess[] = [];

  /** Points `HALL_CONFIG_DIR` at a fresh, never-created directory under this test's own `tempRoot` so the spawned real binary can never pick up a real developer machine's persisted config. Must be called after `tempRoot` is assigned and before any spawn in the same `it()`. */
  function isolateHallConfigDir(): void {
    originalHallConfigDirEnv = process.env[HALL_CONFIG_DIR_ENV_OVERRIDE];
    process.env[HALL_CONFIG_DIR_ENV_OVERRIDE] = path.join(tempRoot, "no-config-here");
  }

  afterEach(async () => {
    try {
      for (const child of spawned.splice(0)) {
        await killAndWait(child);
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } finally {
      // Restored even if the cleanup above throws (e.g. a lingering
      // Windows file handle on a SQLite file under `dataDir` making
      // `rmSync` throw EBUSY) — otherwise a later test in this file (or
      // this vitest worker's next file) could inherit a `HALL_CONFIG_DIR`
      // pointed at a directory this test already deleted.
      if (originalHallConfigDirEnv === undefined) {
        // Static property access (not `[HALL_CONFIG_DIR_ENV_OVERRIDE]`) is
        // required here — ESLint's `no-dynamic-delete` rule forbids deleting
        // a dynamically computed property key; the literal below must stay
        // in sync with `HALL_CONFIG_DIR_ENV_OVERRIDE`'s value.
        delete process.env.HALL_CONFIG_DIR;
      } else {
        process.env[HALL_CONFIG_DIR_ENV_OVERRIDE] = originalHallConfigDirEnv;
      }
      originalHallConfigDirEnv = undefined;
    }
  });

  it("verifies a fresh durable configuration, records the fingerprint, and exits 0 without ever binding a port", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-verify-only-"));
    isolateHallConfigDir();
    const workspaceRoot = path.join(tempRoot, "workspace");
    fs.mkdirSync(workspaceRoot);
    const dataDir = path.join(tempRoot, "data");
    const port = 47090;

    const { child, output } = spawnRealServerCapturingOutput([
      "--workspace-root",
      workspaceRoot,
      "--data-dir",
      dataDir,
      "--port",
      String(port),
      "--verify-only",
    ]);
    spawned.push(child);
    await waitForExit(child);

    expect(child.exitCode).toBe(0);
    expect(output.text).toContain("OK: installation verified.");
    await expect(fetch(`http://127.0.0.1:${String(port)}/api/v1/health`)).rejects.toBeTruthy();

    const db = HallDatabase.open({ dataDir, busyTimeoutMs: 2000 });
    try {
      const fingerprintRow = db
        .prepare("SELECT value FROM server_metadata WHERE key = 'configFingerprint.workspaceRoot'")
        .get() as { value: string } | undefined;
      expect(fingerprintRow?.value).toBeDefined();
      const bootCount = db.prepare("SELECT COUNT(*) AS count FROM boots").get() as { count: number };
      expect(bootCount.count).toBe(0);
    } finally {
      db.close();
    }
  }, 20000);

  it("skips storage checks with EXIT_VERIFICATION_INCOMPLETE (not 0) when a real instance is already running against the same dataDir", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-verify-only-live-"));
    isolateHallConfigDir();
    const workspaceRoot = path.join(tempRoot, "workspace");
    fs.mkdirSync(workspaceRoot);
    const dataDir = path.join(tempRoot, "data");
    const livePort = 47091;
    const verifyPort = 47092;

    const live = (
      await attemptStart(
        [
          "--workspace-root",
          workspaceRoot,
          "--data-dir",
          dataDir,
          "--port",
          String(livePort),
          "--mock-scenario",
          "success",
        ],
        livePort,
        5000,
      )
    ).child;
    spawned.push(live);

    const { child: verify, output } = spawnRealServerCapturingOutput([
      "--workspace-root",
      workspaceRoot,
      "--data-dir",
      dataDir,
      "--port",
      String(verifyPort),
      "--verify-only",
    ]);
    spawned.push(verify);
    await waitForExit(verify);

    // Deliberately NOT 0: the skip is expected and safe, but the durable
    // fingerprint compatibility check never ran, so this is a third
    // outcome — neither full success nor a failure. Reporting 0 let
    // install.ps1's reconfigure flow promote a candidate nothing had
    // checked, over the active config of this very running instance.
    expect(verify.exitCode).toBe(EXIT_VERIFICATION_INCOMPLETE);
    expect(output.text).toContain("storage and fingerprint checks were skipped");

    const stillHealthy = await fetch(`http://127.0.0.1:${String(livePort)}/api/v1/health`);
    expect(stillHealthy.status).toBe(200);
  }, 20000);

  it("verifies ephemeral (no --data-dir) configuration and exits 0", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-verify-only-ephemeral-"));
    isolateHallConfigDir();
    const workspaceRoot = path.join(tempRoot, "workspace");
    fs.mkdirSync(workspaceRoot);

    const { child, output } = spawnRealServerCapturingOutput([
      "--workspace-root",
      workspaceRoot,
      "--verify-only",
    ]);
    spawned.push(child);
    await waitForExit(child);

    expect(child.exitCode).toBe(0);
    expect(output.text).toContain("ephemeral mode");
  }, 15000);
});
