import type {
  CommunicationAuthor,
  CommunicationMessage,
  CommunicationMessageReference,
} from "@hall-of-wisdom/protocol";
import {
  BoardNotFoundError,
  MessageBoardIdentityMismatchError,
  MessageCapacityReachedError,
} from "../errors/app-error.js";
import type { MessageStorePort } from "./message-store-port.js";

export interface MessageStoreOptions {
  readonly maxMessagesPerBoard: number;
}

/** Opaque to every caller except `MessageStore` itself — see `snapshot()`'s doc comment. */
export interface MessageStoreSnapshot {
  readonly _brand: "MessageStoreSnapshot";
  readonly messagesByBoardId: ReadonlyMap<string, CommunicationMessage[]>;
}

export interface AppendMessageInput {
  readonly messageId: string;
  /** Must equal the `boardId` this is appended to — see `append()`'s doc comment. */
  readonly boardId: string;
  readonly author: CommunicationAuthor;
  readonly text: string;
  readonly reference?: CommunicationMessageReference;
  readonly createdAt: string;
}

/**
 * In-memory, per-board, sequence-ordered message log. Deliberately much
 * simpler than `EventStore`: a communication message's `sequence` is always
 * *assigned by this store itself* (the next slot, i.e. current length),
 * never supplied by a caller — there is no incoming sequence to validate,
 * so there is no duplicate/conflict/gap policy and no terminal-slot
 * reservation to reason about. The only invariants this store enforces are
 * "the target board is known", "the board has not reached its message
 * capacity", and "the caller's own `boardId` matches the board being
 * appended to" (defense-in-depth, mirroring `EventStore.append()`'s
 * `ExpectedEventIdentity` check).
 */
export class MessageStore implements MessageStorePort {
  readonly #messagesByBoardId = new Map<string, CommunicationMessage[]>();
  readonly #maxMessagesPerBoard: number;

  constructor(options: MessageStoreOptions) {
    this.#maxMessagesPerBoard = options.maxMessagesPerBoard;
  }

  /** Registers `boardId` as a valid append/list target with an empty message log. Idempotent — safe to call more than once for the same board. */
  registerBoard(boardId: string): void {
    if (!this.#messagesByBoardId.has(boardId)) {
      this.#messagesByBoardId.set(boardId, []);
    }
  }

  /**
   * Appends one message to `boardId`, assigning its `sequence` as the
   * board's current message count. No `await` appears anywhere between
   * reading that count and pushing the new message onto the array — the
   * entire operation is one synchronous, atomic step, so two "concurrent"
   * POST requests handled within the same synchronous tick (this store
   * never performs any I/O, so a route calling it never needs to `await`
   * before or after this call) can never observe or be assigned the same
   * sequence number.
   */
  append(boardId: string, input: AppendMessageInput): CommunicationMessage {
    if (input.boardId !== boardId) {
      throw new MessageBoardIdentityMismatchError(boardId, input.boardId);
    }
    const messages = this.#messagesByBoardId.get(boardId);
    if (!messages) {
      throw new BoardNotFoundError(boardId);
    }
    if (messages.length >= this.#maxMessagesPerBoard) {
      throw new MessageCapacityReachedError(boardId, this.#maxMessagesPerBoard);
    }

    const message: CommunicationMessage = {
      messageId: input.messageId,
      boardId,
      sequence: messages.length,
      author: input.author,
      text: input.text,
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      createdAt: input.createdAt,
    };
    messages.push(message);
    return structuredClone(message);
  }

  list(boardId: string, afterSequence?: number): CommunicationMessage[] {
    const messages = this.#messagesByBoardId.get(boardId);
    if (!messages) {
      throw new BoardNotFoundError(boardId);
    }
    const filtered =
      afterSequence === undefined
        ? messages
        : messages.filter((message) => message.sequence > afterSequence);
    return filtered.map((message) => structuredClone(message));
  }

  /** The sequence number the next appended message for this board must use — equivalently, how many messages are already stored. */
  nextSequence(boardId: string): number {
    const messages = this.#messagesByBoardId.get(boardId);
    if (!messages) {
      throw new BoardNotFoundError(boardId);
    }
    return messages.length;
  }

  /**
   * Phase 14.1 — the ephemeral-mode analogue of `withTransaction`'s
   * durable-mode SAVEPOINT (see `TaskStore.snapshot()`'s doc comment for
   * the full rationale). Unlike `TaskStore`/`BoardStore`, a per-board
   * shallow array copy is sufficient here — no per-message deep clone is
   * needed: `append()` only ever pushes a brand-new, already-immutable
   * `CommunicationMessage` object onto a board's array; no method on this
   * class ever mutates a stored message's own fields after it is pushed.
   */
  snapshot(): MessageStoreSnapshot {
    return {
      _brand: "MessageStoreSnapshot",
      messagesByBoardId: new Map(
        Array.from(this.#messagesByBoardId, ([boardId, messages]) => [boardId, [...messages]]),
      ),
    };
  }

  /** Replaces this store's entire state with `snapshot`'s — see `TaskStore.restore()`'s doc comment. */
  restore(snapshot: MessageStoreSnapshot): void {
    this.#messagesByBoardId.clear();
    for (const [boardId, messages] of snapshot.messagesByBoardId) {
      this.#messagesByBoardId.set(boardId, messages);
    }
  }
}
