import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventFactory } from "@hall-of-wisdom/agent-adapter-sdk";
import { AgentWorktreeManager } from "../agent-worktrees/agent-worktree-manager.js";
import { InMemoryAgentWorktreeStore } from "../agent-worktrees/in-memory-agent-worktree-store.js";
import {
  NodeGitCommandRunner,
  nodeGitProcessSpawner,
  type GitCommandRunner,
} from "../agent-worktrees/git-command-runner.js";
import { EventStore } from "../events/event-store.js";
import { InMemoryAgentExecutionArtifactStore } from "../execution-artifacts/in-memory-agent-execution-artifact-store.js";
import { AgentExecutionArtifactTerminalizer } from "../agent-execution/agent-execution-artifact-terminalizer.js";
import { GitArtifactCollector } from "../agent-execution/git-artifact-collector.js";
import { reconcileAgentWorktrees } from "./reconcile-agent-worktrees.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("reconcileAgentWorktrees", () => {
  it("marks an interrupted 'creating' worktree with no path as interrupted and cleans it up", async () => {
    const fixture = createFixtureRepository("creating-no-path");
    const ownedRoot = makeTempDir("hall owned ");
    const store = new InMemoryAgentWorktreeStore();
    const manager = new AgentWorktreeManager({ store, gitRunner: testGitRunner(), ownedRoot });
    store.createCreating({
      worktreeId: "wt-no-path",
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      adapterId: "hall.codex",
      agentId: "agent-1",
      canonicalSourceRepositoryRoot: fixture.repo,
      sourceWorkingDirectoryRelativePath: ".",
      baseCommit: fixture.head,
      canonicalWorktreePath: path.join(ownedRoot, "wt_wt-no-path"),
      createdAt: "2026-08-05T00:00:00.000Z",
    });

    const summary = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
      }),
    );

    expect(summary.interruptedCreationCount).toBe(1);
    expect(summary.worktreesCleaned).toBe(1);
    const final = store.get("wt-no-path");
    expect(final.status).toBe("cleaned");
    expect(final.safeFailureCode).toBeUndefined();
  });

  it("fails soft (never deletes arbitrarily) on an interrupted 'creating' worktree with an unregistered partial directory", async () => {
    const fixture = createFixtureRepository("creating-partial-path");
    const ownedRoot = makeTempDir("hall owned ");
    const partialPath = path.join(ownedRoot, "wt_wt-partial");
    fs.mkdirSync(partialPath, { recursive: true });
    fs.writeFileSync(path.join(partialPath, "leftover.txt"), "leftover");
    const store = new InMemoryAgentWorktreeStore();
    const manager = new AgentWorktreeManager({ store, gitRunner: testGitRunner(), ownedRoot });
    store.createCreating({
      worktreeId: "wt-partial",
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      adapterId: "hall.codex",
      agentId: "agent-1",
      canonicalSourceRepositoryRoot: fixture.repo,
      sourceWorkingDirectoryRelativePath: ".",
      baseCommit: fixture.head,
      canonicalWorktreePath: partialPath,
      createdAt: "2026-08-05T00:00:00.000Z",
    });

    const summary = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
      }),
    );

    expect(summary.interruptedCreationCount).toBe(1);
    expect(summary.cleanupFailures).toBe(1);
    expect(store.get("wt-partial").status).toBe("cleanup_failed");
    // Never a recursive filesystem fallback — the untracked leftover file must survive.
    expect(fs.existsSync(path.join(partialPath, "leftover.txt"))).toBe(true);
  });

  it("cleans up an interrupted 'creating' worktree that Git had already registered before the crash", async () => {
    const fixture = createFixtureRepository("creating-registered");
    const ownedRoot = makeTempDir("hall owned ");
    const worktreePath = path.join(ownedRoot, "wt_wt-registered");
    git(["worktree", "add", "--detach", "--no-checkout", worktreePath, fixture.head], fixture.repo);
    const store = new InMemoryAgentWorktreeStore();
    const manager = new AgentWorktreeManager({ store, gitRunner: testGitRunner(), ownedRoot });
    store.createCreating({
      worktreeId: "wt-registered",
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      adapterId: "hall.codex",
      agentId: "agent-1",
      canonicalSourceRepositoryRoot: fixture.repo,
      sourceWorkingDirectoryRelativePath: ".",
      baseCommit: fixture.head,
      canonicalWorktreePath: fs.realpathSync.native(worktreePath),
      createdAt: "2026-08-05T00:00:00.000Z",
    });

    const summary = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
      }),
    );

    expect(summary.worktreesCleaned).toBe(1);
    expect(store.get("wt-registered").status).toBe("cleaned");
    expect(fs.existsSync(worktreePath)).toBe(false);
  });

  it("attempts residual cleanup exactly once for a 'creation_failed' worktree whose path was already gone", async () => {
    const fixture = createFixtureRepository("creation-failed");
    const ownedRoot = makeTempDir("hall owned ");
    const store = new InMemoryAgentWorktreeStore();
    const manager = new AgentWorktreeManager({ store, gitRunner: testGitRunner(), ownedRoot });
    const creating = store.createCreating({
      worktreeId: "wt-cf",
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      canonicalSourceRepositoryRoot: fixture.repo,
      sourceWorkingDirectoryRelativePath: ".",
      baseCommit: fixture.head,
      canonicalWorktreePath: path.join(ownedRoot, "wt_wt-cf"),
      createdAt: "2026-08-05T00:00:00.000Z",
    });
    store.markCreationFailed({
      worktreeId: "wt-cf",
      expectedRevision: creating.revision,
      safeFailureCode: "GIT_FAILURE",
      safeFailureSummary: "simulated",
      now: "2026-08-05T00:00:01.000Z",
    });

    const summary = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
      }),
    );

    expect(summary.cleanupAttempts).toBe(1);
    expect(summary.worktreesCleaned).toBe(1);
    expect(store.get("wt-cf").status).toBe("cleaned");
  });

  it("resumes a 'cleanup_pending' worktree left mid-teardown", async () => {
    const { manager, store, ownedRoot, worktreeId, worktreePath } =
      await readyWorktreeFixture("cleanup-pending");
    const ready = store.get(worktreeId);
    store.requestCleanup({
      worktreeId,
      expectedRevision: ready.revision,
      now: "2026-08-05T00:05:00.000Z",
    });
    expect(fs.existsSync(worktreePath)).toBe(true);

    const summary = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
      }),
    );

    expect(summary.worktreesCleaned).toBe(1);
    expect(store.get(worktreeId).status).toBe("cleaned");
    expect(fs.existsSync(worktreePath)).toBe(false);
  });

  it("retries a 'cleanup_failed' worktree at most once per boot", async () => {
    const fixture = createFixtureRepository("cleanup-failed");
    const ownedRoot = makeTempDir("hall owned ");
    const unregisteredPath = path.join(ownedRoot, "wt_wt-stuck");
    fs.mkdirSync(unregisteredPath, { recursive: true });
    const store = new InMemoryAgentWorktreeStore();
    const runner = new RecordingGitRunner(testGitRunner());
    const manager = new AgentWorktreeManager({ store, gitRunner: runner, ownedRoot });
    const creating = store.createCreating({
      worktreeId: "wt-stuck",
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      canonicalSourceRepositoryRoot: fixture.repo,
      sourceWorkingDirectoryRelativePath: ".",
      baseCommit: fixture.head,
      canonicalWorktreePath: fs.realpathSync.native(unregisteredPath),
      createdAt: "2026-08-05T00:00:00.000Z",
    });
    const ready = store.markReady({
      worktreeId: "wt-stuck",
      expectedRevision: creating.revision,
      readyAt: "2026-08-05T00:00:01.000Z",
    });
    const pending = store.requestCleanup({
      worktreeId: "wt-stuck",
      expectedRevision: ready.revision,
      now: "2026-08-05T00:00:02.000Z",
    });
    store.markCleanupFailed({
      worktreeId: "wt-stuck",
      expectedRevision: pending.revision,
      safeFailureCode: "GIT_WORKTREE_REMOVE_FAILED",
      safeFailureSummary: "simulated",
      now: "2026-08-05T00:00:03.000Z",
    });

    const summary = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
      }),
    );

    expect(summary.cleanupAttempts).toBe(1);
    expect(summary.cleanupFailures).toBe(1);
    expect(store.get("wt-stuck").status).toBe("cleanup_failed");
    expect(runner.calls.filter((call) => call.args.includes("remove")).length).toBe(1);
  });

  it("confirms an already-matching artifact for a ready terminal worktree and cleans it up", async () => {
    const {
      manager,
      store,
      ownedRoot,
      worktreeId,
      taskId,
      runId,
      taskEventStore,
      artifactStore,
      terminalizer,
    } = await readyWorktreeFixture("ready-confirm");
    const factory = new EventFactory({ runId, taskId, agentId: "agent-1" });
    const started = factory.runStarted();
    const completed = factory.runCompleted("done");
    taskEventStore.append(taskId, started, { runId, taskId, agentId: "agent-1" });
    taskEventStore.append(taskId, completed, { runId, taskId, agentId: "agent-1" });
    // Must match exactly what the terminalizer's own Git evidence collector
    // would reconstruct from the real, untouched worktree (HEAD still at
    // base commit, zero diff) — this is what makes it a genuine semantic
    // match rather than an incidental one.
    const baseCommit = store.get(worktreeId).baseCommit;
    artifactStore.create({
      artifactId: "artifact-preexisting",
      hallTaskId: taskId,
      hallAgentRunId: runId,
      adapterId: "hall.codex",
      worktreeId,
      outcome: "completed",
      startedAt: started.timestamp,
      finishedAt: completed.timestamp,
      durationMs: Math.max(0, Date.parse(completed.timestamp) - Date.parse(started.timestamp)),
      baseCommit,
      finalCommit: baseCommit,
      changedFiles: [],
      diffSummary: { filesChanged: 0, insertions: 0, deletions: 0 },
      finalSummary: "done",
      createdAt: completed.timestamp,
    });

    const summary = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
        taskEventStore,
        agentExecutionArtifactStore: artifactStore,
        agentExecutionArtifactTerminalizer: terminalizer,
      }),
    );

    expect(summary.artifactsConfirmed).toBe(1);
    expect(summary.artifactsRecovered).toBe(0);
    expect(summary.worktreesCleaned).toBe(1);
    expect(store.get(worktreeId).status).toBe("cleaned");
  });

  it("reconstructs a missing artifact for a ready terminal worktree from exact durable evidence, then cleans it up", async () => {
    const {
      manager,
      store,
      ownedRoot,
      worktreeId,
      taskId,
      runId,
      taskEventStore,
      artifactStore,
      terminalizer,
    } = await readyWorktreeFixture("ready-recover");
    const factory = new EventFactory({ runId, taskId, agentId: "agent-1" });
    const started = factory.runStarted();
    const completed = factory.runCompleted("recovered summary");
    taskEventStore.append(taskId, started, { runId, taskId, agentId: "agent-1" });
    taskEventStore.append(taskId, completed, { runId, taskId, agentId: "agent-1" });
    expect(artifactStore.findByHallAgentRunId(runId)).toBeUndefined();

    const summary = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
        taskEventStore,
        agentExecutionArtifactStore: artifactStore,
        agentExecutionArtifactTerminalizer: terminalizer,
      }),
    );

    expect(summary.artifactsRecovered).toBe(1);
    expect(summary.worktreesCleaned).toBe(1);
    const artifact = artifactStore.getByHallAgentRunId(runId);
    expect(artifact.hallTaskId).toBe(taskId);
    expect(artifact.adapterId).toBe("hall.codex");
    expect(artifact.outcome).toBe("completed");
    expect(store.get(worktreeId).status).toBe("cleaned");
  });

  it("reconstructs the exact old run's artifact when a newer retry's events share the same task stream", async () => {
    const {
      manager,
      store,
      ownedRoot,
      worktreeId,
      taskId,
      runId,
      taskEventStore,
      artifactStore,
      terminalizer,
    } = await readyWorktreeFixture("ready-old-run");
    // "agent-1" matches the immutable identity `readyWorktreeFixture` captured on the
    // worktree record at creation time — this is the OLD run this worktree actually belongs to.
    const oldFactory = new EventFactory({ runId, taskId, agentId: "agent-1" });
    taskEventStore.append(taskId, oldFactory.runStarted(), {
      runId,
      taskId,
      agentId: "agent-1",
    });
    const oldCompleted = oldFactory.runCompleted("old run result");
    taskEventStore.append(taskId, oldCompleted, { runId, taskId, agentId: "agent-1" });

    // A newer, unrelated retry run for the SAME task, with a different agentId — its own
    // worktree (if any) is out of scope for this record; only its events share the one
    // continuous per-task stream, exactly like a real governed retry (Phase 15.2).
    expect(taskEventStore.reopenForRetry(taskId, oldCompleted.sequence)).toBe(true);
    const newRunId = "run-newer-retry";
    const newFactory = new EventFactory({ runId: newRunId, taskId, agentId: "agent-new" });
    const newStarted = {
      ...newFactory.runStarted(),
      sequence: taskEventStore.nextSequence(taskId),
    };
    taskEventStore.append(taskId, newStarted, {
      runId: newRunId,
      taskId,
      agentId: "agent-new",
    });

    const summary = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
        taskEventStore,
        agentExecutionArtifactStore: artifactStore,
        agentExecutionArtifactTerminalizer: terminalizer,
      }),
    );

    expect(summary.artifactsRecovered).toBe(1);
    const artifact = artifactStore.getByHallAgentRunId(runId);
    expect(artifact.hallAgentRunId).toBe(runId);
    expect(artifact.adapterId).toBe("hall.codex");
    expect(store.get(worktreeId).status).toBe("cleaned");
    // The newer retry's own run is untouched — never conflated with the old run's artifact.
    expect(artifactStore.findByHallAgentRunId(newRunId)).toBeUndefined();
  });

  it("blocks cleanup when a pre-existing artifact semantically mismatches the reconstructed evidence", async () => {
    const {
      manager,
      store,
      ownedRoot,
      worktreeId,
      taskId,
      runId,
      taskEventStore,
      artifactStore,
      terminalizer,
    } = await readyWorktreeFixture("ready-mismatch");
    const factory = new EventFactory({ runId, taskId, agentId: "agent-1" });
    const started = factory.runStarted();
    const completed = factory.runCompleted("actual summary");
    taskEventStore.append(taskId, started, { runId, taskId, agentId: "agent-1" });
    taskEventStore.append(taskId, completed, { runId, taskId, agentId: "agent-1" });
    artifactStore.create({
      artifactId: "artifact-mismatched",
      hallTaskId: taskId,
      hallAgentRunId: runId,
      adapterId: "hall.codex",
      worktreeId,
      outcome: "failed",
      terminalReasonCode: "SOMETHING_ELSE",
      safeTerminalSummary: "a different outcome entirely",
      startedAt: started.timestamp,
      finishedAt: completed.timestamp,
      durationMs: 1,
      changedFiles: [],
      diffSummary: { filesChanged: 0, insertions: 0, deletions: 0 },
      createdAt: completed.timestamp,
    });

    const summary = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
        taskEventStore,
        agentExecutionArtifactStore: artifactStore,
        agentExecutionArtifactTerminalizer: terminalizer,
      }),
    );

    expect(summary.reconciliationBlockedCount).toBe(1);
    expect(summary.worktreesCleaned).toBe(0);
    expect(store.get(worktreeId).status).toBe("ready");
  });

  it("blocks cleanup for a legacy ready worktree with no captured adapter/agent identity, never fabricating one", async () => {
    const fixture = createFixtureRepository("legacy-identity");
    const ownedRoot = makeTempDir("hall owned ");
    const store = new InMemoryAgentWorktreeStore();
    const manager = new AgentWorktreeManager({ store, gitRunner: testGitRunner(), ownedRoot });
    const created = await manager.createWorktree({
      hallTaskId: "task-legacy",
      hallAgentRunId: "run-legacy",
      sourceWorkingDirectory: fixture.repo,
    });
    expect(created.record.adapterId).toBeUndefined();
    const taskEventStore = new EventStore({ maxEventsPerTask: 100 });
    const factory = new EventFactory({
      runId: "run-legacy",
      taskId: "task-legacy",
      agentId: "agent-1",
    });
    taskEventStore.append("task-legacy", factory.runStarted(), {
      runId: "run-legacy",
      taskId: "task-legacy",
      agentId: "agent-1",
    });
    taskEventStore.append("task-legacy", factory.runCompleted("done"), {
      runId: "run-legacy",
      taskId: "task-legacy",
      agentId: "agent-1",
    });

    const summary = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
        taskEventStore,
      }),
    );

    expect(summary.reconciliationBlockedCount).toBe(1);
    expect(summary.worktreesCleaned).toBe(0);
    expect(store.get(created.record.worktreeId).status).toBe("ready");
  });

  it("blocks (never fabricates) when the ready worktree's source repository is gone", async () => {
    const {
      manager,
      store,
      ownedRoot,
      worktreeId,
      taskId,
      runId,
      taskEventStore,
      sourceRepo,
      artifactStore,
      terminalizer,
    } = await readyWorktreeFixture("ready-source-missing");
    const factory = new EventFactory({ runId, taskId, agentId: "agent-1" });
    taskEventStore.append(taskId, factory.runStarted(), { runId, taskId, agentId: "agent-1" });
    taskEventStore.append(taskId, factory.runCompleted("done"), {
      runId,
      taskId,
      agentId: "agent-1",
    });
    fs.rmSync(sourceRepo, { recursive: true, force: true });

    const summary = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
        taskEventStore,
        agentExecutionArtifactStore: artifactStore,
        agentExecutionArtifactTerminalizer: terminalizer,
      }),
    );

    expect(summary.reconciliationBlockedCount).toBe(1);
    expect(summary.worktreesCleaned).toBe(0);
    expect(store.get(worktreeId).status).toBe("ready");
  });

  it("reports (but never deletes) a cleaned worktree whose path unexpectedly reappeared, and never transitions it backward", async () => {
    const {
      manager,
      store,
      ownedRoot,
      worktreeId,
      worktreePath,
      taskId,
      runId,
      taskEventStore,
      artifactStore,
      terminalizer,
    } = await readyWorktreeFixture("cleaned-reappeared");
    const factory = new EventFactory({ runId, taskId, agentId: "agent-1" });
    taskEventStore.append(taskId, factory.runStarted(), { runId, taskId, agentId: "agent-1" });
    taskEventStore.append(taskId, factory.runCompleted("done"), {
      runId,
      taskId,
      agentId: "agent-1",
    });
    const contextInput = {
      agentWorktreeStore: store,
      agentWorktreeManager: manager,
      agentWorktreeRoot: ownedRoot,
      taskEventStore,
      agentExecutionArtifactStore: artifactStore,
      agentExecutionArtifactTerminalizer: terminalizer,
    };
    const firstPass = await reconcileAgentWorktrees(context(contextInput));
    expect(firstPass.worktreesCleaned).toBe(1);
    expect(store.get(worktreeId).status).toBe("cleaned");
    expect(fs.existsSync(worktreePath)).toBe(false);

    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "reappeared.txt"), "reappeared");

    const secondPass = await reconcileAgentWorktrees(context(contextInput));

    expect(secondPass.inconsistentCleanedDirectoryCount).toBe(1);
    expect(store.get(worktreeId).status).toBe("cleaned");
    expect(fs.existsSync(path.join(worktreePath, "reappeared.txt"))).toBe(true);
  });

  it("counts an unknown directory under the owned root as an orphan without touching it", async () => {
    const fixture = createFixtureRepository("orphan-scan");
    const ownedRoot = makeTempDir("hall owned ");
    const orphanPath = path.join(ownedRoot, "wt_never-persisted");
    fs.mkdirSync(orphanPath, { recursive: true });
    fs.writeFileSync(path.join(orphanPath, "mystery.txt"), "mystery");
    const store = new InMemoryAgentWorktreeStore();
    const manager = new AgentWorktreeManager({ store, gitRunner: testGitRunner(), ownedRoot });
    void fixture;

    const summary = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
      }),
    );

    expect(summary.orphanWorktreeDirectoryCount).toBe(1);
    expect(fs.existsSync(orphanPath)).toBe(true);
  });

  it("is idempotent across repeated boots — a second pass performs no further Git mutation", async () => {
    const fixture = createFixtureRepository("idempotent");
    const ownedRoot = makeTempDir("hall owned ");
    const store = new InMemoryAgentWorktreeStore();
    const runner = new RecordingGitRunner(testGitRunner());
    const manager = new AgentWorktreeManager({ store, gitRunner: runner, ownedRoot });
    store.createCreating({
      worktreeId: "wt-idem",
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      canonicalSourceRepositoryRoot: fixture.repo,
      sourceWorkingDirectoryRelativePath: ".",
      baseCommit: fixture.head,
      canonicalWorktreePath: path.join(ownedRoot, "wt_wt-idem"),
      createdAt: "2026-08-05T00:00:00.000Z",
    });

    const first = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
      }),
    );
    expect(first.worktreesCleaned).toBe(1);
    const mutatingCallsAfterFirst = countMutatingGitCalls(runner);

    const second = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
      }),
    );
    expect(second.worktreesCleaned).toBe(0);
    expect(second.interruptedCreationCount).toBe(0);
    expect(second.inconsistentCleanedDirectoryCount).toBe(0);
    expect(second.inconsistentCleanedRegistrationCount).toBe(0);
    // The second pass still issues a read-only `git worktree list`
    // registration inspection (expected every boot) but no further
    // mutating `worktree add`/`worktree remove` call.
    expect(countMutatingGitCalls(runner)).toBe(mutatingCallsAfterFirst);
    expect(store.get("wt-idem").status).toBe("cleaned");
  });

  it("returns only bounded numeric counts, never a path", async () => {
    const fixture = createFixtureRepository("bounded-summary");
    const ownedRoot = makeTempDir("hall owned ");
    const store = new InMemoryAgentWorktreeStore();
    const manager = new AgentWorktreeManager({ store, gitRunner: testGitRunner(), ownedRoot });
    void fixture;

    const summary = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
      }),
    );

    for (const value of Object.values(summary)) {
      expect(typeof value).toBe("number");
    }
  });

  it("counts a real Git worktree registration with a directory that is not backed by any persisted record, and never deletes it", async () => {
    // Registration inspection only ever runs against a source repository
    // Hall already has at least one persisted record for — it has no way
    // to discover an entirely unrelated repository. This fixture has one
    // legitimate `ready` worktree so the source repo is in scope, plus a
    // second, orphan registration under the same repo Hall never created.
    const { manager, store, ownedRoot, taskId, runId, taskEventStore } = await readyWorktreeFixture(
      "orphan-registration-with-dir",
    );
    void taskId;
    void runId;
    void taskEventStore;
    const sourceRepo = store.list()[0]?.canonicalSourceRepositoryRoot ?? "";
    const head = store.list()[0]?.baseCommit ?? "";
    const orphanPath = path.join(ownedRoot, "wt_never-persisted");
    git(["worktree", "add", "--detach", "--no-checkout", orphanPath, head], sourceRepo);

    const summary = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
      }),
    );

    expect(summary.orphanWorktreeRegistrationCount).toBe(1);
    expect(fs.existsSync(orphanPath)).toBe(true);
    expect(isWorktreeRegistered(sourceRepo, orphanPath)).toBe(true);
  });

  it("counts an orphan Git registration whose directory is already missing, without pruning it", async () => {
    const { manager, store, ownedRoot } = await readyWorktreeFixture(
      "orphan-registration-missing-dir",
    );
    const sourceRepo = store.list()[0]?.canonicalSourceRepositoryRoot ?? "";
    const head = store.list()[0]?.baseCommit ?? "";
    const orphanPath = path.join(ownedRoot, "wt_dangling");
    git(["worktree", "add", "--detach", "--no-checkout", orphanPath, head], sourceRepo);
    fs.rmSync(orphanPath, { recursive: true, force: true });
    expect(isWorktreeRegistered(sourceRepo, orphanPath)).toBe(true);

    const summary = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
      }),
    );

    expect(summary.orphanWorktreeRegistrationCount).toBe(1);
    // Never `git worktree prune` — the dangling registration is untouched.
    expect(isWorktreeRegistered(sourceRepo, orphanPath)).toBe(true);
  });

  it("reports (but never deletes or prunes) a cleaned record whose Git registration unexpectedly reappeared", async () => {
    const {
      manager,
      store,
      ownedRoot,
      worktreeId,
      worktreePath,
      taskId,
      runId,
      taskEventStore,
      artifactStore,
      terminalizer,
    } = await readyWorktreeFixture("cleaned-registration-reappeared");
    const sourceRepo = store.get(worktreeId).canonicalSourceRepositoryRoot;
    const baseCommit = store.get(worktreeId).baseCommit;
    const factory = new EventFactory({ runId, taskId, agentId: "agent-1" });
    taskEventStore.append(taskId, factory.runStarted(), { runId, taskId, agentId: "agent-1" });
    taskEventStore.append(taskId, factory.runCompleted("done"), {
      runId,
      taskId,
      agentId: "agent-1",
    });
    const contextInput = {
      agentWorktreeStore: store,
      agentWorktreeManager: manager,
      agentWorktreeRoot: ownedRoot,
      taskEventStore,
      agentExecutionArtifactStore: artifactStore,
      agentExecutionArtifactTerminalizer: terminalizer,
    };
    const firstPass = await reconcileAgentWorktrees(context(contextInput));
    expect(firstPass.worktreesCleaned).toBe(1);
    expect(store.get(worktreeId).status).toBe("cleaned");
    expect(fs.existsSync(worktreePath)).toBe(false);

    // Simulate the registration reappearing (e.g. an external `git worktree
    // add` reusing the exact same path) without recreating the directory
    // through Hall's own manager.
    fs.mkdirSync(worktreePath, { recursive: true });
    git(["worktree", "add", "--detach", "--no-checkout", worktreePath, baseCommit], sourceRepo);

    const secondPass = await reconcileAgentWorktrees(context(contextInput));

    expect(secondPass.inconsistentCleanedRegistrationCount).toBe(1);
    expect(store.get(worktreeId).status).toBe("cleaned");
    expect(isWorktreeRegistered(sourceRepo, worktreePath)).toBe(true);
  });

  it("reports a bounded registration-inspection failure (never a silent zero) when the source repository is unavailable", async () => {
    const fixture = createFixtureRepository("registration-source-missing");
    const ownedRoot = makeTempDir("hall owned ");
    const store = new InMemoryAgentWorktreeStore();
    const manager = new AgentWorktreeManager({ store, gitRunner: testGitRunner(), ownedRoot });
    const worktreePath = path.join(ownedRoot, "wt_wt-src-missing");
    fs.mkdirSync(worktreePath, { recursive: true });
    const creating = store.createCreating({
      worktreeId: "wt-src-missing",
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      adapterId: "hall.codex",
      agentId: "agent-1",
      canonicalSourceRepositoryRoot: fixture.repo,
      sourceWorkingDirectoryRelativePath: ".",
      baseCommit: fixture.head,
      canonicalWorktreePath: fs.realpathSync.native(worktreePath),
      createdAt: "2026-08-06T00:00:00.000Z",
    });
    store.markReady({
      worktreeId: "wt-src-missing",
      expectedRevision: creating.revision,
      readyAt: "2026-08-06T00:00:01.000Z",
    });
    fs.rmSync(fixture.repo, { recursive: true, force: true });

    const summary = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
      }),
    );

    expect(summary.registrationInspectionFailureCount).toBeGreaterThanOrEqual(1);
    expect(summary.orphanWorktreeRegistrationCount).toBe(0);
  });

  it("reports a bounded registration-inspection failure (never a silent zero) on truncated Git worktree-list output", async () => {
    const fixture = createFixtureRepository("registration-truncated");
    const ownedRoot = makeTempDir("hall owned ");
    const store = new InMemoryAgentWorktreeStore();
    const realRunner = testGitRunner();
    const truncatingRunner: GitCommandRunner = {
      run(input): ReturnType<GitCommandRunner["run"]> {
        if (input.args.includes("list")) {
          return Promise.resolve({
            exitCode: 0,
            signal: null,
            stdout: "worktree ",
            stderr: "",
            stdoutTruncated: true,
            stderrTruncated: false,
            timedOut: false,
            spawnError: undefined,
          });
        }
        return realRunner.run(input);
      },
    };
    const manager = new AgentWorktreeManager({ store, gitRunner: truncatingRunner, ownedRoot });
    const worktreePath = path.join(ownedRoot, "wt_wt-truncated");
    fs.mkdirSync(worktreePath, { recursive: true });
    const creating = store.createCreating({
      worktreeId: "wt-truncated",
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      adapterId: "hall.codex",
      agentId: "agent-1",
      canonicalSourceRepositoryRoot: fixture.repo,
      sourceWorkingDirectoryRelativePath: ".",
      baseCommit: fixture.head,
      canonicalWorktreePath: fs.realpathSync.native(worktreePath),
      createdAt: "2026-08-06T00:00:00.000Z",
    });
    store.markReady({
      worktreeId: "wt-truncated",
      expectedRevision: creating.revision,
      readyAt: "2026-08-06T00:00:01.000Z",
    });

    const summary = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
      }),
    );

    expect(summary.registrationInspectionFailureCount).toBeGreaterThanOrEqual(1);
    expect(summary.orphanWorktreeRegistrationCount).toBe(0);
  });

  it("reports a bounded registration-inspection failure (never a silent zero) on malformed exit-code-zero Git worktree-list output", async () => {
    const fixture = createFixtureRepository("registration-malformed");
    const ownedRoot = makeTempDir("hall owned ");
    const store = new InMemoryAgentWorktreeStore();
    const realRunner = testGitRunner();
    const malformedRunner: GitCommandRunner = {
      run(input): ReturnType<GitCommandRunner["run"]> {
        if (input.args.includes("list")) {
          return Promise.resolve({
            exitCode: 0,
            signal: null,
            stdout: "this is not valid porcelain -z output",
            stderr: "",
            timedOut: false,
            spawnError: undefined,
          });
        }
        return realRunner.run(input);
      },
    };
    const manager = new AgentWorktreeManager({ store, gitRunner: malformedRunner, ownedRoot });
    const worktreePath = path.join(ownedRoot, "wt_wt-malformed");
    fs.mkdirSync(worktreePath, { recursive: true });
    const creating = store.createCreating({
      worktreeId: "wt-malformed",
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      adapterId: "hall.codex",
      agentId: "agent-1",
      canonicalSourceRepositoryRoot: fixture.repo,
      sourceWorkingDirectoryRelativePath: ".",
      baseCommit: fixture.head,
      canonicalWorktreePath: fs.realpathSync.native(worktreePath),
      createdAt: "2026-08-06T00:00:00.000Z",
    });
    store.markReady({
      worktreeId: "wt-malformed",
      expectedRevision: creating.revision,
      readyAt: "2026-08-06T00:00:01.000Z",
    });

    const summary = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
      }),
    );

    // The whole point of this test: malformed-but-exit-zero output must
    // never be silently parsed down to an empty registration list — it
    // must surface as a bounded inspection failure instead, exactly like
    // a hard Git failure or truncation does.
    expect(summary.registrationInspectionFailureCount).toBeGreaterThanOrEqual(1);
    expect(summary.orphanWorktreeRegistrationCount).toBe(0);
  });

  it("reports a bounded registration-inspection failure (never a silent zero) on genuinely empty exit-code-zero Git worktree-list output", async () => {
    const fixture = createFixtureRepository("registration-empty");
    const ownedRoot = makeTempDir("hall owned ");
    const store = new InMemoryAgentWorktreeStore();
    const realRunner = testGitRunner();
    const emptyOutputRunner: GitCommandRunner = {
      run(input): ReturnType<GitCommandRunner["run"]> {
        if (input.args.includes("list")) {
          return Promise.resolve({
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            timedOut: false,
            spawnError: undefined,
          });
        }
        return realRunner.run(input);
      },
    };
    const manager = new AgentWorktreeManager({ store, gitRunner: emptyOutputRunner, ownedRoot });
    const worktreePath = path.join(ownedRoot, "wt_wt-empty");
    fs.mkdirSync(worktreePath, { recursive: true });
    const creating = store.createCreating({
      worktreeId: "wt-empty",
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      adapterId: "hall.codex",
      agentId: "agent-1",
      canonicalSourceRepositoryRoot: fixture.repo,
      sourceWorkingDirectoryRelativePath: ".",
      baseCommit: fixture.head,
      canonicalWorktreePath: fs.realpathSync.native(worktreePath),
      createdAt: "2026-08-06T00:00:00.000Z",
    });
    store.markReady({
      worktreeId: "wt-empty",
      expectedRevision: creating.revision,
      readyAt: "2026-08-06T00:00:01.000Z",
    });

    const summary = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
      }),
    );

    // A successful `git worktree list --porcelain -z` invocation always
    // reports at least one record — genuinely empty output is never
    // proof that nothing is registered, so this must surface as a
    // bounded inspection failure, never a silent zero.
    expect(summary.registrationInspectionFailureCount).toBeGreaterThanOrEqual(1);
    expect(summary.orphanWorktreeRegistrationCount).toBe(0);
  });

  it("counts a symlink or junction entry under the owned root rather than silently skipping it", async () => {
    const fixture = createFixtureRepository("symlink-entry");
    const ownedRoot = makeTempDir("hall owned ");
    const store = new InMemoryAgentWorktreeStore();
    const manager = new AgentWorktreeManager({ store, gitRunner: testGitRunner(), ownedRoot });
    void fixture;
    const target = makeTempDir("hall symlink target ");
    const linkPath = path.join(ownedRoot, "wt_symlinked");
    try {
      fs.symlinkSync(target, linkPath, "junction");
    } catch {
      return undefined;
    }

    const summary = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
      }),
    );

    expect(summary.orphanWorktreeDirectoryCount).toBe(1);
    expect(
      fs.existsSync(linkPath) || fs.lstatSync(linkPath, { throwIfNoEntry: false }) !== undefined,
    ).toBe(true);
  });
});

