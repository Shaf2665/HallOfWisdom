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
  type AgentTaskInput,
} from "@hall-of-wisdom/agent-adapter-sdk";
import { TaskStore } from "../tasks/task-store.js";
import { TaskOrchestrator } from "../tasks/task-orchestrator.js";
import { EventStore } from "../events/event-store.js";
import { EventBus } from "../events/event-bus.js";
import { InMemoryAgentWorktreeStore } from "../agent-worktrees/in-memory-agent-worktree-store.js";
import type { AgentWorktreeRecord } from "../agent-worktrees/agent-worktree-record.js";
import type { CreateAgentWorktreeResult } from "../agent-worktrees/agent-worktree-manager.js";
import { InMemoryAgentExecutionArtifactStore } from "../execution-artifacts/in-memory-agent-execution-artifact-store.js";
import type { TaskRecord } from "../tasks/task-record.js";
import { AgentExecutionArtifactMismatchError } from "./agent-execution-errors.js";
import { ExplicitAdapterIsolationPolicy } from "./isolation-policy.js";
import { IsolatedAgentExecutionCoordinator } from "./isolated-agent-execution-coordinator.js";
import { AgentExecutionArtifactTerminalizer } from "./agent-execution-artifact-terminalizer.js";
import { buildAgentExecutionTerminalSnapshot } from "./agent-execution-terminal-snapshot.js";

