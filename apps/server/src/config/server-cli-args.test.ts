import { describe, expect, it } from "vitest";
import { parseServerCliArguments, ServerCliError } from "./server-cli-args.js";

describe("parseServerCliArguments", () => {
  it("parses a minimal valid command", () => {
    const options = parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom"]);
    expect(options.workspaceRoot).toBe("D:\\HallOfWisdom");
    expect(options.port).toBeUndefined();
  });

  it("parses port, mock-scenario, and mock-step-delay-ms", () => {
    const options = parseServerCliArguments([
      "--workspace-root",
      "D:\\HallOfWisdom",
      "--port",
      "5000",
      "--mock-scenario",
      "failure",
      "--mock-step-delay-ms",
      "10",
    ]);
    expect(options.port).toBe(5000);
    expect(options.mockScenario).toBe("failure");
    expect(options.mockStepDelayMs).toBe(10);
  });

  it("rejects a missing required --workspace-root", () => {
    expect(() => parseServerCliArguments([])).toThrow(ServerCliError);
  });

  it("rejects an out-of-range port", () => {
    expect(() =>
      parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom", "--port", "99999"]),
    ).toThrow(ServerCliError);
  });

  it("rejects a non-numeric port", () => {
    expect(() =>
      parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom", "--port", "not-a-number"]),
    ).toThrow(ServerCliError);
  });

  it("rejects an unknown argument", () => {
    expect(() =>
      parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom", "--not-a-real-flag"]),
    ).toThrow(ServerCliError);
  });
});
