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

    expect(secondPass.inconsistentCleanedCount).toBe(1);
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
    const callsAfterFirst = runner.calls.length;

    const second = await reconcileAgentWorktrees(
      context({
        agentWorktreeStore: store,
        agentWorktreeManager: manager,
        agentWorktreeRoot: ownedRoot,
      }),
    );
    expect(second.worktreesCleaned).toBe(0);
    expect(second.interruptedCreationCount).toBe(0);
    expect(second.inconsistentCleanedCount).toBe(0);
    expect(runner.calls.length).toBe(callsAfterFirst);
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
