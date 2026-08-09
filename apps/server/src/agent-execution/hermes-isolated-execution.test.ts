import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTaskInput } from "@hall-of-wisdom/agent-adapter-sdk";
import {
  HERMES_PROTOCOL_VERSION,
  HermesRouterAdapter,
  type HermesExecutionTransportOptions,
  type HermesExecutionTransportRun,
  type HermesRawEvent,
  type HermesRawTerminalEvent,
} from "@hall-of-wisdom/hermes-router-adapter";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { AgentWorktreeManager } from "../agent-worktrees/agent-worktree-manager.js";
import {
  NodeGitCommandRunner,
  nodeGitProcessSpawner,
} from "../agent-worktrees/git-command-runner.js";
import { InMemoryAgentWorktreeStore } from "../agent-worktrees/in-memory-agent-worktree-store.js";
import { EventBus } from "../events/event-bus.js";
import { EventStore } from "../events/event-store.js";
import { InMemoryAgentExecutionArtifactStore } from "../execution-artifacts/in-memory-agent-execution-artifact-store.js";
import { TaskOrchestrator } from "../tasks/task-orchestrator.js";
import { TaskStore } from "../tasks/task-store.js";
import { AgentExecutionArtifactTerminalizer } from "./agent-execution-artifact-terminalizer.js";
import { GitArtifactCollector } from "./git-artifact-collector.js";
import { ExplicitAdapterIsolationPolicy } from "./isolation-policy.js";
import { IsolatedAgentExecutionCoordinator } from "./isolated-agent-execution-coordinator.js";

