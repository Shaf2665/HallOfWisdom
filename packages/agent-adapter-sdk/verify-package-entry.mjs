// Proves the *built* package can be consumed the same way an external
// package would consume it: by importing the package name and resolving
// through its `exports` map, never by reaching into `src`. Must be run
// after `pnpm build`. See packages/protocol/verify-package-entry.mjs for
// why this file is kept outside tsconfig.json's "include" and outside
// ESLint's type-aware project.
import assert from "node:assert/strict";

const sdk = await import("@hall-of-wisdom/agent-adapter-sdk");

assert.equal(typeof sdk.parseAgentAdapterDescriptor, "function");
assert.equal(typeof sdk.parseAgentTaskInput, "function");
assert.equal(typeof sdk.EventFactory, "function");
assert.equal(typeof sdk.TerminalEventGuard, "function");
assert.equal(typeof sdk.EventAfterTerminationError, "function");

const factory = new sdk.EventFactory({ runId: "run-1", taskId: "task-1", agentId: "agent-1" });
const started = factory.runStarted();
assert.equal(started.type, "run.started");
assert.equal(started.sequence, 0);

const guard = new sdk.TerminalEventGuard();
const completed = factory.runCompleted();
guard.guardEvent(completed);
assert.throws(() => {
  guard.guardEvent(factory.messageDelta("too late"));
}, sdk.EventAfterTerminationError);

console.log(
  "OK: @hall-of-wisdom/agent-adapter-sdk resolves and behaves correctly through its public entry point.",
);
