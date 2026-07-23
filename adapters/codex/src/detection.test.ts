import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectCodex,
  UNSUPPORTED_ISOLATION_PROFILE_MESSAGE,
  UNVERIFIED_CHATGPT_MESSAGE,
  NOT_CHATGPT_MESSAGE,
} from "./detection.js";
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

/**
 * Simulates a real spawn failure (e.g. the underlying OS call itself
 * failing) — `onError` fires instead of `onExit`, matching
 * `runBoundedProcess`'s `spawnError` path. Distinct from `HangingHandle`
 * (which never settles at all, exercising the timeout path instead).
 */
class ErrorHandle implements SpawnedProcessHandle {
  readonly pid = 9999;
  readonly stdout = { on: () => undefined } as unknown as NodeJS.ReadableStream;
  readonly stderr = { on: () => undefined } as unknown as NodeJS.ReadableStream;
  readonly stdin = { end: () => undefined, write: () => true } as unknown as NodeJS.WritableStream;
  #errorCallback: ((error: Error) => void) | undefined;

  onExit(): void {
    // never called on this path
  }
  onError(callback: (error: Error) => void): void {
    this.#errorCallback = callback;
    queueMicrotask(() => {
      this.#errorCallback?.(new Error("spawn ENOENT"));
    });
  }
  kill(): boolean {
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

/**
 * Phase 10.3 — returns a queued handle for each successive `--version`
 * spawn (the Nth call gets `versionHandles[N-1]`, clamped to the last
 * entry once exhausted), while `exec --help`/`login status` always
 * succeed with the given fixed text. Lets a test construct exact
 * sequences like "first call hangs, second call succeeds" and directly
 * count how many times `--version` was actually spawned.
 */
function versionQueueSpawner(
  versionHandles: readonly SpawnedProcessHandle[],
  helpText: string = VALID_EXEC_HELP_TEXT,
  loginStatusText = "Logged in using ChatGPT",
): { spawner: ProcessSpawner; versionCallCount: () => number } {
  let versionIndex = 0;
  let versionCallCount = 0;
  const spawner: ProcessSpawner = {
    spawn: (_executablePath, args) => {
      if (args.includes("--version")) {
        versionCallCount += 1;
        const handle = versionHandles[versionIndex] ?? versionHandles[versionHandles.length - 1];
        versionIndex += 1;
        if (handle === undefined) throw new Error("versionQueueSpawner: no handle configured");
        return handle;
      }
      if (args.includes("exec") && args.includes("--help")) return new ScriptedHandle(helpText, 0);
      if (args.includes("login") && args.includes("status")) {
        return new ScriptedHandle("", 0, loginStatusText);
      }
      return new ScriptedHandle("", 0);
    },
  };
  return { spawner, versionCallCount: () => versionCallCount };
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
    expect(result.installed).toBe(false);
    expect(result.availability).toBe("unavailable");
    expect(result.diagnosticMessage).toBe("Codex CLI was not found on PATH.");
    expect(result.executionTrust).toBe("unavailable");
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

  it(
    "a --version timeout on both the initial attempt and its one bounded retry reports " +
      "unavailable, distinct from a spawn error or a bad exit code (Phase 10.3: every --version " +
      "spawn in this test hangs identically, so this also proves the retry is truly bounded — " +
      "the promise settles rather than hanging forever)",
    async () => {
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
        versionRetryDelayMs: 250,
      });
      // First timeout (1000ms) + retry delay (250ms) + second timeout (1000ms).
      await vi.advanceTimersByTimeAsync(2300);
      const result = await resultPromise;
      expect(result.availability).toBe("unavailable");
      expect(result.diagnosticMessage).toBe("Codex CLI could not be started.");
    },
  );

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

const TRUSTED_LOCAL_EXEC_HELP_TEXT = [
  ...VALID_EXEC_HELP_TEXT.split("\n"),
  "--dangerously-bypass-approvals-and-sandbox",
  "--disable",
].join("\n");

const VALID_TRUSTED_LOCAL: import("./detection.js").TrustedLocalDetectionOptions = {
  enabled: true,
  loopbackBound: true,
  workspaceRoot: "/workspace",
};

function trustedLocalSpawner(): ProcessSpawner {
  return scriptedSpawner(
    "codex-cli 0.144.4",
    "Logged in using ChatGPT",
    0,
    TRUSTED_LOCAL_EXEC_HELP_TEXT,
  );
}

describe("detectCodex — trusted-local mode disabled (default, Phase 10.1 unchanged)", () => {
  it("with trustedLocal omitted entirely, behaves byte-for-byte like Phase 10.1", async () => {
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner: trustedLocalSpawner(),
    });
    expect(result.availability).toBe("unsupported");
    expect(result.diagnosticMessage).toBe(
      "Codex file-edit execution is not verified in the current sandbox.",
    );
    // Phase 11 — strict mode reports project.edit as restricted (a
    // diagnosed, environment-probed reason), never verified or declared.
    expect(result.executionTrust).toBe("unavailable");
    const projectEdit = result.capabilityObservations?.find((o) => o.capability === "project.edit");
    expect(projectEdit?.status).toBe("restricted");
    expect(projectEdit?.evidence).toBe("environment_probe");
  });