const HERMES_ADAPTER_ID = "hall.hermes-router";
const ISOLATION_CHECK_FILE = "hermes-isolation-check.txt";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Hermes isolated worktree execution", () => {
  it("runs the Hermes Hall lifecycle only after a real worktree is ready, captures its file event, and cleans up without changing the source checkout", async () => {
    const fixture = createFixtureRepository("hermes source repo");
    const sourceBefore = sourceState(fixture.repo);
    const transportCalls: HermesExecutionTransportOptions[] = [];
    let worktreeWasReadyAtTransportStart = false;
    let fileExistedInWorktree = false;
    const harness = createHarness(fixture.repo, (options, worktreeStore) => {
      transportCalls.push(options);
      const record = worktreeStore.findActiveByAgentRunId(options.runId);
      worktreeWasReadyAtTransportStart = record?.status === "ready";
      fs.writeFileSync(
        path.join(options.workingDirectory, ISOLATION_CHECK_FILE),
        "HERMES_ISOLATION_OK\n",
      );
      fileExistedInWorktree = fs.existsSync(
        path.join(options.workingDirectory, ISOLATION_CHECK_FILE),
      );
      return completedTransport(options.runId, [
        rawEvent(options.runId, 0, "run.started", {}),
        rawEvent(options.runId, 1, "file.changed", {
          path: ISOLATION_CHECK_FILE,
          operation: "created",
        }),
        rawEvent(options.runId, 2, "run.completed", { summary: "Done" }),
      ]);
    });

    const { task, runId } = harness.orchestrator.createTask({
      projectId: "project-1",
      title: "Create the isolation check file",
      adapterId: HERMES_ADAPTER_ID,
    });

    await waitUntil(() => {
      const worktree = harness.worktreeStore.list()[0];
      return (
        harness.taskStore.get(task.taskId).task.status === "completed" &&
        worktree?.status === "cleaned"
      );
    });

    const worktree = harness.worktreeStore.list()[0];
    expect(worktree).toBeDefined();
    expect(transportCalls).toHaveLength(1);
    expect(worktreeWasReadyAtTransportStart).toBe(true);
    expect(fileExistedInWorktree).toBe(true);
    expect(transportCalls[0]?.workingDirectory).toBe(worktree?.canonicalWorktreePath);
    expect(transportCalls[0]?.workingDirectory).not.toBe(fixture.repo);
    expect(fs.existsSync(path.join(fixture.repo, ISOLATION_CHECK_FILE))).toBe(false);
    expect(sourceState(fixture.repo)).toEqual(sourceBefore);
    expect(harness.eventStore.list(task.taskId).map((event) => event.type)).toEqual([
      "run.started",
      "file.changed",
      "run.completed",
    ]);
    expect(harness.eventStore.list(task.taskId)[1]?.payload).toEqual({
      path: ISOLATION_CHECK_FILE,
      operation: "created",
    });
    expect(harness.artifactStore.getByHallAgentRunId(runId ?? "").changedFiles).toContain(
      ISOLATION_CHECK_FILE,
    );
    expect(worktree?.status).toBe("cleaned");
    expect(fs.existsSync(worktree?.canonicalWorktreePath ?? "")).toBe(false);
    expect(git(["worktree", "list", "--porcelain"], fixture.repo)).not.toContain(
      worktree?.canonicalWorktreePath,
    );
  });

  it("does not start Hermes when real worktree preparation fails", async () => {
    const fixture = createFixtureRepository("dirty hermes source");
    fs.writeFileSync(path.join(fixture.repo, "uncommitted.txt"), "not ready\n");
    let transportStartCount = 0;
    const harness = createHarness(fixture.repo, () => {
      transportStartCount += 1;
      throw new Error("Hermes transport must not start");
    });

    const { task } = harness.orchestrator.createTask({
      projectId: "project-1",
      title: "Must stop before Hermes",
      adapterId: HERMES_ADAPTER_ID,
    });

    await waitUntil(() => harness.taskStore.get(task.taskId).task.status === "failed");

    expect(transportStartCount).toBe(0);
    expect(harness.worktreeStore.list()).toHaveLength(0);
  });

  it("reuses the existing Hall validator and rejects a ready worktree whose HEAD moved", async () => {
    const fixture = createFixtureRepository("tampered hermes worktree");
    const store = new InMemoryAgentWorktreeStore();
    const manager = new AgentWorktreeManager({
      store,
      gitRunner: testGitRunner(),
      ownedRoot: makeTempDir("hall hermes worktrees "),
      idGenerator: () => "hermes-invalid-ready",
    });
    const coordinator = new IsolatedAgentExecutionCoordinator({
      isolationPolicy: new ExplicitAdapterIsolationPolicy([HERMES_ADAPTER_ID]),
      worktreeManager: manager,
      worktreeStore: store,
      worktreeValidator: manager,
    });
    const input = taskInput(fixture.repo, "task-invalid-ready", "run-invalid-ready");
    const first = await coordinator.prepare({
      adapterId: HERMES_ADAPTER_ID,
      approvedSourceWorkingDirectory: fixture.repo,
      taskInput: input,
    });
    fs.writeFileSync(path.join(first.taskInput.workingDirectory, "README.md"), "moved head\n");
    git(["add", "README.md"], first.taskInput.workingDirectory);
    git(["commit", "-m", "move isolated head"], first.taskInput.workingDirectory);

    await expect(
      coordinator.prepare({
        adapterId: HERMES_ADAPTER_ID,
        approvedSourceWorkingDirectory: fixture.repo,
        taskInput: input,
      }),
    ).rejects.toThrow();

    expect(sourceState(fixture.repo).head).toBe(fixture.head);
  });
});

interface Harness {
  readonly orchestrator: TaskOrchestrator;
  readonly taskStore: TaskStore;
  readonly eventStore: EventStore;
  readonly worktreeStore: InMemoryAgentWorktreeStore;
  readonly artifactStore: InMemoryAgentExecutionArtifactStore;
}

