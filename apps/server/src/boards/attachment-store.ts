import type { MessageAttachment } from "@hall-of-wisdom/protocol";
import { AttachmentAlreadyLinkedError, AttachmentNotFoundError } from "../errors/app-error.js";
import type {
  AttachmentStorePort,
  CreatePendingAttachmentInput,
} from "./attachment-store-port.js";

interface AttachmentRecord {
  readonly boardId: string;
  readonly metadata: MessageAttachment;
  messageId: string | null;
  readonly createdAt: string;
}

/**
 * In-memory `AttachmentStorePort` — the ephemeral-mode sibling of
 * `SqliteAttachmentStore`. Keyed directly by `attachmentId` (already a
 * globally unique `randomUUID()`), rather than nested per-board, since
 * every lookup already carries its own `boardId` to cross-check against.
 */
export class AttachmentStore implements AttachmentStorePort {
  readonly #attachmentsById = new Map<string, AttachmentRecord>();

  createPending(input: CreatePendingAttachmentInput): void {
    this.#attachmentsById.set(input.attachmentId, {
      boardId: input.boardId,
      metadata: {
        attachmentId: input.attachmentId,
        filename: input.filename,
        mimeType: input.mimeType,
        byteSize: input.byteSize,
        kind: input.kind,
      },
      messageId: null,
      createdAt: input.createdAt,
    });
  }

  resolvePending(boardId: string, attachmentIds: readonly string[]): readonly MessageAttachment[] {
    const resolved: MessageAttachment[] = [];
    for (const attachmentId of attachmentIds) {
      const record = this.#attachmentsById.get(attachmentId);
      if (record?.boardId !== boardId) {
        throw new AttachmentNotFoundError(attachmentId);
      }
      if (record.messageId !== null) {
        throw new AttachmentAlreadyLinkedError(attachmentId);
      }
      resolved.push(structuredClone(record.metadata));
    }
    return resolved;
  }

  link(boardId: string, attachmentIds: readonly string[], messageId: string): void {
    for (const attachmentId of attachmentIds) {
      const record = this.#attachmentsById.get(attachmentId);
      if (record?.boardId !== boardId) {
        throw new AttachmentNotFoundError(attachmentId);
      }
      record.messageId = messageId;
    }
  }

  getLinked(boardId: string, attachmentId: string): MessageAttachment | undefined {
    const record = this.#attachmentsById.get(attachmentId);
    if (record?.boardId !== boardId || record.messageId === null) return undefined;
    return structuredClone(record.metadata);
  }

  sweepExpiredPending(cutoffIso: string): readonly string[] {
    const swept: string[] = [];
    for (const [attachmentId, record] of this.#attachmentsById) {
      if (record.messageId === null && record.createdAt < cutoffIso) {
        swept.push(attachmentId);
        this.#attachmentsById.delete(attachmentId);
      }
    }
    return swept;
  }
}
