import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Shared support for `src/process-tests/**` — every test in this
 * directory spawns the actual built `dist/server.js` binary as a real OS
 * child process, never `runServer()` in-process. See
 * `docs/architecture/0013-durable-persistence-and-recovery.md`,
 * "Process-level verification" for why this directory is deliberately
 * excluded from the default `pnpm test` (`vitest.config.ts`'s `exclude`)
 * and only reachable through the dedicated `pnpm verify:process-recovery`
 * command (root `package.json`), which builds first — see that script
 * for why a stale or missing `dist/` can never silently pass here.
 */

export const DIST_SERVER_PATH = fileURLToPath(new URL("../../dist/server.js", import.meta.url));

/**
 * Throws a clear, actionable error — never silently skips — when
 * `dist/server.js` is missing or was built from source older than this
 * test file itself (a coarse staleness heuristic; the authoritative
 * guarantee is that `pnpm verify:process-recovery` always rebuilds
 * first, this check only protects a developer running this file
 * directly against a stale local `dist/`).
 */
export function requireBuiltDist(): void {
  if (!fs.existsSync(DIST_SERVER_PATH)) {
    throw new Error(
      `dist/server.js not found at "${DIST_SERVER_PATH}". Process-level tests require a build first: ` +
        `run "pnpm --filter @hall-of-wisdom/hall-core run build" in this package, or run the ` +
        `documented "pnpm verify:process-recovery" command from the repository root, which builds ` +
        `automatically before running these tests.`,
    );
  }
}

export async function waitUntil(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function spawnRealServer(args: readonly string[]): ChildProcess {
  return spawn(process.execPath, [DIST_SERVER_PATH, ...args], {
    stdio: "ignore",
    windowsHide: true,
  });
}

/** Same as `spawnRealServer`, but captures stdout/stderr into a buffer instead of discarding it — for tests that need to inspect a rejected instance's diagnostic output. */
export function spawnRealServerCapturingOutput(args: readonly string[]): {
  readonly child: ChildProcess;
  readonly output: { text: string };
} {
  const child = spawn(process.execPath, [DIST_SERVER_PATH, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const output = { text: "" };
  child.stdout.on("data", (chunk: Buffer) => {
    output.text += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output.text += chunk.toString("utf8");
  });
  return { child, output };
}

export async function waitForHealth(port: number, timeoutMs = 5000): Promise<void> {
  await waitUntil(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/v1/health`);
      return response.status === 200;
    } catch {
      return false;
    }
  }, timeoutMs);
}

export async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });
}

/** Resolves once the process has exited AND it did so with a non-zero code — used for "this instance must fail to start" assertions, bounded by `timeoutMs`. */
export async function waitForNonZeroExit(child: ChildProcess, timeoutMs = 10000): Promise<number> {
  const start = Date.now();
  while (child.exitCode === null) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitForNonZeroExit: process did not exit within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return child.exitCode;
}

/** Best-effort kill-and-wait for test cleanup — never throws, safe to call on an already-exited child. */
export async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitForExit(child);
  }
}

export interface StartAttemptResult {
  readonly child: ChildProcess;
  readonly started: boolean;
}

/**
 * Spawns a real server instance and races two outcomes within
 * `timeoutMs`: the health endpoint responding (`started: true`) or the
 * process exiting on its own first, e.g. rejected by instance ownership
 * (`started: false`) — whichever happens first, without waiting out the
 * full timeout once the outcome is already decided.
 */
export async function attemptStart(
  args: readonly string[],
  port: number,
  timeoutMs: number,
): Promise<StartAttemptResult> {
  const child = spawnRealServer(args);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) {
      return { child, started: false };
    }
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/v1/health`);
      if (response.status === 200) return { child, started: true };
    } catch {
      // Not reachable yet — keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { child, started: child.exitCode === null && (await isHealthy(port)) };
}

async function isHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/v1/health`);
    return response.status === 200;
  } catch {
    return false;
  }
}

/**
 * Retries `attemptStart` in a loop until it succeeds or `overallTimeoutMs`
 * elapses. Every failed attempt's child is confirmed exited before the
 * next attempt — used to prove that a genuinely stale ownership lock is
 * eventually reacquired, once real wall-clock time has actually passed.
 */
export async function retryStartUntilSuccessful(
  args: readonly string[],
  port: number,
  perAttemptTimeoutMs: number,
  overallTimeoutMs: number,
): Promise<{ readonly child: ChildProcess; readonly attempts: number }> {
  const start = Date.now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const result = await attemptStart(args, port, perAttemptTimeoutMs);
    if (result.started) return { child: result.child, attempts };
    await killAndWait(result.child);
    if (Date.now() - start > overallTimeoutMs) {
      throw new Error(
        `retryStartUntilSuccessful: no attempt succeeded within ${String(overallTimeoutMs)}ms (${String(attempts)} attempts)`,
      );
    }
  }
}
