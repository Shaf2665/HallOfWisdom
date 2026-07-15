import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_CODES } from "./exit-codes.js";

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

  text(): string {
    return this.chunks.join("");
  }

  lines(): string[] {
    return this.text()
      .split("\n")
      .filter((line) => line.length > 0);
  }
}

describe("runCli", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-runner-cli-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function baseArgs(extra: string[] = []): string[] {
    return [
      "--adapter",
      "hall.mock-agent",
      "--workspace-root",
      tempRoot,
      "--working-directory",
      tempRoot,
      "--title",
      "CLI test run",
      "--step-delay-ms",
      "0",
      ...extra,
    ];
  }

  it("runs a valid success command and exits 0", async () => {
    const stdout = new CollectingWritable();
    const stderr = new CollectingWritable();
    const exitCode = await runCli({
      argv: baseArgs(["--scenario", "success"]),
      stdout,
      stderr,
    });
    expect(exitCode).toBe(EXIT_CODES.completed);
    expect(stdout.lines().at(-1)).toContain('"run.completed"');
  });

  it("runs a valid failure command and exits 1", async () => {
    const stdout = new CollectingWritable();
    const stderr = new CollectingWritable();
    const exitCode = await runCli({
      argv: baseArgs(["--scenario", "failure"]),
      stdout,
      stderr,
    });
    expect(exitCode).toBe(EXIT_CODES.failed);
    expect(stdout.lines().at(-1)).toContain('"run.failed"');
  });

  it("rejects an invalid scenario with exit code 2", async () => {
    const stdout = new CollectingWritable();
    const stderr = new CollectingWritable();
    const exitCode = await runCli({
      argv: baseArgs(["--scenario", "not-a-real-scenario"]),
      stdout,
      stderr,
    });
    expect(exitCode).toBe(EXIT_CODES.invalidInput);
    expect(stderr.text().length).toBeGreaterThan(0);
    expect(stdout.text()).toBe("");
  });

  it("rejects a command missing a required argument with exit code 2", async () => {
    const stdout = new CollectingWritable();
    const stderr = new CollectingWritable();
    const exitCode = await runCli({
      argv: [
        "--adapter",
        "hall.mock-agent",
        "--workspace-root",
        tempRoot,
        // --working-directory intentionally omitted
        "--title",
        "Missing arg test",
      ],
      stdout,
      stderr,
    });
    expect(exitCode).toBe(EXIT_CODES.invalidInput);
    expect(stderr.text().length).toBeGreaterThan(0);
  });

  it("rejects an invalid numeric --step-delay-ms with exit code 2", async () => {
    const stdout = new CollectingWritable();
    const stderr = new CollectingWritable();
    const exitCode = await runCli({
      argv: baseArgs(["--step-delay-ms", "not-a-number"]),
      stdout,
      stderr,
    });
    expect(exitCode).toBe(EXIT_CODES.invalidInput);
  });

  it("rejects an unknown argument with exit code 2", async () => {
    const stdout = new CollectingWritable();
    const stderr = new CollectingWritable();
    const exitCode = await runCli({
      argv: [...baseArgs(), "--not-a-real-flag", "value"],
      stdout,
      stderr,
    });
    expect(exitCode).toBe(EXIT_CODES.invalidInput);
  });

  it("writes JSON Lines only to stdout, never to stderr", async () => {
    const stdout = new CollectingWritable();
    const stderr = new CollectingWritable();
    await runCli({ argv: baseArgs(["--scenario", "success"]), stdout, stderr });
    for (const line of stdout.lines()) {
      expect(() => {
        JSON.parse(line);
      }).not.toThrow();
    }
    expect(stderr.text()).toBe("");
  });

  it("writes diagnostics only to stderr, never mixed into stdout", async () => {
    const stdout = new CollectingWritable();
    const stderr = new CollectingWritable();
    await runCli({ argv: baseArgs(["--scenario", "not-a-real-scenario"]), stdout, stderr });
    expect(stdout.text()).toBe("");
    expect(stderr.text().length).toBeGreaterThan(0);
    // Every stdout line (if any) must remain valid JSON — no decorative text mixed in.
    for (const line of stdout.lines()) {
      expect(() => {
        JSON.parse(line);
      }).not.toThrow();
    }
  });

  it("maps every terminal state to its documented exit code", async () => {
    const successStdout = new CollectingWritable();
    const successExit = await runCli({
      argv: baseArgs(["--scenario", "success"]),
      stdout: successStdout,
      stderr: new CollectingWritable(),
    });
    expect(successExit).toBe(EXIT_CODES.completed);

    const failureStdout = new CollectingWritable();
    const failureExit = await runCli({
      argv: baseArgs(["--scenario", "failure"]),
      stdout: failureStdout,
      stderr: new CollectingWritable(),
    });
    expect(failureExit).toBe(EXIT_CODES.failed);
  });

  it("handles a simulated Ctrl+C without terminating the test process", async () => {
    const stdout = new CollectingWritable();
    const stderr = new CollectingWritable();
    const exitSpy = vi.fn();

    const resultPromise = runCli({
      argv: baseArgs(["--scenario", "cancellable", "--step-delay-ms", "20"]),
      stdout,
      stderr,
      exit: exitSpy,
    });

    // Give the run a tick to emit run.started before requesting cancellation.
    await new Promise((resolve) => setTimeout(resolve, 5));
    process.emit("SIGINT", "SIGINT");

    const exitCode = await resultPromise;
    expect(exitCode).toBe(EXIT_CODES.cancelled);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("removes its SIGINT listener after the run completes", async () => {
    const before = process.listenerCount("SIGINT");
    await runCli({
      argv: baseArgs(["--scenario", "success"]),
      stdout: new CollectingWritable(),
      stderr: new CollectingWritable(),
    });
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("does not accumulate SIGINT listeners across repeated runs", async () => {
    const before = process.listenerCount("SIGINT");
    for (let i = 0; i < 3; i += 1) {
      await runCli({
        argv: baseArgs(["--scenario", "success"]),
        stdout: new CollectingWritable(),
        stderr: new CollectingWritable(),
      });
    }
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});
