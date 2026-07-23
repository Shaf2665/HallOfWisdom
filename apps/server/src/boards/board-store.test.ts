import { describe, expect, it } from "vitest";
import type { HallTask } from "@hall-of-wisdom/protocol";
import { TaskStore } from "../tasks/task-store.js";
import type { TaskRecord } from "../tasks/task-record.js";
import { BoardCapacityReachedError, TaskNotFoundError } from "../errors/app-error.js";
import { BoardStore, GENERAL_BOARD_ID, taskBoardId } from "./board-store.js";

function makeTask(taskId: string, overrides: Partial<HallTask> = {}): HallTask {
  return {
    taskId,
    projectId: "project-1",
    title: "Add login page",
    description: "",
    priority: "normal",
    status: "backlog",
    dependencyTaskIds: [],
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

function makeRecord(
  taskId: string,
  overrides: Partial<Omit<TaskRecord, "task">> & { readonly task?: Partial<HallTask> } = {},
): TaskRecord {
  const { task: taskOverrides, ...restOverrides } = overrides;
  return {
    task: makeTask(taskId, taskOverrides),
    runId: undefined,
    adapterId: undefined,
    agentId: undefined,
    eventCount: 0,
    lastSequence: undefined,
    terminalEventType: undefined,
    failure: undefined,
    cancellationRequested: false,
    createdAt: "2026-07-15T12:00:00.000Z",
    startedAt: undefined,
    completedAt: undefined,
    assignedExecutionTrust: undefined,
    ...restOverrides,
  };
}

function newHarness(maxBoards = 500): { taskStore: TaskStore; boardStore: BoardStore } {
  const taskStore = new TaskStore({ maxTasks: 500 });
  const boardStore = new BoardStore({ maxBoards, taskStore });
  return { taskStore, boardStore };
}

describe("BoardStore", () => {
  it("seeds the one General board", () => {
    const { boardStore } = newHarness();
    const board = boardStore.seedGeneralBoard("2026-07-15T12:00:00.000Z");
    expect(board.boardId).toBe(GENERAL_BOARD_ID);
    expect(board.kind).toBe("general");
    expect(boardStore.get(GENERAL_BOARD_ID).boardId).toBe(GENERAL_BOARD_ID);
  });

  it("seeds an independent General board per store instance (no shared module-level state)", () => {
    const a = newHarness().boardStore;
    const b = newHarness().boardStore;
    a.seedGeneralBoard("2026-07-15T12:00:00.000Z");
    b.seedGeneralBoard("2026-07-15T12:00:00.000Z");
    expect(() => a.get(GENERAL_BOARD_ID)).not.toThrow();
    expect(() => b.get(GENERAL_BOARD_ID)).not.toThrow();
    // Mutating one instance's board must never affect the other's.
    a.recordMessageAppended(GENERAL_BOARD_ID, 5, "2026-07-15T12:05:00.000Z");
    expect(a.get(GENERAL_BOARD_ID).messageCount).toBe(5);
    expect(b.get(GENERAL_BOARD_ID).messageCount).toBe(0);
  });

  it("creates a task board for an existing task", () => {
    const { taskStore, boardStore } = newHarness();
    taskStore.add(makeRecord("task-1"));
    const { board, created } = boardStore.ensureTaskBoard("task-1", "2026-07-15T12:00:00.000Z");
    expect(created).toBe(true);
    expect(board.kind).toBe("task");
    expect(board.boardId).toBe(taskBoardId("task-1"));
    if (board.kind === "task") {
      expect(board.taskId).toBe("task-1");
      expect(board.projectId).toBe("project-1");
    }
  });

  it("a repeated ensure returns the exact same board, unchanged", () => {
    const { taskStore, boardStore } = newHarness();
    taskStore.add(makeRecord("task-1"));
    const first = boardStore.ensureTaskBoard("task-1", "2026-07-15T12:00:00.000Z");
    const second = boardStore.ensureTaskBoard("task-1", "2026-07-15T12:30:00.000Z");
    expect(second.created).toBe(false);
    expect(second.board.boardId).toBe(first.board.boardId);
    expect(second.board.updatedAt).toBe(first.board.updatedAt);
  });

  it("concurrent-looking ensure calls for the same task create exactly one board", () => {
    const { taskStore, boardStore } = newHarness();
    taskStore.add(makeRecord("task-1"));
    // ensureTaskBoard performs no I/O and awaits nothing, so calling it
    // back-to-back is representative of two requests racing to create the
    // same task's discussion board.
    const first = boardStore.ensureTaskBoard("task-1", "2026-07-15T12:00:00.000Z");
    const second = boardStore.ensureTaskBoard("task-1", "2026-07-15T12:00:00.000Z");
    expect(first.board.boardId).toBe(second.board.boardId);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(boardStore.list().filter((board) => board.kind === "task")).toHaveLength(1);
  });

  it("rejects creating a board for an unknown task", () => {
    const { boardStore } = newHarness();
    expect(() => boardStore.ensureTaskBoard("nonexistent", "2026-07-15T12:00:00.000Z")).toThrow(
      TaskNotFoundError,
    );
  });

  it("enforces the configured board capacity", () => {
    const { taskStore, boardStore } = newHarness(1);
    taskStore.add(makeRecord("task-1"));
    taskStore.add(makeRecord("task-2"));
    boardStore.ensureTaskBoard("task-1", "2026-07-15T12:00:00.000Z");
    expect(() => boardStore.ensureTaskBoard("task-2", "2026-07-15T12:00:00.000Z")).toThrow(
      BoardCapacityReachedError,
    );
  });

  it("the General board does not count against the board capacity", () => {
    const { taskStore, boardStore } = newHarness(1);
    boardStore.seedGeneralBoard("2026-07-15T12:00:00.000Z");
    taskStore.add(makeRecord("task-1"));
    expect(() => boardStore.ensureTaskBoard("task-1", "2026-07-15T12:00:00.000Z")).not.toThrow();
  });

  it("board creation does not change the task's status", () => {
    const { taskStore, boardStore } = newHarness();
    taskStore.add(makeRecord("task-1", { task: { status: "completed" } }));
    boardStore.ensureTaskBoard("task-1", "2026-07-15T12:00:00.000Z");
    expect(taskStore.get("task-1").task.status).toBe("completed");
  });

  it("board creation does not create a run", () => {
    const { taskStore, boardStore } = newHarness();
    taskStore.add(makeRecord("task-1"));
    boardStore.ensureTaskBoard("task-1", "2026-07-15T12:00:00.000Z");
    expect(taskStore.get("task-1").runId).toBeUndefined();
  });

  it("a discussion may be created for a terminal task", () => {
    const { taskStore, boardStore } = newHarness();
    taskStore.add(makeRecord("task-1", { task: { status: "cancelled" } }));
    const { board } = boardStore.ensureTaskBoard("task-1", "2026-07-15T12:00:00.000Z");
    expect(board.kind).toBe("task");
  });

  it("lists General first, then task boards ordered by most-recently-updated, boardId as tie-breaker", () => {
    const { taskStore, boardStore } = newHarness();
    boardStore.seedGeneralBoard("2026-07-15T11:00:00.000Z");
    taskStore.add(makeRecord("task-a"));
    taskStore.add(makeRecord("task-b"));
    taskStore.add(makeRecord("task-c"));
    boardStore.ensureTaskBoard("task-a", "2026-07-15T12:00:00.000Z");
    boardStore.ensureTaskBoard("task-b", "2026-07-15T13:00:00.000Z");
    boardStore.ensureTaskBoard("task-c", "2026-07-15T13:00:00.000Z");
    const order = boardStore.list().map((board) => board.boardId);
    expect(order[0]).toBe(GENERAL_BOARD_ID);
    // task-b and task-c share updatedAt "13:00" — boardId break the tie ascending.
    expect(order.slice(1)).toEqual(
      [taskBoardId("task-b"), taskBoardId("task-c"), taskBoardId("task-a")].sort((a, b) => {
        const updatedAtRank: Record<string, string> = {
          [taskBoardId("task-a")]: "12",
          [taskBoardId("task-b")]: "13",
          [taskBoardId("task-c")]: "13",
        };
        if (updatedAtRank[a] !== updatedAtRank[b]) {
          return (updatedAtRank[b] ?? "") > (updatedAtRank[a] ?? "") ? 1 : -1;
        }
        return a < b ? -1 : 1;
      }),
    );
  });

  it("returns defensive copies from get/list/ensureTaskBoard", () => {
    const { taskStore, boardStore } = newHarness();
    taskStore.add(makeRecord("task-1"));
    const { board } = boardStore.ensureTaskBoard("task-1", "2026-07-15T12:00:00.000Z");
    const mutable = board as { title: string };
    mutable.title = "tampered";
    expect(boardStore.get(board.boardId).title).not.toBe("tampered");
  });

  it("a task board snapshot never contains an absolute filesystem path", () => {
    const { taskStore, boardStore } = newHarness();
    taskStore.add(makeRecord("task-1"));
    const { board } = boardStore.ensureTaskBoard("task-1", "2026-07-15T12:00:00.000Z");
    const serialized = JSON.stringify(board);
    expect(serialized).not.toMatch(/[A-Za-z]:\\/);
    expect(serialized).not.toContain("/home/");
    expect(serialized).not.toContain("workingDirectory");
  });

  it("a task board snapshot never contains an internal task revision field", () => {
    const { taskStore, boardStore } = newHarness();
    taskStore.add(makeRecord("task-1"));
    const { board } = boardStore.ensureTaskBoard("task-1", "2026-07-15T12:00:00.000Z");
    expect(Object.keys(board)).not.toContain("revision");
    expect(JSON.stringify(board).toLowerCase()).not.toContain("revision");
  });

  it("recordMessageAppended updates messageCount and updatedAt only", () => {
    const { boardStore } = newHarness();
    const seeded = boardStore.seedGeneralBoard("2026-07-15T12:00:00.000Z");
    boardStore.recordMessageAppended(GENERAL_BOARD_ID, 3, "2026-07-15T12:05:00.000Z");
    const updated = boardStore.get(GENERAL_BOARD_ID);
    expect(updated.messageCount).toBe(3);
    expect(updated.updatedAt).toBe("2026-07-15T12:05:00.000Z");
    expect(updated.title).toBe(seeded.title);
    expect(updated.createdAt).toBe(seeded.createdAt);
  });
});
