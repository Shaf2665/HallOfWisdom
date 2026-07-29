import { describe, expect, it } from "vitest";
import { BoardCapacityReachedError, BoardNotFoundError } from "../errors/app-error.js";
import type { TaskStorePort } from "../tasks/task-store-port.js";
import { GENERAL_BOARD_ID, taskBoardId } from "./board-store.js";
import type { BoardStorePort } from "./board-store-port.js";

const NOW = "2026-01-01T00:00:00.000Z";

/**
 * Behavioral contract every `BoardStorePort` implementation must satisfy —
 * run once against the in-memory `BoardStore` and once against
 * `SqliteBoardStore` (Phase 13's durable-mode sibling).
 */
export function defineBoardStoreContractTests(
  label: string,
  createStore: (taskStore: TaskStorePort, maxBoards?: number) => BoardStorePort,
  createTaskStore: () => TaskStorePort,
  addTask: (taskStore: TaskStorePort, taskId: string) => void,
): void {
  describe(`BoardStorePort contract (${label})`, () => {
    it("seedGeneralBoard creates the one General board with a stable id", () => {
      const taskStore = createTaskStore();
      const store = createStore(taskStore);
      const board = store.seedGeneralBoard(NOW);
      expect(board.boardId).toBe(GENERAL_BOARD_ID);
      expect(board.kind).toBe("general");
      expect(store.get(GENERAL_BOARD_ID).boardId).toBe(GENERAL_BOARD_ID);
    });

    it("ensureTaskBoard is idempotent — a second call returns the same board with created: false", () => {
      const taskStore = createTaskStore();
      addTask(taskStore, "task-1");
      const store = createStore(taskStore);
      const first = store.ensureTaskBoard("task-1", NOW);
      const second = store.ensureTaskBoard("task-1", NOW);
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(first.board.boardId).toBe(second.board.boardId);
      expect(first.board.boardId).toBe(taskBoardId("task-1"));
    });

    it("ensureTaskBoard throws for an unknown task without creating an orphaned board", () => {
      const taskStore = createTaskStore();
      const store = createStore(taskStore);
      expect(() => store.ensureTaskBoard("does-not-exist", NOW)).toThrow();
      expect(store.has(taskBoardId("does-not-exist"))).toBe(false);
    });

    it("task board capacity is enforced, excluding the General board", () => {
      const taskStore = createTaskStore();
      addTask(taskStore, "task-1");
      addTask(taskStore, "task-2");
      const store = createStore(taskStore, 1);
      store.seedGeneralBoard(NOW);
      store.ensureTaskBoard("task-1", NOW);
      expect(() => store.ensureTaskBoard("task-2", NOW)).toThrow(BoardCapacityReachedError);
    });

    it("list() orders the General board first, then task boards by most-recently-updated", () => {
      const taskStore = createTaskStore();
      addTask(taskStore, "task-1");
      addTask(taskStore, "task-2");
      const store = createStore(taskStore);
      store.seedGeneralBoard(NOW);
      store.ensureTaskBoard("task-1", "2026-01-01T00:00:01.000Z");
      store.ensureTaskBoard("task-2", "2026-01-01T00:00:02.000Z");
      const boards = store.list();
      expect(boards[0]?.boardId).toBe(GENERAL_BOARD_ID);
      expect(boards[1]?.boardId).toBe(taskBoardId("task-2"));
      expect(boards[2]?.boardId).toBe(taskBoardId("task-1"));
    });

    it("recordMessageAppended updates messageCount/updatedAt and throws for an unknown board", () => {
      const taskStore = createTaskStore();
      const store = createStore(taskStore);
      const board = store.seedGeneralBoard(NOW);
      store.recordMessageAppended(board.boardId, 3, "2026-01-01T00:00:05.000Z");
      const updated = store.get(board.boardId);
      expect(updated.messageCount).toBe(3);
      expect(updated.updatedAt).toBe("2026-01-01T00:00:05.000Z");
      expect(() => {
        store.recordMessageAppended("does-not-exist", 1, NOW);
      }).toThrow(BoardNotFoundError);
    });

    it("get() throws BoardNotFoundError for an unknown board", () => {
      const taskStore = createTaskStore();
      const store = createStore(taskStore);
      expect(() => store.get("does-not-exist")).toThrow(BoardNotFoundError);
    });
  });
}
