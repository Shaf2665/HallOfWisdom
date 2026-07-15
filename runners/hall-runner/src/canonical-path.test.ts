import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseNormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { runCli } from "./cli.js";
import { AgentRegistry } from "./agent-registry.js";
import { EXIT_CODES } from "./exit-codes.js";
import { CapturingAdapter } from "./test-support.js";

class CollectingWritable extends Writable {
  chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  lines(): string[] {
    return this.chunks
      .join("")
      .split("\n")
      .filter((line) => line.length > 0);
  }
}

/**
 * These tests exercise the exact same composition path the real CLI uses
 * (argument parsing -> workspace validation -> `buildTaskInput` ->
 * `runTask`), substituting only the adapter registry: a `CapturingAdapter`
 * stands in for `createMockAgentRegistry`'s real Mock Agent, via `runCli`'s
 * `createRegistry` override. This proves what value *actually reaches*
 * `AgentAdapter.startTask()` — not just what a unit test of an isolated
 * function returns — while still avoiding a real child-process spawn.
 *
 * This is a regression test for the bug a security review found in
 * Phase 4: `cli.ts` validated and canonicalized `workingDirectory` via
 * `validateWorkspace()`, then discarded that result and passed the raw,
 * unresolved CLI string into `AgentTaskInput` instead. Against that
 * pre-fix behavior this test's core assertion
 * (`received.workingDirectory === canonicalPath`) would have failed,
 * since the raw symlink path and its canonical target are different
 * strings; against the current fix it passes.
 */
describe("canonical workingDirectory reaches AgentAdapter.startTask()", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-runner-canonical-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function baseArgs(workingDirectory: string): string[] {
    return [
      "--adapter",
      "hall.capturing-agent",
      "--workspace-root",
      tempRoot,
      "--working-directory",
      workingDirectory,
      "--title",
      "Canonical path regression test",
    ];
  }

  it("passes the canonical (symlink-resolved) working directory, not the raw CLI value, to the adapter", async () => {
    const nested = path.join(tempRoot, "nested", "real-dir");
    fs.mkdirSync(nested, { recursive: true });
    const linkPath = path.join(tempRoot, "link-to-nested");

    let linkCreated = true;
    try {
      fs.symlinkSync(nested, linkPath, process.platform === "win32" ? "junction" : "dir");
    } catch {
      // Creating symlinks/junctions can require elevated privileges on some
      // Windows configurations. Fall back to exercising the "root itself"
      // case, which still proves buildTaskInput uses the canonical value
      // (they're identical here, but the wiring under test is the same).
      linkCreated = false;
    }

    const workingDirectoryArg = linkCreated ? linkPath : tempRoot;
    const capturing = new CapturingAdapter("hall.capturing-agent");
    const stdout = new CollectingWritable();
    const stderr = new CollectingWritable();

    const exitCode = await runCli({
      argv: baseArgs(workingDirectoryArg),
      stdout,
      stderr,
      createRegistry: () => {
        const registry = new AgentRegistry();
        registry.register(capturing);
        return registry;
      },
    });

    expect(exitCode).toBe(EXIT_CODES.completed);
    expect(capturing.receivedInputs).toHaveLength(1);

    const [received] = capturing.receivedInputs;
    if (!received) {
      throw new Error("expected the capturing adapter to have received exactly one input");
    }
    const canonicalWorkingDirectory = fs.realpathSync.native(workingDirectoryArg);
    expect(received.workingDirectory).toBe(canonicalWorkingDirectory);

    if (linkCreated) {
      // The whole point of the fix: the raw symlink path and its resolved
      // target are different strings, and the adapter must receive the
      // resolved one.
      expect(received.workingDirectory).not.toBe(workingDirectoryArg);
      expect(canonicalWorkingDirectory).not.toBe(workingDirectoryArg);
    }
  });

  it("passes a canonical workspaceRoot-equals-workingDirectory case consistently", async () => {
    const capturing = new CapturingAdapter("hall.capturing-agent");
    const exitCode = await runCli({
      argv: baseArgs(tempRoot),
      stdout: new CollectingWritable(),
      stderr: new CollectingWritable(),
      createRegistry: () => {
        const registry = new AgentRegistry();
        registry.register(capturing);
        return registry;
      },
    });

    expect(exitCode).toBe(EXIT_CODES.completed);
    const [received] = capturing.receivedInputs;
    if (!received) {
      throw new Error("expected the capturing adapter to have received exactly one input");
    }
    expect(received.workingDirectory).toBe(fs.realpathSync.native(tempRoot));
  });

  it("never invokes the adapter for a working directory outside the validated workspace boundary", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hall-runner-canonical-outside-"));
    try {
      const capturing = new CapturingAdapter("hall.capturing-agent");
      const stderr = new CollectingWritable();

      const exitCode = await runCli({
        argv: baseArgs(outside),
        stdout: new CollectingWritable(),
        stderr,
        createRegistry: () => {
          const registry = new AgentRegistry();
          registry.register(capturing);
          return registry;
        },
      });

      expect(exitCode).toBe(EXIT_CODES.invalidInput);
      expect(capturing.receivedInputs).toHaveLength(0);
      expect(stderr.lines().length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("emits a minimal lifecycle whose every event passes parseNormalizedAgentEvent", async () => {
    const capturing = new CapturingAdapter("hall.capturing-agent");
    const stdout = new CollectingWritable();

    await runCli({
      argv: baseArgs(tempRoot),
      stdout,
      stderr: new CollectingWritable(),
      createRegistry: () => {
        const registry = new AgentRegistry();
        registry.register(capturing);
        return registry;
      },
    });

    const events = stdout.lines().map((line) => JSON.parse(line) as unknown);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(() => parseNormalizedAgentEvent(event)).not.toThrow();
    }
    expect((events.at(-1) as { type: string }).type).toBe("run.completed");
  });
});
