import { describe, expect, it } from "vitest";
import { buildExecFileOptions, type DetectionProcessOptions } from "./process-runner.js";

describe("buildExecFileOptions", () => {
  it("enforces a shell-free, bounded child process", () => {
    const processOptions: DetectionProcessOptions = {
      executablePath: "python",
      args: ["/opt/Hermes Router/hermes_agent_runner.py", "detect"],
      cwd: "/tmp",
      env: { HALL_HERMES_ROUTER_ROOT: "/opt/Hermes Router" },
      timeoutMs: 5000,
      maxOutputBytes: 16_384,
    };

    expect(buildExecFileOptions(processOptions)).toMatchObject({
      cwd: "/tmp",
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 16_384,
      shell: false,
      windowsHide: true,
    });
  });
});
