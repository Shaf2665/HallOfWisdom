// Proves the *built* package can be consumed the same way an external
// package would consume it: by importing the package name and resolving
// through its `exports` map, never by reaching into `src`. Must be run
// after `pnpm build`. See packages/protocol/verify-package-entry.mjs for
// why this file is kept outside tsconfig.json's "include" and outside
// ESLint's type-aware project.
import assert from "node:assert/strict";

const mockAgent = await import("@hall-of-wisdom/mock-agent");

assert.equal(typeof mockAgent.MockAgentAdapter, "function");
assert.equal(mockAgent.mockAgentDescriptor.adapterId, "hall.mock-agent");

const adapter = new mockAgent.MockAgentAdapter({ scenario: "success", progressMessageCount: 0 });
const detection = await adapter.detect();
assert.equal(detection.installed, true);
assert.equal(detection.availability, "available");

const run = await adapter.startTask({
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
});

const events = [];
for await (const event of run.events) {
  events.push(event);
}

assert.equal(events.at(-1).type, "run.completed");
assert.equal(run.currentState, "completed");

console.log(
  "OK: @hall-of-wisdom/mock-agent resolves and behaves correctly through its public entry point.",
);
