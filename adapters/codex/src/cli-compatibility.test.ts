import { describe, expect, it, vi } from "vitest";
import {
  parseSemverPrefix,
  verifyIsolationFlagSupport,
  MIN_SUPPORTED_CODEX_VERSION,
} from "./cli-compatibility.js";
import type { ProcessSpawner, SpawnedProcessHandle } from "./process-spawner.js";

const VALID_EXEC_HELP_TEXT = `
Usage: codex exec [OPTIONS] [PROMPT]

Options:
  -c, --config <key=value>
      --json
      --ephemeral
      --ignore-user-config
      --ignore-rules
      --strict-config
  -s, --sandbox <SANDBOX_MODE>
      --cd <DIR>
`;

function fakeSpawner(exitCode: number, stdout: string): ProcessSpawner {
  return {
    spawn(): SpawnedProcessHandle {
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      const stream = {
        on(event: string, cb: (...args: unknown[]) => void) {
          (listeners[event] ??= []).push(cb);
          if (event === "data")
            queueMicrotask(() => {
              cb(Buffer.from(stdout));
            });
          if (event === "end")
            queueMicrotask(() => {
              cb();
            });
          return stream;
        },
      } as unknown as NodeJS.ReadableStream;
      return {
        pid: 1234,
        stdin: { end: () => undefined, write: () => true } as unknown as NodeJS.WritableStream,
        stdout: stream,
        stderr: { on: () => stream } as unknown as NodeJS.ReadableStream,
        onExit(cb) {
          queueMicrotask(() => {
            cb(exitCode, null);
          });
        },
        onError() {
          /* no error path exercised here */
        },
        kill: () => true,
      };
    },
  };
}

describe("parseSemverPrefix", () => {
  it("strips the codex-cli package-label prefix (real observed --version output)", () => {
    expect(parseSemverPrefix("codex-cli 0.144.4")).toEqual({ major: 0, minor: 144, patch: 4 });
  });

  it("parses a bare semver string too", () => {
    expect(parseSemverPrefix("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("returns undefined for unparseable input", () => {
    expect(parseSemverPrefix("not-a-version")).toBeUndefined();
  });

  it("returns undefined for empty input", () => {
    expect(parseSemverPrefix("")).toBeUndefined();
  });
});

describe("MIN_SUPPORTED_CODEX_VERSION", () => {
  it("matches the real version this profile was confirmed against", () => {
    expect(MIN_SUPPORTED_CODEX_VERSION).toEqual({ major: 0, minor: 144, patch: 4 });
  });
});

describe("verifyIsolationFlagSupport", () => {
  it("returns true when the version meets the floor and --help contains every required marker", async () => {
    const result = await verifyIsolationFlagSupport({
      spawner: fakeSpawner(0, VALID_EXEC_HELP_TEXT),
      executablePath: "/usr/bin/codex",
      cwd: "/tmp",
      env: {},
      detectedVersionString: "codex-cli 0.144.4",
    });
    expect(result).toBe(true);
  });

  it("returns true for a newer version", async () => {
    const result = await verifyIsolationFlagSupport({
      spawner: fakeSpawner(0, VALID_EXEC_HELP_TEXT),
      executablePath: "/usr/bin/codex",
      cwd: "/tmp",
      env: {},
      detectedVersionString: "codex-cli 1.0.0",
    });
    expect(result).toBe(true);
  });

  it("fails closed for an older version without spawning --help", async () => {
    const spawnFn = vi.fn(
      (
        executablePath: string,
        args: readonly string[],
        options: { cwd: string; env: Readonly<Record<string, string>> },
      ) => fakeSpawner(0, VALID_EXEC_HELP_TEXT).spawn(executablePath, args, options),
    );
    const result = await verifyIsolationFlagSupport({
      spawner: { spawn: spawnFn },
      executablePath: "/usr/bin/codex",
      cwd: "/tmp",
      env: {},
      detectedVersionString: "codex-cli 0.1.0",
    });
    expect(result).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("fails closed for an unparseable version", async () => {
    const result = await verifyIsolationFlagSupport({
      spawner: fakeSpawner(0, VALID_EXEC_HELP_TEXT),
      executablePath: "/usr/bin/codex",
      cwd: "/tmp",
      env: {},
      detectedVersionString: undefined,
    });
    expect(result).toBe(false);
  });

  it("fails closed when --help is missing a required marker", async () => {
    const incompleteHelp = VALID_EXEC_HELP_TEXT.replace("--strict-config", "");
    const result = await verifyIsolationFlagSupport({
      spawner: fakeSpawner(0, incompleteHelp),
      executablePath: "/usr/bin/codex",
      cwd: "/tmp",
      env: {},
      detectedVersionString: "codex-cli 0.144.4",
    });
    expect(result).toBe(false);
  });

  it("fails closed when --help exits nonzero", async () => {
    const result = await verifyIsolationFlagSupport({
      spawner: fakeSpawner(1, VALID_EXEC_HELP_TEXT),
      executablePath: "/usr/bin/codex",
      cwd: "/tmp",
      env: {},
      detectedVersionString: "codex-cli 0.144.4",
    });
    expect(result).toBe(false);
  });

  it("never runs a real model request to check flag support — only --help is ever spawned", async () => {
    let spawnedArgs: readonly string[] | undefined;
    const spawner: ProcessSpawner = {
      spawn(executablePath, args, options) {
        spawnedArgs = args;
        return fakeSpawner(0, VALID_EXEC_HELP_TEXT).spawn(executablePath, args, options);
      },
    };
    await verifyIsolationFlagSupport({
      spawner,
      executablePath: "/usr/bin/codex",
      cwd: "/tmp",
      env: {},
      detectedVersionString: "codex-cli 0.144.4",
    });
    expect(spawnedArgs).toEqual(["exec", "--help"]);
  });
});
