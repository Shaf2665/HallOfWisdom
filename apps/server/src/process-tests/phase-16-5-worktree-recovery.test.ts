import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  attemptStart,
  gracefulStop,
  killAndWait,
  requireBuiltDist,
  spawnRealServerWithStdin,
  waitForHealth,
  waitForNonZeroExit,
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

/**
 * Post-merge Phase 16.5 hardening — proves, through the real built binary,
 * that a legacy database (one with persisted `agent_worktrees` rows but no
 * durably recorded `agentWorktreeRoot`) refuses to start when the root is
 * omitted, rather than silently composing no agent-worktree manager and
 * leaving those rows permanently unreconciled. See
 * `server-metadata-repository.ts`'s `checkOrRecordConfigurationFingerprint`
 * for the in-process unit coverage of the same defect; this is the
 * real-process proof that the rejection actually happens before the server
 * ever binds its port or records a boot-ready state.
 */
describe("Phase 16.5 legacy database with worktree rows rejects an omitted agent-worktree root", () => {
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

  it("refuses to start when agent_worktrees rows exist but the root is omitted, touches nothing, and recovers once the exact proven root is supplied", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-phase16-5-legacy-root-"));
    const workspaceRoot = path.join(tempRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    initGitRepo(workspaceRoot);

    const dataDir = path.join(tempRoot, "data");
    const agentWorktreeRootRaw = path.join(tempRoot, "agent-worktrees");
    fs.mkdirSync(agentWorktreeRootRaw, { recursive: true });
    const agentWorktreeRoot = fs.realpathSync.native(agentWorktreeRootRaw);

    const port = 47181;
    const argsWithoutRoot = [
      "--workspace-root",
      workspaceRoot,
      "--data-dir",
      dataDir,
      "--port",
      String(port),
      "--mock-scenario",
      "success",
    ];
    const argsWithCorrectRoot = [
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

    // Boot 1 — establishes the database with no agent-worktree root ever
    // supplied (durable mode, isolation not yet enabled).
    const first = spawnRealServerWithStdin(argsWithoutRoot);
    spawned.push(first);
    await waitForHealth(port);
    await gracefulStop(first);

    // Seed a legacy `agent_worktrees` row directly via raw SQL — the exact
    // state a database could reach with isolation rows present but no
    // root ever durably recorded (a prior version, or an interrupted
    // first enablement). Its `worktree_path` is built from the same
    // canonical root the correct boot below will supply, so it correctly
    // reconstructs once the exact proven root is given.
    const legacyWorktreeId = "legacy-worktree-1";
    const legacyWorktreePath = path.join(agentWorktreeRoot, `wt_${legacyWorktreeId}`);
    {
      const db = HallDatabase.open({ dataDir, busyTimeoutMs: 5000 });
      try {
        db.prepare(
          `INSERT INTO agent_worktrees (
            worktree_id, hall_task_id, hall_agent_run_id, source_repository_root,
            source_working_directory_relative_path, base_commit, worktree_path,
            status, created_at, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, 0)`,
        ).run(
          legacyWorktreeId,
          "legacy-task-1",
          "legacy-run-1",
          fs.realpathSync.native(workspaceRoot),
          ".",
          "0".repeat(40),
          legacyWorktreePath,
          "2026-08-06T00:00:00.000Z",
        );
      } finally {
        db.close();
      }
    }

    const beforeRejection = inspectLegacyRootState(dataDir, legacyWorktreeId);
    expect(beforeRejection.bootCount).toBe(1);

    // Boot 2 — still omits the root. Must be refused before ever binding
    // the port, recording a boot-ready state, or touching the legacy row.
    const attempt = await attemptStart(argsWithoutRoot, port, 8000);
    spawned.push(attempt.child);
    expect(attempt.started).toBe(false);
    const exitCode = await waitForNonZeroExit(attempt.child, 10000);
    expect(exitCode).toBe(2);

    await expect(fetch(`http://127.0.0.1:${String(port)}/api/v1/health`)).rejects.toBeTruthy();

    const afterRejection = inspectLegacyRootState(dataDir, legacyWorktreeId);
    expect(afterRejection.bootCount).toBe(1);
    expect(afterRejection.worktreeStatus).toBe("ready");
    expect(afterRejection.worktreePath).toBe(legacyWorktreePath);
    expect(afterRejection.agentWorktreeRootRecorded).toBeUndefined();

    // Boot 3 — the exact proven root is supplied. The legacy row's
    // reconstructed path matches it, so this database remains
    // recoverable: startup succeeds and the root becomes durably
    // recorded.
    const third = spawnRealServerWithStdin(argsWithCorrectRoot);
    spawned.push(third);
    await waitForHealth(port);
    await gracefulStop(third);

    const afterRecovery = inspectLegacyRootState(dataDir, legacyWorktreeId);
    expect(afterRecovery.agentWorktreeRootRecorded).toBe(agentWorktreeRoot);
  }, 60000);
});

function inspectLegacyRootState(
  dataDir: string,
  worktreeId: string,
): {
  readonly bootCount: number;
  readonly worktreeStatus: string | undefined;
  readonly worktreePath: string | undefined;
  readonly agentWorktreeRootRecorded: string | undefined;
} {
  const db = HallDatabase.open({ dataDir, busyTimeoutMs: 5000 });
  try {
    const bootRow = db.prepare("SELECT COUNT(*) AS count FROM boots").get() as { count: number };
    const worktreeRow = db
      .prepare("SELECT status, worktree_path FROM agent_worktrees WHERE worktree_id = ?")
      .get(worktreeId) as { status: string; worktree_path: string } | undefined;
    const rootRow = db
      .prepare(
        "SELECT value FROM server_metadata WHERE key = 'configFingerprint.agentWorktreeRoot'",
      )
      .get() as { value: string } | undefined;
    return {
      bootCount: bootRow.count,
      worktreeStatus: worktreeRow?.status,
      worktreePath: worktreeRow?.worktree_path,
      agentWorktreeRootRecorded: rootRow?.value,
    };
  } finally {
    db.close();
  }
}

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
