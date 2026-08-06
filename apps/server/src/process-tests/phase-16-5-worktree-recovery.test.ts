import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  gracefulStop,
  killAndWait,
  requireBuiltDist,
  spawnRealServerWithStdin,
  waitForHealth,
  waitUntil,
} from "./process-test-support.js";
import { HallDatabase } from "../persistence/database.js";
import { AgentWorktreeManager } from "../agent-worktrees/agent-worktree-manager.js";
import { SqliteAgentWorktreeStore } from "../agent-worktrees/sqlite-agent-worktree-store.js";
import {
  NodeGitCommandRunner,
  nodeGitProcessSpawner,
} from "../agent-worktrees/git-command-runner.js";

/**
 * Phase 16.5 — the one dedicated real-process scenario for restart-safe
 * worktree reconciliation, run only through `pnpm verify:process-recovery`
 * (never the default `pnpm test`) via the actual built `dist/server.js`
 * binary — see `process-test-support.ts`'s module doc comment for why
 * this directory is structured this way. No model-backed provider task is
 * ever run: the "ready terminal worktree with a missing artifact"
 * scenario is built from a real, completed Mock Agent task (whose
 * `runId`/`adapterId`/`agentId` are read back from the real HTTP API) plus
 * a real Git worktree created in-process, through the exact same
 * `AgentWorktreeManager`/`SqliteAgentWorktreeStore` production code uses,
 * against the same durable database file the spawned server process
 * later reopens — never a synthetic shortcut or an in-process unit test
 * standing in for the real restart.
 */
