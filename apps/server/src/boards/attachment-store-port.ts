import type { AttachmentKind, MessageAttachment } from "@hall-of-wisdom/protocol";

export interface CreatePendingAttachmentInput {
  readonly attachmentId: string;
  readonly boardId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly kind: AttachmentKind;
  readonly createdAt: string;
}

/**
 * Owns attachment *metadata* and its pending→linked lifecycle — never the
 * bytes themselves (see `AttachmentBlobStore`, a single, non-dual-implementation
 * class, since only its root directory ever varies between durable and
 * ephemeral mode). Mirrors `MessageStorePort`'s dual-implementation shape:
 * an in-memory `AttachmentStore` and a durable `SqliteAttachmentStore`,
 * selected exactly like `MessageStore`/`SqliteMessageStore` by `db !== undefined`.
 *
 * Deliberately does NOT itself verify board existence — every route calling
 * this port already checked `boardStore.has(boardId)` first (the same
 * discipline `boards.ts`'s existing routes already follow), so this store's
 * only job is scoping every lookup by the caller-supplied `boardId` as a
 * defense-in-depth cross-board guard, the same role `MessageBoardIdentityMismatchError`
 * plays for `MessageStore.append()`.
 */
export interface AttachmentStorePort {
  /** Records a newly uploaded, not-yet-linked attachment. */
  createPending(input: CreatePendingAttachmentInput): void;

  /**
   * Resolves each id to its canonical, server-stored metadata for `boardId`,
   * all-or-nothing (throws on the first problem found, before returning
   * anything) — the route calls this BEFORE `messageStore.append()`, so a
   * bad id means nothing is ever stored. Throws `AttachmentNotFoundError`
   * for an id that doesn't exist or belongs to a different board (the two
   * cases are deliberately indistinguishable to the caller), and
   * `AttachmentAlreadyLinkedError` for an id already attached to a
   * different message.
   */
  resolvePending(boardId: string, attachmentIds: readonly string[]): readonly MessageAttachment[];

  /**
   * Transitions each id from pending to linked, associating it with
   * `messageId` — called only after `messageStore.append()` has already
   * durably stored the message carrying this exact resolved metadata (see
   * `routes/boards.ts`'s message-creation handler for the required order).
   */
  link(boardId: string, attachmentIds: readonly string[], messageId: string): void;

  /**
   * Returns metadata only when `attachmentId` is linked to a message on
   * `boardId` — `undefined` for unknown, still-pending, or wrong-board ids,
   * collapsing all three into one outcome so `GET .../attachments/:id`
   * always responds identically (404) regardless of which case applies.
   */
  getLinked(boardId: string, attachmentId: string): MessageAttachment | undefined;

  /**
   * Deletes every still-pending (never linked) attachment row created
   * before `cutoffIso`, returning the swept ids so the caller can also
   * remove their blobs. Covers both an abandoned upload and a failed
   * message-creation request — see
   * `docs/architecture/0020-communication-board-attachments.md`.
   */
  sweepExpiredPending(cutoffIso: string): readonly string[];
}
