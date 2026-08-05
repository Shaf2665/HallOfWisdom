import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { runBoundedProcess } from "./bounded-process.js";
import { buildChildEnvironment } from "./environment.js";
import type { ProcessSpawner } from "./process-spawner.js";
import {
  STRICT_CODEX_SANDBOX_POLICY,
  strictCodexConfigArgs,
  strictCodexFeatureDisableArgs,
} from "./strict-sandbox-policy.js";

export interface CodexSandboxCompatibilityProbeInput {
  readonly executablePath: string;
  readonly spawner: ProcessSpawner;
  readonly parentEnv: Readonly<NodeJS.ProcessEnv>;
  readonly worktreeRoot: string;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface CodexSandboxCompatibilityProbeResult {
  readonly ok: boolean;
  readonly code: string;
}

export interface CodexSandboxCompatibilityProbe {
  run(input: CodexSandboxCompatibilityProbeInput): Promise<CodexSandboxCompatibilityProbeResult>;
}

const PROBE_OK = "HALL_CODEX_SANDBOX_PROBE_OK";
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_OUTPUT_CHARS = 2_000;

export const passingCodexSandboxCompatibilityProbe: CodexSandboxCompatibilityProbe = {
  run: () => Promise.resolve({ ok: true, code: "SANDBOX_PROBE_PASSED" }),
};

export const failingCodexSandboxCompatibilityProbe: CodexSandboxCompatibilityProbe = {
  run: () => Promise.resolve({ ok: false, code: "SANDBOX_PROBE_FAILED" }),
};

export const realCodexSandboxCompatibilityProbe: CodexSandboxCompatibilityProbe = {
  async run(input) {
    let listener: net.Server | undefined;
    const loopbackState = { connectionObserved: false };
    if (!path.isAbsolute(input.worktreeRoot))
      return { ok: false, code: "SANDBOX_PROBE_INVALID_ROOT" };
    const probeRoot = path.resolve(input.worktreeRoot);
    if (!fs.existsSync(probeRoot)) return { ok: false, code: "SANDBOX_PROBE_INVALID_ROOT" };

    const workspace = fs.mkdtempSync(path.join(probeRoot, "_hall_codex_probe_workspace_"));
    const outsideTarget = path.join(
      probeRoot,
      `_hall_codex_probe_outside_${String(process.pid)}_${String(Date.now())}.txt`,
    );
    const outsideBefore = "outside sentinel before";
    fs.writeFileSync(path.join(workspace, "readable.txt"), "readable", "utf8");
    fs.writeFileSync(path.join(workspace, "mutable.txt"), "before", "utf8");
    fs.writeFileSync(path.join(workspace, "delete-me.txt"), "delete", "utf8");
    fs.writeFileSync(outsideTarget, outsideBefore, "utf8");

    try {
      listener = await createLoopbackListener(() => {
        loopbackState.connectionObserved = true;
      });
      const address = listener.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      if (port === undefined) return { ok: false, code: "SANDBOX_PROBE_LOOPBACK_UNAVAILABLE" };

      const result = await runBoundedProcess({
        spawner: input.spawner,
        executablePath: input.executablePath,
        args: [
          "sandbox",
          "-P",
          STRICT_CODEX_SANDBOX_POLICY.sandboxPermissionProfile,
          ...strictCodexConfigArgs(),
          "--sandbox-state-disable-network",
          ...strictCodexFeatureDisableArgs(),
          "-C",
          workspace,
          "--",
          process.execPath,
          "-e",
          SANDBOX_PROBE_SCRIPT,
          outsideTarget,
          String(port),
        ],
        cwd: workspace,
        env: buildChildEnvironment(input.parentEnv),
        timeoutMs: input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
        maxOutputChars: PROBE_MAX_OUTPUT_CHARS,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });

      if (result.spawnError !== undefined) return { ok: false, code: "SANDBOX_PROBE_SPAWN_FAILED" };
      if (result.timedOut) return { ok: false, code: "SANDBOX_PROBE_TIMEOUT" };
      if (result.exitCode !== 0) return { ok: false, code: "SANDBOX_PROBE_COMMAND_FAILED" };
      if (result.stdout.trim() !== PROBE_OK) return { ok: false, code: "SANDBOX_PROBE_UNVERIFIED" };
      if (loopbackState.connectionObserved) {
        return { ok: false, code: "SANDBOX_PROBE_NETWORK_ALLOWED" };
      }
      if (fs.readFileSync(outsideTarget, "utf8") !== outsideBefore) {
        return { ok: false, code: "SANDBOX_PROBE_OUTSIDE_WRITE" };
      }
      return { ok: true, code: "SANDBOX_PROBE_PASSED" };
    } catch {
      return { ok: false, code: "SANDBOX_PROBE_UNEXPECTED_FAILURE" };
    } finally {
      await closeListener(listener);
      removeGeneratedProbePath(workspace, probeRoot);
      removeGeneratedProbeFile(outsideTarget, probeRoot);
    }
  },
};

const SANDBOX_PROBE_SCRIPT = String.raw`
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const outsideTarget = process.argv[1];
const loopbackPort = Number(process.argv[2]);

function fail(code) {
  process.stdout.write(code);
  process.exit(1);
}

try {
  if (fs.readFileSync(path.join(process.cwd(), "readable.txt"), "utf8") !== "readable") fail("READ_FAILED");
  fs.writeFileSync(path.join(process.cwd(), "created.txt"), "created", "utf8");
  fs.writeFileSync(path.join(process.cwd(), "mutable.txt"), "after", "utf8");
  fs.unlinkSync(path.join(process.cwd(), "delete-me.txt"));
  try {
    fs.writeFileSync(outsideTarget, "outside", "utf8");
    fail("OUTSIDE_WRITE_ALLOWED");
  } catch {
    // Expected: the workspace sandbox denies writes outside cwd.
  }
} catch {
  fail("INSIDE_WRITE_FAILED");
}

const socket = net.connect({ host: "127.0.0.1", port: loopbackPort });
let settled = false;
function ok() {
  if (settled) return;
  settled = true;
  socket.destroy();
  process.stdout.write("HALL_CODEX_SANDBOX_PROBE_OK");
}
socket.setTimeout(1000, ok);
socket.on("error", ok);
socket.on("connect", () => fail("NETWORK_ALLOWED"));
`;

function createLoopbackListener(onConnection: () => void): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      onConnection();
      socket.destroy();
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function closeListener(server: net.Server | undefined): Promise<void> {
  if (server === undefined) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

function removeGeneratedProbePath(candidate: string, root: string): void {
  const resolved = path.resolve(candidate);
  const rootResolved = path.resolve(root);
  const relative = path.relative(rootResolved, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.length === 0) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

function removeGeneratedProbeFile(candidate: string, root: string): void {
  const resolved = path.resolve(candidate);
  const rootResolved = path.resolve(root);
  const relative = path.relative(rootResolved, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.length === 0) return;
  fs.rmSync(resolved, { force: true });
}
