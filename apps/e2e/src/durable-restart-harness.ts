import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DURABLE_RESTART_HALL_CORE_PORT,
  DURABLE_RESTART_WEB_PORT,
} from "./durable-restart-constants.js";

const FIXTURE_SERVER_DIST_PATH = fileURLToPath(
  new URL("../dist/fixture-server.js", import.meta.url),
);

/**
 * Process management for `tests/durable-restart.spec.ts` only — never
 * imported by any other spec. This module has no top-level side effects
 * (no `main()`, nothing runs on import) — see `fixture-constants.ts`'s
 * doc comment for why that discipline matters in this directory.
 *
 * Deliberately spawns the actual built `dist/server.js` binary as a real
 * OS child process, and a genuinely separate `next dev` process for Hall
 * Web (never the shared `webServer`-managed pair on 3000/4310) — the spec
 * needs to stop and restart Hall Core mid-test while Hall Web and the
 * browser stay open, which the shared, Playwright-owned pair's lifecycle
 * cannot support without risking the exact `EADDRINUSE` class of bug this
 * repository already found and fixed once (see `fixture-constants.ts`).
 */

const DIST_SERVER_PATH = fileURLToPath(new URL("../../server/dist/server.js", import.meta.url));
const NEXT_BIN_PATH = fileURLToPath(
  new URL("../../web/node_modules/next/dist/bin/next", import.meta.url),
);
const WEB_APP_DIR = fileURLToPath(new URL("../../web", import.meta.url));

/** Throws a clear, actionable error rather than letting the spec hang or fail obscurely when prerequisites are missing. */
export function requireDurableRestartBuildArtifacts(): void {
  if (!fs.existsSync(DIST_SERVER_PATH)) {
    throw new Error(
      `dist/server.js not found at "${DIST_SERVER_PATH}". Run "pnpm --filter @hall-of-wisdom/hall-core run build" first.`,
    );
  }
  if (!fs.existsSync(NEXT_BIN_PATH)) {
    throw new Error(
      `Next.js binary not found at "${NEXT_BIN_PATH}". Run "pnpm install" at the repository root first.`,
    );
  }
}

/** Same idea as `requireDurableRestartBuildArtifacts`, for the dual-fixture spec's own prerequisites. */
export function requireDualFixtureDurableRestartBuildArtifacts(): void {
  if (!fs.existsSync(FIXTURE_SERVER_DIST_PATH)) {
    throw new Error(
      `dist/fixture-server.js not found at "${FIXTURE_SERVER_DIST_PATH}". Run "pnpm --filter @hall-of-wisdom/e2e run build" first.`,
    );
  }
  if (!fs.existsSync(NEXT_BIN_PATH)) {
    throw new Error(
      `Next.js binary not found at "${NEXT_BIN_PATH}". Run "pnpm install" at the repository root first.`,
    );
  }
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil: condition not met within ${String(timeoutMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function waitForHallCoreHealth(port: number, timeoutMs = 20000): Promise<void> {
  await waitUntil(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/v1/health`);
      return response.status === 200;
    } catch {
      return false;
    }
  }, timeoutMs);
}

export async function waitForHallWebReady(port: number, timeoutMs = 90000): Promise<void> {
  await waitUntil(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/system`);
      return response.status === 200;
    } catch {
      return false;
    }
  }, timeoutMs);
}

export async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });
}

export async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitForExit(child);
  }
}

export interface SpawnedHallCore {
  readonly child: ChildProcess;
  readonly port: number;
  /**
   * Sends the graceful-shutdown stdin command (`installShutdownSignals`'s
   * `installStdinShutdownTrigger`, added in Phase 13.1 specifically
   * because Windows cannot deliver a real SIGINT/SIGTERM from a parent
   * Node process to a child Node process — see
   * `apps/server/src/process/signal-shutdown.ts`'s doc comment for the
   * empirical confirmation) and waits for the process to fully exit.
   */
  gracefulStop(): Promise<void>;
}

export interface SpawnDurableHallCoreOptions {
  readonly workspaceRoot: string;
  readonly dataDir: string;
  readonly comparisonRoot?: string | undefined;
  readonly port?: number;
}

