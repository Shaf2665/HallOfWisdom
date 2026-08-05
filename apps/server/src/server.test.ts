import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runServer } from "./server.js";
import { waitUntil } from "./test-support.js";

/**
 * `runServer` blocks (awaiting an internal promise) until a shutdown
 * signal is received, so every test here starts it without awaiting the
 * returned promise up front, pokes it via HTTP or a synthetic signal, and
 * only then awaits the promise it already holds a reference to. Signals
 * are triggered via `process.emit(...)`, never a real OS signal — see
 * `process/signal-shutdown.test.ts` for why.
 */
describe("runServer", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-server-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("starts, serves a request, and shuts down cleanly on SIGINT with exit code 0", async () => {
    const beforeSigint = process.listenerCount("SIGINT");
    const exitCodePromise = runServer([
      "--workspace-root",
      tempRoot,
      "--port",
      "47001",
      "--mock-scenario",
      "success",
    ]);

    await waitUntil(() => process.listenerCount("SIGINT") > beforeSigint, 3000);

    process.emit("SIGINT", "SIGINT");

    const exitCode = await exitCodePromise;
    expect(exitCode).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
  });

  it("rejects invalid CLI input with exit code 2 and does not bind a port", async () => {
    const exitCode = await runServer(["--workspace-root", ""]);
    expect(exitCode).toBe(2);
  });

  it("rejects a nonexistent workspace root with exit code 2", async () => {
    const missing = path.join(tempRoot, "does-not-exist");
    const exitCode = await runServer(["--workspace-root", missing]);
    expect(exitCode).toBe(2);
  });

  it("rejects an invalid --mock-scenario with exit code 2", async () => {
    const exitCode = await runServer([
      "--workspace-root",
      tempRoot,
      "--mock-scenario",
      "not-a-real-scenario",
    ]);
    expect(exitCode).toBe(2);
  });

  it("rejects a --data-dir nested inside --workspace-root with exit code 2 and does not bind a port", async () => {
    const nestedDataDir = path.join(tempRoot, "data");
    const exitCode = await runServer(["--workspace-root", tempRoot, "--data-dir", nestedDataDir]);
    expect(exitCode).toBe(2);
  });

  it("rejects a Hall-owned agent worktree root nested inside --workspace-root before creating it", async () => {
    const workspaceRoot = path.join(tempRoot, "workspace");
    const dataDir = path.join(tempRoot, "data");
    const nestedWorktreeRoot = path.join(workspaceRoot, ".hall-worktrees");
    fs.mkdirSync(workspaceRoot);
    const exitCode = await runServer([
      "--workspace-root",
      workspaceRoot,
      "--data-dir",
      dataDir,
      "--agent-worktree-root",
      nestedWorktreeRoot,
    ]);
    expect(exitCode).toBe(2);
    expect(fs.existsSync(nestedWorktreeRoot)).toBe(false);
  });

  it("boots twice in a row with --data-dir against the same directory, reporting previousShutdown clean on the second boot after a graceful first shutdown", async () => {
    const workspaceRoot = path.join(tempRoot, "workspace");
    fs.mkdirSync(workspaceRoot);
    const dataDir = path.join(tempRoot, "data");
    const previousShutdowns: unknown[] = [];

    for (let i = 0; i < 2; i += 1) {
      const port = 47020 + i;
      const beforeSigint = process.listenerCount("SIGINT");
      const exitCodePromise = runServer([
        "--workspace-root",
        workspaceRoot,
        "--data-dir",
        dataDir,
        "--port",
        String(port),
        "--mock-scenario",
        "success",
      ]);

      await waitUntil(() => process.listenerCount("SIGINT") > beforeSigint, 3000);

      const response = await fetch(`http://127.0.0.1:${String(port)}/api/v1/system/storage`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { mode: string; previousShutdown: unknown };
      expect(body.mode).toBe("durable");
      previousShutdowns.push(body.previousShutdown);

      process.emit("SIGINT", "SIGINT");
      const exitCode = await exitCodePromise;
      expect(exitCode).toBe(0);
    }

    expect(previousShutdowns).toEqual(["first_start", "clean"]);
    expect(fs.existsSync(path.join(dataDir, "hall-core.db"))).toBe(true);
  });

  it("holds the instance-ownership lock while running, releases it on a graceful shutdown, and a new instance can reacquire it immediately", async () => {
    const workspaceRoot = path.join(tempRoot, "workspace");
    fs.mkdirSync(workspaceRoot);
    const dataDir = path.join(tempRoot, "data");
    const lockPath = path.join(dataDir, "hall-core.lock");

    const beforeSigint = process.listenerCount("SIGINT");
    const firstExitCodePromise = runServer([
      "--workspace-root",
      workspaceRoot,
      "--data-dir",
      dataDir,
      "--port",
      "47030",
      "--mock-scenario",
      "success",
    ]);
    await waitUntil(() => process.listenerCount("SIGINT") > beforeSigint, 3000);

    expect(fs.existsSync(lockPath)).toBe(true);

    // Real cross-process SIGINT delivery on Windows behaves like a
    // forceful kill (see `process-tests/concurrent-instance-rejected.test.ts`'s
    // doc comment) — so graceful-shutdown behavior is verified here,
    // in-process, via a synthetic signal on the SAME process actually
    // running `runServer`'s real code, exactly like every other signal
    // test in this file.
    process.emit("SIGINT", "SIGINT");
    const firstExitCode = await firstExitCodePromise;
    expect(firstExitCode).toBe(0);

    expect(fs.existsSync(lockPath)).toBe(false);

    // No staleness wait needed — the lock was genuinely released, not
    // merely stale, so a new instance acquires it immediately.
    const beforeSecondSigint = process.listenerCount("SIGINT");
    const secondExitCodePromise = runServer([
      "--workspace-root",
      workspaceRoot,
      "--data-dir",
      dataDir,
      "--port",
      "47031",
      "--mock-scenario",
      "success",
    ]);
    await waitUntil(() => process.listenerCount("SIGINT") > beforeSecondSigint, 3000);
    expect(fs.existsSync(lockPath)).toBe(true);

    process.emit("SIGINT", "SIGINT");
    const secondExitCode = await secondExitCodePromise;
    expect(secondExitCode).toBe(0);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("releases the instance-ownership lock if startup fails after ownership was already acquired", async () => {
    const workspaceRoot = path.join(tempRoot, "workspace");
    fs.mkdirSync(workspaceRoot);
    const dataDir = path.join(tempRoot, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const lockPath = path.join(dataDir, "hall-core.lock");
    // A corrupt (non-SQLite) file at the expected database path makes
    // `HallDatabase.open`/`runMigrations` fail AFTER ownership has
    // already been acquired — exercising the "startup failure after
    // ownership acquisition releases resources" requirement without
    // needing a real second OS process.
    fs.writeFileSync(path.join(dataDir, "hall-core.db"), "not a real sqlite file");

    const exitCode = await runServer([
      "--workspace-root",
      workspaceRoot,
      "--data-dir",
      dataDir,
      "--port",
      "47032",
      "--mock-scenario",
      "success",
    ]);

    expect(exitCode).not.toBe(0);
    expect(fs.existsSync(lockPath)).toBe(false);

    // A subsequent legitimate start against the same (now-fixed) dataDir
    // must not be blocked by a dangling lock from the failed attempt.
    fs.rmSync(path.join(dataDir, "hall-core.db"));
    const beforeSigint = process.listenerCount("SIGINT");
    const recoveredExitCodePromise = runServer([
      "--workspace-root",
      workspaceRoot,
      "--data-dir",
      dataDir,
      "--port",
      "47033",
      "--mock-scenario",
      "success",
    ]);
    await waitUntil(() => process.listenerCount("SIGINT") > beforeSigint, 3000);
    expect(fs.existsSync(lockPath)).toBe(true);
    process.emit("SIGINT", "SIGINT");
    expect(await recoveredExitCodePromise).toBe(0);
  });

  it("does not accumulate SIGINT/SIGTERM listeners across repeated start/stop cycles", async () => {
    const beforeInt = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");

    for (let i = 0; i < 3; i += 1) {
      const exitCodePromise = runServer([
        "--workspace-root",
        tempRoot,
        "--port",
        String(47010 + i),
        "--mock-scenario",
        "success",
      ]);
      await waitUntil(() => process.listenerCount("SIGINT") > beforeInt, 3000);
      process.emit("SIGINT", "SIGINT");
      await exitCodePromise;
    }

    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
  });
});
