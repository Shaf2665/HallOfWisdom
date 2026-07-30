import { describe, expect, it } from "vitest";
import type { HallTask } from "@hall-of-wisdom/protocol";
import { TaskStore } from "../tasks/task-store.js";
import type { TaskRecord } from "../tasks/task-record.js";
import { BoardStore } from "../boards/board-store.js";
import { MessageStore } from "../boards/message-store.js";
import { InMemoryCeoPlanStore } from "./in-memory-ceo-plan-store.js";
import { createEphemeralAtomicUnit } from "./ephemeral-atomic-unit.js";

function makeTaskRecord(taskId: string, overrides: Partial<HallTask> = {}): TaskRecord {
  return {
    task: {
      taskId,
      projectId: "project-1",
      title: "Test task",
      description: "",
      priority: "normal",
      status: "backlog",
      dependencyTaskIds: [],
      createdAt: "2026-07-15T12:00:00.000Z",
      updatedAt: "2026-07-15T12:00:00.000Z",
      ...overrides,
    },
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
  };
}

function buildStores() {
  const taskStore = new TaskStore({ maxTasks: 100 });
  const boardStore = new BoardStore({ maxBoards: 100, taskStore });
  const messageStore = new MessageStore({ maxMessagesPerBoard: 200 });
  const planStore = new InMemoryCeoPlanStore();
  const runAtomicUnit = createEphemeralAtomicUnit({
    taskStore,
    boardStore,
    messageStore,
    planStore,
  });
  return { taskStore, boardStore, messageStore, planStore, runAtomicUnit };
}

describe("createEphemeralAtomicUnit", () => {
  it("rolls back every store to its pre-call snapshot when fn() throws", () => {
    const { taskStore, runAtomicUnit } = buildStores();

    expect(() =>
      runAtomicUnit(() => {
        taskStore.add(makeTaskRecord("child-1"));
        throw new Error("simulated mid-delegation failure");
      }),
    ).toThrow("simulated mid-delegation failure");

    expect(taskStore.list()).toHaveLength(0);
  });

  it("commits every store's writes when fn() succeeds", () => {
    const { taskStore, runAtomicUnit } = buildStores();

    const result = runAtomicUnit(() => {
      taskStore.add(makeTaskRecord("child-1"));
      return "ok";
    });

    expect(result).toBe("ok");
    expect(taskStore.list()).toHaveLength(1);
  });

  it("a failure after several task writes rolls back all of them, not just the last", () => {
    const { taskStore, runAtomicUnit } = buildStores();

    expect(() =>
      runAtomicUnit(() => {
        taskStore.add(makeTaskRecord("child-1"));
        taskStore.add(makeTaskRecord("child-2"));
        taskStore.add(makeTaskRecord("child-3"));
        throw new Error("failure while linking the final step");
      }),
    ).toThrow();

    expect(taskStore.list()).toHaveLength(0);
  });

  it("rolls back writes across all four stores together, not just the one that threw", () => {
    const { taskStore, boardStore, messageStore, planStore, runAtomicUnit } = buildStores();
    taskStore.add(makeTaskRecord("parent-1"));

    expect(() =>
      runAtomicUnit(() => {
        taskStore.add(makeTaskRecord("child-1"));
        const { board } = boardStore.ensureTaskBoard("parent-1", "2026-07-15T12:00:00.000Z");
        messageStore.registerBoard(board.boardId);
        messageStore.append(board.boardId, {
          messageId: "msg-1",
          boardId: board.boardId,
          author: { kind: "system", displayName: "CEO Agent" },
          text: "step delegated",
          createdAt: "2026-07-15T12:00:00.000Z",
        });
        planStore.createPlan({
          planId: "plan-1",
          parentTaskId: "parent-1",
          createdBy: "ceo_planner",
          createdAt: "2026-07-15T12:00:00.000Z",
          content: {
            objective: "obj",
            summary: "sum",
            assumptions: [],
            constraints: [],
            steps: [],
          },
          contentHash: "a".repeat(64),
        });
        throw new Error("failure while updating plan status");
      }),
    ).toThrow();

    expect(taskStore.list()).toHaveLength(1); // only parent-1, created before the atomic unit
    expect(boardStore.has("task:parent-1")).toBe(false);
    expect(() => planStore.getPlan("plan-1")).toThrow();
  });

  it("a nested runAtomicUnit call's success does not commit early if the outer call later throws", () => {
    const { taskStore, runAtomicUnit } = buildStores();

    expect(() =>
      runAtomicUnit(() => {
        runAtomicUnit(() => {
          taskStore.add(makeTaskRecord("child-1"));
        });
        throw new Error("outer failure after inner success");
      }),
    ).toThrow("outer failure after inner success");

    expect(taskStore.list()).toHaveLength(0);
  });
});
