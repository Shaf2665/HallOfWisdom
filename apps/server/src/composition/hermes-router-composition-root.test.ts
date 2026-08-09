import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import {
  HERMES_RUNNER_FILENAME,
  nodeDetectionProcessRunner,
  type DetectionProcessRunner,
} from "@hall-of-wisdom/hermes-router-adapter";
import { registerHermesRouterAdapter } from "./hermes-router-composition-root.js";
import {
  createServerComposition,
  DEFAULT_DURABLE_ISOLATED_AGENT_ADAPTER_IDS,
} from "./server-composition.js";
import { DEFAULT_LIMITS } from "../config/server-config.js";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";

const tempDirs: string[] = [];
const dbs: HallDatabase[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const db of dbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("registerHermesRouterAdapter", () => {
  it("registers exactly one non-assignable Hermes adapter", async () => {
    const processRunner: DetectionProcessRunner = {
      run: () =>
        Promise.resolve({
          status: "success",
          stdout: JSON.stringify({
            protocol: "hermes-agent/v1",
            runtime_version: "0.1.0",
            available: true,
            capabilities: [
              "project.read",
              "project.edit",
              "command.execute",
              "structured.events",
              "cancellation",
            ],
            integration_level: "structured_cli",
            execution_trust: "trusted_local",
          }),
        }),
    };
    const registry = new AgentRegistry();
    registerHermesRouterAdapter(registry, {
      adapterConfig: {
        platform: "linux",
        parentEnv: { HALL_HERMES_ROUTER_ROOT: "/opt/Hermes Router" },
        fs: { isFile: () => true },
        processRunner,
      },
    });

    expect(registry.listDescriptors().map((descriptor) => descriptor.adapterId)).toEqual([
      "hall.hermes-router",
    ]);
    expect((await registry.resolve("hall.hermes-router").detect()).availability).toBe(
      "unsupported",
    );
  });

  it("enables isolated Hermes detection only from the trusted composition flag", async () => {
    const processRunner: DetectionProcessRunner = {
      run: () =>
        Promise.resolve({
          status: "success",
          stdout: JSON.stringify({
            protocol: "hermes-agent/v1",
            runtime_version: "0.1.0",
            available: true,
            capabilities: [
              "project.read",
              "project.edit",
              "command.execute",
              "structured.events",
              "cancellation",
            ],
            integration_level: "structured_cli",
            execution_trust: "trusted_local",
          }),
        }),
    };
    const registry = new AgentRegistry();
    registerHermesRouterAdapter(registry, {
      isolatedExecutionEnabled: true,
      adapterConfig: {
        platform: "linux",
        parentEnv: { HALL_HERMES_ROUTER_ROOT: "/opt/Hermes Router" },
        fs: { isFile: () => true },
        processRunner,
      },
    });

    await expect(registry.resolve("hall.hermes-router").detect()).resolves.toMatchObject({
      availability: "available",
      executionTrust: "isolated",
    });
  });

  it("is included by the production server composition", () => {
    const composition = createServerComposition({
      workspaceRoot: process.cwd(),
      limits: DEFAULT_LIMITS,
    });

    expect(
      composition.registry.listDescriptors().map((descriptor) => descriptor.adapterId),
    ).toContain("hall.hermes-router");
  });

  it("registers Hermes beside Codex in the existing durable isolation policy", () => {
    expect(DEFAULT_DURABLE_ISOLATED_AGENT_ADAPTER_IDS).toEqual([
      "hall.codex",
      "hall.hermes-router",
    ]);
    expect(DEFAULT_DURABLE_ISOLATED_AGENT_ADAPTER_IDS).not.toContain("hall.claude-code");
  });

  it("enables Hermes only when production composition has every durable isolation prerequisite", async () => {
    const runtimeRoot = makeTempDir("hall-hermes-runtime-");
    fs.writeFileSync(path.join(runtimeRoot, HERMES_RUNNER_FILENAME), "test runner\n");
    vi.stubEnv("HALL_HERMES_ROUTER_ROOT", runtimeRoot);
    vi.spyOn(nodeDetectionProcessRunner, "run").mockResolvedValue({
      status: "success",
      stdout: JSON.stringify({
        protocol: "hermes-agent/v1",
        runtime_version: "0.1.0",
        available: true,
        capabilities: [
          "project.read",
          "project.edit",
          "command.execute",
          "structured.events",
          "cancellation",
        ],
        integration_level: "structured_cli",
        execution_trust: "trusted_local",
      }),
    });

    const ephemeral = createServerComposition({
      workspaceRoot: process.cwd(),
      limits: DEFAULT_LIMITS,
    });
    const durable = createServerComposition({
      workspaceRoot: process.cwd(),
      limits: DEFAULT_LIMITS,
      db: openMigratedDatabase(),
      agentWorktreeRoot: makeTempDir("hall-hermes-worktrees-"),
    });

    await expect(ephemeral.registry.resolve("hall.hermes-router").detect()).resolves.toMatchObject({
      availability: "unsupported",
      executionTrust: "unavailable",
    });
    await expect(durable.registry.resolve("hall.hermes-router").detect()).resolves.toMatchObject({
      availability: "available",
      executionTrust: "isolated",
    });
  });
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync.native(dir);
}

function openMigratedDatabase(): HallDatabase {
  const db = HallDatabase.openInMemory();
  runMigrations(db);
  dbs.push(db);
  return db;
}
