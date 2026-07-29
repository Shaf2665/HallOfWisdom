import type { CommunicationMessage } from "@hall-of-wisdom/protocol";
import type { AppendMessageInput } from "./message-store.js";

/**
 * Extracted, unchanged, from `MessageStore`'s own existing public method
 * signatures (Phase 13). `SqliteMessageStore` is the durable-mode sibling.
 */
export interface MessageStorePort {
  registerBoard(boardId: string): void;
  append(boardId: string, input: AppendMessageInput): CommunicationMessage;
  list(boardId: string, afterSequence?: number): CommunicationMessage[];
  nextSequence(boardId: string): number;
}