  it("with trustedLocal.enabled false, still never returns available even if every other precondition would pass", async () => {
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner: trustedLocalSpawner(),
      trustedLocal: { enabled: false, loopbackBound: true, workspaceRoot: "/workspace" },
    });
    expect(result.availability).toBe("unsupported");
  });
});

describe("detectCodex — trusted-local mode enabled (Phase 10.2)", () => {
  it("reports available with the fixed trusted-local diagnostic once every precondition passes", async () => {
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner: trustedLocalSpawner(),
      trustedLocal: VALID_TRUSTED_LOCAL,
    });
    expect(result.availability).toBe("available");
    expect(result.diagnosticMessage).toBe(
      "Trusted-local mode: Codex sandbox and approval protections are bypassed. Codex runs with the Hall Core user's filesystem permissions.",
    );
    // Phase 11
    expect(result.executionTrust).toBe("trusted_local");
    const projectEdit = result.capabilityObservations?.find((o) => o.capability === "project.edit");
    expect(projectEdit?.status).toBe("verified");
    expect(projectEdit?.evidence).toBe("browser_smoke_test");
    expect(result.limitations).toEqual([
      "Trusted-local mode: Codex sandbox and approval protections are bypassed. Codex runs with the Hall Core user's filesystem permissions.",
    ]);
  });

  it("never reports isolated execution trust for trusted-local mode — Phase 11", async () => {
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner: trustedLocalSpawner(),
      trustedLocal: VALID_TRUSTED_LOCAL,
    });
    expect(result.executionTrust).not.toBe("isolated");
  });

  it("never describes trusted-local mode as sandboxed or restricted", async () => {
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner: trustedLocalSpawner(),
      trustedLocal: VALID_TRUSTED_LOCAL,
    });
    const message = (result.diagnosticMessage ?? "").toLowerCase();
    expect(message).not.toContain("sandboxed");
    expect(message).not.toContain("restricted");
  });

  it("fails closed to unsupported when not loopback-bound", async () => {
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner: trustedLocalSpawner(),
      trustedLocal: { ...VALID_TRUSTED_LOCAL, loopbackBound: false },
    });
    expect(result.availability).toBe("unsupported");
    expect(result.diagnosticMessage).toBe(
      "Codex trusted-local execution requires Hall Core to be bound to loopback only.",
    );
  });

  it("fails closed to unsupported when no workspace root is configured", async () => {
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner: trustedLocalSpawner(),
      trustedLocal: { ...VALID_TRUSTED_LOCAL, workspaceRoot: "   " },
    });
    expect(result.availability).toBe("unsupported");
    expect(result.diagnosticMessage).toBe(
      "Codex trusted-local execution requires a configured workspace root.",
    );
  });

  it.each(["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"])(
    "fails closed to unsupported when %s is present in the operator's environment",
    async (blockedKey) => {
      const result = await detectCodex({
        platform: "linux",
        parentEnv: { ...FOUND_ENV, [blockedKey]: "sk-something" },
        fs: FS_WITH_CODEX,
        spawner: trustedLocalSpawner(),
        trustedLocal: VALID_TRUSTED_LOCAL,
      });
      expect(result.availability).toBe("unsupported");
      expect(result.diagnosticMessage).toBe(
        "Codex trusted-local execution was refused because a billing-changing environment variable is present.",
      );
    },
  );

  it("never leaks the blocked environment variable's value in the diagnostic", async () => {
    const result = await detectCodex({
      platform: "linux",
      parentEnv: { ...FOUND_ENV, OPENAI_API_KEY: "sk-super-secret-value" },
      fs: FS_WITH_CODEX,
      spawner: trustedLocalSpawner(),
      trustedLocal: VALID_TRUSTED_LOCAL,
    });
    expect(JSON.stringify(result)).not.toContain("sk-super-secret-value");
  });

  it("fails closed to unsupported when --help is missing the bypass flag, even with valid ChatGPT auth and loopback binding", async () => {
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner: scriptedSpawner(
        "codex-cli 0.144.4",
        "Logged in using ChatGPT",
        0,
        VALID_EXEC_HELP_TEXT,
      ),
      trustedLocal: VALID_TRUSTED_LOCAL,
    });
    expect(result.availability).toBe("unsupported");
    expect(result.diagnosticMessage).toBe(
      "Installed Codex cannot guarantee the required trusted-local execution profile.",
    );
  });

  it("still fails closed to unsupported (not available) when ChatGPT auth cannot be verified, even with trusted-local enabled", async () => {
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner: scriptedSpawner(
        "codex-cli 0.144.4",
        "Logged in using an API key",
        0,
        TRUSTED_LOCAL_EXEC_HELP_TEXT,
      ),
      trustedLocal: VALID_TRUSTED_LOCAL,
    });
    expect(result.availability).toBe("unsupported");
    expect(result.availability).not.toBe("available");
  });

  it("still fails closed (logged_out) when not signed in, even with trusted-local enabled", async () => {
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner: scriptedSpawner(
        "codex-cli 0.144.4",
        "Not logged in",
        0,
        TRUSTED_LOCAL_EXEC_HELP_TEXT,
      ),
      trustedLocal: VALID_TRUSTED_LOCAL,
    });
    expect(result.availability).toBe("logged_out");
  });

  it("never exposes executablePath, CODEX_HOME, account info, or raw help/login output even when available", async () => {
    const result = await detectCodex({
      platform: "linux",
      parentEnv: { ...FOUND_ENV, CODEX_HOME: "/home/operator/.codex" },
      fs: FS_WITH_CODEX,
      spawner: trustedLocalSpawner(),
      trustedLocal: VALID_TRUSTED_LOCAL,
    });
    const serialized = JSON.stringify(result);
    expect(result.executablePath).toBeUndefined();
    expect(serialized).not.toContain("/home/operator/.codex");
    expect(serialized).not.toContain("/usr/local/bin/codex");
  });

  it("fetches 'codex exec --help' exactly once even though both the strict and trusted-local marker sets are checked", async () => {
    let helpSpawnCount = 0;
    const spawner: ProcessSpawner = {
      spawn: (_exe, args) => {
        if (args.includes("--version")) return new ScriptedHandle("codex-cli 0.144.4", 0);
        if (args.includes("exec") && args.includes("--help")) {
          helpSpawnCount += 1;
          return new ScriptedHandle(TRUSTED_LOCAL_EXEC_HELP_TEXT, 0);
        }
        return new ScriptedHandle("", 0, "Logged in using ChatGPT");
      },
    };
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner,
      trustedLocal: VALID_TRUSTED_LOCAL,
    });
    expect(result.availability).toBe("available");
    expect(helpSpawnCount).toBe(1);
  });
});

