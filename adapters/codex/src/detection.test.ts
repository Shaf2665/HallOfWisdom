import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectCodex } from "./detection.js";
import type { ProcessSpawner, SpawnedProcessHandle } from "./process-spawner.js";
import type { FileSystemProbe } from "./executable-resolver.js";

class ScriptedHandle implements SpawnedProcessHandle {
  readonly pid = 1234;
  readonly stdoutEmitter = new EventEmitter();
  readonly stderrEmitter = new EventEmitter();
  readonly stdout = this.stdoutEmitter as unknown as NodeJS.ReadableStream;
  readonly stderr = this.stderrEmitter as unknown as NodeJS.ReadableStream;
  readonly stdin = { end: () => undefined, write: () => true } as unknown as NodeJS.WritableStream;
  #exitCallback: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;

  constructor(
    private readonly stdoutText: string,
    private readonly exitCode: number | null = 0,
    private readonly stderrText = "",
  ) {}

  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.#exitCallback = callback;
    queueMicrotask(() => {
      if (this.stdoutText.length > 0)
        this.stdoutEmitter.emit("data", Buffer.from(this.stdoutText, "utf8"));
      if (this.stderrText.length > 0)
        this.stderrEmitter.emit("data", Buffer.from(this.stderrText, "utf8"));
      this.#exitCallback?.(this.exitCode, null);
    });
  }
  onError(): void {
    // not used by these fixtures
  }
  kill(): boolean {
    return true;
  }
}

/**
 * Never calls its exit callback until `kill()` is invoked — simulating a
 * process that has not produced a result yet. Used with `vi.useFakeTimers()`
 * to deterministically exercise `runBoundedProcess`'s own timeout path
 * (which calls `handle.kill()` after the configured bound) without any
 * real elapsed wall-clock time or a real process.
 */
class HangingHandle implements SpawnedProcessHandle {
  readonly pid = 5678;
  readonly stdout = { on: () => undefined } as unknown as NodeJS.ReadableStream;
  readonly stderr = { on: () => undefined } as unknown as NodeJS.ReadableStream;
  readonly stdin = { end: () => undefined, write: () => true } as unknown as NodeJS.WritableStream;
  #exitCallback: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;

  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.#exitCallback = callback;
  }
  onError(): void {
    // not used by these fixtures
  }
  kill(): boolean {
    // Mirrors a real killed process eventually reporting its exit.
    this.#exitCallback?.(null, "SIGTERM");
    return true;
  }
}

const VALID_EXEC_HELP_TEXT = [
  "--json",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--strict-config",
  "--sandbox",
  "--cd",
  "-c, --config",
].join("\n");

/**
 * A spawner keyed on the invoked args, not call order/index — robust
 * against detection.ts adding/removing/reordering its own bounded
 * process calls. `loginStatusOnStderr` defaults to true because the real
 * installed CLI writes `login status`'s message to stderr, not stdout —
 * confirmed live during Phase 10 reconnaissance and instrumented
 * diagnostics (see docs/architecture/0009-codex-adapter.md, "Real
 * smoke-test results").
 */
function scriptedSpawner(
  versionStdout: string,
  loginStatusText: string,
  loginExitCode = 0,
  helpText: string = VALID_EXEC_HELP_TEXT,
  loginStatusOnStderr = true,
): ProcessSpawner {
  return {
    spawn: (_executablePath, args) => {
      if (args.includes("--version")) return new ScriptedHandle(versionStdout, 0);
      if (args.includes("exec") && args.includes("--help")) return new ScriptedHandle(helpText, 0);
      if (args.includes("login") && args.includes("status")) {
        return loginStatusOnStderr
          ? new ScriptedHandle("", loginExitCode, loginStatusText)
          : new ScriptedHandle(loginStatusText, loginExitCode);
      }
      return new ScriptedHandle("", 0);
    },
  };
}

function fakeFs(existingPaths: readonly string[]): FileSystemProbe {
  const set = new Set(existingPaths.map((p) => p.toLowerCase()));
  return { isFile: (p) => set.has(p.toLowerCase()) };
}

const FOUND_ENV = { PATH: "/usr/local/bin" };
const FS_WITH_CODEX = fakeFs(["/usr/local/bin/codex"]);

describe("detectCodex — executable resolution", () => {
  it("reports unavailable when the executable is not found", async () => {
    const result = await detectCodex({
      platform: "linux",
      parentEnv: { PATH: "/usr/bin" },
      fs: fakeFs([]),
      spawner: scriptedSpawner("", ""),
    });
    expect(result).toEqual({
      installed: false,
      availability: "unavailable",
      diagnosticMessage: "Codex CLI was not found on PATH.",
    });
  });

  it("never returns an executablePath", async () => {
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner: scriptedSpawner("codex-cli 0.144.4", "Logged in using ChatGPT"),
    });
    expect(result.executablePath).toBeUndefined();
  });
});

