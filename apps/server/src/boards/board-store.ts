import type { CommunicationBoard } from "@hall-of-wisdom/protocol";
import { BoardCapacityReachedError, BoardNotFoundError } from "../errors/app-error.js";
import type { TaskStorePort } from "../tasks/task-store-port.js";
import type { BoardStorePort, EnsureTaskBoardResult } from "./board-store-port.js";

/** Stable, documented identifier for the one General board — never generated, never looked up through an index. */
export const GENERAL_BOARD_ID = "hall.general";

/**
 * The task board's id is *derived* from `taskId`, not randomly generated
 * and tracked through a separate `taskId -> boardId` index. This is what
 * makes "at most one board per task" and "creation is idempotent"
 * structural facts rather than invariants a lock has to maintain: two
 * concurrent `ensureTaskBoard(taskId)` calls always compute the identical
 * key, so "does a board already exist for this task" reduces to a single
 * map lookup at a known key — see `ensureTaskBoard`'s doc comment.
 */
export function taskBoardId(taskId: string): string {
  return `task:${taskId}`;
}

export interface BoardStoreOptions {
  readonly maxBoards: number;
  /** Read-only dependency: used only to validate a task exists and to read its (already-public) title/projectId when creating a task board. Never mutated. */
  readonly taskStore: TaskStorePort;
}

export type { EnsureTaskBoardResult } from "./board-store-port.js";

/**
 * In-memory board storage — the ephemeral implementation of
 * `BoardStorePort` (Phase 13's durable sibling is `SqliteBoardStore`).
 * `get`/`list`/`ensureTaskBoard` always return `structuredClone`d
 * snapshots, the same discipline `TaskStore` and `EventStore` already
 * follow — callers can never mutate this store's internal state through a
 * returned value.
 */
export class BoardStore implements BoardStorePort {
  readonly #boards = new Map<string, CommunicationBoard>();
  readonly #maxBoards: number;
  readonly #taskStore: TaskStorePort;

  constructor(options: BoardStoreOptions) {
    this.#maxBoards = options.maxBoards;
    this.#taskStore = options.taskStore;
  }

  /**
   * Seeds the one General board. Called exactly once, during server
   * composition (never from a route, never on every request) — see
   * `docs/architecture/0007-communication-boards.md`, "General board
   * initialization". Does not count against `maxBoards`: the General board
   * is a fixed part of every Hall Core instance, not browser-created
   * capacity.
   */
  seedGeneralBoard(now: string): CommunicationBoard {
    const board: CommunicationBoard = {
      boardId: GENERAL_BOARD_ID,
      kind: "general",
      title: "General",
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };
    this.#boards.set(GENERAL_BOARD_ID, board);
    return structuredClone(board);
  }

  get(boardId: string): CommunicationBoard {
    const board = this.#boards.get(boardId);
    if (!board) {
      throw new BoardNotFoundError(boardId);
    }
    return structuredClone(board);
  }

  has(boardId: string): boolean {
    return this.#boards.has(boardId);
  }

  /**
   * General board first, then task boards ordered by most-recently-updated
   * (descending), with `boardId` as a stable tie-breaker for boards sharing
   * an identical `updatedAt` — deterministic regardless of `Map` iteration
   * order or timestamp collisions.
   */
  list(): CommunicationBoard[] {
    const boards = Array.from(this.#boards.values());
    boards.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "general" ? -1 : 1;
      if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? -1 : 1;
      if (a.boardId === b.boardId) return 0;
      return a.boardId < b.boardId ? -1 : 1;
    });
    return boards.map((board) => structuredClone(board));
  }

  /**
   * Get-or-create at the deterministic key `taskBoardId(taskId)` — nothing
   * here ever `await`s between the existence check and the `#boards.set()`
   * write, so JavaScript's single-threaded execution guarantees the first
   * of two concurrent calls for the same `taskId` to actually run creates
   * the board, and every subsequent call (concurrent or not) observes and
   * returns that exact same board. There is no window in which two boards
   * for one task could ever be stored, and therefore nothing to detect or
   * roll back after the fact — see
   * `docs/architecture/0007-communication-boards.md`, "Task-board
   * idempotency" for why this made a `BOARD_STATE_CONFLICT` code
   * unnecessary for this operation.
   *
   * Validates the task exists (via the injected `TaskStore`, which throws
   * `TaskNotFoundError` for an unknown id) before ever creating a board —
   * an unknown task must never silently produce an orphaned discussion
   * board. Reads only `task.title`/`task.projectId` (both already
   * client-visible fields) and never touches status, revision, or any
   * execution-internal state; never calls a mutating `TaskStore` method, so
   * a task's status/lifecycle is provably unaffected by board creation.
   */
  ensureTaskBoard(taskId: string, now: string): EnsureTaskBoardResult {
    const boardId = taskBoardId(taskId);
    const existing = this.#boards.get(boardId);
    if (existing) {
      return { board: structuredClone(existing), created: false };
    }

    const record = this.#taskStore.get(taskId);

    // The General board is a fixed, always-present part of every Hall Core
    // instance, not browser-created capacity — it must never count toward
    // (or be evictable by) `maxBoards`, which bounds only how many task
    // discussion boards can accumulate.
    const taskBoardCount = this.#boards.has(GENERAL_BOARD_ID)
      ? this.#boards.size - 1
      : this.#boards.size;
    if (taskBoardCount >= this.#maxBoards) {
      throw new BoardCapacityReachedError(this.#maxBoards);
    }

    const board: CommunicationBoard = {
      boardId,
      kind: "task",
      title: `Discussion: ${record.task.title}`,
      taskId,
      projectId: record.task.projectId,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };
    this.#boards.set(boardId, board);
    return { board: structuredClone(board), created: true };
  }

  /** Updates a board's `messageCount`/`updatedAt` after a message is appended — never touches any other field. */
  recordMessageAppended(boardId: string, messageCount: number, now: string): void {
    const board = this.#boards.get(boardId);
    if (!board) {
      throw new BoardNotFoundError(boardId);
    }
    board.messageCount = messageCount;
    board.updatedAt = now;
  }
}
