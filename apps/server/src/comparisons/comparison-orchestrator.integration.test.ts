import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import type {
  AgentAdapter,
  AgentAdapterDescriptor,
  AgentDetectionResult,
  AgentExecutionOptions,
  AgentRunHandle,
  AgentTaskInput,
  AvailabilityStatus,
  RunTerminalState,
} from "@hall-of-wisdom/agent-adapter-sdk";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { ComparisonOrchestrator } from "./comparison-orchestrator.js";
import { ComparisonStore } from "./comparison-store.js";
import { GitWorktreeManager } from "./git-worktree-manager.js";
import { nodeProcessSpawner } from "./process-spawner.js";
import type { ProcessSpawner, SpawnedProcessHandle, SpawnOptions } from "./process-spawner.js";
import { TaskStore } from "../tasks/task-store.js";
import { EventStore } from "../events/event-store.js";
import { EventBus } from "../events/event-bus.js";
import {
  ComparisonCandidateNotEligibleError,
  ComparisonStateConflictError,
} from "../errors/app-error.js";
import type { TaskRecord } from "../tasks/task-record.js";

/**
 * Integration coverage for `ComparisonOrchestrator` against real `git`
 * temp repositories and a purpose-built scripted `AgentAdapter` — the
 * existing E2E fixture adapters (`apps/e2e/src/fixture-adapters.ts`)
 * always reject `startTask()`, so they cannot exercise a real
 * prepare -> start -> complete -> cleanup lifecycle. This file targets
 * exactly the paths a fake-adapter unit test cannot: prepare rollback
 * atomicity against real Git locking, result-evidence capture against a
 * real worktree, the cleanup/finalization race (see
 * `ComparisonOrchestrator#cleanupComparison`'s doc comment), and start-time
 * re-eligibility rejection.
 */

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function initRepoWithCommit(repoPath: string): void {
  git(["init", "--quiet"], repoPath);
  git(["config", "user.email", "hall-of-wisdom-test@example.com"], repoPath);
  git(["config", "user.name", "Hall of Wisdom Test"], repoPath);
  fs.writeFileSync(path.join(repoPath, "README.md"), "hello\n");
  git(["add", "README.md"], repoPath);
  git(["commit", "--quiet", "-m", "initial commit"], repoPath);
}

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function buildDescriptor(adapterId: string): AgentAdapterDescriptor {
  return {
    adapterId,
    displayName: adapterId,
    adapterVersion: "0.0.0-test",
    integrationLevel: "native",
    supportedOperatingSystems: ["windows", "macos", "linux"],
    supportedAgent: {
      agentId: `${adapterId}-agent`,
      displayName: adapterId,
      adapterId,
      adapterVersion: "0.0.0-test",
    },
    capabilities: {
      streaming: true,
      cancellation: true,
      sessionResume: false,
      toolEvents: true,
      fileEditing: true,
      shellExecution: false,
      subagents: false,
      mcp: false,
      acp: false,
    },
    declaredCapabilities: ["project.read", "project.edit", "structured.events", "cancellation"],
  };
}

class ScriptedRunHandle implements AgentRunHandle {
  readonly runId: string;
  readonly events: AsyncIterable<NormalizedAgentEvent>;
  readonly completion: Promise<NormalizedAgentEvent>;
  readonly currentState: RunTerminalState = "running";

  /** `neverTerminates`: after exhausting `events`, the async iterator's `next()` never resolves — simulates a candidate that started but is still genuinely running (as opposed to one whose finalization merely hasn't finished), for tests that need a deterministic "still running" window. */
  constructor(events: readonly NormalizedAgentEvent[], runId: string, neverTerminates = false) {
    this.runId = runId;
    const last = events.at(-1);
    this.completion = neverTerminates
      ? new Promise<NormalizedAgentEvent>(() => {
          // Deliberately never settles.
        })
      : Promise.resolve(
          last ?? {
            protocolVersion: "0.1",
            eventId: randomUUID(),
            runId,
            taskId: "unknown",
            agentId: "unknown",
            timestamp: new Date().toISOString(),
            sequence: 0,
            type: "run.cancelled",
            payload: { cancelledBy: "system" },
          },
        );
    this.events = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next(): Promise<IteratorResult<NormalizedAgentEvent>> {
            const value = events.at(index);
            if (value === undefined) {
              if (neverTerminates) {
                return new Promise(() => {
                  // Deliberately never settles — keeps the run "running" forever.
                });
              }
              return Promise.resolve({ done: true, value: undefined });
            }
            index += 1;
            return Promise.resolve({ done: false, value });
          },
        };
      },
    };
  }

  cancel(): void {
    // no-op: this fixture's event list is fixed at construction time.
  }
}