describe("detectCodex — ChatGPT authentication verification", () => {
  it(
    "Phase 10.1: recognizes the real observed 'Logged in using ChatGPT' shape (on stderr) as " +
      "installed/authenticated, but still reports 'unsupported' — never 'available' — because " +
      "file-edit execution capability is not verified",
    async () => {
      const result = await detectCodex({
        platform: "linux",
        parentEnv: FOUND_ENV,
        fs: FS_WITH_CODEX,
        spawner: scriptedSpawner("codex-cli 0.144.4", "Logged in using ChatGPT"),
      });
      expect(result.availability).toBe("unsupported");
      expect(result.installed).toBe(true);
      expect(result.detectedVersion).toBe("codex-cli 0.144.4");
      expect(result.diagnosticMessage).toBe(
        "Codex file-edit execution is not verified in the current sandbox.",
      );
    },
  );

  it("never reports available even if a future CLI version puts the same ChatGPT message on stdout instead", async () => {
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner: scriptedSpawner(
        "codex-cli 0.144.4",
        "Logged in using ChatGPT",
        0,
        VALID_EXEC_HELP_TEXT,
        false,
      ),
    });
    expect(result.availability).toBe("unsupported");
    expect(result.availability).not.toBe("available");
  });

  it("reports logged_out for a not-logged-in shape", async () => {
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner: scriptedSpawner("codex-cli 0.144.4", "Not logged in"),
    });
    expect(result.availability).toBe("logged_out");
  });

  it("fails closed (unsupported) for an api-key-shaped auth message", async () => {
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner: scriptedSpawner("codex-cli 0.144.4", "Logged in using an API key"),
    });
    expect(result.availability).toBe("unsupported");
    expect(result.diagnosticMessage).toBe("Codex authentication is not ChatGPT-based.");
  });

  it("fails closed (unsupported) for an access-token-shaped auth message", async () => {
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner: scriptedSpawner("codex-cli 0.144.4", "Logged in using an access token"),
    });
    expect(result.availability).toBe("unsupported");
  });

  it("fails closed on an ambiguous/unrecognized auth message", async () => {
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner: scriptedSpawner("codex-cli 0.144.4", "something we've never seen before"),
    });
    expect(result.availability).toBe("unsupported");
    expect(result.diagnosticMessage).toBe("Codex authentication could not be verified safely.");
  });

  it("fails closed when login status spawn errors out", async () => {
    const spawner: ProcessSpawner = {
      spawn: (_exe, args) => {
        if (args.includes("--version")) return new ScriptedHandle("codex-cli 0.144.4", 0);
        if (args.includes("exec") && args.includes("--help"))
          return new ScriptedHandle(VALID_EXEC_HELP_TEXT, 0);
        const emptyStream = { on: () => undefined } as unknown as NodeJS.ReadableStream;
        return {
          pid: 1234,
          stdin: { end: () => undefined, write: () => true } as unknown as NodeJS.WritableStream,
          stdout: emptyStream,
          stderr: emptyStream,
          onExit: () => undefined,
          onError: (cb: (error: Error) => void) => {
            queueMicrotask(() => {
              cb(new Error("spawn failed"));
            });
          },
          kill: () => true,
        } satisfies SpawnedProcessHandle;
      },
    };
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner,
    });
    expect(result.availability).toBe("unsupported");
  });
});

describe("detectCodex — isolation-flag support", () => {
  it("reports unsupported with the fixed diagnostic when exec --help is missing a required flag", async () => {
    const incompleteHelp = VALID_EXEC_HELP_TEXT.replace("--strict-config\n", "");
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner: scriptedSpawner("codex-cli 0.144.4", "Logged in using ChatGPT", 0, incompleteHelp),
    });
    expect(result.availability).toBe("unsupported");
    expect(result.diagnosticMessage).toBe(
      "Installed Codex cannot guarantee the required isolated execution profile.",
    );
  });

  it("reports unsupported for a version below the documented minimum, without spawning --help or login status", async () => {
    let helpOrAuthSpawned = false;
    const spawner: ProcessSpawner = {
      spawn: (_executablePath, args) => {
        if (args.includes("--version")) return new ScriptedHandle("codex-cli 0.1.0", 0);
        helpOrAuthSpawned = true;
        return new ScriptedHandle("", 0);
      },
    };
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner,
    });
    expect(result.availability).toBe("unsupported");
    expect(helpOrAuthSpawned).toBe(false);
  });

  it("does not fall back to a less secure invocation when isolation flags cannot be verified, even with valid ChatGPT auth available", async () => {
    const incompleteHelp = VALID_EXEC_HELP_TEXT.replace("--ignore-user-config\n", "");
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner: scriptedSpawner("codex-cli 0.144.4", "Logged in using ChatGPT", 0, incompleteHelp),
    });
    expect(result.availability).not.toBe("available");
  });
});

