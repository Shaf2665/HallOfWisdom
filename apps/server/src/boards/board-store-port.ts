import type { CommunicationBoard } from "@hall-of-wisdom/protocol";

export interface EnsureTaskBoardResult {
  readonly board: CommunicationBoard;
  /** `true` only when this call actually created the board; `false` when an existing board was returned unchanged. */
  readonly created: boolean;
}

/**
 * Extracted, unchanged, from `BoardStore`'s own existing public method
 * signatures (Phase 13). `SqliteBoardStore` is the durable-mode sibling.
 */
export interface BoardStorePort {
  seedGeneralBoard(now: string): CommunicationBoard;
  get(boardId: string): CommunicationBoard;
  has(boardId: string): boolean;
  list(): CommunicationBoard[];
  ensureTaskBoard(taskId: string, now: string): EnsureTaskBoardResult;
  recordMessageAppended(boardId: string, messageCount: number, now: string): void;
}