interface ScriptedAdapterOptions {
  readonly adapterId: string;
  /** `detect()` availability per call, in order; the last entry repeats once exhausted. */
  readonly availabilitySequence?: readonly AvailabilityStatus[];
  /** Writes this file into `workingDirectory` (the candidate's own worktree) before emitting the outcome. */
  readonly writeFile?: { readonly name: string; readonly content: string };
  readonly outcome?: "completed" | "failed";
  /** Emits only `run.started` and then never terminates — see `ScriptedRunHandle`'s doc comment. */
  readonly neverTerminates?: boolean;
}

/** A minimal, fully controllable, real-worktree-writing `AgentAdapter` — see the module doc comment above for why the E2E fixtures can't be reused here. */
class ScriptedAdapter implements AgentAdapter {
  readonly descriptor: AgentAdapterDescriptor;
  readonly #availabilitySequence: AvailabilityStatus[];
  readonly #writeFile: { readonly name: string; readonly content: string } | undefined;
  readonly #outcome: "completed" | "failed";
  readonly #neverTerminates: boolean;
  #detectCallCount = 0;

  constructor(options: ScriptedAdapterOptions) {
    this.descriptor = buildDescriptor(options.adapterId);
    this.#availabilitySequence = [...(options.availabilitySequence ?? ["available"])];
    this.#writeFile = options.writeFile;
    this.#outcome = options.outcome ?? "completed";
    this.#neverTerminates = options.neverTerminates ?? false;
  }

  detect(): Promise<AgentDetectionResult> {
    const index = Math.min(this.#detectCallCount, this.#availabilitySequence.length - 1);
    const availability = this.#availabilitySequence[index] ?? "available";
    this.#detectCallCount += 1;
    return Promise.resolve({ installed: true, availability, executionTrust: "isolated" });
  }

  startTask(input: AgentTaskInput, _options?: AgentExecutionOptions): Promise<AgentRunHandle> {
    if (this.#writeFile) {
      fs.writeFileSync(
        path.join(input.workingDirectory, this.#writeFile.name),
        this.#writeFile.content,
      );
    }
    const envelope = {
      protocolVersion: "0.1" as const,
      runId: input.runId,
      taskId: input.hallTask.taskId,
      agentId: input.agentIdentity.agentId,
      timestamp: new Date().toISOString(),
    };
    const startedEvent: NormalizedAgentEvent = {
      ...envelope,
      eventId: randomUUID(),
      sequence: 0,
      type: "run.started",
      payload: {},
    };
    if (this.#neverTerminates) {
      return Promise.resolve(new ScriptedRunHandle([startedEvent], input.runId, true));
    }
    const events: NormalizedAgentEvent[] =
      this.#outcome === "completed"
        ? [
            startedEvent,
            { ...envelope, eventId: randomUUID(), sequence: 1, type: "run.completed", payload: {} },
          ]
        : [
            startedEvent,
            {
              ...envelope,
              eventId: randomUUID(),
              sequence: 1,
              type: "run.failed",
              payload: {
                failure: { code: "TEST_FAILURE", message: "scripted failure", retryable: false },
              },
            },
          ];
    return Promise.resolve(new ScriptedRunHandle(events, input.runId));
  }
}

/** Wraps the real spawner but fails a specific `git worktree add` invocation (1-indexed across the whole test) — used to prove `prepareComparison`'s rollback atomicity against real `git` locking, not a mock. */
function createFailOnNthWorktreeAddSpawner(failOnCallNumber: number): ProcessSpawner {
  let worktreeAddCount = 0;
  return {
    spawn(
      executablePath: string,
      args: readonly string[],
      options: SpawnOptions,
    ): SpawnedProcessHandle {
      const isWorktreeAdd = args[0] === "worktree" && args[1] === "add";
      if (isWorktreeAdd) {
        worktreeAddCount += 1;
        if (worktreeAddCount === failOnCallNumber) {
          return createFailingHandle();
        }
      }
      return nodeProcessSpawner.spawn(executablePath, args, options);
    },
  };
}

function createFailingHandle(): SpawnedProcessHandle {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let exitCallback: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  queueMicrotask(() => {
    stderr.emit("data", Buffer.from("simulated worktree add failure\n"));
    exitCallback?.(1, null);
  });
  return {
    pid: 9999,
    stdin: { end: () => undefined } as unknown as NodeJS.WritableStream,
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    onExit(callback) {
      exitCallback = callback;
    },
    onError() {
      // never used by this fixture.
    },
    kill() {
      return true;
    },
  };
}

function buildSourceTaskRecord(taskId: string): TaskRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    task: {
      taskId,
      projectId: "project-1",
      title: "Add a health check endpoint",
      description: "Implement GET /healthz returning 200.",
      priority: "normal",
      status: "ready",
      dependencyTaskIds: [],
      createdAt: now,
      updatedAt: now,
    },
    runId: undefined,
    adapterId: undefined,
    agentId: undefined,
    eventCount: 0,
    lastSequence: undefined,
    terminalEventType: undefined,
    failure: undefined,
    cancellationRequested: false,
    createdAt: now,
    startedAt: undefined,
    completedAt: undefined,
    assignedExecutionTrust: undefined,
  };
}

