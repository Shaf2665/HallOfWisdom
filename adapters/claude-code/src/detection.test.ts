import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { detectClaudeCode } from "./detection.js";
import type { ProcessSpawner, SpawnedProcessHandle } from "./process-spawner.js";
import type { FileSystemProbe } from "./executable-resolver.js";

class ScriptedHandle implements SpawnedProcessHandle {
  readonly pid = 1234;
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
    // not used by these fixtures
  }
  kill(): boolean {
    return true;
  }
}

/**
 * A fake --help response containing every flag verifyIsolationFlagSupport
 * requires — used by default so every existing test below keeps exercising
 * the auth-verification path without needing to know about the
 * isolation-flag-support check Phase 9.1 inserted between --version and
 * auth status.
 */
const VALID_HELP_TEXT = [
  "--safe-mode",
  "--no-chrome",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--permission-mode",
  "--allowedTools",
  "--disallowedTools",
  "--tools",
  '--output-format <format> (choices: "text", "json", "stream-json")',
].join("\n");

/**
 * A spawner keyed on the invoked args, not call order/index — robust
 * against detection.ts adding, removing, or reordering its own bounded
 * process calls (Phase 9.1 added a --help call between --version and
 * auth status; keying on call index would have silently fed the wrong
 * fixture to the wrong call).
 */
function scriptedSpawner(
  versionStdout: string,
  authStdout: string,
  authExitCode = 0,
  helpText: string = VALID_HELP_TEXT,
): ProcessSpawner {
  return {
    spawn: (_executablePath, args) => {
      if (args.includes("--version")) return new ScriptedHandle(versionStdout, 0);
      if (args.includes("--help")) return new ScriptedHandle(helpText, 0);
      if (args.includes("auth") && args.includes("status")) {
        return new ScriptedHandle(authStdout, authExitCode);
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
const FS_WITH_CLAUDE = fakeFs(["/usr/local/bin/claude"]);

describe("detectClaudeCode — executable resolution", () => {
  it("reports unavailable when the executable is not found", async () => {
    const result = await detectClaudeCode({
      platform: "linux",
      parentEnv: { PATH: "/usr/bin" },
      fs: fakeFs([]),
      spawner: scriptedSpawner("", ""),
    });
    expect(result.installed).toBe(false);
    expect(result.availability).toBe("unavailable");
    expect(result.diagnosticMessage).toBe("Claude Code CLI was not found on PATH.");
    expect(result.executionTrust).toBe("unavailable");
  });

  it("reports unsupported when only a Windows shim is found", async () => {
    const result = await detectClaudeCode({
      platform: "win32",
      parentEnv: { PATH: "C:\\npm\\shim" },
      fs: fakeFs(["C:\\npm\\shim\\claude.cmd"]),
      spawner: scriptedSpawner("", ""),
    });
    expect(result.installed).toBe(true);
    expect(result.availability).toBe("unsupported");
  });

  it("never returns an executablePath", async () => {
    const result = await detectClaudeCode({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CLAUDE,
      spawner: scriptedSpawner(
        "2.1.212 (Claude Code)",
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          subscriptionType: "pro",
        }),
      ),
    });
    expect(result.executablePath).toBeUndefined();
  });
});

describe("detectClaudeCode — subscription verification", () => {
  it("reports available for verified claude.ai subscription auth (pro)", async () => {
    const result = await detectClaudeCode({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CLAUDE,
      spawner: scriptedSpawner(
        "2.1.212 (Claude Code)",
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          email: "user@example.com",
          orgId: "org-should-never-appear",
          orgName: "Should Never Appear Org",
          subscriptionType: "pro",
        }),
      ),
    });
    expect(result.availability).toBe("available");
    expect(result.installed).toBe(true);
    expect(result.detectedVersion).toBe("2.1.212 (Claude Code)");
    expect(JSON.stringify(result)).not.toContain("example.com");
    expect(JSON.stringify(result)).not.toContain("org-should-never-appear");
    expect(JSON.stringify(result)).not.toContain("Should Never Appear Org");
    // Phase 11
    expect(result.executionTrust).toBe("isolated");
    const projectEdit = result.capabilityObservations?.find((o) => o.capability === "project.edit");
    expect(projectEdit?.status).toBe("verified");
    expect(projectEdit?.evidence).toBe("isolated_smoke_test");
    const sessionResume = result.capabilityObservations?.find(
      (o) => o.capability === "session.resume",
    );
    expect(sessionResume?.status).toBe("unsupported");
  });

  it("reports available for max/team/enterprise subscription types (case-insensitive)", async () => {
    for (const subscriptionType of ["max", "TEAM", "Enterprise"]) {
      const result = await detectClaudeCode({
        platform: "linux",
        parentEnv: FOUND_ENV,
        fs: FS_WITH_CLAUDE,
        spawner: scriptedSpawner(
          "2.1.212",
          JSON.stringify({
            loggedIn: true,
            authMethod: "claude.ai",
            apiProvider: "firstParty",
            subscriptionType,
          }),
        ),
      });
      expect(result.availability).toBe("available");
    }
  });

  it("reports logged_out when loggedIn is false", async () => {
    const result = await detectClaudeCode({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CLAUDE,
      spawner: scriptedSpawner("2.1.212", JSON.stringify({ loggedIn: false })),
    });
    expect(result.availability).toBe("logged_out");
    expect(result.executionTrust).toBe("unavailable");
  });

  it("fails closed (unsupported) for API-key authentication", async () => {
    const result = await detectClaudeCode({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CLAUDE,
      spawner: scriptedSpawner(
        "2.1.212",
        JSON.stringify({ loggedIn: true, authMethod: "apiKey", apiProvider: "firstParty" }),
      ),
    });
    expect(result.availability).toBe("unsupported");
  });

  it("fails closed for Bedrock authentication", async () => {
    const result = await detectClaudeCode({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CLAUDE,
      spawner: scriptedSpawner(
        "2.1.212",
        JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "bedrock" }),
      ),
    });
    expect(result.availability).toBe("unsupported");
  });

  it("fails closed for Vertex authentication", async () => {
    const result = await detectClaudeCode({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CLAUDE,
      spawner: scriptedSpawner(
        "2.1.212",
        JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "vertex" }),
      ),
    });
    expect(result.availability).toBe("unsupported");
  });

  it("fails closed for Foundry authentication", async () => {
    const result = await detectClaudeCode({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CLAUDE,
      spawner: scriptedSpawner(
        "2.1.212",
        JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "foundry" }),
      ),
    });
    expect(result.availability).toBe("unsupported");
  });

  it("fails closed when authMethod/apiProvider are present but ambiguous (no subscriptionType)", async () => {
    const result = await detectClaudeCode({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CLAUDE,
      spawner: scriptedSpawner(
        "2.1.212",
        JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }),
      ),
    });
    expect(result.availability).toBe("unsupported");
  });

  it("fails closed on an unrecognized subscriptionType", async () => {
    const result = await detectClaudeCode({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CLAUDE,
      spawner: scriptedSpawner(
        "2.1.212",
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          subscriptionType: "some_future_tier",
        }),
      ),
    });
    expect(result.availability).toBe("unsupported");
  });

  it("fails closed on malformed JSON from auth status", async () => {
    const result = await detectClaudeCode({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CLAUDE,
      spawner: scriptedSpawner("2.1.212", "not json"),
    });
    expect(result.availability).toBe("unsupported");
    expect(result.diagnosticMessage).toBe(
      "Claude Code authentication could not be verified as subscription-based.",
    );
  });

  it("fails closed when auth status exits non-zero", async () => {
    const result = await detectClaudeCode({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CLAUDE,
      spawner: scriptedSpawner("2.1.212", "{}", 1),
    });
    // exitCode !== 0 falls through JSON parse (may fail) or schema check;
    // either way this must not report available.
    expect(result.availability).not.toBe("available");
  });

  it("uses the exact safe diagnostic message for unverified subscription auth", async () => {
    const result = await detectClaudeCode({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CLAUDE,
      spawner: scriptedSpawner("2.1.212", JSON.stringify({ loggedIn: true, authMethod: "apiKey" })),
    });
    expect(result.diagnosticMessage).toBe(
      "Claude Code authentication could not be verified as subscription-based.",
    );
  });
});

