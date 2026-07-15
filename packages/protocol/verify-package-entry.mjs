// Proves the *built* package can be consumed the same way an external
// package would consume it: by importing the package name and resolving
// through its `exports` map, never by reaching into `src` or `dist`
// directly. Must be run after `pnpm build` (it imports compiled output).
//
// Deliberately outside `src/`, `tsconfig.json`, and ESLint's type-aware
// project: importing "@hall-of-wisdom/protocol" here resolves to
// dist/index.d.ts via Node/TS package self-reference, which does not
// exist on a clean checkout before the first build. Keeping this file
// out of tsconfig.json's "include" means a clean-checkout `pnpm typecheck`
// never depends on `dist` already existing.
import assert from "node:assert/strict";

const protocol = await import("@hall-of-wisdom/protocol");

assert.equal(protocol.PROTOCOL_VERSION, "0.1", "PROTOCOL_VERSION should be exported and equal 0.1");

assert.equal(typeof protocol.parseHallTask, "function", "parseHallTask should be exported");
assert.equal(
  typeof protocol.parseNormalizedAgentEvent,
  "function",
  "parseNormalizedAgentEvent should be exported",
);
assert.equal(
  typeof protocol.parseRunCancelledEvent,
  "function",
  "parseRunCancelledEvent should be exported",
);

const validTask = protocol.parseHallTask({
  taskId: "task-1",
  projectId: "project-1",
  title: "Add login page",
  description: "Implement the login page per the design spec.",
  priority: "normal",
  status: "backlog",
  dependencyTaskIds: [],
  createdAt: "2026-07-15T12:00:00.000Z",
  updatedAt: "2026-07-15T12:00:00.000Z",
});
assert.equal(
  validTask.taskId,
  "task-1",
  "parseHallTask should parse a valid task via the public entry point",
);

const cancelledEvent = protocol.parseRunCancelledEvent({
  protocolVersion: protocol.PROTOCOL_VERSION,
  eventId: "event-1",
  runId: "run-1",
  taskId: "task-1",
  agentId: "agent-1",
  timestamp: "2026-07-15T12:00:00.000Z",
  sequence: 0,
  type: "run.cancelled",
  payload: { cancelledBy: "user" },
});
assert.equal(
  cancelledEvent.payload.cancelledBy,
  "user",
  "run.cancelled should round-trip via the public entry point",
);

assert.throws(
  () => protocol.parseHallTask({ taskId: "task-1" }),
  protocol.ProtocolValidationError,
  "invalid input should raise ProtocolValidationError through the public entry point",
);

console.log(
  "OK: @hall-of-wisdom/protocol resolves and behaves correctly through its public entry point.",
);
