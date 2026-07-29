import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { HallDatabase } from "../persistence/database.js";
import {
  killAndWait,
  requireBuiltDist,
  retryStartUntilSuccessful,
  waitForHealth,
} from "./process-test-support.js";

const FROZEN_OWNER_CHILD_PATH = fileURLToPath(
  new URL("../../dist/process-tests/frozen-owner-child.js", import.meta.url),
);

function requireFrozenOwnerChildBuilt(): void {
  if (!fs.existsSync(FROZEN_OWNER_CHILD_PATH)) {
    throw new Error(
      `frozen-owner-child.js not found at "${FROZEN_OWNER_CHILD_PATH}". Build first: run "pnpm --filter @hall-of-wisdom/hall-core run build", or the root "pnpm verify:process-recovery" command.`,
    );
  }
}

function spawnFrozenOwnerChild(dataDir: string): ChildProcess {
  return spawn(process.execPath, [FROZEN_OWNER_CHILD_PATH, dataDir], {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
}

/**
 * A tiny line-delimited-JSON reader over a child's stdout, decoupled from
 * `readline` so repeated single-line reads across the child's whole
 * lifetime don't require juggling multiple `readline.Interface` instances
 * over the same stream.
 */
function createLineReader(child: ChildProcess): { next(): Promise<Record<string, unknown>> } {
  const pendingLines: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let buffer = "";
  const stdout = child.stdout;
  if (stdout === null) throw new Error("child process has no stdout");
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(line);
      else pendingLines.push(line);
    }
  });
  return {
    next(): Promise<Record<string, unknown>> {
      return new Promise((resolve) => {
        const raw = pendingLines.shift();
        if (raw !== undefined) {
          resolve(JSON.parse(raw) as Record<string, unknown>);
          return;
        }
        waiters.push((line) => {
          resolve(JSON.parse(line) as Record<string, unknown>);
        });
      });
    },
  };
}

function sendCommand(child: ChildProcess, command: string): void {
  const stdin = child.stdin;
  if (stdin === null) throw new Error("child process has no stdin");
  stdin.write(`${command}\n`);
}

/**
 * Kickoff §6 — the one scenario a real production-binary crash test
 * cannot prove: a former owner that is not dead, merely frozen (a
 * debugger breakpoint, a STOP signal, a paused hypervisor — see
 * `instance-ownership.ts`'s "Disclosed limitation" doc comment), which
 * later resumes and attempts a durable write through the *same*
 * connection it held the whole time. `frozen-owner-child.ts` stays alive
 * and interactive for exactly this reason — a `SIGKILL`led process's
 * connection would already be gone, which is a materially weaker proof
 * (that scenario is already covered by `hard-crash-restart.test.ts`).
 */
describe("a frozen (not crashed) former owner cannot commit after a legitimate takeover", () => {
  beforeAll(() => {
    requireBuiltDist();
    requireFrozenOwnerChildBuilt();
  });

  let tempRoot: string;
  const spawned: ChildProcess[] = [];

  afterEach(async () => {
    // Kickoff §6, item 8 — every child process this test started is
    // confirmed cleaned up, regardless of where the test failed.
    for (const child of spawned.splice(0)) {
      await killAndWait(child);
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("A freezes after acquiring ownership, B legitimately takes over, and A's original connection is rejected by the database fence on its next write", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-frozen-owner-"));
    const workspaceRoot = path.join(tempRoot, "workspace");
    fs.mkdirSync(workspaceRoot);
    const dataDir = path.join(tempRoot, "data");

    // Kickoff §6, item 1 — A acquires ownership and opens the database.
    const a = spawnFrozenOwnerChild(dataDir);
    spawned.push(a);
    const aOutput = createLineReader(a);
    const readyEvent = await aOutput.next();
    expect(readyEvent).toEqual({ event: "ready", ownerToken: readyEvent.ownerToken, epoch: 1 });

    // Confirm A can genuinely mutate before anything happens — otherwise
    // the later "rejected" result would be meaningless.
    sendCommand(a, "MUTATE");
    expect(await aOutput.next()).toEqual({ event: "mutate-result", ok: true });

    // Kickoff §6, item 2 — A stops heartbeating without releasing
    // ownership: frozen, not dead.
    sendCommand(a, "PAUSE-HEARTBEAT");
    expect(await aOutput.next()).toEqual({ event: "heartbeat-paused" });

    // Kickoff §6, item 3 — wait until A's lock is genuinely stale, then B
    // (the real production binary) legitimately takes over.
    // `staleAfterMs`'s production default (20s) has no CLI override,
    // reused as-is here exactly like `hard-crash-restart.test.ts`.
    const portB = 47090;
    const argsForB = [
      "--workspace-root",
      workspaceRoot,
      "--data-dir",
      dataDir,
      "--port",
      String(portB),
      "--mock-scenario",
      "success",
    ];
    const { child: b } = await retryStartUntilSuccessful(argsForB, portB, 2000, 40000);
    spawned.push(b);
    await waitForHealth(portB);

    // Kickoff §6, item 6 — B remains able to mutate: create a real task
    // through the real REST API.
    const baseUrlB = `http://127.0.0.1:${String(portB)}`;
    const createResponse = await fetch(`${baseUrlB}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "proj-1",
        title: "B takeover check",
        executionMode: "immediate",
        adapterId: "hall.mock-agent",
      }),
    });
    expect(createResponse.status).toBe(202);
    const created = (await createResponse.json()) as { task: { taskId: string } };
    const afterB = await fetch(`${baseUrlB}/api/v1/tasks/${created.task.taskId}`);
    expect(afterB.status).toBe(200);

    // Kickoff §6, items 4 & 5 — A resumes and attempts a durable
    // mutation through its *original* connection, never reopened, never
    // re-acquired. This is the core proof: rejected by the database
    // fence, not by any filesystem check (A's own in-process state has
    // no idea it has been displaced).
    sendCommand(a, "MUTATE");
    const rejectedMutate = await aOutput.next();
    expect(rejectedMutate).toEqual({
      event: "mutate-result",
      ok: false,
      error: "OwnershipLostError",
    });

    // Kickoff §6, item 7 — A cannot remove B's ownership record: A's own
    // `release()` call is confirmed to leave B fully healthy afterward
    // (see `instance-ownership.ts`'s `release()` — it only ever removes a
    // lock file that still holds its own token).
    sendCommand(a, "RELEASE-ATTEMPT");
    expect(await aOutput.next()).toEqual({ event: "release-attempted" });

    const stillHealthy = await fetch(`${baseUrlB}/api/v1/health`);
    expect(stillHealthy.status).toBe(200);
    const stillHasTask = await fetch(`${baseUrlB}/api/v1/tasks/${created.task.taskId}`);
    expect(stillHasTask.status).toBe(200);

    sendCommand(a, "EXIT");
    await killAndWait(a);
    await killAndWait(b);

    // Direct database inspection — the authoritative proof that no rows
    // beyond A's one legitimate pre-displacement write and B's one real
    // task ever landed: A's every post-displacement MUTATE attempt
    // (there was exactly one) contributed nothing.
    const db = HallDatabase.open({ dataDir, busyTimeoutMs: 2000 });
    try {
      const scratchCount = db
        .prepare("SELECT COUNT(*) AS count FROM frozen_owner_test_scratch")
        .get() as { count: number };
      expect(scratchCount.count).toBe(1);
      const taskCount = db.prepare("SELECT COUNT(*) AS count FROM tasks").get() as {
        count: number;
      };
      expect(taskCount.count).toBe(1);
    } finally {
      db.close();
    }
  }, 60000);
});