export function spawnDurableHallCore(options: SpawnDurableHallCoreOptions): SpawnedHallCore {
  const port = options.port ?? DURABLE_RESTART_HALL_CORE_PORT;
  const args = [
    "--workspace-root",
    options.workspaceRoot,
    "--data-dir",
    options.dataDir,
    "--port",
    String(port),
    "--mock-scenario",
    "success",
    "--web-origin",
    `http://127.0.0.1:${String(DURABLE_RESTART_WEB_PORT)}`,
  ];
  if (options.comparisonRoot !== undefined) {
    args.push("--comparison-root", options.comparisonRoot);
  }

  const child = spawn(process.execPath, [DIST_SERVER_PATH, ...args], {
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });

  return {
    child,
    port,
    async gracefulStop(): Promise<void> {
      child.stdin.write("SHUTDOWN\n");
      await waitForExit(child);
    },
  };
}

export interface SpawnDurableFixtureHallCoreOptions {
  readonly workspaceRoot: string;
  readonly dataDir: string;
  readonly comparisonRoot: string;
  readonly port?: number;
  readonly webPort?: number;
}

/**
 * Phase 13.2 — the dual-fixture-adapter counterpart to
 * `spawnDurableHallCore`: spawns `apps/e2e`'s own built
 * `dist/fixture-server.js` (two deterministic, genuinely-completing
 * comparison fixture adapters — `hall.e2e-comparison-a`/`-b`, see
 * `fixture-adapters.ts`) in durable mode, entirely via environment
 * variables (`HALL_CORE_E2E_DATA_DIR`/`_WORKSPACE_ROOT`/`_COMPARISON_ROOT`)
 * rather than any CLI flag — `fixture-server.ts` is never reachable
 * through the real production binary regardless. Reuses the exact same
 * `openDurableStorage`/`createCoreStoresComposition`/ownership-fence
 * sequence `server.ts` uses (see `fixture-server.ts`'s and
 * `durable-startup.ts`'s doc comments) — this harness only chooses which
 * process to spawn and which adapters that process registers, never how
 * fencing itself works. Uses the identical stdin `gracefulStop` protocol
 * as `spawnDurableHallCore`, for the same Windows-signal-delivery reason.
 */
export function spawnDurableFixtureHallCore(
  options: SpawnDurableFixtureHallCoreOptions,
): SpawnedHallCore {
  const port = options.port ?? DURABLE_RESTART_HALL_CORE_PORT;
  const webPort = options.webPort ?? DURABLE_RESTART_WEB_PORT;

  const child = spawn(process.execPath, [FIXTURE_SERVER_DIST_PATH], {
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
    env: {
      ...process.env,
      HALL_CORE_E2E_PORT: String(port),
      HALL_CORE_E2E_WEB_ORIGIN: `http://127.0.0.1:${String(webPort)}`,
      HALL_CORE_E2E_DATA_DIR: options.dataDir,
      HALL_CORE_E2E_WORKSPACE_ROOT: options.workspaceRoot,
      HALL_CORE_E2E_COMPARISON_ROOT: options.comparisonRoot,
    },
  });

  return {
    child,
    port,
    async gracefulStop(): Promise<void> {
      child.stdin.write("SHUTDOWN\n");
      await waitForExit(child);
    },
  };
}

/** Its own `.next` build output directory — see `next.config.ts`'s doc comment on `HALL_E2E_DURABLE_DIST_DIR`. */
const DURABLE_RESTART_NEXT_DIST_DIR = ".next-durable-restart-e2e";
/** Its own throwaway tsconfig — see `next.config.ts`'s doc comment on `typescript.tsconfigPath`. Written fresh before every spawn; gitignored. */
const DURABLE_RESTART_TSCONFIG_NAME = "tsconfig.durable-restart-e2e.json";

export function spawnDurableHallWeb(
  hallCorePort: number,
  port = DURABLE_RESTART_WEB_PORT,
): ChildProcess {
  fs.writeFileSync(
    path.join(WEB_APP_DIR, DURABLE_RESTART_TSCONFIG_NAME),
    JSON.stringify({ extends: "./tsconfig.json" }, null, 2),
  );

  return spawn(
    process.execPath,
    [NEXT_BIN_PATH, "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: WEB_APP_DIR,
      env: {
        ...process.env,
        NEXT_PUBLIC_HALL_CORE_URL: `http://127.0.0.1:${String(hallCorePort)}`,
        HALL_E2E_DURABLE_DIST_DIR: DURABLE_RESTART_NEXT_DIST_DIR,
      },
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    },
  );
}