interface Harness {
  readonly orchestrator: ComparisonOrchestrator;
  readonly comparisonStore: ComparisonStore;
  readonly taskStore: TaskStore;
  readonly registry: AgentRegistry;
  readonly comparisonRoot: string;
}

/**
 * Adds a source task record AND records its working directory (Phase
 * 12.1) — `workingDirectory` defaults to `"."`, i.e. the task's repository
 * IS `workspaceRoot` itself, which every test in this file sets up via
 * `initRepoWithCommit(repositoryPath)` before calling this. Tests that need
 * to exercise a *different* repository (nested under `workspaceRoot`, or a
 * second independent one) pass an explicit relative `workingDirectory`.
 */
function addSourceTask(harness: Harness, taskId: string, workingDirectory = "."): void {
  harness.taskStore.add(buildSourceTaskRecord(taskId));
  harness.taskStore.setWorkingDirectory(taskId, workingDirectory);
}

function buildHarness(input: {
  readonly repositoryPath: string;
  readonly spawner?: ProcessSpawner;
  readonly cleanupGraceTimeoutMs?: number;
}): Harness {
  const spawner = input.spawner ?? nodeProcessSpawner;
  const comparisonRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "hall-comparison-root-")),
  );
  const gitWorktreeManager = new GitWorktreeManager({
    spawner,
    gitExecutablePath: "git",
    timeoutMs: 15000,
    comparisonRoot,
  });
  const comparisonStore = new ComparisonStore({ maxComparisons: 50 });
  const taskStore = new TaskStore({ maxTasks: 50 });
  const registry = new AgentRegistry();
  const eventStore = new EventStore({ maxEventsPerTask: 100 });
  const eventBus = new EventBus({ maxSubscribersPerTask: 10 });

  const orchestrator = new ComparisonOrchestrator({
    comparisonStore,
    taskStore,
    eventStore,
    eventBus,
    registry,
    gitWorktreeManager,
    workspaceRoot: input.repositoryPath,
    resultEvidenceOptions: {
      spawner,
      gitExecutablePath: "git",
      timeoutMs: 15000,
      maxChangedFiles: 500,
      maxDiffChars: 200_000,
    },
    cleanupGraceTimeoutMs: input.cleanupGraceTimeoutMs ?? 10000,
  });

  return { orchestrator, comparisonStore, taskStore, registry, comparisonRoot };
}