describe("detectCodex — diagnostic safety", () => {
  it("never includes an account/workspace identifier present in the raw login output", async () => {
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner: scriptedSpawner(
        "codex-cli 0.144.4",
        "Logged in using ChatGPT (workspace: Leak Org, operator@example.invalid)",
      ),
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Leak Org");
    expect(serialized).not.toContain("example.invalid");
  });

  it("bounds detectedVersion length", async () => {
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner: scriptedSpawner("x".repeat(500), "Logged in using ChatGPT"),
    });
    expect((result.detectedVersion ?? "").length).toBeLessThanOrEqual(64);
  });
});

/**
 * Phase 10.1: reviewed the transient cold-start "unavailable" result
 * observed once during Phase 10's Playwright verification (a single
 * `GET /api/v1/adapters` request reported Codex unavailable; the very
 * next request against the same long-running Hall Core process reported
 * it correctly). detectCodex has no cache and no retry loop — every call
 * is a fresh, independent, single-pass sequence of bounded sub-checks;
 * there is nothing here to expire or grow stale. The most likely
 * explanation for that one observation is a slow first real process
 * spawn (e.g. Windows Defender/AV scanning a just-built executable, OS
 * page-cache being cold) landing close to one of the bounded timeouts —
 * a real, transient condition, not a code defect, and not something an
 * automatic retry inside detectCodex should paper over (the kickoff
 * explicitly prohibits introducing unbounded/automatic retries here).
 * `startTask` already re-runs `detect()` immediately before spawning the
 * real task, so a single stale-looking poll can never become permission
 * to execute; a subsequent poll (which is exactly what happened) simply
 * reflects current reality.
 */
describe("detectCodex — bounded timeouts (Phase 10.1)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a --version timeout reports unavailable, distinct from a spawn error or a bad exit code", async () => {
    vi.useFakeTimers();
    const spawner: ProcessSpawner = {
      spawn: (_exe, args) =>
        args.includes("--version") ? new HangingHandle() : new ScriptedHandle("", 0),
    };
    const resultPromise = detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner,
      versionTimeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1100);
    const result = await resultPromise;
    expect(result.availability).toBe("unavailable");
    expect(result.diagnosticMessage).toBe("Codex CLI could not be started.");
  });

  it("an exec --help timeout reports unsupported with the isolation diagnostic, distinct from a --version timeout", async () => {
    vi.useFakeTimers();
    const spawner: ProcessSpawner = {
      spawn: (_exe, args) => {
        if (args.includes("--version")) return new ScriptedHandle("codex-cli 0.144.4", 0);
        if (args.includes("exec") && args.includes("--help")) return new HangingHandle();
        return new ScriptedHandle("", 0);
      },
    };
    const resultPromise = detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner,
      helpTimeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1100);
    const result = await resultPromise;
    expect(result.availability).toBe("unsupported");
    expect(result.diagnosticMessage).toBe(
      "Installed Codex cannot guarantee the required isolated execution profile.",
    );
  });

  it("a login status timeout reports unsupported with the unverified-auth diagnostic, distinct from a logged-out result", async () => {
    vi.useFakeTimers();
    const spawner: ProcessSpawner = {
      spawn: (_exe, args) => {
        if (args.includes("--version")) return new ScriptedHandle("codex-cli 0.144.4", 0);
        if (args.includes("exec") && args.includes("--help"))
          return new ScriptedHandle(VALID_EXEC_HELP_TEXT, 0);
        if (args.includes("login") && args.includes("status")) return new HangingHandle();
        return new ScriptedHandle("", 0);
      },
    };
    const resultPromise = detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner,
      authTimeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1100);
    const result = await resultPromise;
    expect(result.availability).toBe("unsupported");
    expect(result.diagnosticMessage).toBe("Codex authentication could not be verified safely.");
    expect(result.availability).not.toBe("logged_out");
  });

  it("performs exactly one bounded process spawn per detection stage — no internal retry loop", async () => {
    let versionSpawnCount = 0;
    const spawner: ProcessSpawner = {
      spawn: (_exe, args) => {
        if (args.includes("--version")) {
          versionSpawnCount += 1;
          return new ScriptedHandle("codex-cli 0.144.4", 0);
        }
        if (args.includes("exec") && args.includes("--help"))
          return new ScriptedHandle(VALID_EXEC_HELP_TEXT, 0);
        return new ScriptedHandle("", 0, "Logged in using ChatGPT");
      },
    };
    await detectCodex({ platform: "linux", parentEnv: FOUND_ENV, fs: FS_WITH_CODEX, spawner });
    expect(versionSpawnCount).toBe(1);
  });
});
