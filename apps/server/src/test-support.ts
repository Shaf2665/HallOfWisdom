import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { MockAgentAdapter, type MockAgentConfigInput } from "@hall-of-wisdom/mock-agent";
import { createHallCoreApp, type CreateHallCoreAppOptions } from "./app.js";
import { TaskStore } from "./tasks/task-store.js";
import { TaskOrchestrator } from "./tasks/task-orchestrator.js";
import { EventStore } from "./events/event-store.js";
import { EventBus } from "./events/event-bus.js";
import { DEFAULT_LIMITS, type ServerLimits } from "./config/server-config.js";

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
  readonly runId: string;
  readonly adapterId: string;
  readonly agentId: string;
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
}

export interface TestHarness {
  readonly registry: AgentRegistry;
  readonly taskStore: TaskStore;
  readonly eventStore: EventStore;
  readonly eventBus: EventBus;
  readonly orchestrator: TaskOrchestrator;
  readonly limits: ServerLimits;
}

export function buildTestHarness(options: TestHarnessOptions): TestHarness {
  const limits: ServerLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const adapter = new MockAgentAdapter(options.mockAgentConfig ?? { scenario: "success" });
  const registry = new AgentRegistry();
  registry.register(adapter);

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

  return { registry, taskStore, eventStore, eventBus, orchestrator, limits };
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
    limits: harness.limits,
    logger: options.logger ?? false,
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
