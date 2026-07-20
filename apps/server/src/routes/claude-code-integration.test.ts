import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeCodeAdapter,
  type ProcessSpawner,
  type SpawnedProcessHandle,
  type FileSystemProbe,
} from "@hall-of-wisdom/claude-code-adapter";
import { buildTestApp, validCreateTaskBody } from "../test-support.js";

interface AdapterSummaryJson {
  readonly adapterId: string;
  readonly availability: string;
}

// Verifies Claude Code coexists with Mock Agent through Hall Core's
// existing, provider-neutral surface — no code in this test file or in
// any generic route/orchestrator module ever branches on adapterId. See
// docs/architecture/0008-claude-code-adapter.md, "Hall Core integration".

class ScriptedHandle implements SpawnedProcessHandle {
  readonly pid = 7777;
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

function fakeFs(existingPaths: readonly string[]): FileSystemProbe {
  const set = new Set(existingPaths.map((p) => p.toLowerCase()));
  return { isFile: (p) => set.has(p.toLowerCase()) };
}

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

/** Keyed on the invoked args, not call order — robust against the adapter's own detection call count/order changing. */
function scriptedSpawner(
  versionStdout: string,
  authStdout: string,
  authExitCode = 0,
): ProcessSpawner {
  return {
    spawn: (_executablePath, args) => {
      if (args.includes("--version")) return new ScriptedHandle(versionStdout, 0);
      if (args.includes("--help")) return new ScriptedHandle(VALID_HELP_TEXT, 0);
      if (args.includes("auth") && args.includes("status")) {
        return new ScriptedHandle(authStdout, authExitCode);
      }
      return new ScriptedHandle("", 0);
    },
  };
}

const AVAILABLE_AUTH = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  subscriptionType: "pro",
});

function availableClaudeAdapter(): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    platform: "linux",
    parentEnv: { PATH: "/usr/local/bin" },
    fs: fakeFs(["/usr/local/bin/claude"]),
    spawner: scriptedSpawner("2.1.212", AVAILABLE_AUTH),
  });
}

function unavailableClaudeAdapter(): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    platform: "linux",
    parentEnv: { PATH: "/usr/bin" },
    fs: fakeFs([]),
    spawner: scriptedSpawner("", ""),
  });
}

let cleanupApp: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanupApp?.();
  cleanupApp = undefined;
});

describe("Hall Core adapter discovery — Claude Code coexistence", () => {
  it("lists both Mock Agent and Claude Code (available) via GET /api/v1/adapters", async () => {
    const { app } = await buildTestApp({
      workspaceRoot: process.cwd(),
      additionalAdapters: [availableClaudeAdapter()],
    });
    cleanupApp = () => app.close();

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ adapters: AdapterSummaryJson[] }>();
    const adapterIds = body.adapters.map((a) => a.adapterId);
    expect(adapterIds).toContain("hall.mock-agent");
    expect(adapterIds).toContain("hall.claude-code");
    const claude = body.adapters.find((a) => a.adapterId === "hall.claude-code");
    expect(claude?.availability).toBe("available");
  });

  it("lists Claude Code as unavailable without breaking Mock Agent's listing", async () => {
    const { app } = await buildTestApp({
      workspaceRoot: process.cwd(),
      additionalAdapters: [unavailableClaudeAdapter()],
    });
    cleanupApp = () => app.close();

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    const body = response.json<{ adapters: AdapterSummaryJson[] }>();
    const claude = body.adapters.find((a) => a.adapterId === "hall.claude-code");
    const mock = body.adapters.find((a) => a.adapterId === "hall.mock-agent");
    expect(claude?.availability).toBe("unavailable");
    expect(mock?.availability).toBe("available");
  });

  it("never exposes an executable path or raw auth diagnostic in the adapter list response", async () => {
    const { app } = await buildTestApp({
      workspaceRoot: process.cwd(),
      additionalAdapters: [availableClaudeAdapter()],
    });
    cleanupApp = () => app.close();

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    const raw = response.body;
    expect(raw).not.toContain("/usr/local/bin/claude");
    expect(raw).not.toContain("diagnosticMessage");
    expect(raw).not.toContain("executablePath");
  });

  it("Mock Agent remains registered and assignable when Claude Code is also registered", async () => {
    const { app } = await buildTestApp({
      workspaceRoot: process.cwd(),
      additionalAdapters: [availableClaudeAdapter()],
    });
    cleanupApp = () => app.close();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validCreateTaskBody(),
    });
    expect(response.statusCode).toBe(202);
  });

  it("no Claude-specific field exists on the generic task-creation request contract", async () => {
    const { app } = await buildTestApp({
      workspaceRoot: process.cwd(),
      additionalAdapters: [availableClaudeAdapter()],
    });
    cleanupApp = () => app.close();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validCreateTaskBody({ claudePermissionMode: "dontAsk", claudeModel: "sonnet" }),
    });
    // Unknown fields are rejected by the strict create-task schema exactly
    // as any other unrecognized field would be — no special-cased
    // provider field exists to accept.
    expect(response.statusCode).toBe(400);
  });
});