describe("Phase 16.5 restart-safe worktree reconciliation through the real server binary", () => {
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

  it("recovers a missing execution artifact from exact durable evidence and safely cleans up worktrees across real restarts, idempotently, without touching the primary checkout or any orphan", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-phase16-5-recovery-"));
    const workspaceRoot = path.join(tempRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    initGitRepo(workspaceRoot);
    const originalReadme = fs.readFileSync(path.join(workspaceRoot, "README.md"), "utf8");
    const originalHead = git(["rev-parse", "HEAD"], workspaceRoot);

    const dataDir = path.join(tempRoot, "data");
    const agentWorktreeRoot = path.join(tempRoot, "agent-worktrees");
    fs.mkdirSync(agentWorktreeRoot, { recursive: true });
    // A pre-existing, unrelated directory under the owned root — must
    // survive every restart below untouched, proving orphan directories
    // are counted, never deleted or pruned.
    const orphanPath = path.join(agentWorktreeRoot, "wt_definitely-not-hall-owned");
    fs.mkdirSync(orphanPath, { recursive: true });
    fs.writeFileSync(path.join(orphanPath, "sentinel.txt"), "orphan");

    const port = 47180;
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    const args = [
      "--workspace-root",
      workspaceRoot,
      "--data-dir",
      dataDir,
      "--agent-worktree-root",
      agentWorktreeRoot,
      "--port",
      String(port),
      "--mock-scenario",
      "success",
    ];

    // Boot 1 — create and complete a real, non-isolated Mock Agent task
    // through the real HTTP API. Its genuine terminal event and
    // committed identity (runId/adapterId/agentId) are what the seeded
    // worktree below will be tied to.
    const first = spawnRealServerWithStdin(args);
    spawned.push(first);
    await waitForHealth(port);

    const createResponse = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "proj-1",
        title: "Phase 16.5 recovery fixture task",
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
      return body.task.status === "completed";
    }, 10000);

    const completed = (await (await fetch(`${baseUrl}/api/v1/tasks/${taskId}`)).json()) as {
      runId: string;
      adapterId: string;
      agentId: string;
    };
    const { runId, adapterId, agentId } = completed;
    expect(runId).toBeDefined();

    await gracefulStop(first);

    // Seed phase — real `git worktree add`/checkout, in-process, through
    // the exact same manager/store production uses, against the SAME
    // durable database file, tying one real "ready" worktree to the run
    // just completed (Mock Agent's own non-isolated completion path
    // never creates an execution artifact, so this is a genuine, not
    // synthetic, "missing artifact" state) — plus a second worktree used
    // to prove a specific crash boundary (see below).
    let recoveredWorktreeId: string;
    let crashBoundaryWorktreeId: string;
    {
      const db = HallDatabase.open({ dataDir, busyTimeoutMs: 5000 });
      try {
        const store = new SqliteAgentWorktreeStore({ db });
        const gitRunner = isolatedGitRunner();
        const manager = new AgentWorktreeManager({
          store,
          gitRunner,
          ownedRoot: agentWorktreeRoot,
        });

        const readyWorktree = await manager.createWorktree({
          hallTaskId: taskId,
          hallAgentRunId: runId,
          adapterId,
          agentId,
          sourceWorkingDirectory: workspaceRoot,
        });
        recoveredWorktreeId = readyWorktree.record.worktreeId;
        expect(readyWorktree.record.status).toBe("ready");

        // Crash boundary: "cleanup_pending after Git removal but before
        // the durable `cleaned` status was recorded." Clean up for
        // real first (real `git worktree remove`, durably marked
        // `cleaned`), then force the record itself back to
        // `cleanup_pending` — the exact state a crash landing between
        // the real Git removal committing and the following store
        // write would leave behind.
        const crashBoundary = await manager.createWorktree({
          hallTaskId: taskId,
          hallAgentRunId: `${runId}-crash-boundary`,
          adapterId,
          agentId,
          sourceWorkingDirectory: workspaceRoot,
        });
        crashBoundaryWorktreeId = crashBoundary.record.worktreeId;
        const cleaned = await manager.cleanupWorktree(crashBoundaryWorktreeId);
        expect(cleaned.status).toBe("cleaned");
        db.prepare(
          "UPDATE agent_worktrees SET status = 'cleanup_pending', cleaned_at = NULL WHERE worktree_id = ?",
        ).run(crashBoundaryWorktreeId);

        // Boot 1's own ordinary (non-isolated) task completion already
        // persisted its own ordinary execution artifact for this run
        // (Phase 16.2's terminalizer wiring runs for every task, not
        // only isolated ones) — with no worktree id, since Mock Agent
        // was never isolated. Delete it so this fixture faithfully
        // represents the real Phase 16.5 target scenario: a `ready`
        // worktree whose run reached a terminal event, but for which no
        // artifact has yet been durably persisted — the exact crash
        // boundary "authoritative terminalization committed, artifact
        // persistence did not" this test exists to prove recovers
        // safely. Deleting a row that a prior boot already committed is
        // a faithful stand-in for that persistence step never having
        // completed, not a synthetic shortcut around it.
        db.prepare("DELETE FROM agent_execution_artifacts WHERE hall_agent_run_id = ?").run(runId);
      } finally {
        db.close();
      }
    }

    const recoveredWorktreePath = path.join(agentWorktreeRoot, `wt_${recoveredWorktreeId}`);
    expect(fs.existsSync(recoveredWorktreePath)).toBe(true);

    // Boot 2 — the real reconciliation pass. Must, from durable evidence
    // alone: reconstruct and persist the missing artifact BEFORE
    // cleanup, safely remove the now-terminal worktree, durably mark it
    // `cleaned`, and finish the crash-boundary worktree's interrupted
    // cleanup — all without touching the orphan directory or the
    // primary checkout.
    const second = spawnRealServerWithStdin(args);
    spawned.push(second);
    await waitForHealth(port);
    await gracefulStop(second);

    const afterFirstReconciliation = inspectDurableState(dataDir, {
      runId,
      recoveredWorktreeId,
      crashBoundaryWorktreeId,
    });
    expect(afterFirstReconciliation.artifactCount).toBe(1);
    expect(afterFirstReconciliation.artifactOutcome).toBe("completed");
    expect(afterFirstReconciliation.recoveredWorktreeStatus).toBe("cleaned");
    expect(afterFirstReconciliation.crashBoundaryWorktreeStatus).toBe("cleaned");
    expect(fs.existsSync(recoveredWorktreePath)).toBe(false);

    // Boot 3 — idempotency: a second real restart over already-fully-
    // reconciled state must change nothing (no duplicate artifact, no
    // state regression, no error preventing a clean boot).
    const third = spawnRealServerWithStdin(args);
    spawned.push(third);
    await waitForHealth(port);
    await gracefulStop(third);

    const afterSecondReconciliation = inspectDurableState(dataDir, {
      runId,
      recoveredWorktreeId,
      crashBoundaryWorktreeId,
    });
    expect(afterSecondReconciliation.artifactCount).toBe(1);
    expect(afterSecondReconciliation.recoveredWorktreeStatus).toBe("cleaned");
    expect(afterSecondReconciliation.crashBoundaryWorktreeStatus).toBe("cleaned");

    // The primary checkout was never touched by any of the above — same
    // HEAD, same tracked file content, no uncommitted changes.
    expect(git(["rev-parse", "HEAD"], workspaceRoot)).toBe(originalHead);
    expect(fs.readFileSync(path.join(workspaceRoot, "README.md"), "utf8")).toBe(originalReadme);
    expect(git(["status", "--porcelain"], workspaceRoot)).toBe("");

    // The unrelated, unknown directory under the owned root was never
    // deleted or pruned by any restart above.
    expect(fs.existsSync(orphanPath)).toBe(true);
    expect(fs.readFileSync(path.join(orphanPath, "sentinel.txt"), "utf8")).toBe("orphan");
  }, 120000);
});

