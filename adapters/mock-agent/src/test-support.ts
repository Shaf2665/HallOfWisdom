import type { AgentTaskInput } from "@hall-of-wisdom/agent-adapter-sdk";

/** Shared fixture builder for tests only — excluded from the build output. */
export function createTaskInput(overrides: Partial<AgentTaskInput> = {}): AgentTaskInput {
  return {
    hallTask: {
      taskId: "task-1",
      projectId: "project-1",
      title: "Add login page",
      description: "Implement the login page per the design spec.",
      priority: "normal",
      status: "assigned",
      dependencyTaskIds: [],
      createdAt: "2026-07-15T12:00:00.000Z",
      updatedAt: "2026-07-15T12:00:00.000Z",
    },
    agentIdentity: {
      agentId: "mock-agent",
      displayName: "Mock Agent",
      adapterId: "hall.mock-agent",
      adapterVersion: "0.1.0",
    },
    runId: "run-1",
    workingDirectory: "C:\\Projects\\hall-of-wisdom\\worktrees\\task-1",
    ...overrides,
  };
}

export async function collectEvents<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}
