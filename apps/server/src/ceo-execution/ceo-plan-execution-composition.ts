import { randomUUID } from "node:crypto";
import type { CommunicationAuthor } from "@hall-of-wisdom/protocol";
import type { TaskStorePort } from "../tasks/task-store-port.js";
import type { TaskOrchestrator } from "../tasks/task-orchestrator.js";
import type { BoardStorePort } from "../boards/board-store-port.js";
import type { MessageStorePort } from "../boards/message-store-port.js";
import type { CeoPlanStorePort } from "../ceo-plans/ceo-plan-store-port.js";
import type { HallDatabase } from "../persistence/database.js";
import { withTransaction } from "../persistence/transaction.js";
import {
  createEphemeralAtomicUnit,
  type Snapshottable,
} from "../ceo-plans/ephemeral-atomic-unit.js";
import { InMemoryCeoPlanRunStore } from "./in-memory-ceo-plan-run-store.js";
import { SqliteCeoPlanRunStore } from "./sqlite-ceo-plan-run-store.js";
import type { CeoPlanRunStorePort } from "./ceo-plan-run-store-port.js";
import { InMemoryExecutionSignalStore } from "./in-memory-execution-signal-store.js";
import { SqliteExecutionSignalStore } from "./sqlite-execution-signal-store.js";
import type { ExecutionSignalStorePort } from "./execution-signal-store-port.js";
import { CeoPlanExecutionScheduler } from "./ceo-plan-execution-scheduler.js";
import { PlanRunEventBus } from "./plan-run-event-bus.js";
import {
  createCeoPlanMutationTokenIssuer,
  type CeoPlanMutationTokenIssuer,
} from "../ceo-plans/ceo-plan-mutation-token.js";

const DEFAULT_MAX_PLAN_RUN_EVENT_SUBSCRIBERS_PER_RUN = 20;

/** Structural check, matching `ceo-plan-composition.ts`'s own — never `instanceof`, so a future mutation-hook-style wrapper around either store would still qualify. */
function isSnapshottable(value: unknown): value is Snapshottable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { snapshot?: unknown }).snapshot === "function" &&
    typeof (value as { restore?: unknown }).restore === "function"
  );
}

const SCHEDULER_BOARD_AUTHOR: CommunicationAuthor = {
  kind: "system",
  displayName: "Execution Scheduler",
};

export interface CeoPlanExecutionCompositionOptions {
  readonly taskStore: TaskStorePort;
  readonly taskOrchestrator: TaskOrchestrator;
  readonly boardStore: BoardStorePort;
  readonly messageStore: MessageStorePort;
  /** Resolves a plan run's `planId` to its `parentTaskId` for bounded Board summaries — never used for anything else. */
  readonly planStore: CeoPlanStorePort;
  /** Same durable-vs-ephemeral branch every other Phase 13/14/15 composition root uses. */
  readonly db?: HallDatabase | undefined;
  /** Test-only override — production always lets this default to a fresh `randomUUID()` per process boot. */
  readonly ownerToken?: string | undefined;
}

export interface CeoPlanExecutionComposition {
  readonly planRunStore: CeoPlanRunStorePort;
  readonly signalStore: ExecutionSignalStorePort;
  readonly scheduler: CeoPlanExecutionScheduler;
  /** Dedicated execution-event stream — never mixed with `CeoPlanEventBus`, task normalized events, comparison events, or Board messages. */
  readonly planRunEventBus: PlanRunEventBus;
  /** Same bounded, dedup-gated Board summary function the scheduler itself uses — exposed so `ceo-plan-execution-recovery.ts` can post its own recovery-pause summary through the identical path, never a second reimplementation of "resolve planId -> parentTaskId -> post". */
  readonly postBoardAudit: (planId: string, text: string) => void;
  /** Same seam passed to the scheduler — exposed so `ceo-plan-execution-recovery.ts` can wrap its own unclean-restart multi-write span atomically too, using the identical durable-vs-ephemeral coordinator rather than a second one. */
  readonly runAtomicUnit: <T>(fn: () => T) => T;
  /** Opaque public concurrency token for plan-run REST routes — same `CeoPlanMutationTokenIssuer` shape `ceo-plan-composition.ts` already uses for plan-level mutations, a fresh in-memory secret per process boot (see that issuer's own doc comment for why a restart safely invalidating every previously-issued token is intended). Keyed by `runId` + the run's own `activeGeneration` — see `routes/ceo-plan-runs.ts`'s doc comment on why `activeGeneration`, not a separate per-run revision counter, is the "revision" this token binds to. */
  readonly tokenIssuer: CeoPlanMutationTokenIssuer;
}

