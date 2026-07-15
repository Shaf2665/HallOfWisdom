// Proves the *built* package can be consumed the same way an external
// package would consume it: by importing the package name and resolving
// through its `exports` map, never by reaching into `src`. Must be run
// after `pnpm build`. See packages/protocol/verify-package-entry.mjs for
// why this file is kept outside tsconfig.json's "include" and outside
// ESLint's type-aware project.
import assert from "node:assert/strict";

const hallRunner = await import("@hall-of-wisdom/hall-runner");

assert.equal(typeof hallRunner.AgentRegistry, "function");
assert.equal(typeof hallRunner.runTask, "function");
assert.equal(typeof hallRunner.validateWorkspace, "function");
assert.equal(typeof hallRunner.isContainedPath, "function");
assert.equal(typeof hallRunner.installSignalCancellation, "function");
assert.equal(hallRunner.EXIT_CODES.completed, 0);
assert.equal(hallRunner.EXIT_CODES.cancelled, 130);

const registry = new hallRunner.AgentRegistry();
assert.deepEqual(registry.listDescriptors(), []);

console.log(
  "OK: @hall-of-wisdom/hall-runner resolves and behaves correctly through its public entry point.",
);
