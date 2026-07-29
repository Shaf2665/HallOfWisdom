import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { HallDatabase } from "../persistence/database.js";
import { LOCK_FILE_NAME } from "../persistence/instance-ownership.js";
import {
  attemptStart,
  killAndWait,
  requireBuiltDist,
  spawnRealServerCapturingOutput,
  waitForExit,
  waitForHealth,
  waitForNonZeroExit,
  waitUntil,
} from "./process-test-support.js";

/**
 * The real-child-process proof kickoff §3 explicitly requires "at least
 * one" of: a live first instance and a concurrently-started second
 * instance against the *same* `--data-dir`, proving the second is
 * rejected before it ever mutates anything, while the first stays fully
 * healthy throughout. Covers kickoff §3 items 2–6 and §5 item 11.
 */
describe("a live second Hall Core instance cannot use the same dataDir", () => {
  beforeAll(() => {
    requireBuiltDist();
  });

  let tempRoot: string;
  const spawned: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of spawned.splice(0)) {
      await killAndWait(child);
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("rejects the second instance without a boot record, without touching state, while the first remains responsive", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-concurrent-ownership-"));
    const workspaceRoot = path.join(tempRoot, "workspace");
    fs.mkdirSync(workspaceRoot);
    const dataDir = path.join(tempRoot, "data");
    const portA = 47070;
    const portB = 47071;
    const baseUrlA = `http://127.0.0.1:${String(portA)}`;

    const argsFor = (port: number): string[] => [
      "--workspace-root",
      workspaceRoot,
      "--data-dir",
      dataDir,
      "--port",
      String(port),
      "--mock-scenario",
      "success",
    ];

    const a = (await attemptStart(argsFor(portA), portA, 5000)).child;
    spawned.push(a);
    await waitForHealth(portA);

    const createResponse = await fetch(`${baseUrlA}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "proj-1",
        title: "Ownership contention check",
        executionMode: "immediate",
        adapterId: "hall.mock-agent",
      }),
    });
    expect(createResponse.status).toBe(202);
    const created = (await createResponse.json()) as { task: { taskId: string } };
    const taskId = created.task.taskId;
    await waitUntil(async () => {
      const response = await fetch(`${baseUrlA}/api/v1/tasks/${taskId}`);
      const body = (await response.json()) as { task: { status: string } };
      return body.task.status === "completed";
    }, 5000);

    // B targets the SAME dataDir, a DIFFERENT port — isolating the
    // rejection to ownership contention rather than a port conflict.
    const { child: b, output } = spawnRealServerCapturingOutput(argsFor(portB));
    const bExitCode = await waitForNonZeroExit(b, 10000);

    expect(bExitCode).not.toBe(0);
    // Kickoff requirement: ownership metadata (dataDir, lock path) is
    // never exposed publicly — including in the CLI's own diagnostic.
    expect(output.text).not.toContain(dataDir);
    expect(output.text).not.toContain(LOCK_FILE_NAME);

    // B must never have bound its port at all.
    await expect(fetch(`http://127.0.0.1:${String(portB)}/api/v1/health`)).rejects.toBeTruthy();

    // A must remain fully healthy and unaffected throughout.
    const stillHealthy = await fetch(`${baseUrlA}/api/v1/health`);
    expect(stillHealthy.status).toBe(200);
    const stillHasTask = await fetch(`${baseUrlA}/api/v1/tasks/${taskId}`);
    const stillHasTaskBody = (await stillHasTask.json()) as { task: { status: string } };
    expect(stillHasTaskBody.task.status).toBe("completed");

    // Stop A so the database can be inspected directly afterward. A
    // real OS SIGINT cannot be reliably delivered to a *child* process
    // from a Node parent on Windows (`ChildProcess.kill('SIGINT')` is
    // documented to behave like a forceful kill there) — graceful
    // shutdown's lock-release path is instead verified in-process, via
    // `runServer()` + a real `process.emit("SIGINT")` on the current
    // process, in `server.test.ts` ("releases the ownership lock file
    // on a graceful shutdown, and a new instance can reacquire it
    // immediately"). A `SIGKILL` here is sufficient for this test's own
    // purpose, which is only to prove what B did — never what A's own
    // shutdown path does.
    await killAndWait(a);
    await waitForExit(a);

    // Direct database inspection — the authoritative proof that B
    // never wrote a boot record, never allocated a task, and never
    // touched a revision/sequence: exactly one boot row (A's) and
    // exactly one task row (the one created above) exist.
    const db = HallDatabase.open({ dataDir, busyTimeoutMs: 2000 });
    try {
      const bootCount = db.prepare("SELECT COUNT(*) AS count FROM boots").get() as {
        count: number;
      };
      const taskCount = db.prepare("SELECT COUNT(*) AS count FROM tasks").get() as {
        count: number;
      };
      expect(bootCount.count).toBe(1);
      expect(taskCount.count).toBe(1);
    } finally {
      db.close();
    }
  }, 30000);
});
