import { afterEach, describe, expect, it } from "vitest";
import {
  HermesRouterAdapter,
  type DetectionProcessRunner,
} from "@hall-of-wisdom/hermes-router-adapter";
import { buildTestApp } from "../test-support.js";

let cleanupApp: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanupApp?.();
  cleanupApp = undefined;
});

describe("Hall Core adapter discovery — Hermes Router", () => {
  it("exposes a detected Hermes runtime as non-assignable", async () => {
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
    const adapter = new HermesRouterAdapter({
      platform: "linux",
      parentEnv: { HALL_HERMES_ROUTER_ROOT: "/opt/Hermes Router" },
      fs: { isFile: () => true },
      processRunner,
    });
    const { app } = await buildTestApp({
      workspaceRoot: process.cwd(),
      additionalAdapters: [adapter],
    });
    cleanupApp = () => app.close();

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      adapters: {
        adapterId: string;
        installed: boolean;
        availability: string;
        assignable: boolean;
        detectedVersion?: string;
      }[];
    }>();
    const hermes = body.adapters.find((candidate) => candidate.adapterId === "hall.hermes-router");
    expect(hermes).toMatchObject({
      adapterId: "hall.hermes-router",
      installed: true,
      availability: "unsupported",
      assignable: false,
      detectedVersion: "0.1.0",
    });
  });
});