describe("detectClaudeCode — isolation-flag support (Phase 9.1)", () => {
  it("reports unsupported with the fixed diagnostic when --help is missing a required flag", async () => {
    const incompleteHelp = VALID_HELP_TEXT.replace("--safe-mode\n", "");
    const result = await detectClaudeCode({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CLAUDE,
      spawner: scriptedSpawner(
        "2.1.212",
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          subscriptionType: "pro",
        }),
        0,
        incompleteHelp,
      ),
    });
    expect(result.availability).toBe("unsupported");
    expect(result.diagnosticMessage).toBe(
      "Installed Claude Code does not support the required isolated execution profile.",
    );
  });

  it("reports unsupported for a version below the documented minimum, without spawning --help or auth status", async () => {
    let helpOrAuthSpawned = false;
    const spawner: ProcessSpawner = {
      spawn: (_executablePath, args) => {
        if (args.includes("--version")) return new ScriptedHandle("1.0.0", 0);
        helpOrAuthSpawned = true;
        return new ScriptedHandle("", 0);
      },
    };
    const result = await detectClaudeCode({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CLAUDE,
      spawner,
    });
    expect(result.availability).toBe("unsupported");
    expect(helpOrAuthSpawned).toBe(false);
  });

  it("does not fall back to a less secure invocation when isolation flags cannot be verified", async () => {
    // Even with a fully valid subscription auth response available, an
    // unsupported isolation profile must still win — detection never
    // reaches (or reports) "available" by skipping the flag check.
    const incompleteHelp = VALID_HELP_TEXT.replace("--strict-mcp-config\n", "");
    const result = await detectClaudeCode({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CLAUDE,
      spawner: scriptedSpawner(
        "2.1.212",
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          subscriptionType: "pro",
        }),
        0,
        incompleteHelp,
      ),
    });
    expect(result.availability).not.toBe("available");
  });
});

describe("detectClaudeCode — diagnostic safety", () => {
  it("never includes raw auth JSON, email, or org identifiers in any field", async () => {
    const result = await detectClaudeCode({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CLAUDE,
      spawner: scriptedSpawner(
        "2.1.212",
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          subscriptionType: "pro",
          email: "leak@example.com",
          orgId: "org-leak-id",
          orgName: "Leak Org Name",
        }),
      ),
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("leak@example.com");
    expect(serialized).not.toContain("org-leak-id");
    expect(serialized).not.toContain("Leak Org Name");
  });

  it("bounds detectedVersion length", async () => {
    const result = await detectClaudeCode({
      platform: "linux",
      parentEnv: FOUND_ENV,
      fs: FS_WITH_CLAUDE,
      spawner: scriptedSpawner(
        "x".repeat(500),
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          subscriptionType: "pro",
        }),
      ),
    });
    expect((result.detectedVersion ?? "").length).toBeLessThanOrEqual(64);
  });
});
