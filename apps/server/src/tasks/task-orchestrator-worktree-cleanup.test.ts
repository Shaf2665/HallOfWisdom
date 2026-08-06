import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import {
  EventFactory,
  parseAgentAdapterDescriptor,
  type AgentAdapter,
  type AgentAdapterDescriptor,
  type AgentDetectionResult,
} from "@hall-of-wisdom/agent-adapter-sdk";
import { TaskStore } from "./task-store.js";
import { TaskOrchestrator } from "./task-orchestrator.js";
import { EventStore } from "../events/event-store.js";
import { EventBus } from "../events/event-bus.js";
import { InMemoryAgentWorktreeStore } from "../agent-worktrees/in-memory-agent-worktree-store.js";
import type { AgentWorktreeRecord } from "../agent-worktrees/agent-worktree-record.js";
import type { CreateAgentWorktreeResult } from "../agent-worktrees/agent-worktree-manager.js";
import { InMemoryAgentExecutionArtifactStore } from "../execution-artifacts/in-memory-agent-execution-artifact-store.js";
import type {
  AgentExecutionArtifactRecord,
  CreateAgentExecutionArtifactInput,
} from "../execution-artifacts/agent-execution-artifact-record.js";
import type { AgentExecutionArtifactStorePort } from "../execution-artifacts/agent-execution-artifact-store-port.js";
import { AgentExecutionArtifactTerminalizer } from "../agent-execution/agent-execution-artifact-terminalizer.js";
import { ExplicitAdapterIsolationPolicy } from "../agent-execution/isolation-policy.js";
import { IsolatedAgentExecutionCoordinator } from "../agent-execution/isolated-agent-execution-coordinator.js";

const NOW = "2026-08-05T10:00:00.000Z";
const ISOLATED_ADAPTER_ID = "hall.isolated-agent";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A deterministic "N calls have happened" signal — no sleeps, no polling.
 * Every waiter is resolved exactly once, the instant the Nth `notify()`
 * call happens, from inside the exact synchronous callback that performed
 * the Nth mutation — so a caller that `await`s `wait(n)` is guaranteed
 * every side effect of that Nth call has already completed before its
 * `await` resumes (a `resolve()` call only ever schedules a microtask;
 * the synchronous code that called it, including everything after
 * `resolve()` in the same function body, always finishes first).
 */
class CountSignal {
  #count = 0;
  readonly #waiters = new Map<number, (() => void)[]>();

  notify(): void {
    this.#count += 1;
    const waiting = this.#waiters.get(this.#count);
    if (waiting === undefined) return;
    this.#waiters.delete(this.#count);
    for (const resolve of waiting) resolve();
  }