interface ReconciliationContextOverrides {
  readonly agentWorktreeStore: InMemoryAgentWorktreeStore;
  readonly agentWorktreeManager: AgentWorktreeManager;
  readonly agentWorktreeRoot: string;
  readonly taskEventStore?: EventStore;
  readonly agentExecutionArtifactStore?: InMemoryAgentExecutionArtifactStore;
  readonly agentExecutionArtifactTerminalizer?: AgentExecutionArtifactTerminalizer;
}

function context(overrides: ReconciliationContextOverrides) {
  const agentExecutionArtifactStore =
    overrides.agentExecutionArtifactStore ?? new InMemoryAgentExecutionArtifactStore();
  return {
    agentWorktreeStore: overrides.agentWorktreeStore,
    agentWorktreeManager: overrides.agentWorktreeManager,
    agentWorktreeRoot: overrides.agentWorktreeRoot,
    taskEventStore: overrides.taskEventStore ?? new EventStore({ maxEventsPerTask: 100 }),
    agentExecutionArtifactStore,
    agentExecutionArtifactTerminalizer:
      overrides.agentExecutionArtifactTerminalizer ??
      new AgentExecutionArtifactTerminalizer({ store: agentExecutionArtifactStore }),
  };
}

async function readyWorktreeFixture(name: string): Promise<{
  readonly manager: AgentWorktreeManager;
  readonly store: InMemoryAgentWorktreeStore;
  readonly ownedRoot: string;
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly sourceRepo: string;
  readonly taskId: string;
  readonly runId: string;
  readonly taskEventStore: EventStore;
  readonly artifactStore: InMemoryAgentExecutionArtifactStore;
  readonly terminalizer: AgentExecutionArtifactTerminalizer;
}> {
  const fixture = createFixtureRepository(name);
  const ownedRoot = makeTempDir("hall owned ");
  const store = new InMemoryAgentWorktreeStore();
  const gitRunner = testGitRunner();
  const manager = new AgentWorktreeManager({ store, gitRunner, ownedRoot });
  const taskId = "task-1";
  const runId = "run-1";
  const created = await manager.createWorktree({
    hallTaskId: taskId,
    hallAgentRunId: runId,
    adapterId: "hall.codex",
    agentId: "agent-1",
    sourceWorkingDirectory: fixture.repo,
  });
  const taskEventStore = new EventStore({ maxEventsPerTask: 100 });
  const artifactStore = new InMemoryAgentExecutionArtifactStore();
  const terminalizer = new AgentExecutionArtifactTerminalizer({
    store: artifactStore,
    gitArtifactCollector: new GitArtifactCollector({ gitRunner, worktreeValidator: manager }),
  });
  return {
    manager,
    store,
    ownedRoot,
    worktreeId: created.record.worktreeId,
    worktreePath: created.record.canonicalWorktreePath,
    sourceRepo: fixture.repo,
    taskId,
    runId,
    taskEventStore,
    artifactStore,
    terminalizer,
  };
}