describe("detectCodex — Phase 10.3 bounded version-probe retry", () => {
  it("a successful first --version probe starts exactly one version process — never retried", async () => {
    vi.useFakeTimers();
    const { spawner, versionCallCount } = versionQueueSpawner([
      new ScriptedHandle("codex-cli 0.144.4", 0),
    ]);
    const resultPromise = detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner,
      versionRetryDelayMs: 10,
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;
    expect(result.availability).toBe("unsupported"); // reaches the fixed Phase 10.1 cap, strict mode
    expect(versionCallCount()).toBe(1);
    vi.useRealTimers();
  });

  it("process_start_failed on the first attempt, success on the second — detection succeeds, exactly two version processes started", async () => {
    vi.useFakeTimers();
    const { spawner, versionCallCount } = versionQueueSpawner([
      new ErrorHandle(),
      new ScriptedHandle("codex-cli 0.144.4", 0),
    ]);
    const resultPromise = detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner,
      versionRetryDelayMs: 10,
    });
    await vi.advanceTimersByTimeAsync(20);
    const result = await resultPromise;
    expect(result.availability).not.toBe("unavailable");
    expect(result.detectedVersion).toBe("codex-cli 0.144.4");
    expect(versionCallCount()).toBe(2);
    vi.useRealTimers();
  });

  it("process_timeout on the first attempt, success on the second — detection succeeds", async () => {
    vi.useFakeTimers();
    const { spawner, versionCallCount } = versionQueueSpawner([
      new HangingHandle(),
      new ScriptedHandle("codex-cli 0.144.4", 0),
    ]);
    const resultPromise = detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner,
      versionTimeoutMs: 500,
      versionRetryDelayMs: 10,
    });
    await vi.advanceTimersByTimeAsync(600);
    const result = await resultPromise;
    expect(result.availability).not.toBe("unavailable");
    expect(versionCallCount()).toBe(2);
    vi.useRealTimers();
  });

  it("both attempts fail — detection returns unavailable, exactly two attempts occurred, no third attempt", async () => {
    vi.useFakeTimers();
    const { spawner, versionCallCount } = versionQueueSpawner([
      new ErrorHandle(),
      new ErrorHandle(),
    ]);
    const resultPromise = detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner,
      versionRetryDelayMs: 10,
    });
    await vi.advanceTimersByTimeAsync(50);
    const result = await resultPromise;
    expect(result.availability).toBe("unavailable");
    expect(result.diagnosticMessage).toBe("Codex CLI could not be started.");
    expect(versionCallCount()).toBe(2);
    vi.useRealTimers();
  });

  it("executable missing: no --version spawn happens at all, so no meaningless retry occurs", async () => {
    const { spawner, versionCallCount } = versionQueueSpawner([
      new ScriptedHandle("codex-cli 0.144.4", 0),
    ]);
    const result = await detectCodex({
      platform: "linux",
      parentEnv: { PATH: "/usr/bin" },
      fs: fakeFs([]),
      spawner,
    });
    expect(result.availability).toBe("unavailable");
    expect(versionCallCount()).toBe(0);
  });

  it("unsupported version (below the floor): the version process itself succeeded, so no retry occurs", async () => {
    const { spawner, versionCallCount } = versionQueueSpawner([
      new ScriptedHandle("codex-cli 0.1.0", 0),
    ]);
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner,
    });
    expect(result.availability).toBe("unsupported");
    expect(versionCallCount()).toBe(1);
  });

  it("missing required exec --help flag: the version probe itself succeeded, so no retry occurs there", async () => {
    const incompleteHelp = VALID_EXEC_HELP_TEXT.replace("--strict-config\n", "");
    const { spawner, versionCallCount } = versionQueueSpawner(
      [new ScriptedHandle("codex-cli 0.144.4", 0)],
      incompleteHelp,
    );
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner,
    });
    expect(result.availability).toBe("unsupported");
    expect(result.diagnosticMessage).toBe(UNSUPPORTED_ISOLATION_PROFILE_MESSAGE);
    expect(versionCallCount()).toBe(1);
  });

  it("logged-out authentication: the version probe succeeded, so no retry occurs", async () => {
    const { spawner, versionCallCount } = versionQueueSpawner(
      [new ScriptedHandle("codex-cli 0.144.4", 0)],
      VALID_EXEC_HELP_TEXT,
      "Not logged in",
    );
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner,
    });
    expect(result.availability).toBe("logged_out");
    expect(versionCallCount()).toBe(1);
  });

  it("API-key authentication: the version probe succeeded, so no retry occurs", async () => {
    const { spawner, versionCallCount } = versionQueueSpawner(
      [new ScriptedHandle("codex-cli 0.144.4", 0)],
      VALID_EXEC_HELP_TEXT,
      "Logged in using an API key",
    );
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner,
    });
    expect(result.availability).toBe("unsupported");
    expect(result.diagnosticMessage).toBe(NOT_CHATGPT_MESSAGE);
    expect(versionCallCount()).toBe(1);
  });

  it("access-token authentication: the version probe succeeded, so no retry occurs", async () => {
    const { spawner, versionCallCount } = versionQueueSpawner(
      [new ScriptedHandle("codex-cli 0.144.4", 0)],
      VALID_EXEC_HELP_TEXT,
      "Logged in using an access token",
    );
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner,
    });
    expect(result.availability).toBe("unsupported");
    expect(result.diagnosticMessage).toBe(NOT_CHATGPT_MESSAGE);
    expect(versionCallCount()).toBe(1);
  });

  it("ambiguous authentication: the version probe succeeded, so no retry occurs", async () => {
    const { spawner, versionCallCount } = versionQueueSpawner(
      [new ScriptedHandle("codex-cli 0.144.4", 0)],
      VALID_EXEC_HELP_TEXT,
      "some unrecognized status line",
    );
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner,
    });
    expect(result.availability).toBe("unsupported");
    expect(result.diagnosticMessage).toBe(UNVERIFIED_CHATGPT_MESSAGE);
    expect(versionCallCount()).toBe(1);
  });

  it("the retry delay is genuinely bounded — advancing less than the delay never triggers the second attempt", async () => {
    vi.useFakeTimers();
    const { spawner, versionCallCount } = versionQueueSpawner([
      new ErrorHandle(),
      new ScriptedHandle("codex-cli 0.144.4", 0),
    ]);
    const resultPromise = detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner,
      versionRetryDelayMs: 250,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(versionCallCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(versionCallCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(versionCallCount()).toBe(2);
    await resultPromise;
    vi.useRealTimers();
  });

  it("no model invocation occurs anywhere in the retry path — only --version, exec --help, and login status are ever spawned", async () => {
    const calls: string[][] = [];
    const { spawner: base } = versionQueueSpawner([
      new ErrorHandle(),
      new ScriptedHandle("codex-cli 0.144.4", 0),
    ]);
    const spawner: ProcessSpawner = {
      spawn: (exe, args, opts) => {
        calls.push([...args]);
        return base.spawn(exe, args, opts);
      },
    };
    await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner,
      versionRetryDelayMs: 0,
    });
    for (const args of calls) {
      // "exec" only ever appears paired with "--help" (a bounded compatibility
      // scan), never as a real task invocation (which would be "exec" with
      // "--json" and a working-directory/prompt profile — never produced here).
      expect(args.includes("exec") && !args.includes("--help")).toBe(false);
      expect(args).not.toContain("--json");
      const isKnownFreeCommand =
        args.includes("--version") ||
        (args.includes("exec") && args.includes("--help")) ||
        (args.includes("login") && args.includes("status"));
      expect(isKnownFreeCommand).toBe(true);
    }
  });

  it("raw process output from a retried --version probe never reaches the public detection result", async () => {
    class LeakyErrorHandle extends ErrorHandle {
      override onError(callback: (error: Error) => void): void {
        queueMicrotask(() => {
          callback(new Error("secret internal detail: TOKEN=abc123"));
        });
      }
    }
    const { spawner } = versionQueueSpawner([
      new LeakyErrorHandle(),
      new ScriptedHandle("codex-cli 0.144.4", 0),
    ]);
    const result = await detectCodex({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CODEX,
      spawner,
      versionRetryDelayMs: 0,
    });
    expect(JSON.stringify(result)).not.toContain("TOKEN=abc123");
    expect(JSON.stringify(result)).not.toContain("secret internal detail");
  });
});
