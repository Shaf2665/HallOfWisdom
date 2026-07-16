import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../config/server-config.js";
import { ServerCliError } from "../config/server-cli-args.js";
import { createMockAgentServerComposition } from "./mock-agent-composition-root.js";

/**
 * `--mock-scenario` is parsed as an unbounded-but-length-limited string by
 * `parseServerCliArguments` (it has no enum concept of its own — see the
 * comment on `mockScenario` in `server-cli-args.ts`); the actual
 * success/failure/cancellable validation happens here, in
 * `resolveScenario`, the moment the composition root turns that raw string
 * into a real `MockAgentAdapter`. This is the only place that rejection
 * path is exercised.
 */
describe("createMockAgentServerComposition", () => {
  function buildOptions(mockScenario?: string) {
    return {
      workspaceRoot: process.cwd(),
      mockScenario,
      limits: DEFAULT_LIMITS,
    };
  }

  it("defaults to the success scenario when --mock-scenario is omitted", () => {
    const composition = createMockAgentServerComposition(buildOptions(undefined));
    expect(composition.registry.listDescriptors()).toHaveLength(1);
  });

  it.each(["success", "failure", "cancellable"])(
    "accepts the documented scenario value %s",
    (scenario) => {
      expect(() => createMockAgentServerComposition(buildOptions(scenario))).not.toThrow();
    },
  );

  it("rejects an unrecognized --mock-scenario value with a clear, safe error", () => {
    expect(() => createMockAgentServerComposition(buildOptions("bogus"))).toThrow(ServerCliError);
    try {
      createMockAgentServerComposition(buildOptions("bogus"));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ServerCliError);
      expect((error as ServerCliError).message).toContain("success");
      expect((error as ServerCliError).message).toContain("failure");
      expect((error as ServerCliError).message).toContain("cancellable");
      expect((error as ServerCliError).message).toContain("bogus");
    }
  });

  it("registers exactly one adapter under the mock agent's own adapter id", () => {
    const composition = createMockAgentServerComposition(buildOptions("success"));
    const [descriptor] = composition.registry.listDescriptors();
    expect(descriptor?.adapterId).toBe("hall.mock-agent");
  });
});
