import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  attemptStart,
  killAndWait,
  requireBuiltDist,
  retryStartUntilSuccessful,
  waitForHealth,
  waitForNonZeroExit,
  waitForExit,
  waitUntil,
} from "./process-test-support.js";

/**
 * Proves the actual production binary — not `runServer()` in-process, not
 * a synthetic `process.emit("SIGINT")` — survives a genuine, non-graceful
 * OS process kill: committed state is retained, `previousShutdown`
 * reports `"unclean"`, and (Phase 13.1) a restart is correctly rejected
 * while the crashed owner's lock is still fresh and only succeeds once it
 * has genuinely gone stale — see `instance-ownership.ts` and
 * `docs/architecture/0013-durable-persistence-and-recovery.md`.
 *
 * Interrupted-*run* reconciliation (a task genuinely mid-flight when the
 * crash happens) is deliberately NOT re-proven here — the task below is
 * already `completed` before the kill. That path is covered at the
 * module level (`reconcile-tasks.test.ts`) and the composition level
 * (`durable-restart.test.ts`); see this file's own package doc comment
 * and `0013-durable-persistence-and-recovery.md` for why a fixture-only
 * production binary cannot deterministically expose a hanging run
 * without a testing backdoor this phase's kickoff explicitly forbids.
 */
describe("hard-crash restart via the real server binary", () => {
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

  it("rejects an immediate restart while the crashed owner's lock is still fresh, then reacquires ownership once it is genuinely stale, retaining committed state", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-hard-crash-"));
    const workspaceRoot = path.join(tempRoot, "workspace");
    fs.mkdirSync(workspaceRoot);
    const dataDir = path.join(tempRoot, "data");
    const port = 47060;
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    const args = [
      "--workspace-root",
      workspaceRoot,
      "--data-dir",
      dataDir,
      "--port",
      String(port),
      "--mock-scenario",
      "success",
    ];

    const first = (await attemptStart(args, port, 5000)).child;
    spawned.push(first);
    await waitForHealth(port);

    const createResponse = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "proj-1",
        title: "Hard-crash durability check",
        executionMode: "immediate",
        adapterId: "hall.mock-agent",
      }),
    });
    expect(createResponse.status).toBe(202);
    const created = (await createResponse.json()) as { task: { taskId: string } };
    const taskId = created.task.taskId;

    await waitUntil(async () => {
      const response = await fetch(`${baseUrl}/api/v1/tasks/${taskId}`);
      const body = (await response.json()) as { task: { status: string } };
      return body.task.status === "completed" || body.task.status === "failed";
    }, 5000);
    const beforeCrash = (await (await fetch(`${baseUrl}/api/v1/tasks/${taskId}`)).json()) as {
      task: { status: string };
    };
    expect(beforeCrash.task.status).toBe("completed");

    // Non-graceful kill: no SIGINT/SIGTERM handler ever runs, so
    // neither the clean-shutdown marker nor a lock release ever
    // happens — the lock file is left behind with whatever
    // `heartbeatAt` it last wrote, well inside the default staleness
    // window.
    first.kill("SIGKILL");
    await waitForExit(first);

    // Kickoff §5, item 11 (the "genuinely gone but not yet stale"
    // half): the very first restart attempt, made immediately after
    // the crash, must be rejected — proving the ownership gate is
    // real, not a no-op that happens to always let the next boot in.
    const immediate = (await attemptStart(args, port, 5000)).child;
    const immediateExitCode = await waitForNonZeroExit(immediate, 8000);
    expect(immediateExitCode).not.toBe(0);
    await killAndWait(immediate);

    // Kickoff §5, item 10: once the crashed owner's lock has genuinely
    // gone stale (real wall-clock time actually elapsing — this is the
    // production default `staleAfterMs`, not a shortened test-only
    // value, since the real CLI has no override flag for it), a new
    // instance can reacquire ownership and start normally.
    // Per-attempt budget deliberately wider than the 2000ms other
    // process-tests in this directory use: this scenario's restart must
    // run real crash-recovery reconciliation against a database that
    // already holds a completed task, which measurably (~2.2s, timed
    // directly against this exact scenario) takes longer than the
    // lighter, freshly-migrated-or-near-empty databases those other
    // tests restart against.
    const { child: second, attempts } = await retryStartUntilSuccessful(args, port, 6000, 60000);
    spawned.push(second);
    expect(attempts).toBeGreaterThan(1);

    const storageResponse = await fetch(`${baseUrl}/api/v1/system/storage`);
    expect(storageResponse.status).toBe(200);
    const storage = (await storageResponse.json()) as {
      mode: string;
      previousShutdown: string | null;
    };
    expect(storage.mode).toBe("durable");
    expect(storage.previousShutdown).toBe("unclean");

    const afterRestart = (await (await fetch(`${baseUrl}/api/v1/tasks/${taskId}`)).json()) as {
      task: { status: string };
    };
    expect(afterRestart.task.status).toBe("completed");

    // Kickoff §5, item 8: no duplicate record — exactly the one task
    // created against the first instance exists, never two.
    const listResponse = await fetch(`${baseUrl}/api/v1/tasks`);
    const list = (await listResponse.json()) as {
      tasks: readonly { task: { taskId: string } }[];
    };
    expect(list.tasks.filter((record) => record.task.taskId === taskId)).toHaveLength(1);
  }, 90000);
});
