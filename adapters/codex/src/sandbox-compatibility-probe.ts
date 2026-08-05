import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runBoundedProcess } from "./bounded-process.js";
import { buildChildEnvironment } from "./environment.js";
import type { ProcessSpawner } from "./process-spawner.js";

export interface CodexSandboxCompatibilityProbeInput {
  readonly executablePath: string;
  readonly spawner: ProcessSpawner;
  readonly parentEnv: Readonly<NodeJS.ProcessEnv>;
  readonly timeoutMs?: number | undefined;
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
    const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), "hall-codex-sandbox-probe-"));
    const workspace = path.join(tempParent, "workspace with spaces");
    const outside = path.join(tempParent, "outside");
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(workspace, "readable.txt"), "readable", "utf8");
    fs.writeFileSync(path.join(workspace, "mutable.txt"), "before", "utf8");
    fs.writeFileSync(path.join(workspace, "delete-me.txt"), "delete", "utf8");
    const outsideTarget = path.join(outside, "escape.txt");

    try {
      const result = await runBoundedProcess({
        spawner: input.spawner,
        executablePath: input.executablePath,
        args: [
          "sandbox",
          "-P",
          ":workspace",
          "-c",
          "sandbox_workspace_write.network_access=false",
          "--disable",
          "hooks",
          "--disable",
          "plugins",
          "--disable",
          "plugin_sharing",
          "--disable",
          "remote_plugin",
          "--disable",
          "multi_agent",
          "--disable",
          "apps",
          "--disable",
          "browser_use",
          "--disable",
          "browser_use_external",
          "--disable",
          "browser_use_full_cdp_access",
          "--disable",
          "computer_use",
          "-C",
          workspace,
          "--",
          process.execPath,
          "-e",
          SANDBOX_PROBE_SCRIPT,
          outsideTarget,
        ],
        cwd: workspace,
        env: buildChildEnvironment(input.parentEnv),
        timeoutMs: input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
        maxOutputChars: PROBE_MAX_OUTPUT_CHARS,
      });

      if (result.spawnError !== undefined) return { ok: false, code: "SANDBOX_PROBE_SPAWN_FAILED" };
      if (result.timedOut) return { ok: false, code: "SANDBOX_PROBE_TIMEOUT" };
      if (result.exitCode !== 0) return { ok: false, code: "SANDBOX_PROBE_COMMAND_FAILED" };
      if (result.stdout.trim() !== PROBE_OK) return { ok: false, code: "SANDBOX_PROBE_UNVERIFIED" };
      if (fs.existsSync(outsideTarget)) return { ok: false, code: "SANDBOX_PROBE_OUTSIDE_WRITE" };
      return { ok: true, code: "SANDBOX_PROBE_PASSED" };
    } catch {
      return { ok: false, code: "SANDBOX_PROBE_UNEXPECTED_FAILURE" };
    } finally {
      removeGeneratedTempTree(tempParent);
    }
  },
};

const SANDBOX_PROBE_SCRIPT = String.raw`
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const outsideTarget = process.argv[1];

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

const socket = net.connect({ host: "1.1.1.1", port: 80 });
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

function removeGeneratedTempTree(candidate: string): void {
  const resolved = path.resolve(candidate);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.length === 0) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}