  wait(target: number): Promise<void> {
    if (this.#count >= target) return Promise.resolve();
    return new Promise((resolve) => {
      const waiting = this.#waiters.get(target) ?? [];
      waiting.push(resolve);
      this.#waiters.set(target, waiting);
    });
  }
}

describe("TaskOrchestrator runtime isolated worktree cleanup (Phase 16.5)", () => {
  it("cleans up the worktree after a completed run, only after the artifact is durably persisted", async () => {
    const harness = buildHarness({ adapterBehavior: "completed" });

    const { task, runId } = harness.orchestrator.createTask({
      projectId: "project-1",
      title: "Completed task",
      adapterId: ISOLATED_ADAPTER_ID,
    });

    // Cleanup can only ever be requested after terminalize() has already
    // succeeded, which itself only ever runs after the terminal event's
    // status commit — so this single signal proves the task is
    // "completed" AND artifact-persisted AND cleanup-attempted, with no
    // separate status poll needed.
    await harness.cleanupSignal.wait(1);

    expect(harness.taskStore.get(task.taskId).task.status).toBe("completed");
    expect(harness.artifactStore.findByHallAgentRunId(runId ?? "")).toBeDefined();
    expect(harness.worktreeStore.get(harness.cleanupCalls[0] ?? "").status).toBe("cleaned");
    const artifactCreatedAt = harness.eventLog.indexOf("artifact-created");
    const cleanupRequestedAt = harness.eventLog.indexOf("cleanup-requested");
    expect(artifactCreatedAt).toBeGreaterThanOrEqual(0);
    expect(cleanupRequestedAt).toBeGreaterThan(artifactCreatedAt);
  });

  it("cleans up the worktree after a failed run", async () => {
    const harness = buildHarness({ adapterBehavior: "failed" });

    const { task, runId } = harness.orchestrator.createTask({
      projectId: "project-1",
      title: "Failed task",
      adapterId: ISOLATED_ADAPTER_ID,
    });

    await harness.cleanupSignal.wait(1);

    expect(harness.taskStore.get(task.taskId).task.status).toBe("failed");
    expect(harness.artifactStore.findByHallAgentRunId(runId ?? "")?.outcome).toBe("failed");
    expect(harness.worktreeStore.get(harness.cleanupCalls[0] ?? "").status).toBe("cleaned");
  });

  it("cleans up the worktree after a cancelled run", async () => {
    const harness = buildHarness({ adapterBehavior: "cancelled" });

    const { task, runId } = harness.orchestrator.createTask({
      projectId: "project-1",
      title: "Cancelled task",
      adapterId: ISOLATED_ADAPTER_ID,
    });

    await harness.cleanupSignal.wait(1);

    expect(harness.taskStore.get(task.taskId).task.status).toBe("cancelled");
    expect(harness.artifactStore.findByHallAgentRunId(runId ?? "")?.outcome).toBe("cancelled");
    expect(harness.worktreeStore.get(harness.cleanupCalls[0] ?? "").status).toBe("cleaned");
  });

  it("never requests cleanup when artifact persistence fails", async () => {
    const executionErrors: unknown[] = [];
    const harness = buildHarness({
      adapterBehavior: "completed",
      failArtifactCreate: true,
      onExecutionError: (error) => executionErrors.push(error),
    });

    const { task } = harness.orchestrator.createTask({
      projectId: "project-1",
      title: "Artifact failure task",
      adapterId: ISOLATED_ADAPTER_ID,
    });

    // `onExecutionError` fires synchronously inside `#terminalizeExecution`'s
    // catch block, immediately before its own `return` — the one and only
    // statement that could still request cleanup never runs in that
    // branch, so this signal alone proves cleanup was never (and can now
    // never be) requested for this run, deterministically.
    await harness.executionErrorSignal.wait(1);

    expect(harness.cleanupCalls).toHaveLength(0);
    expect(executionErrors.length).toBeGreaterThan(0);
    // The task's own terminal outcome is completely unaffected by the
    // downstream artifact failure — status already committed before
    // terminalization ever runs.
    expect(harness.taskStore.get(task.taskId).task.status).toBe("completed");
  });

  it("cleanup failure never changes the already-recorded task outcome", async () => {
    const executionErrors: unknown[] = [];
    const harness = buildHarness({
      adapterBehavior: "completed",
      failCleanup: true,
      onExecutionError: (error) => executionErrors.push(error),
    });

    const { task, runId } = harness.orchestrator.createTask({
      projectId: "project-1",
      title: "Cleanup failure task",
      adapterId: ISOLATED_ADAPTER_ID,
    });

    await harness.cleanupSignal.wait(1);

    expect(harness.taskStore.get(task.taskId).task.status).toBe("completed");
    expect(harness.artifactStore.findByHallAgentRunId(runId ?? "")).toBeDefined();
    const worktreeId = harness.cleanupCalls[0] ?? "";
    // Never transitioned past its failed cleanup attempt — recoverable on the
    // next restart's reconciliation pass, never silently dropped.
    expect(harness.worktreeStore.get(worktreeId).status).toBe("cleanup_failed");
  });

  it("a failed cleanup for an old run never blocks or corrupts a fresh retry's own worktree", async () => {
    const harness = buildHarness({ adapterBehavior: "failed", failCleanup: true });

    const { task } = harness.orchestrator.createTask({
      projectId: "project-1",
      title: "Retry task",
      adapterId: ISOLATED_ADAPTER_ID,
    });
    await harness.cleanupSignal.wait(1);
    const oldWorktreeId = harness.cleanupCalls[0] ?? "";
    expect(harness.taskStore.get(task.taskId).task.status).toBe("failed");
    expect(harness.worktreeStore.get(oldWorktreeId).status).toBe("cleanup_failed");

    // Now let the retry succeed cleanly.
    harness.failCleanup = false;
    harness.adapterBehavior = "completed";
    harness.orchestrator.prepareRetry(task.taskId);
    const { runId: retryRunId } = await harness.orchestrator.startTask(task.taskId);

    await harness.cleanupSignal.wait(2);

    const newWorktreeId = harness.cleanupCalls[1] ?? "";
    expect(harness.taskStore.get(task.taskId).task.status).toBe("completed");
    expect(newWorktreeId).not.toBe(oldWorktreeId);
    expect(harness.worktreeStore.get(newWorktreeId).status).toBe("cleaned");
    expect(harness.artifactStore.findByHallAgentRunId(retryRunId)?.outcome).toBe("completed");
    // The old run's failed-cleanup record is completely untouched by the retry.
    expect(harness.worktreeStore.get(oldWorktreeId).status).toBe("cleanup_failed");
  });
});

interface Harness {
  orchestrator: TaskOrchestrator;
  readonly taskStore: TaskStore;
  readonly worktreeStore: InMemoryAgentWorktreeStore;
  readonly artifactStore: AgentExecutionArtifactStorePort;
  readonly cleanupCalls: string[];
  readonly cleanupSignal: CountSignal;
  readonly executionErrorSignal: CountSignal;
  readonly eventLog: string[];
  adapterBehavior: "completed" | "failed" | "cancelled";
  failCleanup: boolean;
}

/** Delegates every read to a real in-memory store but always rejects `create` — simulates artifact persistence failing after a genuine terminal outcome was already recorded. */
class FailingCreateArtifactStore implements AgentExecutionArtifactStorePort {
  readonly #inner = new InMemoryAgentExecutionArtifactStore();