const NOW = "2026-08-03T10:00:00.000Z";
const BASE_COMMIT = "a".repeat(40);
const FINAL_COMMIT = "b".repeat(40);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Phase 16.3 provider-neutral execution orchestration", () => {
  it("uses isolation only for explicitly configured adapters, never task text", async () => {
    const source = makeTempDir("hall-source ");
    const worktreeRoot = makeTempDir("hall-owned ");
    const worktreePath = path.join(worktreeRoot, "wt_run-1");
    fs.mkdirSync(worktreePath, { recursive: true });
    const store = new InMemoryAgentWorktreeStore();
    let createCalls = 0;
    const coordinator = new IsolatedAgentExecutionCoordinator({
      isolationPolicy: new ExplicitAdapterIsolationPolicy(["hall.isolated-agent"]),
      worktreeStore: store,
      worktreeManager: {
        createWorktree(input) {
          createCalls += 1;
          return Promise.resolve({
            record: readyWorktreeRecord({
              worktreeId: "run-1",
              hallTaskId: input.hallTaskId,
              hallAgentRunId: input.hallAgentRunId,
              source,
              worktreePath,
            }),
            agentWorkingDirectory: worktreePath,
          });
        },
      },
    });

    const plain = await coordinator.prepare({
      adapterId: "hall.unknown-agent",
      approvedSourceWorkingDirectory: source,
      taskInput: taskInput("task text says hall.isolated-agent but policy ignores it"),
    });
    expect(plain.isolation).toBe("none");
    expect(createCalls).toBe(0);

    const isolated = await coordinator.prepare({
      adapterId: "hall.isolated-agent",
      approvedSourceWorkingDirectory: source,
      taskInput: taskInput("task-1"),
    });
    expect(isolated.isolation).toBe("worktree");
    expect(isolated.taskInput.workingDirectory).toBe(worktreePath);
    expect(createCalls).toBe(1);
  });

  it("passes the mapped Hall-owned worktree directory to the adapter and persists a worktree artifact", async () => {
    const workspaceRoot = makeTempDir("hall workspace ");
    const sourceSubdir = path.join(workspaceRoot, "apps", "server");
    fs.mkdirSync(sourceSubdir, { recursive: true });
    const ownedRoot = makeTempDir("hall owned ");
    const worktreePath = path.join(ownedRoot, "wt_iso-run");
    const mapped = path.join(worktreePath, "apps", "server");
    fs.mkdirSync(mapped, { recursive: true });
    const capturedInputs: AgentTaskInput[] = [];
    const adapter = capturingAdapter("hall.isolated-agent", capturedInputs);
    const registry = new AgentRegistry();
    registry.register(adapter);
    const taskStore = new TaskStore({ maxTasks: 10 });
    const artifactStore = new InMemoryAgentExecutionArtifactStore();
    const worktreeStore = new InMemoryAgentWorktreeStore();
    let preparedHallTaskId = "";
    let preparedHallAgentRunId = "";
    const orchestrator = new TaskOrchestrator({
      taskStore,
      eventStore: new EventStore({ maxEventsPerTask: 100 }),
      eventBus: new EventBus({ maxSubscribersPerTask: 10 }),
      registry,
      workspaceRoot,
      executionCoordinator: new IsolatedAgentExecutionCoordinator({
        isolationPolicy: new ExplicitAdapterIsolationPolicy(["hall.isolated-agent"]),
        worktreeStore,
        worktreeManager: {
          createWorktree(input) {
            preparedHallTaskId = input.hallTaskId;
            preparedHallAgentRunId = input.hallAgentRunId;
            const record = worktreeStore.createCreating({
              worktreeId: "iso-run",
              hallTaskId: input.hallTaskId,
              hallAgentRunId: input.hallAgentRunId,
              canonicalSourceRepositoryRoot: fs.realpathSync.native(workspaceRoot),
              sourceWorkingDirectoryRelativePath: path.join("apps", "server"),
              baseCommit: BASE_COMMIT,
              canonicalWorktreePath: fs.realpathSync.native(worktreePath),
              createdAt: NOW,
            });
            return Promise.resolve({
              record: worktreeStore.markReady({
                worktreeId: record.worktreeId,
                expectedRevision: record.revision,
                readyAt: NOW,
              }),
              agentWorkingDirectory: fs.realpathSync.native(mapped),
            });
          },
        },
      }),
      artifactTerminalizer: new AgentExecutionArtifactTerminalizer({
        store: artifactStore,
        artifactIdFactory: () => "artifact-iso-run",
        now: () => "2026-08-03T10:00:05.000Z",
        gitArtifactCollector: {
          collect(worktreeId) {
            return Promise.resolve({
              worktreeId,
              hallTaskId: preparedHallTaskId,
              hallAgentRunId: preparedHallAgentRunId,
              baseCommit: BASE_COMMIT,
              finalCommit: FINAL_COMMIT,
              changedFiles: ["src/a.ts"],
              diffSummary: { filesChanged: 1, insertions: 2, deletions: 0 },
            });
          },
        },
      }),
    });

    const { task, runId } = orchestrator.createTask({
      projectId: "project-1",
      title: "Task text cannot choose a worktree path",
      adapterId: "hall.isolated-agent",
      workingDirectory: "apps/server",
    });

    await waitUntil(() => taskStore.get(task.taskId).task.status === "completed");
    await waitUntil(() => artifactStore.findByHallAgentRunId(runId ?? "") !== undefined);
    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0]?.workingDirectory).toBe(fs.realpathSync.native(mapped));
    expect(capturedInputs[0]?.workingDirectory).not.toBe(fs.realpathSync.native(sourceSubdir));
    const artifact = artifactStore.getByHallAgentRunId(runId ?? "");
    expect(artifact.worktreeId).toBe("iso-run");
    expect(artifact.baseCommit).toBe(BASE_COMMIT);
    expect(artifact.finalCommit).toBe(FINAL_COMMIT);
  });

  it("creates a non-isolated terminal artifact without a worktree id", async () => {
    const workspaceRoot = makeTempDir("hall workspace ");
    const capturedInputs: AgentTaskInput[] = [];
    const registry = new AgentRegistry();
    registry.register(capturingAdapter("hall.plain-agent", capturedInputs));
    const taskStore = new TaskStore({ maxTasks: 10 });
    const artifactStore = new InMemoryAgentExecutionArtifactStore();
    const orchestrator = new TaskOrchestrator({
      taskStore,
      eventStore: new EventStore({ maxEventsPerTask: 100 }),
      eventBus: new EventBus({ maxSubscribersPerTask: 10 }),
      registry,
      workspaceRoot,
      executionCoordinator: new IsolatedAgentExecutionCoordinator({
        isolationPolicy: new ExplicitAdapterIsolationPolicy(["hall.other-agent"]),
      }),
      artifactTerminalizer: new AgentExecutionArtifactTerminalizer({
        store: artifactStore,
        artifactIdFactory: () => "artifact-plain-run",
        now: () => "2026-08-03T10:00:05.000Z",
      }),
    });

    const { task, runId } = orchestrator.createTask({
      projectId: "project-1",
      title: "Plain task",
      adapterId: "hall.plain-agent",
    });

    await waitUntil(() => taskStore.get(task.taskId).task.status === "completed");
    await waitUntil(() => artifactStore.findByHallAgentRunId(runId ?? "") !== undefined);
    const artifact = artifactStore.getByHallAgentRunId(runId ?? "");
    expect(artifact.outcome).toBe("completed");
    expect(artifact.worktreeId).toBeUndefined();
    expect(artifact.changedFiles).toEqual([]);
    expect(capturedInputs[0]?.workingDirectory).toBe(fs.realpathSync.native(workspaceRoot));
  });

  it("fails isolated execution before worktree creation when adapter preflight is unavailable", async () => {
    const workspaceRoot = makeTempDir("hall workspace ");
    const registry = new AgentRegistry();
    let startCalls = 0;
    registry.register(
      controlledAdapter({
        adapterId: "hall.isolated-agent",
        detect: () =>
          Promise.resolve({
            installed: false,
            availability: "unavailable",
            executionTrust: "isolated",
          }),
        startTask() {
          startCalls += 1;
          throw new Error("provider launch must not run after unavailable preflight");
        },
      }),
    );
    const taskStore = new TaskStore({ maxTasks: 10 });
    const artifactStore = new InMemoryAgentExecutionArtifactStore();
    let createCalls = 0;
    const orchestrator = new TaskOrchestrator({
      taskStore,
      eventStore: new EventStore({ maxEventsPerTask: 100 }),
      eventBus: new EventBus({ maxSubscribersPerTask: 10 }),
      registry,
      workspaceRoot,
      executionCoordinator: new IsolatedAgentExecutionCoordinator({
        isolationPolicy: new ExplicitAdapterIsolationPolicy(["hall.isolated-agent"]),
        worktreeStore: new InMemoryAgentWorktreeStore(),
        worktreeManager: {
          createWorktree() {
            createCalls += 1;
            throw new Error("worktree creation must not run after unavailable preflight");
          },
        },
      }),
      artifactTerminalizer: new AgentExecutionArtifactTerminalizer({
        store: artifactStore,
        artifactIdFactory: () => "artifact-unavailable",
        now: () => "2026-08-03T10:00:05.000Z",
      }),
    });

    const { task, runId } = orchestrator.createTask({
      projectId: "project-1",
      title: "Unavailable isolated task",
      adapterId: "hall.isolated-agent",
    });

    await waitUntil(() => taskStore.get(task.taskId).task.status === "failed");
    await waitUntil(() => artifactStore.findByHallAgentRunId(runId ?? "") !== undefined);
    expect(createCalls).toBe(0);
    expect(startCalls).toBe(0);
    expect(artifactStore.getByHallAgentRunId(runId ?? "").terminalReasonCode).toBe(
      "ADAPTER_UNAVAILABLE",
    );
  });

  it("honors cancellation after adapter preflight before creating an isolated worktree", async () => {
    const workspaceRoot = makeTempDir("hall workspace ");
    const registry = new AgentRegistry();
    const detectGate = deferred<AgentDetectionResult>();
    let detectCalls = 0;
    let startCalls = 0;
    registry.register(
      controlledAdapter({
        adapterId: "hall.isolated-agent",
        detect() {
          detectCalls += 1;
          return detectGate.promise;
        },
        startTask() {
          startCalls += 1;
          throw new Error("provider launch must not run after cancellation");
        },
      }),
    );
    const taskStore = new TaskStore({ maxTasks: 10 });
    const artifactStore = new InMemoryAgentExecutionArtifactStore();
    let createCalls = 0;
    const orchestrator = new TaskOrchestrator({
      taskStore,
      eventStore: new EventStore({ maxEventsPerTask: 100 }),
      eventBus: new EventBus({ maxSubscribersPerTask: 10 }),
      registry,
      workspaceRoot,
      executionCoordinator: new IsolatedAgentExecutionCoordinator({
        isolationPolicy: new ExplicitAdapterIsolationPolicy(["hall.isolated-agent"]),
        worktreeStore: new InMemoryAgentWorktreeStore(),
        worktreeManager: {
          createWorktree() {
            createCalls += 1;
            throw new Error("worktree creation must not run after cancellation");
          },
        },
      }),
      artifactTerminalizer: new AgentExecutionArtifactTerminalizer({
        store: artifactStore,
        artifactIdFactory: () => "artifact-cancel-before-worktree",
        now: () => "2026-08-03T10:00:05.000Z",
      }),
    });

    const { task, runId } = orchestrator.createTask({
      projectId: "project-1",
      title: "Cancelled before worktree",
      adapterId: "hall.isolated-agent",
    });
    await waitUntil(() => detectCalls === 1);
    orchestrator.requestCancellation(task.taskId);
    detectGate.resolve({
      installed: true,
      availability: "available",
      executionTrust: "isolated",
    });

    await waitUntil(() => taskStore.get(task.taskId).task.status === "cancelled");
    await waitUntil(() => artifactStore.findByHallAgentRunId(runId ?? "") !== undefined);
    const artifact = artifactStore.getByHallAgentRunId(runId ?? "");
    expect(createCalls).toBe(0);
    expect(startCalls).toBe(0);
    expect(artifact.outcome).toBe("cancelled");
    expect(artifact.worktreeId).toBeUndefined();
  });

  it("honors cancellation after isolated worktree preparation before provider launch", async () => {
    const workspaceRoot = makeTempDir("hall workspace ");
    const ownedRoot = makeTempDir("hall owned ");
    const worktreePath = path.join(ownedRoot, "wt_cancel-after-prep");
    fs.mkdirSync(worktreePath, { recursive: true });
    const registry = new AgentRegistry();
    let startCalls = 0;
    registry.register(
      controlledAdapter({
        adapterId: "hall.isolated-agent",
        detect: () =>
          Promise.resolve({
            installed: true,
            availability: "available",
            executionTrust: "isolated",
          }),
        startTask() {
          startCalls += 1;
          throw new Error("provider launch must not run after cancellation");
        },
      }),
    );
    const taskStore = new TaskStore({ maxTasks: 10 });
    const worktreeStore = new InMemoryAgentWorktreeStore();
    const artifactStore = new InMemoryAgentExecutionArtifactStore();
    const createGate = deferred<CreateAgentWorktreeResult>();
    let createCalls = 0;
    let createdHallTaskId = "";
    let createdHallAgentRunId = "";
    const orchestrator = new TaskOrchestrator({
      taskStore,
      eventStore: new EventStore({ maxEventsPerTask: 100 }),
      eventBus: new EventBus({ maxSubscribersPerTask: 10 }),
      registry,
      workspaceRoot,
      executionCoordinator: new IsolatedAgentExecutionCoordinator({
        isolationPolicy: new ExplicitAdapterIsolationPolicy(["hall.isolated-agent"]),
        worktreeStore,
        worktreeManager: {
          createWorktree(input) {
            createCalls += 1;
            createdHallTaskId = input.hallTaskId;
            createdHallAgentRunId = input.hallAgentRunId;
            return createGate.promise;
          },
        },
      }),
      artifactTerminalizer: new AgentExecutionArtifactTerminalizer({
        store: artifactStore,
        artifactIdFactory: () => "artifact-cancel-after-prep",
        now: () => "2026-08-03T10:00:05.000Z",
        gitArtifactCollector: {
          collect(worktreeId) {
            return Promise.resolve({
              worktreeId,
              hallTaskId: createdHallTaskId,
              hallAgentRunId: createdHallAgentRunId,
              baseCommit: BASE_COMMIT,
              finalCommit: BASE_COMMIT,
              changedFiles: [],
              diffSummary: { filesChanged: 0, insertions: 0, deletions: 0 },
            });
          },
        },
      }),
    });

    const { task, runId } = orchestrator.createTask({
      projectId: "project-1",
      title: "Cancelled after worktree",
      adapterId: "hall.isolated-agent",
    });
    await waitUntil(() => createCalls === 1);
    orchestrator.requestCancellation(task.taskId);
    createGate.resolve({
      record: readyWorktreeRecord({
        worktreeId: "cancel-after-prep",
        hallTaskId: createdHallTaskId,
        hallAgentRunId: createdHallAgentRunId,
        source: workspaceRoot,
        worktreePath,
      }),
      agentWorkingDirectory: fs.realpathSync.native(worktreePath),
    });

    await waitUntil(() => taskStore.get(task.taskId).task.status === "cancelled");
    await waitUntil(() => artifactStore.findByHallAgentRunId(runId ?? "") !== undefined);
    const artifact = artifactStore.getByHallAgentRunId(runId ?? "");
    expect(startCalls).toBe(0);
    expect(artifact.outcome).toBe("cancelled");
    expect(artifact.worktreeId).toBe("cancel-after-prep");
  });

  it("replayed terminalization reuses an equivalent artifact without recollecting Git evidence", async () => {
    const store = new InMemoryAgentExecutionArtifactStore();
    let collectCalls = 0;
    const terminalizer = new AgentExecutionArtifactTerminalizer({
      store,
      artifactIdFactory: () => "artifact-replay",
      now: () => "2026-08-03T10:00:05.000Z",
      gitArtifactCollector: {
        collect(worktreeId) {
          collectCalls += 1;
          if (collectCalls > 1) throw new Error("collector must not run on replay");
          return Promise.resolve({
            worktreeId,
            hallTaskId: "task-replay",
            hallAgentRunId: "run-replay",
            baseCommit: BASE_COMMIT,
            finalCommit: FINAL_COMMIT,
            changedFiles: ["src/a.ts"],
            diffSummary: { filesChanged: 1, insertions: 1, deletions: 0 },
          });
        },
      },
    });
    const terminalEvent = new EventFactory({
      runId: "run-replay",
      taskId: "task-replay",
      agentId: "hall.isolated-agent",
    }).runCompleted("safe final summary");
    const taskRecord = terminalTaskRecord({
      taskId: "task-replay",
      runId: "run-replay",
      adapterId: "hall.isolated-agent",
      terminalEventType: "run.completed",
      status: "completed",
    });
    const snapshot = buildAgentExecutionTerminalSnapshot({
      preTerminalRecord: taskRecord,
      adapterId: "hall.isolated-agent",
      event: terminalEvent,
      worktreeId: "worktree-replay",
    });

    const first = await terminalizer.terminalize({ snapshot });
    const second = await terminalizer.terminalize({ snapshot });

    expect(second).toEqual(first);
    expect(collectCalls).toBe(1);
  });

  it("rejects a mismatched existing artifact without overwriting it", async () => {
    const store = new InMemoryAgentExecutionArtifactStore();
    store.create({
      artifactId: "artifact-existing",
      hallTaskId: "task-mismatch",
      hallAgentRunId: "run-mismatch",
      adapterId: "hall.test-agent",
      outcome: "failed",
      terminalReasonCode: "TASK_EXECUTION_FAILED",
      safeTerminalSummary: "safe failure",
      startedAt: NOW,
      finishedAt: "2026-08-03T10:00:05.000Z",
      durationMs: 5_000,
      changedFiles: [],
      diffSummary: { filesChanged: 0, insertions: 0, deletions: 0 },
      createdAt: "2026-08-03T10:00:06.000Z",
    });
    const terminalizer = new AgentExecutionArtifactTerminalizer({
      store,
      artifactIdFactory: () => "artifact-new",
      now: () => "2026-08-03T10:00:07.000Z",
    });
    const terminalEvent = new EventFactory({
      runId: "run-mismatch",
      taskId: "task-mismatch",
      agentId: "hall.test-agent",
    }).runCompleted("safe final summary");
    const taskRecord = terminalTaskRecord({
      taskId: "task-mismatch",
      runId: "run-mismatch",
      adapterId: "hall.test-agent",
      terminalEventType: "run.completed",
      status: "completed",
    });
    const snapshot = buildAgentExecutionTerminalSnapshot({
      preTerminalRecord: taskRecord,
      adapterId: "hall.test-agent",
      event: terminalEvent,
    });

    await expect(terminalizer.terminalize({ snapshot })).rejects.toThrow(
      AgentExecutionArtifactMismatchError,
    );
    expect(store.list()).toHaveLength(1);
    expect(store.getByHallAgentRunId("run-mismatch").outcome).toBe("failed");
  });
});

