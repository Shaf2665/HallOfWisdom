import { parseCommunicationMessage, type CommunicationMessage } from "@hall-of-wisdom/protocol";
import {
  BoardNotFoundError,
  MessageBoardIdentityMismatchError,
  MessageCapacityReachedError,
} from "../errors/app-error.js";
import type { HallDatabase } from "../persistence/database.js";
import { withTransaction } from "../persistence/transaction.js";
import { CorruptRecordError } from "../persistence/persistence-errors.js";
import type { AppendMessageInput } from "./message-store.js";
import type { MessageStorePort } from "./message-store-port.js";

export interface SqliteMessageStoreOptions {
  readonly db: HallDatabase;
  readonly maxMessagesPerBoard: number;
}

interface MessageRow {
  message_id: string;
  board_id: string;
  sequence: number;
  author_json: string;
  text: string;
  reference_json: string | null;
  created_at: string;
}

function rowToMessage(row: MessageRow): CommunicationMessage {
  try {
    return parseCommunicationMessage({
      messageId: row.message_id,
      boardId: row.board_id,
      sequence: row.sequence,
      author: JSON.parse(row.author_json) as unknown,
      text: row.text,
      ...(row.reference_json !== null
        ? { reference: JSON.parse(row.reference_json) as unknown }
        : {}),
      createdAt: row.created_at,
    });
  } catch (error) {
    throw new CorruptRecordError(
      "messages",
      row.message_id,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * SQLite-backed durable sibling of `MessageStore` — implements the
 * identical `MessageStorePort` contract. `registerBoard` is a no-op here
 * beyond confirming the referenced `boards` row exists (the in-memory
 * store's own "known board" set is replaced by the `boards` table itself
 * — a message can only ever be appended to a board that is genuinely
 * present in storage, enforced by the `messages.board_id` foreign key as
 * defense in depth on top of the explicit check below).
 */
export class SqliteMessageStore implements MessageStorePort {
  readonly #db: HallDatabase;
  readonly #maxMessagesPerBoard: number;

  constructor(options: SqliteMessageStoreOptions) {
    this.#db = options.db;
    this.#maxMessagesPerBoard = options.maxMessagesPerBoard;
  }

  registerBoard(boardId: string): void {
    const exists = this.#db.prepare("SELECT 1 FROM boards WHERE board_id = ?").get(boardId);
    if (!exists) throw new BoardNotFoundError(boardId);
  }

  append(boardId: string, input: AppendMessageInput): CommunicationMessage {
    if (input.boardId !== boardId) {
      throw new MessageBoardIdentityMismatchError(boardId, input.boardId);
    }
    const boardExists = this.#db.prepare("SELECT 1 FROM boards WHERE board_id = ?").get(boardId);
    if (!boardExists) throw new BoardNotFoundError(boardId);

    return withTransaction(this.#db, () => {
      const sequence = this.#length(boardId);
      if (sequence >= this.#maxMessagesPerBoard) {
        throw new MessageCapacityReachedError(boardId, this.#maxMessagesPerBoard);
      }

      const authorJson = JSON.stringify(input.author);
      const referenceJson = input.reference === undefined ? null : JSON.stringify(input.reference);
      this.#db
        .prepare(
          `INSERT INTO messages (
             message_id, board_id, sequence, author_json, text, reference_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.messageId,
          boardId,
          sequence,
          authorJson,
          input.text,
          referenceJson,
          input.createdAt,
        );

      return rowToMessage({
        message_id: input.messageId,
        board_id: boardId,
        sequence,
        author_json: authorJson,
        text: input.text,
        reference_json: referenceJson,
        created_at: input.createdAt,
      });
    });
  }

  list(boardId: string, afterSequence?: number): CommunicationMessage[] {
    const boardExists = this.#db.prepare("SELECT 1 FROM boards WHERE board_id = ?").get(boardId);
    if (!boardExists) throw new BoardNotFoundError(boardId);

    const rows =
      afterSequence === undefined
        ? (this.#db
            .prepare("SELECT * FROM messages WHERE board_id = ? ORDER BY sequence ASC")
            .all(boardId) as unknown as MessageRow[])
        : (this.#db
            .prepare(
              "SELECT * FROM messages WHERE board_id = ? AND sequence > ? ORDER BY sequence ASC",
            )
            .all(boardId, afterSequence) as unknown as MessageRow[]);
    return rows.map(rowToMessage);
  }

  nextSequence(boardId: string): number {
    const boardExists = this.#db.prepare("SELECT 1 FROM boards WHERE board_id = ?").get(boardId);
    if (!boardExists) throw new BoardNotFoundError(boardId);
    return this.#length(boardId);
  }

  #length(boardId: string): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS c FROM messages WHERE board_id = ?")
      .get(boardId) as { c: number };
    return row.c;
  }
}
