import type { MessageAttachment } from "@hall-of-wisdom/protocol";
import { parseMessageAttachment } from "@hall-of-wisdom/protocol";
import { AttachmentAlreadyLinkedError, AttachmentNotFoundError } from "../errors/app-error.js";
import type { HallDatabase } from "../persistence/database.js";
import { withTransaction } from "../persistence/transaction.js";
import { CorruptRecordError } from "../persistence/persistence-errors.js";
import type {
  AttachmentStorePort,
  CreatePendingAttachmentInput,
} from "./attachment-store-port.js";

export interface SqliteAttachmentStoreOptions {
  readonly db: HallDatabase;
}

interface AttachmentRow {
  attachment_id: string;
  board_id: string;
  message_id: string | null;
  filename: string;
  mime_type: string;
  byte_size: number;
  kind: string;
  created_at: string;
}

function rowToAttachment(row: AttachmentRow): MessageAttachment {
  try {
    return parseMessageAttachment({
      attachmentId: row.attachment_id,
      filename: row.filename,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      kind: row.kind,
    });
  } catch (error) {
    throw new CorruptRecordError(
      "attachments",
      row.attachment_id,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** SQLite-backed durable sibling of `AttachmentStore` — implements the identical `AttachmentStorePort` contract. */
export class SqliteAttachmentStore implements AttachmentStorePort {
  readonly #db: HallDatabase;

  constructor(options: SqliteAttachmentStoreOptions) {
    this.#db = options.db;
  }

  createPending(input: CreatePendingAttachmentInput): void {
    this.#db
      .prepare(
        `INSERT INTO attachments (
           attachment_id, board_id, message_id, filename, mime_type, byte_size, kind, created_at
         ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.attachmentId,
        input.boardId,
        input.filename,
        input.mimeType,
        input.byteSize,
        input.kind,
        input.createdAt,
      );
  }

  resolvePending(boardId: string, attachmentIds: readonly string[]): readonly MessageAttachment[] {
    const resolved: MessageAttachment[] = [];
    for (const attachmentId of attachmentIds) {
      const row = this.#db
        .prepare("SELECT * FROM attachments WHERE attachment_id = ?")
        .get(attachmentId) as AttachmentRow | undefined;
      if (row?.board_id !== boardId) {
        throw new AttachmentNotFoundError(attachmentId);
      }
      if (row.message_id !== null) {
        throw new AttachmentAlreadyLinkedError(attachmentId);
      }
      resolved.push(rowToAttachment(row));
    }
    return resolved;
  }

  link(boardId: string, attachmentIds: readonly string[], messageId: string): void {
    withTransaction(this.#db, () => {
      for (const attachmentId of attachmentIds) {
        const row = this.#db
          .prepare("SELECT board_id FROM attachments WHERE attachment_id = ?")
          .get(attachmentId) as { board_id: string } | undefined;
        if (row?.board_id !== boardId) {
          throw new AttachmentNotFoundError(attachmentId);
        }
        this.#db
          .prepare("UPDATE attachments SET message_id = ? WHERE attachment_id = ?")
          .run(messageId, attachmentId);
      }
    });
  }

  getLinked(boardId: string, attachmentId: string): MessageAttachment | undefined {
    const row = this.#db
      .prepare("SELECT * FROM attachments WHERE attachment_id = ?")
      .get(attachmentId) as AttachmentRow | undefined;
    if (row?.board_id !== boardId || row.message_id === null) return undefined;
    return rowToAttachment(row);
  }

  sweepExpiredPending(cutoffIso: string): readonly string[] {
    return withTransaction(this.#db, () => {
      const rows = this.#db
        .prepare("SELECT attachment_id FROM attachments WHERE message_id IS NULL AND created_at < ?")
        .all(cutoffIso) as { attachment_id: string }[];
      const attachmentIds = rows.map((row) => row.attachment_id);
      if (attachmentIds.length > 0) {
        const placeholders = attachmentIds.map(() => "?").join(", ");
        this.#db
          .prepare(`DELETE FROM attachments WHERE attachment_id IN (${placeholders})`)
          .run(...attachmentIds);
      }
      return attachmentIds;
    });
  }
}
