import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexAdapter,
  type ProcessSpawner,
  type SpawnedProcessHandle,
  type FileSystemProbe,
} from "@hall-of-wisdom/codex-adapter";
import { ClaudeCodeAdapter } from "@hall-of-wisdom/claude-code-adapter";
import { buildTestApp, validCreateTaskBody } from "../test-support.js";

interface AdapterSummaryJson {
  readonly adapterId: string;
  readonly availability: string;
}

// Verifies Codex coexists with Mock Agent and Claude Code through Hall
// Core's existing, provider-neutral surface — no code in this test file
// or in any generic route/orchestrator module ever branches on
// adapterId. See docs/architecture/0009-codex-adapter.md, "Hall Core
// integration".

class ScriptedHandle implements SpawnedProcessHandle {
  readonly pid = 8888;
  readonly stdoutEmitter = new EventEmitter();
  readonly stderrEmitter = new EventEmitter();
  readonly stdout = this.stdoutEmitter as unknown as NodeJS.ReadableStream;
  readonly stderr = this.stderrEmitter as unknown as NodeJS.ReadableStream;
  readonly stdin = {
    end: () => undefined,
    write: () => true,
    on: () => undefined,
  } as unknown as NodeJS.WritableStream;
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

function scriptedSpawner(
  versionStdout: string,
  loginStatusText: string,
  loginExitCode = 0,
): ProcessSpawner {
  return {
    spawn: (_executablePath, args) => {
      if (args.includes("--version")) return new ScriptedHandle(versionStdout, 0);
      if (args.includes("exec") && args.includes("--help"))
        return new ScriptedHandle(VALID_EXEC_HELP_TEXT, 0);
      if (args.includes("login") && args.includes("status")) {
        return new ScriptedHandle("", loginExitCode, loginStatusText);
      }
      return new ScriptedHandle("", 0);
    },
  };
}

function fullyAuthenticatedCodexAdapter(): CodexAdapter {
  return new CodexAdapter({
    platform: "linux",
    parentEnv: { PATH: "/usr/local/bin" },
    fs: fakeFs(["/usr/local/bin/codex"]),
    spawner: scriptedSpawner("codex-cli 0.144.4", "Logged in using ChatGPT"),
  });
}

function unavailableCodexAdapter(): CodexAdapter {
  return new CodexAdapter({
    platform: "linux",
    parentEnv: { PATH: "/usr/bin" },
    fs: fakeFs([]),
    spawner: scriptedSpawner("", ""),
  });
}

function loggedOutCodexAdapter(): CodexAdapter {
  return new CodexAdapter({
    platform: "linux",
    parentEnv: { PATH: "/usr/local/bin" },
    fs: fakeFs(["/usr/local/bin/codex"]),
    spawner: scriptedSpawner("codex-cli 0.144.4", "Not logged in"),
  });
}

function apiKeyCodexAdapter(): CodexAdapter {
  return new CodexAdapter({
    platform: "linux",
    parentEnv: { PATH: "/usr/local/bin" },
    fs: fakeFs(["/usr/local/bin/codex"]),
    spawner: scriptedSpawner("codex-cli 0.144.4", "Logged in using an API key"),
  });
}

function fakeClaudeAdapter(): ClaudeCodeAdapter {
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

describe("Hall Core adapter discovery — Codex coexistence", () => {
  it(
    "lists Mock Agent, Claude Code, and Codex via GET /api/v1/adapters — Phase 10.1: Codex " +
      "reports 'unsupported', never 'available', even with fully valid CLI/ChatGPT-auth, since " +
      "file-edit execution capability remains unverified",
    async () => {
      const { app } = await buildTestApp({
        workspaceRoot: process.cwd(),
        additionalAdapters: [fakeClaudeAdapter(), fullyAuthenticatedCodexAdapter()],
      });
      cleanupApp = () => app.close();

      const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ adapters: AdapterSummaryJson[] }>();
      const adapterIds = body.adapters.map((a) => a.adapterId);
      expect(adapterIds).toContain("hall.mock-agent");
      expect(adapterIds).toContain("hall.claude-code");
      expect(adapterIds).toContain("hall.codex");
      const codex = body.adapters.find((a) => a.adapterId === "hall.codex");
      expect(codex?.availability).toBe("unsupported");
      expect(codex?.availability).not.toBe("available");
    },
  );

  it("lists Codex as unavailable without breaking Mock Agent or Claude Code's listing", async () => {
    const { app } = await buildTestApp({
      workspaceRoot: process.cwd(),
      additionalAdapters: [fakeClaudeAdapter(), unavailableCodexAdapter()],
    });
    cleanupApp = () => app.close();

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    const body = response.json<{ adapters: AdapterSummaryJson[] }>();
    const codex = body.adapters.find((a) => a.adapterId === "hall.codex");
    const mock = body.adapters.find((a) => a.adapterId === "hall.mock-agent");
    expect(codex?.availability).toBe("unavailable");
    expect(mock?.availability).toBe("available");
  });

  it("lists Codex as unavailable (logged out) without exposing that detail beyond availability", async () => {
    const { app } = await buildTestApp({
      workspaceRoot: process.cwd(),
      additionalAdapters: [loggedOutCodexAdapter()],
    });
    cleanupApp = () => app.close();

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    const body = response.json<{ adapters: AdapterSummaryJson[] }>();
    const codex = body.adapters.find((a) => a.adapterId === "hall.codex");
    expect(codex?.availability).toBe("logged_out");
  });

  it("lists a non-ChatGPT (API-key) authenticated Codex as unsupported, not available", async () => {
    const { app } = await buildTestApp({
      workspaceRoot: process.cwd(),
      additionalAdapters: [apiKeyCodexAdapter()],
    });
    cleanupApp = () => app.close();

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    const body = response.json<{ adapters: AdapterSummaryJson[] }>();
    const codex = body.adapters.find((a) => a.adapterId === "hall.codex");
    expect(codex?.availability).toBe("unsupported");
  });

  it("never exposes an executable path, CODEX_HOME, or raw login diagnostic in the adapter list response", async () => {
    const { app } = await buildTestApp({
      workspaceRoot: process.cwd(),
      additionalAdapters: [fullyAuthenticatedCodexAdapter()],
    });
    cleanupApp = () => app.close();

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    const raw = response.body;
    expect(raw).not.toContain("/usr/local/bin/codex");
    expect(raw).not.toContain("CODEX_HOME");
    expect(raw).not.toContain("diagnosticMessage");
    expect(raw).not.toContain("executablePath");
  });

  it("Mock Agent remains registered and assignable when Codex is also registered", async () => {
    const { app } = await buildTestApp({
      workspaceRoot: process.cwd(),
      additionalAdapters: [fullyAuthenticatedCodexAdapter()],
    });
    cleanupApp = () => app.close();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validCreateTaskBody(),
    });
    expect(response.statusCode).toBe(202);
  });

  it("no Codex-specific field exists on the generic task-creation request contract", async () => {
    const { app } = await buildTestApp({
      workspaceRoot: process.cwd(),
      additionalAdapters: [fullyAuthenticatedCodexAdapter()],
    });
    cleanupApp = () => app.close();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validCreateTaskBody({ codexSandboxMode: "workspace-write", codexModel: "gpt-5.5" }),
    });
    expect(response.statusCode).toBe(400);
  });
});
