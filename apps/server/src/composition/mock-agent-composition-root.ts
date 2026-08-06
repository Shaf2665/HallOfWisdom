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
import {
  createCeoPlanComposition,
  type CeoPlanComposition,
} from "../ceo-plans/ceo-plan-composition.js";
import { wrapTaskStoreWithMutationHook } from "../ceo-plans/task-mutation-hook.js";
import type { CeoPlanOrchestrator } from "../ceo-plans/ceo-plan-orchestrator.js";
import {
  createCeoPlanExecutionComposition,
  type CeoPlanExecutionComposition,
} from "../ceo-execution/ceo-plan-execution-composition.js";
import type { CeoPlanExecutionScheduler } from "../ceo-execution/ceo-plan-execution-scheduler.js";
import { isTerminalTaskStatus } from "../tasks/task-status-transitions.js";
import { AgentWorktreeManager } from "../agent-worktrees/agent-worktree-manager.js";
import { InMemoryAgentWorktreeStore } from "../agent-worktrees/in-memory-agent-worktree-store.js";
import { SqliteAgentWorktreeStore } from "../agent-worktrees/sqlite-agent-worktree-store.js";
import { NodeGitCommandRunner } from "../agent-worktrees/git-command-runner.js";
import type { AgentWorktreeStorePort } from "../agent-worktrees/agent-worktree-store-port.js";
import { InMemoryAgentExecutionArtifactStore } from "../execution-artifacts/in-memory-agent-execution-artifact-store.js";
import { SqliteAgentExecutionArtifactStore } from "../execution-artifacts/sqlite-agent-execution-artifact-store.js";
import type { AgentExecutionArtifactStorePort } from "../execution-artifacts/agent-execution-artifact-store-port.js";
import { ExplicitAdapterIsolationPolicy } from "../agent-execution/isolation-policy.js";
import { IsolatedAgentExecutionCoordinator } from "../agent-execution/isolated-agent-execution-coordinator.js";
import type { AgentWorktreeValidator } from "../agent-execution/isolated-agent-execution-coordinator.js";
import { GitArtifactCollector } from "../agent-execution/git-artifact-collector.js";
import { AgentExecutionArtifactTerminalizer } from "../agent-execution/agent-execution-artifact-terminalizer.js";

export interface ServerCompositionOptions {
  /** Canonical, already-validated workspace root. */
  readonly workspaceRoot: string;
  readonly mockScenario?: string | undefined;
  readonly mockStepDelayMs?: number | undefined;
  /** Test-only knob (never a real CLI flag) — lets a "failure" scenario report a retryable (transient) structured failure instead of the schema's own `false` default, for tests that specifically need to distinguish transient from permanent classification through the real mutation-hook bridge. */
  readonly mockFailureRetryable?: boolean | undefined;
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
  readonly agentWorktreeRoot?: string | undefined;
  readonly isolatedAgentAdapterIds?: readonly string[] | undefined;
  readonly allowInMemoryAgentIsolation?: boolean | undefined;
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
  /** Phase 14 — always composed (unlike `comparison`, CEO plans need no separate filesystem root). */
  readonly ceoPlans: CeoPlanComposition;
  /** Phase 15 — always composed alongside `ceoPlans`; a delegated plan may still have no active run and stay in manual mode (Phase 14 behavior, unchanged) until an operator explicitly configures and starts autonomous execution. */
  readonly ceoExecution: CeoPlanExecutionComposition;
  readonly agentWorktreeStore: AgentWorktreeStorePort;
  readonly agentWorktreeValidator: AgentWorktreeValidator | undefined;
  readonly agentExecutionArtifactStore: AgentExecutionArtifactStorePort;
  /**
   * Phase 16.5 — present only when isolated execution is actually
   * composed (durable storage + an explicit Hall-owned worktree root).
   * Restart reconciliation (`server.ts`) uses this exact instance's
   * `cleanupWorktree` for startup cleanup resumption — never a second,
   * independently-constructed manager over the same owned root.
   */
  readonly agentWorktreeManager: AgentWorktreeManager | undefined;
  /**
   * Phase 16.5 — the same terminalizer instance `TaskOrchestrator` uses at
   * runtime, reused by restart reconciliation to idempotently create (or
   * confirm a semantic match for) a missing execution artifact from
   * durable evidence. Always present (mirrors `TaskOrchestrator`'s own
   * unconditional construction above) — a no-op when no worktree ever
   * needs reconciling.
   */
  readonly agentExecutionArtifactTerminalizer: AgentExecutionArtifactTerminalizer;
  /**
   * Arms the task-mutation bridge that lets `ceoExecution.scheduler` react
   * to child-task completions. Deliberately NOT armed automatically by
   * this function — the caller (`server.ts`) must call this only AFTER
   * `runCeoPlanExecutionRecovery` has finished deciding what to do with
   * every previously-configured run (pause on an unclean restart, or
   * revalidate-and-continue on a clean one). Calling this before that
   * pass runs would let `runRestartRecovery`'s own `reconcileTasks` step
   * — which mutates `taskStore` directly, before the recovery pass below
   * ever executes — trigger live scheduling decisions on stale,
   * not-yet-reconciled run state. Safe (and required) to call
   * unconditionally in ephemeral mode, where there is no restart sequence
   * at all and no run can already exist.
   */
  readonly activateAutonomousScheduling: () => void;
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
  readonly agentWorktreeRoot?: string | undefined;
  readonly isolatedAgentAdapterIds?: readonly string[] | undefined;
  readonly allowInMemoryAgentIsolation?: boolean | undefined;
  /**
   * Phase 14.1 — an optional generic hook fired after every status-changing
   * `taskStore` mutation, regardless of which caller performed it. This
   * function itself has no notion of CEO plans (it just wraps `taskStore`
   * with `wrapTaskStoreWithMutationHook` before handing it to
   * `TaskOrchestrator`, if supplied) — the caller (`createMockAgentServerComposition`,
   * `apps/e2e/src/fixture-server.ts`) is what actually knows the callback
   * exists to trigger CEO plan progress synchronization. This has to
   * happen here, before `TaskOrchestrator` is constructed, because
   * `TaskOrchestrator` takes `taskStore` once, by reference, in its
   * constructor — there is no way to swap it in afterward.
   */
  readonly onTaskMutated?: ((taskId: string) => void) | undefined;
}

