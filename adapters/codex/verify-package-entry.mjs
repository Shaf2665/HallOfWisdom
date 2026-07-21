// Proves the *built* package can be consumed the same way an external
// package would consume it: by importing the package name and resolving
// through its `exports` map, never by reaching into `src`. Must be run
// after `pnpm build`. Mirrors
// adapters/claude-code/verify-package-entry.mjs.
//
// Deliberately does NOT call `startTask()` here: this adapter spawns a
// real, subscription-backed local Codex CLI process on `startTask()`.
// This script only exercises the safe, bounded, no-task surface:
// descriptor shape and `detect()` (which itself only runs bounded
// `--version`/`login status`/`--help` child-process calls, never a task).
import assert from "node:assert/strict";

const codexAdapter = await import("@hall-of-wisdom/codex-adapter");

assert.equal(typeof codexAdapter.CodexAdapter, "function");
assert.equal(codexAdapter.codexDescriptor.adapterId, "hall.codex");
assert.equal(codexAdapter.codexDescriptor.supportedAgent.agentId, "codex");

const adapter = new codexAdapter.CodexAdapter();
const detection = await adapter.detect();

assert.equal(typeof detection.installed, "boolean");
assert.equal(typeof detection.availability, "string");
// Detection must never leak an executable path or auth diagnostic through
// this entry point either — same safety contract as the real endpoint.
assert.equal(detection.executablePath, undefined);

console.log(
  "OK: @hall-of-wisdom/codex-adapter resolves and behaves correctly through its public entry point.",
);
