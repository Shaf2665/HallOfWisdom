import { parseCommunicationBoard, type CommunicationBoard } from "@hall-of-wisdom/protocol";
import { BoardCapacityReachedError, BoardNotFoundError } from "../errors/app-error.js";
import type { TaskStorePort } from "../tasks/task-store-port.js";
import type { HallDatabase } from "../persistence/database.js";
import { CorruptRecordError } from "../persistence/persistence-errors.js";
import { withTransaction } from "../persistence/transaction.js";
import { GENERAL_BOARD_ID, taskBoardId } from "./board-store.js";
import type { BoardStorePort, EnsureTaskBoardResult } from "./board-store-port.js";

export interface SqliteBoardStoreOptions {
  readonly db: HallDatabase;
  readonly maxBoards: number;
  readonly taskStore: TaskStorePort;
}

interface BoardRow {
  board_id: string;
  kind: string;
  title: string;
  description: string | null;
  project_id: string | null;
  task_id: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

function rowToBoard(row: BoardRow): CommunicationBoard {
  try {
    return parseCommunicationBoard({
      boardId: row.board_id,
      kind: row.kind,
      title: row.title,
      ...(row.description !== null ? { description: row.description } : {}),
      ...(row.project_id !== null ? { projectId: row.project_id } : {}),
      ...(row.kind === "task" ? { taskId: row.task_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count,
    });
  } catch (error) {
    throw new CorruptRecordError(
      "boards",
      row.board_id,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * SQLite-backed durable sibling of `BoardStore` — implements the identical
 * `BoardStorePort` contract, verified by the shared contract-test suite.
 * Ordering for `list()` (General board first, then task boards by
 * most-recently-updated, `boardId` as tiebreak) is expressed directly in
 * the `ORDER BY` clause rather than an in-memory sort — the same
 * deterministic result either way.
 */
export class SqliteBoardStore implements BoardStorePort {
  readonly #db: HallDatabase;
  readonly #maxBoards: number;
  readonly #taskStore: TaskStorePort;

  constructor(options: SqliteBoardStoreOptions) {
    this.#db = options.db;
    this.#maxBoards = options.maxBoards;
    this.#taskStore = options.taskStore;
  }

  /**
   * Idempotent — unlike the in-memory `BoardStore` (always constructed
   * fresh per process start, so an unconditional insert is always safe),
   * a durable startup calls this against a database that may already have
   * the General board seeded by a previous boot. `ON CONFLICT DO NOTHING`
   * makes a restart's call a safe no-op rather than a raw SQLite
   * PRIMARY KEY violation.
   */
  seedGeneralBoard(now: string): CommunicationBoard {
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO boards (board_id, kind, title, created_at, updated_at, message_count)
           VALUES (?, 'general', 'General', ?, ?, 0)
           ON CONFLICT(board_id) DO NOTHING`,
        )
        .run(GENERAL_BOARD_ID, now, now);
    });
    return this.get(GENERAL_BOARD_ID);
  }

  get(boardId: string): CommunicationBoard {
    const row = this.#getRow(boardId);
    if (!row) throw new BoardNotFoundError(boardId);
    return rowToBoard(row);
  }

  has(boardId: string): boolean {
    return this.#getRow(boardId) !== undefined;
  }

  list(): CommunicationBoard[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM boards
         ORDER BY CASE WHEN kind = 'general' THEN 0 ELSE 1 END, updated_at DESC, board_id ASC`,
      )
      .all() as unknown as BoardRow[];
    return rows.map(rowToBoard);
  }

  ensureTaskBoard(taskId: string, now: string): EnsureTaskBoardResult {
    const boardId = taskBoardId(taskId);
    const existing = this.#getRow(boardId);
    if (existing) {
      return { board: rowToBoard(existing), created: false };
    }

    const record = this.#taskStore.get(taskId);

    const taskBoardCount = (
      this.#db.prepare("SELECT COUNT(*) AS c FROM boards WHERE kind = 'task'").get() as {
        c: number;
      }
    ).c;
    if (taskBoardCount >= this.#maxBoards) {
      throw new BoardCapacityReachedError(this.#maxBoards);
    }

    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO boards (board_id, kind, title, project_id, task_id, created_at, updated_at, message_count)
           VALUES (?, 'task', ?, ?, ?, ?, ?, 0)`,
        )
        .run(boardId, `Discussion: ${record.task.title}`, record.task.projectId, taskId, now, now);
    });

    return { board: this.get(boardId), created: true };
  }

  recordMessageAppended(boardId: string, messageCount: number, now: string): void {
    withTransaction(this.#db, () => {
      const update = this.#db
        .prepare("UPDATE boards SET message_count = ?, updated_at = ? WHERE board_id = ?")
        .run(messageCount, now, boardId);
      if (update.changes === 0) throw new BoardNotFoundError(boardId);
    });
  }

  #getRow(boardId: string): BoardRow | undefined {
    return this.#db.prepare("SELECT * FROM boards WHERE board_id = ?").get(boardId) as
      BoardRow | undefined;
  }
}