/**
 * Phase 15 — the autonomous execution control plane, composed on top of
 * the exact same `taskStore`/`taskOrchestrator`/`boardStore`/`messageStore`
 * instances Phase 14's `ceoPlans` composition already uses (never a second,
 * competing set) — mirrors `createCeoPlanComposition`'s own "reuse, never
 * rebuild" discipline. `planStore` is read-only here: the scheduler never
 * mutates plan content, only resolves `planId -> parentTaskId` for bounded
 * Board summaries (`ceo-plan-execution-scheduler.ts`'s `postBoardAudit`).
 */
export function createCeoPlanExecutionComposition(
  options: CeoPlanExecutionCompositionOptions,
): CeoPlanExecutionComposition {
  const db = options.db;
  const planRunStore: CeoPlanRunStorePort =
    db !== undefined ? new SqliteCeoPlanRunStore({ db }) : new InMemoryCeoPlanRunStore();
  const signalStore: ExecutionSignalStorePort =
    db !== undefined ? new SqliteExecutionSignalStore({ db }) : new InMemoryExecutionSignalStore();
  // A fresh, unguessable token per process boot — every attempt this
  // process claims carries it as its lease owner, so a displaced former
  // Hall Core instance (Phase 13's ownership-fencing model) can never be
  // mistaken for the current one after a restart.
  const ownerToken = options.ownerToken ?? randomUUID();

  const postBoardAudit = (planId: string, text: string): void => {
    let plan;
    try {
      plan = options.planStore.getPlan(planId);
    } catch {
      // The plan is gone or not yet visible to this read — an audit
      // summary is best-effort and must never throw back into the
      // scheduler's own commit path.
      return;
    }
    const now = new Date().toISOString();
    const { board, created } = options.boardStore.ensureTaskBoard(plan.parentTaskId, now);
    if (created) options.messageStore.registerBoard(board.boardId);
    const message = options.messageStore.append(board.boardId, {
      messageId: randomUUID(),
      boardId: board.boardId,
      author: SCHEDULER_BOARD_AUTHOR,
      text,
      createdAt: now,
    });
    options.boardStore.recordMessageAppended(board.boardId, message.sequence + 1, now);
  };

  // Same durable-vs-ephemeral `runAtomicUnit` seam `createCeoPlanComposition`
  // already uses for its own four stores — see that function's doc
  // comment. Durable mode: `withTransaction` (reentrant `SAVEPOINT`s).
  // Ephemeral mode: a real snapshot/restore coordinator over exactly the
  // two stores the scheduler ever spans a synchronous multi-write across
  // (`planRunStore` + `signalStore`) — never `taskStore`/`boardStore`
  // (Phase 15's own atomic spans never touch those synchronously; see
  // `ceo-plan-execution-scheduler.ts`'s `SchedulerDeps.runAtomicUnit` doc
  // comment).
  let runAtomicUnit: <T>(fn: () => T) => T;
  if (db !== undefined) {
    runAtomicUnit = (fn) => withTransaction(db, fn);
  } else if (isSnapshottable(planRunStore) && isSnapshottable(signalStore)) {
    runAtomicUnit = createEphemeralAtomicUnit({ planRunStore, signalStore });
  } else {
    throw new Error(
      "createCeoPlanExecutionComposition: ephemeral mode (no db) requires planRunStore/signalStore to support snapshot()/restore()",
    );
  }

  const planRunEventBus = new PlanRunEventBus({
    maxSubscribersPerRun: DEFAULT_MAX_PLAN_RUN_EVENT_SUBSCRIBERS_PER_RUN,
  });

  const scheduler = new CeoPlanExecutionScheduler({
    planRunStore,
    signalStore,
    taskStore: options.taskStore,
    taskOrchestrator: options.taskOrchestrator,
    now: () => new Date().toISOString(),
    ownerToken,
    postBoardAudit,
    runAtomicUnit,
    eventBus: planRunEventBus,
  });

  const tokenIssuer = createCeoPlanMutationTokenIssuer();

  return {
    planRunStore,
    signalStore,
    scheduler,
    postBoardAudit,
    runAtomicUnit,
    planRunEventBus,
    tokenIssuer,
  };
}