function inspectDurableState(
  dataDir: string,
  input: {
    readonly runId: string;
    readonly recoveredWorktreeId: string;
    readonly crashBoundaryWorktreeId: string;
  },
): {
  readonly artifactCount: number;
  readonly artifactOutcome: string | undefined;
  readonly recoveredWorktreeStatus: string | undefined;
  readonly crashBoundaryWorktreeStatus: string | undefined;
} {
  const db = HallDatabase.open({ dataDir, busyTimeoutMs: 5000 });
  try {
    const artifacts = db
      .prepare("SELECT terminal_outcome FROM agent_execution_artifacts WHERE hall_agent_run_id = ?")
      .all(input.runId) as { terminal_outcome: string }[];
    const recoveredRow = db
      .prepare("SELECT status FROM agent_worktrees WHERE worktree_id = ?")
      .get(input.recoveredWorktreeId) as { status: string } | undefined;
    const crashBoundaryRow = db
      .prepare("SELECT status FROM agent_worktrees WHERE worktree_id = ?")
      .get(input.crashBoundaryWorktreeId) as { status: string } | undefined;
    return {
      artifactCount: artifacts.length,
      artifactOutcome: artifacts[0]?.terminal_outcome,
      recoveredWorktreeStatus: recoveredRow?.status,
      crashBoundaryWorktreeStatus: crashBoundaryRow?.status,
    };
  } finally {
    db.close();
  }
}

function initGitRepo(repoRoot: string): void {
  git(["init", "-b", "main"], repoRoot);
  git(["config", "user.name", "Hall Test"], repoRoot);
  git(["config", "user.email", "hall-test@example.invalid"], repoRoot);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "hello\n");
  git(["add", "README.md"], repoRoot);
  git(["commit", "-m", "initial"], repoRoot);
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
  }).trim();
}

/** Isolated from the operator's own global Git config, matching the pattern `agent-worktree-manager.test.ts` already established. */
function isolatedGitRunner(): NodeGitCommandRunner {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hall-isolated-git-home-"));
  return new NodeGitCommandRunner({
    parentEnv: {
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
      SYSTEMROOT: process.env.SYSTEMROOT,
      WINDIR: process.env.WINDIR,
      COMSPEC: process.env.COMSPEC,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      HOME: home,
      USERPROFILE: home,
      APPDATA: home,
      LOCALAPPDATA: home,
    },
    spawner: {
      spawn(executablePath, args, options) {
        return nodeGitProcessSpawner.spawn(executablePath, args, {
          ...options,
          env: { ...options.env, GIT_CONFIG_NOSYSTEM: "1" },
        });
      },
    },
  });
}