function createFixtureRepository(name: string): { readonly repo: string; readonly head: string } {
  const repo = path.join(makeTempDir("hall-agent-worktree-reconcile-fixture "), name);
  fs.mkdirSync(repo, { recursive: true });
  git(["init", "-b", "main"], repo);
  git(["config", "user.name", "Hall Test"], repo);
  git(["config", "user.email", "hall-test@example.invalid"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "initial"], repo);
  return {
    repo: fs.realpathSync.native(repo),
    head: git(["rev-parse", "--verify", "HEAD^{commit}"], repo),
  };
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync.native(dir);
}

function testGitRunner(): NodeGitCommandRunner {
  const home = makeTempDir("hall isolated git home ");
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

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
  }).trim();
}

function isWorktreeRegistered(sourceRepositoryRoot: string, worktreePath: string): boolean {
  const stdout = git(["worktree", "list", "--porcelain"], sourceRepositoryRoot);
  const resolved = path.resolve(worktreePath);
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length).trim()))
    .some((candidate) => candidate.toLowerCase() === resolved.toLowerCase());
}

class RecordingGitRunner {
  readonly calls: { readonly args: readonly string[] }[] = [];
  readonly #inner: NodeGitCommandRunner;

  constructor(inner: NodeGitCommandRunner) {
    this.#inner = inner;
  }

  run(input: Parameters<NodeGitCommandRunner["run"]>[0]): ReturnType<NodeGitCommandRunner["run"]> {
    this.calls.push({ args: input.args });
    return this.#inner.run(input);
  }
}

function countMutatingGitCalls(runner: RecordingGitRunner): number {
  return runner.calls.filter((call) => call.args.includes("add") || call.args.includes("remove"))
    .length;
}
