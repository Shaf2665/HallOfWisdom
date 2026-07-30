import type { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import type { TaskStorePort } from "../tasks/task-store-port.js";
import type { BoardStorePort } from "../boards/board-store-port.js";
import type { MessageStorePort } from "../boards/message-store-port.js";
import type { MessageBus } from "../boards/message-bus.js";
import type { HallDatabase } from "../persistence/database.js";
import { withTransaction } from "../persistence/transaction.js";
import { InMemoryCeoPlanStore } from "./in-memory-ceo-plan-store.js";
import { SqliteCeoPlanStore } from "./sqlite-ceo-plan-store.js";
import type { CeoPlanStorePort } from "./ceo-plan-store-port.js";
import { CeoPlanEventBus } from "./ceo-plan-events.js";
import { createDeterministicCeoPlanner } from "./deterministic-ceo-planner.js";
import { CeoPlanOrchestrator } from "./ceo-plan-orchestrator.js";
import { createCeoPlanMutationTokenIssuer } from "./ceo-plan-mutation-token.js";
import { createEphemeralAtomicUnit, type Snapshottable } from "./ephemeral-atomic-unit.js";

const DEFAULT_MAX_CEO_PLAN_EVENT_SUBSCRIBERS_PER_PLAN = 20;

/**
 * Structural (not `instanceof`) check: `snapshot()`/`restore()` are
 * deliberately not part of any `*StorePort` interface (see
 * `TaskStore.snapshot()`'s doc comment), so `options`'s port-typed
 * fields don't statically carry them. Structural narrowing — rather than
 * `instanceof TaskStore` — is what lets Task 6's `wrapTaskStoreWithMutationHook`
 * result (a plain object, not a `TaskStore` instance, but one that
 * pass-through delegates `snapshot()`/`restore()` to the real store it
 * wraps) participate here too, with this function never needing to know
 * a wrapper is involved.
 */
function isSnapshottable(value: unknown): value is Snapshottable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { snapshot?: unknown }).snapshot === "function" &&
    typeof (value as { restore?: unknown }).restore === "function"
  );
}

/**
 * Every composition root only reaches this function's caller when
 * `db === undefined`, which is exactly when it also constructed plain
 * `TaskStore`/`BoardStore`/`MessageStore`/`InMemoryCeoPlanStore`
 * instances (or a mutation-hook wrapper of one) — so this should never
 * actually throw in production; the check exists so a future composition
 * root that violates that invariant fails loudly at startup instead of
 * silently losing ephemeral delegation's atomicity guarantee.
 */
function buildEphemeralRunAtomicUnit(
  options: CeoPlanCompositionOptions,
  planStore: CeoPlanStorePort,
): <T>(fn: () => T) => T {
  const { taskStore, boardStore, messageStore } = options;
  if (
    !isSnapshottable(taskStore) ||
    !isSnapshottable(boardStore) ||
    !isSnapshottable(messageStore) ||
    !isSnapshottable(planStore)
  ) {
    throw new Error(
      "createCeoPlanComposition: ephemeral mode (no db) requires every store to support snapshot()/restore()",
    );
  }
  return createEphemeralAtomicUnit({ taskStore, boardStore, messageStore, planStore });
}

export interface CeoPlanCompositionOptions {
  readonly registry: AgentRegistry;
  readonly taskStore: TaskStorePort;
  readonly boardStore: BoardStorePort;
  readonly messageStore: MessageStorePort;
  readonly messageBus: MessageBus;
  /** Same durable-vs-ephemeral branch as `createCoreStoresComposition` — see this file's own doc comment for why `runAtomicUnit` is derived here, once, rather than left to each call site. */
  readonly db?: HallDatabase | undefined;
}

export interface CeoPlanComposition {
  readonly planStore: CeoPlanStorePort;
  readonly planEventBus: CeoPlanEventBus;
  readonly orchestrator: CeoPlanOrchestrator;
}

/**
 * Phase 14 — the CEO plan control plane, composed on top of whatever
 * `TaskStore`/`BoardStore`/`MessageStore`/`AgentRegistry` the caller
 * already built (production's `createMockAgentServerComposition` and the
 * E2E fixture composition both call this immediately after
 * `createCoreStoresComposition`). Never builds its own `TaskStore` or
 * `BoardStore` — reusing the exact same instances is what lets
 * `CeoPlanOrchestrator.delegate()`'s atomic unit span all three stores.
 *
 * `runAtomicUnit` is the one, narrow seam that lets the orchestrator
 * write across `TaskStorePort`/`CeoPlanStorePort`/`BoardStorePort`/
 * `MessageStorePort` as a single atomic, fenced operation without this
 * module (or any route) ever exposing a generic transaction API: in
 * durable mode it is `(fn) => withTransaction(db, fn)` — every one of
 * those stores' own public methods already opens its own
 * `withTransaction`, and since that function is reentrant (Phase 14's
 * change to `transaction.ts`), calling them from inside this one just
 * makes them participate via `SAVEPOINT`. In ephemeral mode there is no
 * `HallDatabase` at all, so it is simply `(fn) => fn()` — atomicity there
 * comes from `CeoPlanOrchestrator.delegate()`'s own pre-validation
 * discipline (see that method's doc comment), never from this function.
 */
export function createCeoPlanComposition(options: CeoPlanCompositionOptions): CeoPlanComposition {
  const db = options.db;
  const planStore: CeoPlanStorePort =
    db !== undefined ? new SqliteCeoPlanStore({ db }) : new InMemoryCeoPlanStore();
  const planEventBus = new CeoPlanEventBus({
    maxSubscribersPerPlan: DEFAULT_MAX_CEO_PLAN_EVENT_SUBSCRIBERS_PER_PLAN,
  });
  const planner = createDeterministicCeoPlanner();
  // Phase 14.1 — fresh per process, held only in memory. See
  // `ceo-plan-mutation-token.ts`'s doc comment for why a restart safely
  // invalidating every previously-issued token is the intended behavior.
  const mutationTokens = createCeoPlanMutationTokenIssuer();

  // Phase 14.1 — durable mode's `runAtomicUnit` already existed; the
  // ephemeral branch previously was just `(fn) => fn()`, giving ephemeral
  // delegation no real rollback if an unexpected mutation failed after
  // earlier writes had already succeeded. `createEphemeralAtomicUnit`
  // closes that gap with a snapshot/restore coordinator mirroring
  // `withTransaction`'s all-or-nothing guarantee — see
  // `buildEphemeralRunAtomicUnit`'s doc comment for how it safely
  // narrows the port-typed stores down to their snapshot-capable form.
  const runAtomicUnit =
    db !== undefined
      ? <T>(fn: () => T): T => withTransaction(db, fn)
      : buildEphemeralRunAtomicUnit(options, planStore);

  const orchestrator = new CeoPlanOrchestrator({
    planStore,
    taskStore: options.taskStore,
    boardStore: options.boardStore,
    messageStore: options.messageStore,
    messageBus: options.messageBus,
    planEventBus,
    registry: options.registry,
    planner,
    runAtomicUnit,
    mutationTokens,
  });

  return { planStore, planEventBus, orchestrator };
}
