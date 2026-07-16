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
