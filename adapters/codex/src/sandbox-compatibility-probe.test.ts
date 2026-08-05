import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { realCodexSandboxCompatibilityProbe } from "./sandbox-compatibility-probe.js";
import type { ProcessSpawner, SpawnedProcessHandle } from "./process-spawner.js";

class ProbeHandle implements SpawnedProcessHandle {
  readonly pid = 123;
  readonly stdoutEmitter = new EventEmitter();
  readonly stderrEmitter = new EventEmitter();
  readonly stdout = this.stdoutEmitter as unknown as NodeJS.ReadableStream;
  readonly stderr = this.stderrEmitter as unknown as NodeJS.ReadableStream;
  readonly stdin = { end: () => undefined, write: () => true } as unknown as NodeJS.WritableStream;

  constructor(
    private readonly stdoutText: string,
    private readonly exitCode: number | null = 0,
    private readonly exitDelayMs = 0,
  ) {}

  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    setTimeout(() => {
      if (this.stdoutText.length > 0) {
        this.stdoutEmitter.emit("data", Buffer.from(this.stdoutText, "utf8"));
      }
      callback(this.exitCode, null);
    }, this.exitDelayMs);
  }

  onError(): void {
    // Not used by these fixtures.
  }

  kill(): boolean {
    return true;
  }
}

describe("realCodexSandboxCompatibilityProbe", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hall-codex-probe-test-"));
    roots.push(root);
    return root;
  }

  it("uses the installed sandbox helper with workspace profile, network disabled, and feature disables", async () => {
    const mutableCalls: string[][] = [];
    const spawner: ProcessSpawner = {
      spawn: (_executablePath, args) => {
        mutableCalls.push([...args]);
        return new ProbeHandle("HALL_CODEX_SANDBOX_PROBE_OK", 0);
      },
    };
    const result = await realCodexSandboxCompatibilityProbe.run({
      executablePath: "codex",
      spawner,
      parentEnv: { PATH: "/usr/local/bin" },
      worktreeRoot: makeRoot(),
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(true);
    const [args] = mutableCalls;
    expect(args).toContain("sandbox");
    expect(args).toContain("-P");
    expect(args).toContain(":workspace");
    expect(args).toContain("sandbox_workspace_write.network_access=false");
    expect(args).toContain("--sandbox-state-disable-network");
    expect(args).toContain("--disable");
    expect(args).toContain("hooks");
    expect(args).toContain("plugins");
    expect(args).toContain("remote_plugin");
    expect(args).toContain("multi_agent");
    expect(args).toContain("apps");
    expect(args).toContain("browser_use");
    expect(args).toContain("browser_use_external");
    expect(args).toContain("browser_use_full_cdp_access");
    expect(args).toContain("computer_use");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--yolo");
    expect(args).not.toContain("danger-full-access");
  });

  it("fails closed when the sandboxed command cannot write inside the workspace", async () => {
    const spawner: ProcessSpawner = {
      spawn: () => new ProbeHandle("INSIDE_WRITE_FAILED", 1),
    };
    const result = await realCodexSandboxCompatibilityProbe.run({
      executablePath: "codex",
      spawner,
      parentEnv: { PATH: "/usr/local/bin" },
      worktreeRoot: makeRoot(),
      timeoutMs: 1000,
    });
    expect(result).toEqual({ ok: false, code: "SANDBOX_PROBE_COMMAND_FAILED" });
  });

  it("fails closed when the outside-write sentinel appears", async () => {
    const spawner: ProcessSpawner = {
      spawn: (_executablePath, args) => {
        const outsideTarget = args.at(-2);
        if (outsideTarget !== undefined) fs.writeFileSync(outsideTarget, "outside", "utf8");
        return new ProbeHandle("HALL_CODEX_SANDBOX_PROBE_OK", 0);
      },
    };
    const result = await realCodexSandboxCompatibilityProbe.run({
      executablePath: "codex",
      spawner,
      parentEnv: { PATH: "/usr/local/bin" },
      worktreeRoot: makeRoot(),
      timeoutMs: 1000,
    });
    expect(result).toEqual({ ok: false, code: "SANDBOX_PROBE_OUTSIDE_WRITE" });
  });

  it("fails closed when loopback networking reaches the parent listener and closes the listener", async () => {
    let observedPort: number | undefined;
    const spawner: ProcessSpawner = {
      spawn: (_executablePath, args) => {
        const port = Number(args.at(-1));
        observedPort = port;
        const socket = net.connect({ host: "127.0.0.1", port });
        socket.on("error", () => undefined);
        socket.on("connect", () => {
          socket.destroy();
        });
        return new ProbeHandle("HALL_CODEX_SANDBOX_PROBE_OK", 0, 25);
      },
    };
    const result = await realCodexSandboxCompatibilityProbe.run({
      executablePath: "codex",
      spawner,
      parentEnv: { PATH: "/usr/local/bin" },
      worktreeRoot: makeRoot(),
      timeoutMs: 1000,
    });
    expect(result).toEqual({ ok: false, code: "SANDBOX_PROBE_NETWORK_ALLOWED" });
    await expectLoopbackClosed(observedPort);
  });

  it("does not expose raw sandbox output in the bounded failure result", async () => {
    const spawner: ProcessSpawner = {
      spawn: () => new ProbeHandle("secret absolute path C:\\Users\\operator\\.codex", 0),
    };
    const result = await realCodexSandboxCompatibilityProbe.run({
      executablePath: "codex",
      spawner,
      parentEnv: { PATH: "/usr/local/bin" },
      worktreeRoot: makeRoot(),
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("operator");
    expect(JSON.stringify(result)).not.toContain(".codex");
  });
});

async function expectLoopbackClosed(port: number | undefined): Promise<void> {
  expect(port).toBeDefined();
  if (port === undefined) return;
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("loopback listener was still reachable"));
    }, 100);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error("loopback listener was still reachable"));
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
