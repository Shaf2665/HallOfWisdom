import { describe, expect, it } from "vitest";
import type { AgentTaskInput } from "@hall-of-wisdom/agent-adapter-sdk";
import {
  HermesRouterAdapter,
  HERMES_EXECUTION_NOT_IMPLEMENTED_MESSAGE,
} from "./hermes-router-adapter.js";
import type { DetectionProcessRunner } from "./process-runner.js";

const unusedTaskInput = {} as AgentTaskInput;

describe("HermesRouterAdapter.startTask", () => {
  it("rejects with a fixed message without spawning Hermes", async () => {
    let spawnCount = 0;
    const processRunner: DetectionProcessRunner = {
      run: () => {
        spawnCount += 1;
        return Promise.resolve({ status: "success", stdout: "{}" });
      },
    };
    const adapter = new HermesRouterAdapter({
      platform: "linux",
      parentEnv: { HALL_HERMES_ROUTER_ROOT: "/opt/Hermes-router" },
      fs: { isFile: () => true },
      processRunner,
    });

    await expect(adapter.startTask(unusedTaskInput)).rejects.toThrow(
      HERMES_EXECUTION_NOT_IMPLEMENTED_MESSAGE,
    );
    expect(spawnCount).toBe(0);
  });
});