export interface CoreStoresComposition {
  readonly taskStore: TaskStorePort;
  readonly eventStore: NormalizedEventStorePort;
  readonly eventBus: EventBus;
  readonly orchestrator: TaskOrchestrator;
  readonly boardStore: BoardStorePort;
  readonly messageStore: MessageStorePort;
  readonly messageBus: MessageBus;
  readonly agentWorktreeStore: AgentWorktreeStorePort;
  readonly agentWorktreeValidator: AgentWorktreeValidator | undefined;
  readonly agentExecutionArtifactStore: AgentExecutionArtifactStorePort;
  readonly agentWorktreeManager: AgentWorktreeManager | undefined;
  readonly agentExecutionArtifactTerminalizer: AgentExecutionArtifactTerminalizer;
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
  const isolatedAgentAdapterIds = options.isolatedAgentAdapterIds ?? [];
  const isolationEnabled = isolatedAgentAdapterIds.length > 0;
  if (db === undefined && isolationEnabled && options.allowInMemoryAgentIsolation !== true) {
    throw new ServerCliError(
      "Isolated agent execution requires durable SQLite storage in this composition.",
    );
  }
  if (isolationEnabled && options.agentWorktreeRoot === undefined) {
    throw new ServerCliError(
      "Isolated agent execution requires an explicit Hall-owned agent worktree root.",
    );
  }

  const rawTaskStore: TaskStorePort =
    db !== undefined
      ? new SqliteTaskStore({ db, maxTasks: options.limits.maxTasks })
      : new TaskStore({ maxTasks: options.limits.maxTasks });
  const taskStore: TaskStorePort =
    options.onTaskMutated !== undefined
      ? wrapTaskStoreWithMutationHook(rawTaskStore, options.onTaskMutated)
      : rawTaskStore;
  const eventStore: NormalizedEventStorePort =
    db !== undefined
      ? new SqliteEventStore({
          db,
          streamKind: "task",
          maxEventsPerStream: options.limits.maxEventsPerTask,
        })
      : new EventStore({ maxEventsPerTask: options.limits.maxEventsPerTask });
  const eventBus = new EventBus({ maxSubscribersPerTask: options.limits.maxSubscribersPerTask });
  const agentWorktreeStore: AgentWorktreeStorePort =
    db !== undefined ? new SqliteAgentWorktreeStore({ db }) : new InMemoryAgentWorktreeStore();
  const agentExecutionArtifactStore: AgentExecutionArtifactStorePort =
    db !== undefined
      ? new SqliteAgentExecutionArtifactStore({ db })
      : new InMemoryAgentExecutionArtifactStore();
  const gitRunner = new NodeGitCommandRunner();
  const agentWorktreeManager =
    isolationEnabled && options.agentWorktreeRoot !== undefined
      ? new AgentWorktreeManager({
          store: agentWorktreeStore,
          gitRunner,
          ownedRoot: options.agentWorktreeRoot,
        })
      : undefined;
  const gitArtifactCollector =
    agentWorktreeManager !== undefined
      ? new GitArtifactCollector({
          gitRunner,
          worktreeValidator: agentWorktreeManager,
        })
      : undefined;
  const executionCoordinator =
    agentWorktreeManager !== undefined
      ? new IsolatedAgentExecutionCoordinator({
          isolationPolicy: new ExplicitAdapterIsolationPolicy(isolatedAgentAdapterIds),
          worktreeManager: agentWorktreeManager,
          worktreeStore: agentWorktreeStore,
          worktreeValidator: agentWorktreeManager,
        })
      : undefined;
  const artifactTerminalizer = new AgentExecutionArtifactTerminalizer({
    store: agentExecutionArtifactStore,
    gitArtifactCollector,
  });

