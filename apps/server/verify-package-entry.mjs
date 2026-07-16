// Proves the *built* package can be consumed the same way an external
// package would consume it: by importing the package name and resolving
// through its `exports` map, never by reaching into `src`. Must be run
// after `pnpm build`. See packages/protocol/verify-package-entry.mjs for
// why this file is kept outside tsconfig.json's "include" and outside
// ESLint's type-aware project.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const hallCore = await import("@hall-of-wisdom/hall-core");

assert.equal(typeof hallCore.createHallCoreApp, "function");
assert.equal(typeof hallCore.TaskOrchestrator, "function");
assert.equal(typeof hallCore.TaskStore, "function");
assert.equal(typeof hallCore.EventStore, "function");
assert.equal(typeof hallCore.EventBus, "function");
assert.equal(hallCore.DEFAULT_PORT, 4310);
assert.equal(hallCore.LOCAL_ONLY_HOST, "127.0.0.1");

const taskStore = new hallCore.TaskStore({ maxTasks: 10 });
assert.deepEqual(taskStore.list(), []);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-verify-"));
try {
  const app = await hallCore.createHallCoreApp({
    orchestrator: /** @type {any} */ ({
      createTask: () => {
        throw new Error("not used in this smoke check");
      },
      requestCancellation: () => {
        throw new Error("not used in this smoke check");
      },
      shutdown: () => Promise.resolve(),
    }),
    taskStore,
    eventStore: new hallCore.EventStore({ maxEventsPerTask: 10 }),
    eventBus: new hallCore.EventBus({ maxSubscribersPerTask: 10 }),
    limits: hallCore.DEFAULT_LIMITS,
    logger: false,
  });
  const response = await app.inject({ method: "GET", url: "/api/v1/health" });
  assert.equal(response.statusCode, 200);
  await app.close();
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(
  "OK: @hall-of-wisdom/hall-core resolves and behaves correctly through its public entry point.",
);
