import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { parseSemverPrefix, verifyIsolationFlagSupport } from "./cli-compatibility.js";
import type { ProcessSpawner, SpawnedProcessHandle } from "./process-spawner.js";

const VALID_HELP_TEXT = [
  "--safe-mode",
  "--no-chrome",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--permission-mode",
  "--allowedTools",
  "--disallowedTools",
  "--tools",
  '--output-format <format> ... (choices: "text", "json", "stream-json")',
].join("\n");

class ScriptedHandle implements SpawnedProcessHandle {
  readonly pid = 4242;
  readonly stdoutEmitter = new EventEmitter();
  readonly stderrEmitter = new EventEmitter();
  readonly stdout = this.stdoutEmitter as unknown as NodeJS.ReadableStream;
  readonly stderr = this.stderrEmitter as unknown as NodeJS.ReadableStream;
  #exitCallback: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;

  constructor(
    private readonly stdoutText: string,
    private readonly exitCode: number | null = 0,
  ) {}

  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.#exitCallback = callback;
    queueMicrotask(() => {
      this.stdoutEmitter.emit("data", Buffer.from(this.stdoutText, "utf8"));
      this.#exitCallback?.(this.exitCode, null);
    });
  }
  onError(): void {
    // unused
  }
  kill(): boolean {
    return true;
  }
}

function fakeSpawner(helpText: string, exitCode = 0): ProcessSpawner {
  return { spawn: () => new ScriptedHandle(helpText, exitCode) };
}

describe("parseSemverPrefix", () => {
  it("parses a leading semver from a version string with trailing text", () => {
    expect(parseSemverPrefix("2.1.212 (Claude Code)")).toEqual({ major: 2, minor: 1, patch: 212 });
  });

  it("returns undefined for an unparseable version string", () => {
    expect(parseSemverPrefix("not-a-version")).toBeUndefined();
    expect(parseSemverPrefix("")).toBeUndefined();
  });
});

describe("verifyIsolationFlagSupport", () => {
  it("returns true when the version meets the floor and --help confirms every required flag", async () => {
    const supported = await verifyIsolationFlagSupport({
      spawner: fakeSpawner(VALID_HELP_TEXT),
      executablePath: "claude",
      cwd: "/tmp",
      env: {},
      detectedVersionString: "2.1.212 (Claude Code)",
    });
    expect(supported).toBe(true);
  });

  it("returns true for a newer version than the floor", async () => {
    const supported = await verifyIsolationFlagSupport({
      spawner: fakeSpawner(VALID_HELP_TEXT),
      executablePath: "claude",
      cwd: "/tmp",
      env: {},
      detectedVersionString: "2.1.215 (Claude Code)",
    });
    expect(supported).toBe(true);
  });

  it("fails closed for a version below the floor, without spawning --help", async () => {
    let spawnCount = 0;
    const spawner: ProcessSpawner = {
      spawn: () => {
        spawnCount += 1;
        return new ScriptedHandle(VALID_HELP_TEXT, 0);
      },
    };
    const supported = await verifyIsolationFlagSupport({
      spawner,
      executablePath: "claude",
      cwd: "/tmp",
      env: {},
      detectedVersionString: "1.9.0 (Claude Code)",
    });
    expect(supported).toBe(false);
    expect(spawnCount).toBe(0);
  });

  it("fails closed for an unparseable version string", async () => {
    const supported = await verifyIsolationFlagSupport({
      spawner: fakeSpawner(VALID_HELP_TEXT),
      executablePath: "claude",
      cwd: "/tmp",
      env: {},
      detectedVersionString: "not-a-version",
    });
    expect(supported).toBe(false);
  });

  it("fails closed for an undefined version string", async () => {
    const supported = await verifyIsolationFlagSupport({
      spawner: fakeSpawner(VALID_HELP_TEXT),
      executablePath: "claude",
      cwd: "/tmp",
      env: {},
      detectedVersionString: undefined,
    });
    expect(supported).toBe(false);
  });

  it("fails closed when --help is missing a required flag", async () => {
    const incompleteHelp = VALID_HELP_TEXT.replace("--safe-mode\n", "");
    const supported = await verifyIsolationFlagSupport({
      spawner: fakeSpawner(incompleteHelp),
      executablePath: "claude",
      cwd: "/tmp",
      env: {},
      detectedVersionString: "2.1.212 (Claude Code)",
    });
    expect(supported).toBe(false);
  });

  it("fails closed when --help does not offer the stream-json output choice", async () => {
    const withoutStreamJson = VALID_HELP_TEXT.replace(', "stream-json"', "").replace(
      "stream-json",
      "",
    );
    const supported = await verifyIsolationFlagSupport({
      spawner: fakeSpawner(withoutStreamJson),
      executablePath: "claude",
      cwd: "/tmp",
      env: {},
      detectedVersionString: "2.1.212 (Claude Code)",
    });
    expect(supported).toBe(false);
  });

  it("fails closed when --help exits nonzero", async () => {
    const supported = await verifyIsolationFlagSupport({
      spawner: fakeSpawner(VALID_HELP_TEXT, 1),
      executablePath: "claude",
      cwd: "/tmp",
      env: {},
      detectedVersionString: "2.1.212 (Claude Code)",
    });
    expect(supported).toBe(false);
  });

  it("fails closed when the --help spawn errors", async () => {
    const erroringSpawner: ProcessSpawner = {
      spawn: () => ({
        pid: 1,
        stdout: new EventEmitter() as unknown as NodeJS.ReadableStream,
        stderr: new EventEmitter() as unknown as NodeJS.ReadableStream,
        onExit: () => undefined,
        onError: (cb: (error: Error) => void) => {
          queueMicrotask(() => {
            cb(new Error("spawn ENOENT"));
          });
        },
        kill: () => true,
      }),
    };
    const supported = await verifyIsolationFlagSupport({
      spawner: erroringSpawner,
      executablePath: "claude",
      cwd: "/tmp",
      env: {},
      detectedVersionString: "2.1.212 (Claude Code)",
    });
    expect(supported).toBe(false);
  });
});
