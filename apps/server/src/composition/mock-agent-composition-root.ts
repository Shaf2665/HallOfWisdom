import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import {
  MockAgentAdapter,
  mockAgentScenarioSchema,
  type MockAgentScenario,
} from "@hall-of-wisdom/mock-agent";
import { TaskStore } from "../tasks/task-store.js";
import { TaskOrchestrator } from "../tasks/task-orchestrator.js";
import { EventStore } from "../events/event-store.js";
import { EventBus } from "../events/event-bus.js";
import { BoardStore } from "../boards/board-store.js";
import { MessageStore } from "../boards/message-store.js";
import { MessageBus } from "../boards/message-bus.js";
import type { ServerLimits } from "../config/server-config.js";
import { ServerCliError } from "../config/server-cli-args.js";

export interface ServerCompositionOptions {
  /** Canonical, already-validated workspace root. */
  readonly workspaceRoot: string;
  readonly mockScenario?: string | undefined;
  readonly mockStepDelayMs?: number | undefined;
  readonly limits: ServerLimits;
  readonly onExecutionError?: ((taskId: string, error: unknown) => void) | undefined;
  /**
   * Phase 10.2 — `--enable-codex-trusted-local` at Hall Core startup only.
   * Never read from anything task-, browser-, or REST-request-controlled.
   * Defaults to `false` (Phase 10.1's fail-closed behavior, unchanged).
   */
  readonly enableCodexTrustedLocal?: boolean | undefined;
}

export interface ServerComposition {
  readonly registry: AgentRegistry;
  readonly taskStore: TaskStore;
  readonly eventStore: EventStore;
  readonly eventBus: EventBus;
  readonly orchestrator: TaskOrchestrator;
  readonly boardStore: BoardStore;
  readonly messageStore: MessageStore;
  readonly messageBus: MessageBus;
}

function resolveScenario(rawScenario: string | undefined): MockAgentScenario {
  const value = rawScenario ?? "success";
  const result = mockAgentScenarioSchema.safeParse(value);
  if (!result.success) {
    throw new ServerCliError(
      `--mock-scenario must be one of "success", "failure", "cancellable", got "${value}"`,
    );
  }
  return result.data;
}

/**
 * The only file in this package allowed to know about Mock Agent
 * specifically — mirrors `runners/hall-runner/src/mock-agent-composition-root.ts`.
 * `TaskOrchestrator`, `TaskStore`, `EventStore`, `EventBus`, and every
 * route module never see a scenario name or a `MockAgentAdapter` type,
 * only the `AgentAdapter` interface via the `AgentRegistry` built here.
 */
export function createMockAgentServerComposition(
  options: ServerCompositionOptions,
): ServerComposition {
  const adapter = new MockAgentAdapter({
    scenario: resolveScenario(options.mockScenario),
    stepDelayMs: options.mockStepDelayMs,
  });
  const registry = new AgentRegistry();
  registry.register(adapter);

  const taskStore = new TaskStore({ maxTasks: options.limits.maxTasks });
  const eventStore = new EventStore({ maxEventsPerTask: options.limits.maxEventsPerTask });
  const eventBus = new EventBus({ maxSubscribersPerTask: options.limits.maxSubscribersPerTask });

  const orchestrator = new TaskOrchestrator({
    taskStore,
    eventStore,
    eventBus,
    registry,
    workspaceRoot: options.workspaceRoot,
    onExecutionError: options.onExecutionError,
  });

  // A fresh, isolated store per call (never shared module-level state — see
  // `BoardStore`'s own test coverage for this) with the one General board
  // seeded immediately, before this composition is ever handed to a route.
  const boardStore = new BoardStore({ maxBoards: options.limits.maxBoards, taskStore });
  const messageStore = new MessageStore({
    maxMessagesPerBoard: options.limits.maxMessagesPerBoard,
  });
  const messageBus = new MessageBus({
    maxSubscribersPerBoard: options.limits.maxSubscribersPerBoard,
  });
  const generalBoard = boardStore.seedGeneralBoard(new Date().toISOString());
  messageStore.registerBoard(generalBoard.boardId);

  return {
    registry,
    taskStore,
    eventStore,
    eventBus,
    orchestrator,
    boardStore,
    messageStore,
    messageBus,
  };
}