  const orchestrator = new TaskOrchestrator({
    taskStore,
    eventStore,
    eventBus,
    registry: options.registry,
    workspaceRoot: options.workspaceRoot,
    onExecutionError: options.onExecutionError,
    executionCoordinator,
    artifactTerminalizer,
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
    agentWorktreeStore,
    agentWorktreeValidator: agentWorktreeManager,
    agentExecutionArtifactStore,
    agentWorktreeManager,
    agentExecutionArtifactTerminalizer: artifactTerminalizer,
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
    ...(options.mockFailureRetryable !== undefined
      ? { failureRetryable: options.mockFailureRetryable }
      : {}),
  });
  const registry = new AgentRegistry();
  registry.register(adapter);

  // Phase 14.1 — `ceoOrchestratorRef` closes the loop: the hook needs a
  // callback at `taskStore` construction time, but `CeoPlanOrchestrator`
  // does not exist until after `createCoreStoresComposition` (and the
  // `TaskOrchestrator` it builds) already have. A `const`-bound mutable
  // box (rather than a `let`) so the callback captures a stable
  // reference to `.current`, which safely resolves to the real
  // orchestrator once `ceoPlans` is built below — `.current` is only
  // ever read after this whole function has returned (the earliest any
  // task mutation could occur is a subsequent route call).
  const ceoOrchestratorRef: { current: CeoPlanOrchestrator | undefined } = { current: undefined };
  // Phase 15 — same ref pattern, for the scheduler this composition builds
  // further below. Deliberately forwarded ONLY on a terminal child-task
  // status (`completed`/`failed`/`cancelled`), for two reasons: (1) it is
  // the only status transition `CeoPlanExecutionScheduler.onChildTaskMutated`
  // itself ever acts on (see that method), so forwarding every intermediate
  // transition would be pure overhead on the hottest possible path — the
  // exact "idle efficiency" / "never scan or notify on irrelevant
  // transitions" target this phase requires; and (2) it structurally rules
  // out the one real reentrancy risk in this bridge: `TaskOrchestrator
  // .startTask()` itself calls `taskStore.setRunId(...)` while the task is
  // merely "running" (not yet terminal), so a same-tick "start → notify →
  // scheduler tries to start something else" cycle can never begin here —
  // by the time a task reaches a terminal state, the scheduler's own
  // `startTask()` call for it has long since returned.
  const schedulerRef: { current: CeoPlanExecutionScheduler | undefined } = { current: undefined };
  const stores = createCoreStoresComposition({
    registry,
    workspaceRoot: options.workspaceRoot,
    limits: options.limits,
    onExecutionError: options.onExecutionError,
    db: options.db,
    agentWorktreeRoot: options.agentWorktreeRoot,
    isolatedAgentAdapterIds: options.isolatedAgentAdapterIds,
    allowInMemoryAgentIsolation: options.allowInMemoryAgentIsolation,
    onTaskMutated: (taskId) => {
      ceoOrchestratorRef.current?.onChildTaskMutated(taskId);
      const scheduler = schedulerRef.current;
      if (scheduler === undefined) return;
      let record;
      try {
        record = stores.taskStore.get(taskId);
      } catch {
        return;
      }
      if (isTerminalTaskStatus(record.task.status)) {
        scheduler.onChildTaskMutated(taskId).catch(() => {
          // Best-effort bridge — a missed scheduler wakeup here is
          // recoverable by the bounded reconciliation pass (Phase 15's
          // safety net, never the primary scheduling path).
        });
      }
    },
  });

  const ceoPlans = createCeoPlanComposition({
    registry,
    taskStore: stores.taskStore,
    boardStore: stores.boardStore,
    messageStore: stores.messageStore,
    messageBus: stores.messageBus,
    db: options.db,
  });
  ceoOrchestratorRef.current = ceoPlans.orchestrator;

  const ceoExecution = createCeoPlanExecutionComposition({
    taskStore: stores.taskStore,
    taskOrchestrator: stores.orchestrator,
    boardStore: stores.boardStore,
    messageStore: stores.messageStore,
    planStore: ceoPlans.planStore,
    db: options.db,
  });
  // Deliberately NOT set here — see `activateAutonomousScheduling`'s doc
  // comment on `ServerComposition`. `schedulerRef.current` stays
  // `undefined` (the bridge stays inert) until the caller explicitly arms
  // it, after its own recovery pass has run.
  const activateAutonomousScheduling = (): void => {
    schedulerRef.current = ceoExecution.scheduler;
    // Phase 15.3 — arms the retry-due wake timer for any signal already
    // pending in durable storage (e.g. from before an unclean restart).
    // Called here, never earlier, so it inherits the exact same ordering
    // guarantee `schedulerRef.current` itself relies on: only after
    // recovery has already decided what to do with every previously-
    // configured run — a genuinely interrupted (`"running"`) step stays
    // untouched by Phase 13's own rule, while a step recovery left in
    // `"retry_wait"` (never interrupted mid-flight, only ever waiting out
    // its own already-decided backoff) is exactly what this timer exists
    // to wake.
    ceoExecution.scheduler.start();
  };

  return { registry, ...stores, ceoPlans, ceoExecution, activateAutonomousScheduling };
}
