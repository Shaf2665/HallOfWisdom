// Proves the *built* package can be consumed the same way an external
// package would consume it: by importing the package name and resolving
// through its `exports` map, never by reaching into `src`. Must be run
// after `pnpm build`. See adapters/mock-agent/verify-package-entry.mjs for
// the pattern this mirrors.
//
// Deliberately does NOT call `startTask()` here, unlike Mock Agent's
// equivalent script: Mock Agent is free and fully deterministic, but this
// adapter spawns a real, possibly billed local Claude Code CLI process on
// `startTask()`. This script only exercises the safe, bounded, no-task
// surface: descriptor shape and `detect()` (which itself only runs bounded
// `--version`/auth-status child-process calls, never a task).
import assert from "node:assert/strict";

const claudeCodeAdapter = await import("@hall-of-wisdom/claude-code-adapter");

assert.equal(typeof claudeCodeAdapter.ClaudeCodeAdapter, "function");
assert.equal(claudeCodeAdapter.claudeCodeDescriptor.adapterId, "hall.claude-code");
assert.equal(claudeCodeAdapter.claudeCodeDescriptor.supportedAgent.agentId, "claude-code");

const adapter = new claudeCodeAdapter.ClaudeCodeAdapter();
const detection = await adapter.detect();

assert.equal(typeof detection.installed, "boolean");
assert.equal(typeof detection.availability, "string");
// Detection must never leak an executable path or auth diagnostic through
// this entry point either — same safety contract as the real endpoint.
assert.equal(detection.executablePath, undefined);

console.log(
  "OK: @hall-of-wisdom/claude-code-adapter resolves and behaves correctly through its public entry point.",
);
