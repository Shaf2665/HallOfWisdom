import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import type {
  AgentAdapter,
  AgentDetectionResult,
  AvailabilityStatus,
} from "@hall-of-wisdom/agent-adapter-sdk";
import { MockAgentAdapter, type MockAgentConfigInput } from "@hall-of-wisdom/mock-agent";
import { createHallCoreApp, type CreateHallCoreAppOptions } from "./app.js";
import { TaskStore } from "./tasks/task-store.js";
import { TaskOrchestrator } from "./tasks/task-orchestrator.js";
import { EventStore } from "./events/event-store.js";
import { EventBus } from "./events/event-bus.js";
import { BoardStore } from "./boards/board-store.js";
import { MessageStore } from "./boards/message-store.js";
import { MessageBus } from "./boards/message-bus.js";
import { DEFAULT_LIMITS, type ServerLimits } from "./config/server-config.js";
import {
  createComparisonComposition,
  type ComparisonComposition,
} from "./composition/comparison-composition-root.js";
import {
  createCeoPlanComposition,
  type CeoPlanComposition,
} from "./ceo-plans/ceo-plan-composition.js";

/** JSON shape of a `TaskRecord` as it round-trips through an HTTP response body. */
export interface TaskRecordJson {
  readonly task: {
    readonly taskId: string;
    readonly projectId: string;
    readonly title: string;
    readonly description: string;
    readonly priority: string;
    readonly status: string;
    readonly dependencyTaskIds: readonly string[];
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly runId?: string;
  readonly adapterId?: string;
  readonly agentId?: string;
  readonly eventCount: number;
  readonly lastSequence?: number;
  readonly terminalEventType?: string;
  readonly failure?: { readonly code: string; readonly message: string };
  readonly cancellationRequested: boolean;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface CreateTaskResponseJson extends TaskRecordJson {
  readonly eventsPath: string;
}

export interface ErrorResponseJson {
  readonly error: { readonly code: string; readonly message: string };
}

/** Shared test-only harness builder — excluded from the build output. */
export interface TestHarnessOptions {
  readonly workspaceRoot: string;
  readonly mockAgentConfig?: MockAgentConfigInput | undefined;
  readonly limits?: Partial<ServerLimits> | undefined;
  readonly logger?: boolean | undefined;
  readonly onExecutionError?: ((taskId: string, error: unknown) => void) | undefined;
  readonly webOrigin?: string | undefined;
  /** Extra adapters registered alongside Mock Agent, e.g. a `ClaudeCodeAdapter` for coexistence tests. Defaults to none — existing callers are unaffected. */
  readonly additionalAdapters?: readonly AgentAdapter[] | undefined;
  /** Phase 12 — when true, also composes the multi-agent comparison feature against a freshly created temp comparison-root directory (auto-cleaned by `TestHarness.cleanupComparisonRoot`). Defaults to false — existing callers are unaffected. */
  readonly withComparisons?: boolean | undefined;
  /** Phase 13.2 — passed straight through to `createHallCoreApp`; see `CreateHallCoreAppOptions.readiness`. `undefined` (the default) means `/api/v1/health` always reports ready. */
  readonly readiness?: CreateHallCoreAppOptions["readiness"];
}

export interface TestHarness {
  readonly registry: AgentRegistry;
  readonly taskStore: TaskStore;
  readonly eventStore: EventStore;
  readonly eventBus: EventBus;
  readonly orchestrator: TaskOrchestrator;
  readonly boardStore: BoardStore;
  readonly messageStore: MessageStore;
  readonly messageBus: MessageBus;
  readonly limits: ServerLimits;
  readonly comparison?: ComparisonComposition | undefined;
  /** Phase 14 — always composed (ephemeral, deterministic planner), matching every other Hall Core composition root. */
  readonly ceoPlans: CeoPlanComposition;
  /** No-op unless `withComparisons` was set — removes the temp comparison-root directory this harness created. */
  cleanupComparisonRoot(): void;
}

export function buildTestHarness(options: TestHarnessOptions): TestHarness {
  const limits: ServerLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const adapter = new MockAgentAdapter(options.mockAgentConfig ?? { scenario: "success" });
  const registry = new AgentRegistry();
  registry.register(adapter);
  for (const additionalAdapter of options.additionalAdapters ?? []) {
    registry.register(additionalAdapter);
  }

  const taskStore = new TaskStore({ maxTasks: limits.maxTasks });
  const eventStore = new EventStore({ maxEventsPerTask: limits.maxEventsPerTask });
  const eventBus = new EventBus({ maxSubscribersPerTask: limits.maxSubscribersPerTask });

  const orchestrator = new TaskOrchestrator({
    taskStore,
    eventStore,
    eventBus,
    registry,
    workspaceRoot: options.workspaceRoot,
    onExecutionError: options.onExecutionError,
  });

  const boardStore = new BoardStore({ maxBoards: limits.maxBoards, taskStore });
  const messageStore = new MessageStore({ maxMessagesPerBoard: limits.maxMessagesPerBoard });
  const messageBus = new MessageBus({ maxSubscribersPerBoard: limits.maxSubscribersPerBoard });
  const generalBoard = boardStore.seedGeneralBoard(new Date().toISOString());
  messageStore.registerBoard(generalBoard.boardId);

  const ceoPlans = createCeoPlanComposition({
    registry,
    taskStore,
    boardStore,
    messageStore,
    messageBus,
  });

  let comparison: ComparisonComposition | undefined;
  let comparisonRootDir: string | undefined;
  if (options.withComparisons) {
    comparisonRootDir = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "hall-test-comparison-root-")),
    );
    comparison = createComparisonComposition({
      registry,
      taskStore,
      workspaceRoot: options.workspaceRoot,
      comparisonRoot: comparisonRootDir,
      limits,
    });
  }

  return {
    registry,
    taskStore,
    eventStore,
    eventBus,
    orchestrator,
    boardStore,
    messageStore,
    messageBus,
    limits,
    comparison,
    ceoPlans,
    cleanupComparisonRoot(): void {
      if (comparisonRootDir) fs.rmSync(comparisonRootDir, { recursive: true, force: true });
    },
  };
}

