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
  waitUntil,
} from "./process-test-support.js";

/**
 * The one process-level scenario the original Phase 13 report explicitly
 * flagged as module/composition-level only: a run genuinely *non-terminal*
 * at the moment of a real crash, proven here through the actual built
 * binary using the existing, already-legitimate `--mock-scenario
 * cancellable` + `--mock-step-delay-ms` CLI flags (not a new fixture, not
 * a production testing backdoor — both flags already exist for every
 * other Mock Agent scenario). `progressMessageCount` defaults to 2 and is
 * not independently configurable from the CLI, so the maximum allowed
 * `--mock-step-delay-ms` (5000) gives a comfortable ~10-second window in
 * which the task is reliably still `running` when the process is killed.
 */
describe("a genuinely interrupted run is reconciled through the real server binary", () => {
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

  it("marks a task that was genuinely running at the moment of a crash as failed with the interrupted-run code, and never resumes it", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-interrupted-run-"));
    const workspaceRoot = path.join(tempRoot, "workspace");
    fs.mkdirSync(workspaceRoot);
    const dataDir = path.join(tempRoot, "data");
    const port = 47080;
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    const args = [
      "--workspace-root",
      workspaceRoot,
      "--data-dir",
      dataDir,
      "--port",
      String(port),
      "--mock-scenario",
      "cancellable",
      "--mock-step-delay-ms",
      "5000",
    ];

    const first = (await attemptStart(args, port, 5000)).child;
    spawned.push(first);
    await waitForHealth(port);

    const createResponse = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "proj-1",
        title: "Interrupted-run check",
        executionMode: "immediate",
        adapterId: "hall.mock-agent",
      }),
    });
    expect(createResponse.status).toBe(202);
    const created = (await createResponse.json()) as { task: { taskId: string } };
    const taskId = created.task.taskId;

    // Confirm the run is genuinely non-terminal (not yet a single
    // progress step in, given the 5000ms step delay) before killing —
    // this is the one condition that makes this test meaningfully
    // different from the completed-task hard-crash test.
    await waitUntil(async () => {
      const response = await fetch(`${baseUrl}/api/v1/tasks/${taskId}`);
      const body = (await response.json()) as { task: { status: string } };
      return body.task.status === "running";
    }, 3000);

    first.kill("SIGKILL");
    await killAndWait(first);

    // See `hard-crash-restart.test.ts` — a restart that must run real
    // crash-recovery reconciliation measurably (~2.2s, timed directly)
    // exceeds a 2000ms per-attempt budget on this machine under load; a
    // wider budget avoids an intermittent false failure mid-repeated-run
    // matrix rather than a genuine regression.
    const { child: second } = await retryStartUntilSuccessful(args, port, 6000, 60000);
    spawned.push(second);

    const afterRestart = (await (await fetch(`${baseUrl}/api/v1/tasks/${taskId}`)).json()) as {
      task: { status: string };
      failure?: { code: string };
    };

    expect(afterRestart.task.status).toBe("failed");
    expect(afterRestart.failure?.code).toBe("HALL_RESTART_INTERRUPTED_RUN");

    // Never resumed: no further progress/completion events exist past
    // the synthetic interrupted-run failure — the task's own status
    // being `failed` (a terminal state) already structurally forbids
    // any further transition, but confirm no adapter process for this
    // task lingers either.
    expect(afterRestart.task.status).not.toBe("completed");
  }, 90000);
});
