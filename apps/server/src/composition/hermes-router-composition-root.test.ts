import { describe, expect, it } from "vitest";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import type { DetectionProcessRunner } from "@hall-of-wisdom/hermes-router-adapter";
import { registerHermesRouterAdapter } from "./hermes-router-composition-root.js";
import { createServerComposition } from "./server-composition.js";
import { DEFAULT_LIMITS } from "../config/server-config.js";

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

  it("is included by the production server composition", () => {
    const composition = createServerComposition({
      workspaceRoot: process.cwd(),
      limits: DEFAULT_LIMITS,
    });

    expect(
      composition.registry.listDescriptors().map((descriptor) => descriptor.adapterId),
    ).toContain("hall.hermes-router");
  });
});