  create(_input: CreateAgentExecutionArtifactInput): AgentExecutionArtifactRecord {
    throw new Error("simulated artifact persistence failure");
  }

  get(artifactId: string): AgentExecutionArtifactRecord {
    return this.#inner.get(artifactId);
  }

  find(artifactId: string): AgentExecutionArtifactRecord | undefined {
    return this.#inner.find(artifactId);
  }

  getByHallAgentRunId(hallAgentRunId: string): AgentExecutionArtifactRecord {
    return this.#inner.getByHallAgentRunId(hallAgentRunId);
  }

  findByHallAgentRunId(hallAgentRunId: string): AgentExecutionArtifactRecord | undefined {
    return this.#inner.findByHallAgentRunId(hallAgentRunId);
  }

  list(): readonly AgentExecutionArtifactRecord[] {
    return this.#inner.list();
  }
}

function buildHarness(options: {
  readonly adapterBehavior: "completed" | "failed" | "cancelled";
  readonly failCleanup?: boolean;
  readonly failArtifactCreate?: boolean;
  readonly onExecutionError?: (error: unknown) => void;
}): Harness {
  const taskStore = new TaskStore({ maxTasks: 10 });
  const worktreeStore = new InMemoryAgentWorktreeStore();
  const artifactStore = options.failArtifactCreate
    ? new FailingCreateArtifactStore()
    : new InMemoryAgentExecutionArtifactStore();

  const cleanupCalls: string[] = [];
  const cleanupSignal = new CountSignal();
  const executionErrorSignal = new CountSignal();
  const eventLog: string[] = [];
  const worktreeRoot = makeTempDir("hall owned worktrees ");
  const source = makeTempDir("hall source ");

  const harness: Harness = {
    orchestrator: undefined as unknown as TaskOrchestrator,
    taskStore,
    worktreeStore,
    artifactStore,
    cleanupCalls,
    cleanupSignal,
    executionErrorSignal,
    eventLog,
    adapterBehavior: options.adapterBehavior,
    failCleanup: options.failCleanup ?? false,
  };

  const worktreeManager = {
    createWorktree(input: {
      readonly hallTaskId: string;
      readonly hallAgentRunId: string;
      readonly adapterId?: string | undefined;
      readonly agentId?: string | undefined;
    }): Promise<CreateAgentWorktreeResult> {
      const worktreeId = `wt-${input.hallAgentRunId}`;
      const worktreePath = path.join(worktreeRoot, `wt_${worktreeId}`);
      fs.mkdirSync(worktreePath, { recursive: true });
      const creating = worktreeStore.createCreating({
        worktreeId,
        hallTaskId: input.hallTaskId,
        hallAgentRunId: input.hallAgentRunId,
        adapterId: input.adapterId,
        agentId: input.agentId,
        canonicalSourceRepositoryRoot: source,
        sourceWorkingDirectoryRelativePath: ".",
        baseCommit: "a".repeat(40),
        canonicalWorktreePath: fs.realpathSync.native(worktreePath),
        createdAt: NOW,
      });
      const ready = worktreeStore.markReady({
        worktreeId,
        expectedRevision: creating.revision,
        readyAt: NOW,
      });
      return Promise.resolve({ record: ready, agentWorkingDirectory: worktreePath });
    },
    cleanupWorktree(worktreeId: string): Promise<AgentWorktreeRecord> {
      cleanupCalls.push(worktreeId);
      eventLog.push("cleanup-requested");
      const record = worktreeStore.get(worktreeId);
      const result = harness.failCleanup
        ? worktreeStore.markCleanupFailed({
            worktreeId,
            expectedRevision: worktreeStore.requestCleanup({
              worktreeId,
              expectedRevision: record.revision,
              now: NOW,
            }).revision,
            safeFailureCode: "GIT_WORKTREE_REMOVE_FAILED",
            safeFailureSummary: "simulated cleanup failure",
            now: NOW,
          })
        : worktreeStore.markCleaned({
            worktreeId,
            expectedRevision: worktreeStore.requestCleanup({
              worktreeId,
              expectedRevision: record.revision,
              now: NOW,
            }).revision,
            now: NOW,
          });
      // Fires only after the store mutation above has fully settled
      // (this whole function body is synchronous up to this point), so a
      // caller awaiting `cleanupSignal.wait(n)` can safely read
      // `worktreeStore` immediately afterward.
      cleanupSignal.notify();
      return Promise.resolve(result);
    },
  };

  const coordinator = new IsolatedAgentExecutionCoordinator({
    isolationPolicy: new ExplicitAdapterIsolationPolicy([ISOLATED_ADAPTER_ID]),
    worktreeStore,
    worktreeValidator: { validateReadyWorktree: () => Promise.reject(new Error("unused")) },
    worktreeManager,
  });

  const terminalizer = new AgentExecutionArtifactTerminalizer({
    store: artifactStore,
    now: () => "2026-08-05T10:00:05.000Z",
    artifactIdFactory: (() => {
      let count = 0;
      return () => `artifact-${String((count += 1))}`;
    })(),
    gitArtifactCollector: {
      collect(worktreeId: string) {
        eventLog.push("artifact-created");
        const record = worktreeStore.get(worktreeId);
        return Promise.resolve({
          worktreeId,
          hallTaskId: record.hallTaskId,
          hallAgentRunId: record.hallAgentRunId,
          baseCommit: record.baseCommit,
          finalCommit: record.baseCommit,
          changedFiles: [],
          diffSummary: { filesChanged: 0, insertions: 0, deletions: 0 },
        });
      },
    },
  });

  const registry = new AgentRegistry();
  registry.register(dynamicAdapter(harness));

  harness.orchestrator = new TaskOrchestrator({
    taskStore,
    eventStore: new EventStore({ maxEventsPerTask: 100 }),
    eventBus: new EventBus({ maxSubscribersPerTask: 10 }),
    registry,
    workspaceRoot: source,
    executionCoordinator: coordinator,
    artifactTerminalizer: terminalizer,
    onExecutionError: (_taskId: string, error: unknown) => {
      options.onExecutionError?.(error);
      executionErrorSignal.notify();
    },
  });

  return harness;
}

function dynamicAdapter(harness: Harness): AgentAdapter {
  return {
    descriptor: agentDescriptor(ISOLATED_ADAPTER_ID, "Isolated Agent"),
    detect(): Promise<AgentDetectionResult> {
      return Promise.resolve({
        installed: true,
        availability: "available",
        executionTrust: "isolated",
      });
    },
    startTask(input) {
      const factory = new EventFactory({
        runId: input.runId,
        taskId: input.hallTask.taskId,
        agentId: input.agentIdentity.agentId,
      });
      const behavior = harness.adapterBehavior;
      async function* events() {
        await Promise.resolve();
        yield factory.runStarted();
        if (behavior === "completed") {
          yield factory.runCompleted("done");
        } else if (behavior === "failed") {
          yield factory.runFailed({ code: "SIMULATED_FAILURE", message: "simulated failure" });
        } else {
          yield factory.runCancelled("system", "simulated cancellation");
        }
      }
      return Promise.resolve({
        runId: input.runId,
        events: events(),
        completion: new Promise(() => {
          // Hall Runner drives completion from the event stream in these tests.
        }),
        currentState: "running",
        cancel(): void {
          // Completed/failed/cancelled immediately via the event stream above.
        },
      });
    },
  };
}

function agentDescriptor(adapterId: string, displayName: string): AgentAdapterDescriptor {
  return parseAgentAdapterDescriptor({
    adapterId,
    displayName,
    adapterVersion: "0.0.0",
    integrationLevel: "native",
    supportedOperatingSystems: ["windows", "macos", "linux"],
    supportedAgent: {
      agentId: adapterId,
      displayName,
      adapterId,
      adapterVersion: "0.0.0",
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
    declaredCapabilities: [],
  });
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync.native(dir);
}