function createHarness(
  sourceRepository: string,
  startTransport: (
    options: HermesExecutionTransportOptions,
    worktreeStore: InMemoryAgentWorktreeStore,
  ) => HermesExecutionTransportRun,
): Harness {
  const registry = new AgentRegistry();
  const worktreeStore = new InMemoryAgentWorktreeStore();
  const gitRunner = testGitRunner();
  const manager = new AgentWorktreeManager({
    store: worktreeStore,
    gitRunner,
    ownedRoot: makeTempDir("hall hermes worktrees "),
  });
  const hermes = new HermesRouterAdapter({
    isolatedExecutionEnabled: true,
    platform: process.platform,
    parentEnv: { HALL_HERMES_ROUTER_ROOT: sourceRepository },
    fs: { isFile: () => true },
    processRunner: {
      run: () => Promise.resolve({ status: "success", stdout: healthyDetectionDocument() }),
    },
    startTransport: (options) => startTransport(options, worktreeStore),
  });
  registry.register(hermes);
  const taskStore = new TaskStore({ maxTasks: 10 });
  const eventStore = new EventStore({ maxEventsPerTask: 100 });
  const artifactStore = new InMemoryAgentExecutionArtifactStore();
  const coordinator = new IsolatedAgentExecutionCoordinator({
    isolationPolicy: new ExplicitAdapterIsolationPolicy([HERMES_ADAPTER_ID]),
    worktreeManager: manager,
    worktreeStore,
    worktreeValidator: manager,
  });
  const orchestrator = new TaskOrchestrator({
    taskStore,
    eventStore,
    eventBus: new EventBus({ maxSubscribersPerTask: 10 }),
    registry,
    workspaceRoot: sourceRepository,
    executionCoordinator: coordinator,
    artifactTerminalizer: new AgentExecutionArtifactTerminalizer({
      store: artifactStore,
      gitArtifactCollector: new GitArtifactCollector({
        gitRunner,
        worktreeValidator: manager,
      }),
    }),
  });
  return { orchestrator, taskStore, eventStore, worktreeStore, artifactStore };
}

function healthyDetectionDocument(): string {
  return JSON.stringify({
    protocol: HERMES_PROTOCOL_VERSION,
    runtime_version: "0.1.0",
    available: true,
    capabilities: [
      "project.read",
      "project.edit",
      "command.execute",
      "structured.events",
      "cancellation",
    ],
    integration_level: "structured_cli",
    execution_trust: "trusted_local",
  });
}

function completedTransport(
  runId: string,
  events: readonly HermesRawEvent[],
): HermesExecutionTransportRun {
  const terminalEvent = events.at(-1) as HermesRawTerminalEvent;
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        for (const event of events) yield event;
      },
    },
    completion: Promise.resolve({ terminalEvent, exitCode: 0, signal: null }),
    currentState: "exited",
    cancel() {
      // The deterministic successful transport is already complete.
    },
  };
}

function rawEvent(
  runId: string,
  sequence: number,
  type: HermesRawEvent["type"],
  payload: Readonly<Record<string, unknown>>,
): HermesRawEvent {
  return {
    protocol: HERMES_PROTOCOL_VERSION,
    runtime_version: "0.1.0",
    run_id: runId,
    sequence,
    type,
    payload,
  };
}

function taskInput(workingDirectory: string, taskId: string, runId: string): AgentTaskInput {
  const now = "2026-08-09T10:00:00.000Z";
  return {
    hallTask: {
      taskId,
      projectId: "project-1",
      title: "Validate an existing Hermes worktree",
      description: "",
      priority: "normal",
      status: "assigned",
      dependencyTaskIds: [],
      createdAt: now,
      updatedAt: now,
    },
    agentIdentity: {
      agentId: "hermes-router",
      displayName: "Hermes Router",
      adapterId: HERMES_ADAPTER_ID,
      adapterVersion: "0.1.0",
    },
    runId,
    workingDirectory,
  };
}

function createFixtureRepository(name: string): { readonly repo: string; readonly head: string } {
  const repo = path.join(makeTempDir("hall hermes isolation fixture "), name);
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
  const isolatedHome = makeTempDir("hall hermes git home ");
  return new NodeGitCommandRunner({
    parentEnv: {
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
      SYSTEMROOT: process.env.SYSTEMROOT,
      WINDIR: process.env.WINDIR,
      COMSPEC: process.env.COMSPEC,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      APPDATA: isolatedHome,
      LOCALAPPDATA: isolatedHome,
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

function sourceState(repo: string): {
  readonly head: string;
  readonly branch: string;
  readonly status: string;
} {
  return {
    head: git(["rev-parse", "--verify", "HEAD^{commit}"], repo),
    branch: git(["branch", "--show-current"], repo),
    status: git(["status", "--porcelain=v1", "--untracked-files=all"], repo),
  };
}

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
