import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runVerifyOnly, VERIFY_STORAGE_SKIPPED_LIVE_INSTANCE } from "./run-verify-only.js";
import type { ResolvedServerConfig } from "../config/resolve-server-config.js";
import { openDurableStorage } from "../persistence/durable-startup.js";
import { EXIT_INVALID_INPUT, EXIT_VERIFICATION_INCOMPLETE } from "../config/server-config.js";

let workspaceRoot: string;
let dataDir: string;

beforeEach(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verify-only-workspace-"));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-only-data-"));
});

afterEach(() => {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function baseConfig(overrides: Partial<ResolvedServerConfig> = {}): ResolvedServerConfig {
  return {
    workspaceRoot,
    port: 4310,
    webOrigin: "http://127.0.0.1:3000",
    enableCodexTrustedLocal: false,
    verifyOnly: true,
    ...overrides,
  };
}

describe("runVerifyOnly — ephemeral mode", () => {
  it("succeeds with exit 0 and never touches any storage when dataDir is omitted", async () => {
    const exitCode = await runVerifyOnly(baseConfig());
    expect(exitCode).toBe(0);
  });

  it("fails closed with EXIT_INVALID_INPUT for a workspaceRoot that does not exist", async () => {
    const exitCode = await runVerifyOnly(baseConfig({ workspaceRoot: path.join(workspaceRoot, "does-not-exist") }));
    expect(exitCode).toBe(EXIT_INVALID_INPUT);
  });
});

describe("runVerifyOnly — durable mode, fresh data dir", () => {
  it("succeeds, records the initial fingerprint, and releases the ownership lock afterward", async () => {
    const exitCode = await runVerifyOnly(baseConfig({ dataDir }));
    expect(exitCode).toBe(0);
    // A real startup afterward must be able to acquire ownership cleanly —
    // proves runVerifyOnly released its lock rather than leaving it held.
    const opened = openDurableStorage({ dataDir, bootId: "next-real-boot", busyTimeoutMs: 5000 });
    opened.db.close();
    opened.ownershipHandle.release();
  });
});

describe("runVerifyOnly — a live instance already holds the data dir", () => {
  // EXIT_VERIFICATION_INCOMPLETE, deliberately NOT 0: the skip is expected
  // and safe, but it is a distinct third outcome, not success. Returning 0
  // here let install.ps1's reconfigure flow promote a candidate whose
  // durable fingerprint compatibility had never been checked.
  it("reports skip as EXIT_VERIFICATION_INCOMPLETE (not success, not failure), never touching the epoch", async () => {
    const live = openDurableStorage({ dataDir, bootId: "live-instance", busyTimeoutMs: 5000 });
    try {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };
      let exitCode: number;
      try {
        exitCode = await runVerifyOnly(baseConfig({ dataDir }));
      } finally {
        console.log = originalLog;
      }
      expect(exitCode).toBe(EXIT_VERIFICATION_INCOMPLETE);
      expect(logs.some((line) => line.includes(VERIFY_STORAGE_SKIPPED_LIVE_INSTANCE))).toBe(true);
    } finally {
      live.db.close();
      live.ownershipHandle.release();
    }
  });
});

describe("runVerifyOnly — fingerprint incompatibility fails closed", () => {
  it("rejects a workspaceRoot that conflicts with the database's recorded fingerprint", async () => {
    const firstRun = await runVerifyOnly(baseConfig({ dataDir }));
    expect(firstRun).toBe(0);

    const otherWorkspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verify-only-other-workspace-"));
    try {
      const secondRun = await runVerifyOnly(baseConfig({ dataDir, workspaceRoot: otherWorkspaceRoot }));
      expect(secondRun).toBe(EXIT_INVALID_INPUT);
    } finally {
      fs.rmSync(otherWorkspaceRoot, { recursive: true, force: true });
    }
  });
});