export async function buildTestApp(options: TestHarnessOptions): Promise<{
  app: Awaited<ReturnType<typeof createHallCoreApp>>;
  harness: TestHarness;
}> {
  const harness = buildTestHarness(options);
  const appOptions: CreateHallCoreAppOptions = {
    orchestrator: harness.orchestrator,
    taskStore: harness.taskStore,
    eventStore: harness.eventStore,
    eventBus: harness.eventBus,
    boardStore: harness.boardStore,
    messageStore: harness.messageStore,
    messageBus: harness.messageBus,
    registry: harness.registry,
    comparison: harness.comparison,
    ceoPlanOrchestrator: harness.ceoPlans.orchestrator,
    webOrigin: options.webOrigin,
    limits: harness.limits,
    logger: options.logger ?? false,
    readiness: options.readiness,
  };
  const app = await createHallCoreApp(appOptions);
  return { app, harness };
}

export function validCreateTaskBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    projectId: "project-1",
    title: "Test task",
    adapterId: "hall.mock-agent",
    ...overrides,
  };
}

export function validDeferredTaskBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    executionMode: "deferred",
    projectId: "project-1",
    title: "Planning task",
    ...overrides,
  };
}

/**
 * Controls a `GatedAdapter`'s `detect()` calls from a test: every call to
 * `detect()` parks (does not resolve) until `release()` is called. This is
 * what lets a concurrency test deterministically force two requests to
 * overlap inside `TaskOrchestrator.assignTask()`'s `await adapter.detect()`
 * window — the exact window the Phase 7.1 assignment race lived in —
 * instead of relying on incidental Promise-microtask ordering (which Mock
 * Agent's real, near-instant `detect()` does not reliably control).
 */
export interface GatedAdapterController {
  /** Resolves once at least `count` `detect()` calls are currently parked (called, not yet released). */
  waitForParked(count: number, timeoutMs?: number): Promise<void>;
  /** Resolves every currently-parked `detect()` call (and any future ones) with `availability`. */
  release(availability?: AvailabilityStatus): void;
  readonly parkedCount: number;
}

/**
 * A minimal `AgentAdapter` whose `detect()` is test-controlled via the
 * returned `GatedAdapterController`, and whose `startTask()` always
 * rejects — this adapter exists purely to gate the assignment race window
 * and must never actually be started.
 */
export function createGatedAdapter(adapterId = "hall.gated-agent"): {
  adapter: AgentAdapter;
  controller: GatedAdapterController;
} {
  let parked = 0;
  let releasers: ((result: AgentDetectionResult) => void)[] = [];

  const controller: GatedAdapterController = {
    get parkedCount() {
      return parked;
    },
    async waitForParked(count, timeoutMs = 2000) {
      const start = Date.now();
      while (parked < count) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `GatedAdapterController.waitForParked: only ${String(parked)}/${String(count)} calls parked within ${String(timeoutMs)}ms`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    release(availability = "available") {
      const toRelease = releasers;
      releasers = [];
      parked -= toRelease.length;
      for (const resolve of toRelease) {
        resolve({ installed: true, availability });
      }
    },
  };

  const adapter: AgentAdapter = {
    descriptor: {
      adapterId,
      displayName: "Gated Test Agent",
      adapterVersion: "0.0.0",
      integrationLevel: "native",
      supportedOperatingSystems: ["windows", "macos", "linux"],
      supportedAgent: {
        agentId: "gated-agent",
        displayName: "Gated Test Agent",
        adapterId,
        adapterVersion: "0.0.0",
      },
      capabilities: {
        streaming: true,
        cancellation: true,
        sessionResume: false,
        toolEvents: true,
        fileEditing: false,
        shellExecution: false,
        subagents: false,
        mcp: false,
        acp: false,
      },
      declaredCapabilities: [],
    },
    detect(): Promise<AgentDetectionResult> {
      parked += 1;
      return new Promise((resolve) => {
        releasers.push(resolve);
      });
    },
    startTask(): Promise<never> {
      return Promise.reject(new Error("GatedAdapter.startTask must never be called"));
    },
  };

  return { adapter, controller };
}

/** Polls `check` until it returns true or `timeoutMs` elapses, without a fixed arbitrary sleep for the whole wait. */
export async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