describe("ComparisonOrchestrator (real git + scripted adapters)", () => {
  let repositoryPath: string;
  let comparisonRoot: string | undefined;

  beforeEach(() => {
    repositoryPath = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "hall-comparison-repo-")),
    );
    initRepoWithCommit(repositoryPath);
    comparisonRoot = undefined;
  });

  afterEach(() => {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
    if (comparisonRoot) fs.rmSync(comparisonRoot, { recursive: true, force: true });
  });

  it("runs the full lifecycle: create -> prepare -> start both candidates -> both complete -> cleanup removes both worktrees", async () => {
    const harness = buildHarness({ repositoryPath });
    comparisonRoot = harness.comparisonRoot;
    const taskId = randomUUID();
    addSourceTask(harness, taskId);
    harness.registry.register(
      new ScriptedAdapter({
        adapterId: "hall.adapter-a",
        writeFile: { name: "a.txt", content: "from a\n" },
      }),
    );
    harness.registry.register(
      new ScriptedAdapter({
        adapterId: "hall.adapter-b",
        writeFile: { name: "b.txt", content: "from b\n" },
      }),
    );

    const created = harness.orchestrator.createComparison({
      sourceTaskId: taskId,
      candidateAdapterIds: ["hall.adapter-a", "hall.adapter-b"],
    });
    expect(created.status).toBe("draft");

    const prepared = await harness.orchestrator.prepareComparison(created.comparisonId);
    expect(prepared.status).toBe("ready");
    expect(prepared.baseCommit).toMatch(/^[0-9a-f]{40}$/);

    // Sequential, per the spec's "explicit operator-controlled start,
    // sequential only this phase, no auto-parallel provider execution":
    // candidate B is only started once candidate A has reached a terminal
    // status — see the dedicated concurrent-start-rejection test below for
    // the enforcement of that rule itself.
    const [candidateA, candidateB] = prepared.candidates;
    await harness.orchestrator.startCandidate(created.comparisonId, candidateA.candidateId);
    await waitUntil(() => {
      const candidate = harness.comparisonStore
        .get(created.comparisonId)
        .candidates.find((entry) => entry.candidateId === candidateA.candidateId);
      return candidate?.status === "completed";
    });
    await harness.orchestrator.startCandidate(created.comparisonId, candidateB.candidateId);

    await waitUntil(() => {
      const record = harness.comparisonStore.get(created.comparisonId);
      return record.candidates.every((candidate) => candidate.status === "completed");
    });

    const completed = harness.comparisonStore.get(created.comparisonId);
    expect(completed.status).toBe("completed");
    expect(
      completed.candidates[0].resultEvidence?.changedFiles.map((f) => f.relativePath),
    ).toContain("a.txt");
    expect(
      completed.candidates[1].resultEvidence?.changedFiles.map((f) => f.relativePath),
    ).toContain("b.txt");

    const cleaned = await harness.orchestrator.cleanupComparison(created.comparisonId);
    expect(cleaned.status).toBe("cleaned");
    expect(cleaned.cleanupStatus).toBe("completed");
    expect(fs.existsSync(path.join(harness.comparisonRoot, candidateA.candidateId))).toBe(false);
    expect(fs.existsSync(path.join(harness.comparisonRoot, candidateB.candidateId))).toBe(false);
  }, 60000);

  it("rolls back the first worktree and marks the comparison failed when the second worktree creation fails (real git locking, not a mock)", async () => {
    const spawner = createFailOnNthWorktreeAddSpawner(2);
    const harness = buildHarness({ repositoryPath, spawner });
    comparisonRoot = harness.comparisonRoot;
    const taskId = randomUUID();
    addSourceTask(harness, taskId);
    harness.registry.register(new ScriptedAdapter({ adapterId: "hall.adapter-a" }));
    harness.registry.register(new ScriptedAdapter({ adapterId: "hall.adapter-b" }));

    const created = harness.orchestrator.createComparison({
      sourceTaskId: taskId,
      candidateAdapterIds: ["hall.adapter-a", "hall.adapter-b"],
    });

    const failed = await harness.orchestrator.prepareComparison(created.comparisonId);

    expect(failed.status).toBe("failed");
    expect(failed.candidates[0].status).toBe("pending");
    expect(failed.candidates[1].status).toBe("pending");
    expect(failed.candidates[1].safeFailureReason).toBeDefined();
    // The first candidate's worktree must have been rolled back — not left behind.
    expect(fs.existsSync(path.join(harness.comparisonRoot, failed.candidates[0].candidateId))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(harness.comparisonRoot, failed.candidates[1].candidateId))).toBe(
      false,
    );
  }, 60000);

  it("rejects starting a candidate whose adapter is no longer eligible at start time, rolling the claim back and preserving its worktree for a retry", async () => {
    const harness = buildHarness({ repositoryPath });
    comparisonRoot = harness.comparisonRoot;
    const taskId = randomUUID();
    addSourceTask(harness, taskId);
    // Available during prepareComparison's detection pass, unavailable from startCandidate's fresh detect() onward.
    harness.registry.register(
      new ScriptedAdapter({
        adapterId: "hall.adapter-a",
        availabilitySequence: ["available", "unavailable"],
      }),
    );
    harness.registry.register(new ScriptedAdapter({ adapterId: "hall.adapter-b" }));

    const created = harness.orchestrator.createComparison({
      sourceTaskId: taskId,
      candidateAdapterIds: ["hall.adapter-a", "hall.adapter-b"],
    });
    const prepared = await harness.orchestrator.prepareComparison(created.comparisonId);
    const [candidateA] = prepared.candidates;

    await expect(
      harness.orchestrator.startCandidate(created.comparisonId, candidateA.candidateId),
    ).rejects.toThrow(ComparisonCandidateNotEligibleError);

    const record = harness.comparisonStore.get(created.comparisonId);
    expect(record.candidates[0].status).toBe("prepared");
    expect(record.candidates[0].runId).toBeUndefined();
    expect(fs.existsSync(path.join(harness.comparisonRoot, candidateA.candidateId))).toBe(true);
  }, 60000);

  it("cleanup waits for in-flight result-evidence capture (not just the run's own event stream) before removing the worktree", async () => {
    const harness = buildHarness({ repositoryPath });
    comparisonRoot = harness.comparisonRoot;
    const taskId = randomUUID();
    addSourceTask(harness, taskId);
    harness.registry.register(
      new ScriptedAdapter({
        adapterId: "hall.adapter-a",
        writeFile: { name: "a.txt", content: "from a\n" },
      }),
    );
    harness.registry.register(new ScriptedAdapter({ adapterId: "hall.adapter-b" }));

    const created = harness.orchestrator.createComparison({
      sourceTaskId: taskId,
      candidateAdapterIds: ["hall.adapter-a", "hall.adapter-b"],
    });
    const prepared = await harness.orchestrator.prepareComparison(created.comparisonId);
    const [candidateA] = prepared.candidates;

    await harness.orchestrator.startCandidate(created.comparisonId, candidateA.candidateId);

    // Wait only until both of the run's own events have been recorded —
    // `runTask()`'s promise (and therefore `#activeExecutions`) has
    // settled by this point, but result-evidence capture (`git add -A` /
    // `git diff`, each taking real wall-clock time) is very likely still
    // in flight in `#activeFinalizations`. Calling cleanup right here is
    // exactly the race window described in `cleanupComparison`'s doc
    // comment.
    await waitUntil(() => {
      const candidate = harness.comparisonStore
        .get(created.comparisonId)
        .candidates.find((entry) => entry.candidateId === candidateA.candidateId);
      return candidate?.eventCount === 2;
    });

    const cleaned = await harness.orchestrator.cleanupComparison(created.comparisonId);

    expect(cleaned.cleanupStatus).toBe("completed");
    expect(cleaned.status).toBe("cleaned");
    expect(fs.existsSync(path.join(harness.comparisonRoot, candidateA.candidateId))).toBe(false);
    // The load-bearing assertion: if cleanup did NOT actually wait for the
    // in-flight finalization, `captureResultEvidence` loses its race
    // against `removeWorktree` and throws (worktree already gone) —
    // `#finalizeCandidate` catches that and still finalizes the candidate,
    // but with `resultEvidence: undefined`. A passing cleanup alone
    // (asserted above) does NOT prove the wait happened; this does.
    const finishedCandidateA = cleaned.candidates.find(
      (entry) => entry.candidateId === candidateA.candidateId,
    );
    expect(finishedCandidateA?.status).toBe("completed");
    expect(
      finishedCandidateA?.resultEvidence?.changedFiles.map((file) => file.relativePath),
    ).toContain("a.txt");
  }, 60000);

  it("captures a failing candidate's structured failure and still produces bounded result evidence", async () => {
    const harness = buildHarness({ repositoryPath });
    comparisonRoot = harness.comparisonRoot;
    const taskId = randomUUID();
    addSourceTask(harness, taskId);
    harness.registry.register(
      new ScriptedAdapter({
        adapterId: "hall.adapter-a",
        writeFile: { name: "partial.txt", content: "partial work\n" },
        outcome: "failed",
      }),
    );
    harness.registry.register(new ScriptedAdapter({ adapterId: "hall.adapter-b" }));

    const created = harness.orchestrator.createComparison({
      sourceTaskId: taskId,
      candidateAdapterIds: ["hall.adapter-a", "hall.adapter-b"],
    });
    const prepared = await harness.orchestrator.prepareComparison(created.comparisonId);
    const [candidateA] = prepared.candidates;

    await harness.orchestrator.startCandidate(created.comparisonId, candidateA.candidateId);
    await waitUntil(() => {
      const candidate = harness.comparisonStore
        .get(created.comparisonId)
        .candidates.find((entry) => entry.candidateId === candidateA.candidateId);
      return candidate?.status === "failed";
    });

    const record = harness.comparisonStore.get(created.comparisonId);
    const failedCandidate = record.candidates.find(
      (entry) => entry.candidateId === candidateA.candidateId,
    );
    expect(failedCandidate?.failure?.code).toBe("TEST_FAILURE");
    expect(failedCandidate?.resultEvidence?.changedFiles.map((f) => f.relativePath)).toContain(
      "partial.txt",
    );
  }, 60000);

  it("rejects starting a second candidate while the first is still running — comparisons run candidates sequentially, one at a time, never in parallel", async () => {
    const harness = buildHarness({ repositoryPath });
    comparisonRoot = harness.comparisonRoot;
    const taskId = randomUUID();
    addSourceTask(harness, taskId);
    harness.registry.register(
      new ScriptedAdapter({ adapterId: "hall.adapter-a", neverTerminates: true }),
    );
    harness.registry.register(new ScriptedAdapter({ adapterId: "hall.adapter-b" }));

    const created = harness.orchestrator.createComparison({
      sourceTaskId: taskId,
      candidateAdapterIds: ["hall.adapter-a", "hall.adapter-b"],
    });
    const prepared = await harness.orchestrator.prepareComparison(created.comparisonId);
    const [candidateA, candidateB] = prepared.candidates;

    await harness.orchestrator.startCandidate(created.comparisonId, candidateA.candidateId);
    await waitUntil(() => {
      const candidate = harness.comparisonStore
        .get(created.comparisonId)
        .candidates.find((entry) => entry.candidateId === candidateA.candidateId);
      return candidate?.status === "running" && candidate.runId !== undefined;
    });

    await expect(
      harness.orchestrator.startCandidate(created.comparisonId, candidateB.candidateId),
    ).rejects.toThrow(ComparisonStateConflictError);

    const record = harness.comparisonStore.get(created.comparisonId);
    expect(record.candidates[1].status).toBe("prepared");
  }, 60000);

  describe("Phase 12.1 — source repository resolution (real git)", () => {
    /** A nested, independent Git repository under `repositoryPath` (the harness's `workspaceRoot`). */
    function initNestedRepo(relativeName: string): string {
      const nestedPath = path.join(repositoryPath, relativeName);
      fs.mkdirSync(nestedPath);
      initRepoWithCommit(nestedPath);
      return nestedPath;
    }

    it("prepares successfully using a clean nested repository even though workspaceRoot itself (the outer repo) is dirty", async () => {
      // Dirty the outer workspace/repository — an unrelated, uncommitted
      // change that must never block or affect comparison preparation.
      fs.writeFileSync(path.join(repositoryPath, "unrelated-dirty-file.txt"), "uncommitted\n");

      const nestedPath = initNestedRepo("source-repo");
      const nestedHead = git(["rev-parse", "HEAD"], nestedPath);

      const harness = buildHarness({ repositoryPath });
      comparisonRoot = harness.comparisonRoot;
      const taskId = randomUUID();
      addSourceTask(harness, taskId, "source-repo");
      harness.registry.register(new ScriptedAdapter({ adapterId: "hall.adapter-a" }));
      harness.registry.register(new ScriptedAdapter({ adapterId: "hall.adapter-b" }));

      const created = harness.orchestrator.createComparison({
        sourceTaskId: taskId,
        candidateAdapterIds: ["hall.adapter-a", "hall.adapter-b"],
      });
      const prepared = await harness.orchestrator.prepareComparison(created.comparisonId);

      expect(prepared.status).toBe("ready");
      // The base commit belongs to the NESTED repository, not the outer one.
      expect(prepared.baseCommit).toBe(nestedHead);

      const cleaned = await harness.orchestrator.cleanupComparison(created.comparisonId);
      expect(cleaned.cleanupStatus).toBe("completed");
    }, 60000);

    it("rejects preparation when the resolved SOURCE repository itself is dirty, with the COMPARISON_SOURCE_REPOSITORY_DIRTY code — even though the outer workspace is clean", async () => {
      const nestedPath = initNestedRepo("source-repo");
      // Dirty only the nested source repository — the outer `repositoryPath` stays clean.
      fs.writeFileSync(path.join(nestedPath, "README.md"), "modified\n");

      const harness = buildHarness({ repositoryPath });
      comparisonRoot = harness.comparisonRoot;
      const taskId = randomUUID();
      addSourceTask(harness, taskId, "source-repo");
      harness.registry.register(new ScriptedAdapter({ adapterId: "hall.adapter-a" }));
      harness.registry.register(new ScriptedAdapter({ adapterId: "hall.adapter-b" }));

      const created = harness.orchestrator.createComparison({
        sourceTaskId: taskId,
        candidateAdapterIds: ["hall.adapter-a", "hall.adapter-b"],
      });
      const failed = await harness.orchestrator.prepareComparison(created.comparisonId);

      expect(failed.status).toBe("failed");
      expect(failed.prepareFailureCode).toBe("COMPARISON_SOURCE_REPOSITORY_DIRTY");
      expect(failed.prepareFailureReason).toBeDefined();
      expect(failed.prepareFailureReason).not.toContain(nestedPath);
      // No worktree was ever created for either candidate.
      expect(
        fs.existsSync(path.join(harness.comparisonRoot, failed.candidates[0].candidateId)),
      ).toBe(false);
    }, 60000);

    it("two tasks pointing at two different nested repositories resolve independently — repository A is never substituted for task repository B", async () => {
      const repoA = initNestedRepo("repo-a");
      const repoB = initNestedRepo("repo-b");
      fs.writeFileSync(path.join(repoA, "a-only.txt"), "only in a\n");
      git(["add", "a-only.txt"], repoA);
      git(["commit", "--quiet", "-m", "a-only"], repoA);
      const headA = git(["rev-parse", "HEAD"], repoA);
      const headB = git(["rev-parse", "HEAD"], repoB);
      expect(headA).not.toBe(headB);

      const harness = buildHarness({ repositoryPath });
      comparisonRoot = harness.comparisonRoot;
      const taskIdA = randomUUID();
      const taskIdB = randomUUID();
      addSourceTask(harness, taskIdA, "repo-a");
      addSourceTask(harness, taskIdB, "repo-b");
      harness.registry.register(new ScriptedAdapter({ adapterId: "hall.adapter-a" }));
      harness.registry.register(new ScriptedAdapter({ adapterId: "hall.adapter-b" }));

      const createdA = harness.orchestrator.createComparison({
        sourceTaskId: taskIdA,
        candidateAdapterIds: ["hall.adapter-a", "hall.adapter-b"],
      });
      const preparedA = await harness.orchestrator.prepareComparison(createdA.comparisonId);
      expect(preparedA.baseCommit).toBe(headA);
      await harness.orchestrator.cleanupComparison(createdA.comparisonId);

      const createdB = harness.orchestrator.createComparison({
        sourceTaskId: taskIdB,
        candidateAdapterIds: ["hall.adapter-a", "hall.adapter-b"],
      });
      const preparedB = await harness.orchestrator.prepareComparison(createdB.comparisonId);
      expect(preparedB.baseCommit).toBe(headB);
      await harness.orchestrator.cleanupComparison(createdB.comparisonId);
    }, 60000);

    it("never deletes the source repository or an unrelated repository during cleanup — only candidate worktrees", async () => {
      const nestedPath = initNestedRepo("source-repo");
      const unrelatedPath = initNestedRepo("unrelated-repo");

      const harness = buildHarness({ repositoryPath });
      comparisonRoot = harness.comparisonRoot;
      const taskId = randomUUID();
      addSourceTask(harness, taskId, "source-repo");
      harness.registry.register(new ScriptedAdapter({ adapterId: "hall.adapter-a" }));
      harness.registry.register(new ScriptedAdapter({ adapterId: "hall.adapter-b" }));

      const created = harness.orchestrator.createComparison({
        sourceTaskId: taskId,
        candidateAdapterIds: ["hall.adapter-a", "hall.adapter-b"],
      });
      await harness.orchestrator.prepareComparison(created.comparisonId);
      await harness.orchestrator.cleanupComparison(created.comparisonId);

      expect(fs.existsSync(nestedPath)).toBe(true);
      expect(fs.existsSync(path.join(nestedPath, ".git"))).toBe(true);
      expect(fs.existsSync(unrelatedPath)).toBe(true);
      expect(fs.existsSync(path.join(unrelatedPath, ".git"))).toBe(true);
    }, 60000);

    it("the source task's record and revision are completely unaffected by a comparison's full create -> prepare -> start -> cleanup lifecycle", async () => {
      initNestedRepo("source-repo");
      const harness = buildHarness({ repositoryPath });
      comparisonRoot = harness.comparisonRoot;
      const taskId = randomUUID();
      addSourceTask(harness, taskId, "source-repo");
      harness.registry.register(new ScriptedAdapter({ adapterId: "hall.adapter-a" }));
      harness.registry.register(new ScriptedAdapter({ adapterId: "hall.adapter-b" }));

      const revisionBefore = harness.taskStore.getRevision(taskId);
      const recordBefore = harness.taskStore.get(taskId);

      const created = harness.orchestrator.createComparison({
        sourceTaskId: taskId,
        candidateAdapterIds: ["hall.adapter-a", "hall.adapter-b"],
      });
      const prepared = await harness.orchestrator.prepareComparison(created.comparisonId);
      const [candidateA] = prepared.candidates;
      await harness.orchestrator.startCandidate(created.comparisonId, candidateA.candidateId);
      await waitUntil(() => {
        const candidate = harness.comparisonStore
          .get(created.comparisonId)
          .candidates.find((entry) => entry.candidateId === candidateA.candidateId);
        return candidate?.status === "completed";
      });
      await harness.orchestrator.cleanupComparison(created.comparisonId);

      expect(harness.taskStore.getRevision(taskId)).toBe(revisionBefore);
      expect(harness.taskStore.get(taskId)).toEqual(recordBefore);
    }, 60000);
  });
});