function taskInput(taskId: string): AgentTaskInput {
  return {
    hallTask: {
      taskId,
      projectId: "project-1",
      title: "Task",
      description: "Task description",
      priority: "normal",
      status: "assigned",
      dependencyTaskIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
    agentIdentity: {
      agentId: "agent-1",
      displayName: "Agent",
      adapterId: "hall.test-agent",
      adapterVersion: "0.0.0",
    },
    runId: "run-1",
    workingDirectory: makeTempDir("hall-input-workdir "),
  };
}

function capturingAdapter(adapterId: string, capturedInputs: AgentTaskInput[]): AgentAdapter {
  return {
    descriptor: agentDescriptor(adapterId, "Capturing Agent"),
    detect(): Promise<AgentDetectionResult> {
      return Promise.resolve({
        installed: true,
        availability: "available",
        executionTrust: "isolated",
      });
    },
    startTask(input) {
      capturedInputs.push(input);
      const factory = new EventFactory({
        runId: input.runId,
        taskId: input.hallTask.taskId,
        agentId: input.agentIdentity.agentId,
      });
      async function* events() {
        await Promise.resolve();
        yield factory.runStarted();
        yield factory.runCompleted("safe final summary");
      }
      return Promise.resolve({
        runId: input.runId,
        events: events(),
        completion: new Promise(() => {
          // Hall Runner drives completion from the event stream in these tests.
        }),
        currentState: "running",
        cancel(): void {
          // Completed immediately.
        },
      });
    },
  };
}

function controlledAdapter(input: {
  readonly adapterId: string;
  readonly detect: () => Promise<AgentDetectionResult>;
  readonly startTask: AgentAdapter["startTask"];
}): AgentAdapter {
  return {
    descriptor: agentDescriptor(input.adapterId, "Controlled Agent"),
    detect: input.detect,
    startTask: input.startTask,
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

function readyWorktreeRecord(input: {
  readonly worktreeId: string;
  readonly hallTaskId: string;
  readonly hallAgentRunId: string;
  readonly source: string;
  readonly worktreePath: string;
}): AgentWorktreeRecord {
  return {
    worktreeId: input.worktreeId,
    hallTaskId: input.hallTaskId,
    hallAgentRunId: input.hallAgentRunId,
    canonicalSourceRepositoryRoot: fs.realpathSync.native(input.source),
    sourceWorkingDirectoryRelativePath: ".",
    baseCommit: BASE_COMMIT,
    canonicalWorktreePath: fs.realpathSync.native(input.worktreePath),
    status: "ready",
    createdAt: NOW,
    revision: 1,
    readyAt: NOW,
    cleanupRequestedAt: undefined,
    cleanedAt: undefined,
    safeFailureCode: undefined,
    safeFailureSummary: undefined,
  };
}

function terminalTaskRecord(input: {
  readonly taskId: string;
  readonly runId: string;
  readonly adapterId: string;
  readonly terminalEventType: "run.completed" | "run.failed" | "run.cancelled";
  readonly status: "completed" | "failed" | "cancelled";
}): TaskRecord {
  return {
    task: {
      taskId: input.taskId,
      projectId: "project-1",
      title: "Task",
      description: "Task description",
      priority: "normal",
      status: input.status,
      dependencyTaskIds: [],
      createdAt: NOW,
      updatedAt: "2026-08-03T10:00:05.000Z",
    },
    runId: input.runId,
    adapterId: input.adapterId,
    agentId: input.adapterId,
    eventCount: 2,
    lastSequence: 1,
    terminalEventType: input.terminalEventType,
    failure: undefined,
    cancellationRequested: false,
    createdAt: NOW,
    startedAt: NOW,
    completedAt: "2026-08-03T10:00:05.000Z",
    assignedExecutionTrust: "isolated",
  };
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync.native(dir);
}

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolveValue: (value: T) => void = () => {
    throw new Error("deferred promise was not initialized");
  };
  let rejectValue: (error: unknown) => void = () => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return { promise, resolve: resolveValue, reject: rejectValue };
}
