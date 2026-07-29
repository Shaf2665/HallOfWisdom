import { TaskStore } from "../tasks/task-store.js";
import type { TaskStorePort } from "../tasks/task-store-port.js";
import { BoardStore } from "./board-store.js";
import { defineBoardStoreContractTests } from "./board-store-contract.js";

function addTask(taskStore: TaskStorePort, taskId: string): void {
  taskStore.add({
    task: {
      taskId,
      projectId: "project-1",
      title: "Board contract task",
      description: "",
      priority: "normal",
      status: "backlog",
      dependencyTaskIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    runId: undefined,
    adapterId: undefined,
    agentId: undefined,
    eventCount: 0,
    lastSequence: undefined,
    terminalEventType: undefined,
    failure: undefined,
    cancellationRequested: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: undefined,
    completedAt: undefined,
    assignedExecutionTrust: undefined,
  });
}

defineBoardStoreContractTests(
  "in-memory BoardStore",
  (taskStore, maxBoards = 100) => new BoardStore({ maxBoards, taskStore }),
  () => new TaskStore({ maxTasks: 100 }),
  addTask,
);
