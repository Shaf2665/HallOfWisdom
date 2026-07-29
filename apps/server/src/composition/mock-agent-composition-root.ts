import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import {
  MockAgentAdapter,
  mockAgentScenarioSchema,
  type MockAgentScenario,
} from "@hall-of-wisdom/mock-agent";
import { TaskStore } from "../tasks/task-store.js";
import { SqliteTaskStore } from "../tasks/sqlite-task-store.js";
import type { TaskStorePort } from "../tasks/task-store-port.js";
import { TaskOrchestrator } from "../tasks/task-orchestrator.js";
import { EventStore } from "../events/event-store.js";
import { SqliteEventStore } from "../events/sqlite-event-store.js";
import type { NormalizedEventStorePort } from "../events/event-store-port.js";
import { EventBus } from "../events/event-bus.js";
import { BoardStore } from "../boards/board-store.js";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import type { BoardStorePort } from "../boards/board-store-port.js";
import { MessageStore } from "../boards/message-store.js";
import { SqliteMessageStore } from "../boards/sqlite-message-store.js";
import type { MessageStorePort } from "../boards/message-store-port.js";
import { MessageBus } from "../boards/message-bus.js";
import type { ServerLimits } from "../config/server-config.js";
import { ServerCliError } from "../config/server-cli-args.js";
import type { ComparisonComposition } from "./comparison-composition-root.js";
import type { HallDatabase } from "../persistence/database.js";

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
  /**
   * Phase 12 — canonical, already-validated comparison-root. Optional:
   * when `undefined`, the multi-agent comparison feature is not composed
   * at all (no `comparisonStore`/`comparisonOrchestrator`, no comparison
   * routes registered) — comparisons are additive, never required.
   */
  readonly comparisonRoot?: string | undefined;
  readonly onComparisonExecutionError?: ((candidateId: string, error: unknown) => void) | undefined;
  /**
   * Phase 13 — when supplied, every store below is the SQLite-backed
   * durable sibling instead of the in-memory one, all sharing this one
   * connection — see `server.ts`/`docs/architecture/0013-durable-persistence-and-recovery.md`.
   * `undefined` (the default) preserves every pre-Phase-13 startup path
   * byte-identical: purely in-memory, exactly as before.
   */
  readonly db?: HallDatabase | undefined;
}

export interface ServerComposition {
  readonly registry: AgentRegistry;
  readonly taskStore: TaskStorePort;
  readonly eventStore: NormalizedEventStorePort;
  readonly eventBus: EventBus;
  readonly orchestrator: TaskOrchestrator;
  readonly boardStore: BoardStorePort;
  readonly messageStore: MessageStorePort;
  readonly messageBus: MessageBus;
  /** Present only when `ServerCompositionOptions.comparisonRoot` was supplied. */
  readonly comparison?: ComparisonComposition | undefined;
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

export interface CoreStoresCompositionOptions {
  readonly registry: AgentRegistry;
  readonly workspaceRoot: string;
  readonly limits: ServerLimits;
  readonly onExecutionError?: ((taskId: string, error: unknown) => void) | undefined;
  readonly db?: HallDatabase | undefined;
}

export interface CoreStoresComposition {
  readonly taskStore: TaskStorePort;
  readonly eventStore: NormalizedEventStorePort;
  readonly eventBus: EventBus;
  readonly orchestrator: TaskOrchestrator;
  readonly boardStore: BoardStorePort;
  readonly messageStore: MessageStorePort;
  readonly messageBus: MessageBus;
}

/**
 * The task/board/event stores + orchestrator + buses, wired to the
 * SQLite-backed durable siblings when `options.db` is supplied and the
 * in-memory ones otherwise — factored out of `createMockAgentServerComposition`
 * so this exact logic (in particular, the durable-vs-in-memory branching
 * for every store) has exactly one definition shared by every composition
 * root that needs it, regardless of which adapters that root registers on
 * its own `registry`. `createMockAgentServerComposition` (production, Mock
 * Agent) and `apps/e2e/src/fixture-server.ts` (E2E, two fixture adapters)
 * both call this — see this phase's kickoff (Phase 13.2, §7): "reuse the
 * real Hall Core application; reuse the real SQLite durable stores." A
 * second, independent implementation of this branching in the E2E package
 * would be exactly the kind of divergence that could let the E2E fencing
 * coverage silently drift from what production actually does.
 */
export function createCoreStoresComposition(
  options: CoreStoresCompositionOptions,
): CoreStoresComposition {
  const db = options.db;

  const taskStore: TaskStorePort =
    db !== undefined
      ? new SqliteTaskStore({ db, maxTasks: options.limits.maxTasks })
      : new TaskStore({ maxTasks: options.limits.maxTasks });
  const eventStore: NormalizedEventStorePort =
    db !== undefined
      ? new SqliteEventStore({
          db,
          streamKind: "task",
          maxEventsPerStream: options.limits.maxEventsPerTask,
        })
      : new EventStore({ maxEventsPerTask: options.limits.maxEventsPerTask });
  const eventBus = new EventBus({ maxSubscribersPerTask: options.limits.maxSubscribersPerTask });

  const orchestrator = new TaskOrchestrator({
    taskStore,
    eventStore,
    eventBus,
    registry: options.registry,
    workspaceRoot: options.workspaceRoot,
    onExecutionError: options.onExecutionError,
  });

  // A fresh, isolated store per call (never shared module-level state — see
  // `BoardStore`'s own test coverage for this) with the one General board
  // seeded immediately, before this composition is ever handed to a route.
  // `seedGeneralBoard` is idempotent in durable mode — see
  // `SqliteBoardStore.seedGeneralBoard`'s doc comment — so calling it again
  // on a database a previous boot already seeded is a safe no-op.
  const boardStore: BoardStorePort =
    db !== undefined
      ? new SqliteBoardStore({ db, maxBoards: options.limits.maxBoards, taskStore })
      : new BoardStore({ maxBoards: options.limits.maxBoards, taskStore });
  const messageStore: MessageStorePort =
    db !== undefined
      ? new SqliteMessageStore({ db, maxMessagesPerBoard: options.limits.maxMessagesPerBoard })
      : new MessageStore({ maxMessagesPerBoard: options.limits.maxMessagesPerBoard });
  const messageBus = new MessageBus({
    maxSubscribersPerBoard: options.limits.maxSubscribersPerBoard,
  });
  const generalBoard = boardStore.seedGeneralBoard(new Date().toISOString());
  messageStore.registerBoard(generalBoard.boardId);

  return {
    taskStore,
    eventStore,
    eventBus,
    orchestrator,
    boardStore,
    messageStore,
    messageBus,
  };
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

  const stores = createCoreStoresComposition({
    registry,
    workspaceRoot: options.workspaceRoot,
    limits: options.limits,
    onExecutionError: options.onExecutionError,
    db: options.db,
  });

  return { registry, ...stores };
}
