import type { CommunicationAuthor, CommunicationMessage } from "@hall-of-wisdom/protocol";
import {
  BoardNotFoundError,
  MessageBoardIdentityMismatchError,
  MessageCapacityReachedError,
} from "../errors/app-error.js";

export interface MessageStoreOptions {
  readonly maxMessagesPerBoard: number;
}

export interface AppendMessageInput {
  readonly messageId: string;
  /** Must equal the `boardId` this is appended to — see `append()`'s doc comment. */
  readonly boardId: string;
  readonly author: CommunicationAuthor;
  readonly text: string;
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
export class MessageStore {
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
}
