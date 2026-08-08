import { describe, expect, it } from "vitest";
import {
  parseServerCliArguments,
  ServerCliError,
  stripLeadingScriptSeparator,
} from "./server-cli-args.js";

describe("parseServerCliArguments", () => {
  it("parses a minimal command with no flags at all — workspaceRoot is optional here", () => {
    const options = parseServerCliArguments([]);
    expect(options.workspaceRoot).toBeUndefined();
    expect(options.port).toBeUndefined();
    expect(options.verifyOnly).toBe(false);
  });

  it("parses --workspace-root when supplied", () => {
    const options = parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom"]);
    expect(options.workspaceRoot).toBe("D:\\HallOfWisdom");
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

  it("leaves webOrigin undefined when --web-origin is omitted (defaulting/derivation now happens in resolve-server-config.ts)", () => {
    const options = parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom"]);
    expect(options.webOrigin).toBeUndefined();
  });

  it("parses and normalizes a valid --web-origin", () => {
    const options = parseServerCliArguments([
      "--workspace-root",
      "D:\\HallOfWisdom",
      "--web-origin",
      "http://127.0.0.1:5173/",
    ]);
    expect(options.webOrigin).toBe("http://127.0.0.1:5173");
  });

  it("rejects an invalid --web-origin", () => {
    expect(() =>
      parseServerCliArguments([
        "--workspace-root",
        "D:\\HallOfWisdom",
        "--web-origin",
        "not a url",
      ]),
    ).toThrow(ServerCliError);
  });

  describe("--enable-codex-trusted-local (Phase 10.2)", () => {
    it("is undefined when omitted (defaulting to false now happens in resolve-server-config.ts)", () => {
      const options = parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom"]);
      expect(options.enableCodexTrustedLocal).toBeUndefined();
    });

    it("parses --enable-codex-trusted-local as true", () => {
      const options = parseServerCliArguments([
        "--workspace-root",
        "D:\\HallOfWisdom",
        "--enable-codex-trusted-local",
      ]);
      expect(options.enableCodexTrustedLocal).toBe(true);
    });
  });

  describe("--comparison-root (Phase 12)", () => {
    it("is undefined when omitted", () => {
      const options = parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom"]);
      expect(options.comparisonRoot).toBeUndefined();
    });

    it("parses --comparison-root when supplied", () => {
      const options = parseServerCliArguments([
        "--workspace-root",
        "D:\\HallOfWisdom",
        "--comparison-root",
        "D:\\HallOfWisdomComparisons",
      ]);
      expect(options.comparisonRoot).toBe("D:\\HallOfWisdomComparisons");
    });
  });

  describe("--data-dir (Phase 13)", () => {
    it("is undefined when omitted", () => {
      const options = parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom"]);
      expect(options.dataDir).toBeUndefined();
    });

    it("parses --data-dir when supplied", () => {
      const options = parseServerCliArguments([
        "--workspace-root",
        "D:\\HallOfWisdom",
        "--data-dir",
        "D:\\HallOfWisdomData",
      ]);
      expect(options.dataDir).toBe("D:\\HallOfWisdomData");
    });
  });

  describe("--agent-worktree-root (Phase 16.4)", () => {
    it("is undefined when omitted", () => {
      const options = parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom"]);
      expect(options.agentWorktreeRoot).toBeUndefined();
    });

    it("parses --agent-worktree-root when supplied", () => {
      const options = parseServerCliArguments([
        "--workspace-root",
        "D:\\HallOfWisdom",
        "--data-dir",
        "D:\\HallOfWisdomData",
        "--agent-worktree-root",
        "D:\\HallOfWisdomAgentWorktrees",
      ]);
      expect(options.agentWorktreeRoot).toBe("D:\\HallOfWisdomAgentWorktrees");
    });
  });

  describe("--verify-only (Phase 17.1)", () => {
    it("defaults to false when omitted", () => {
      const options = parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom"]);
      expect(options.verifyOnly).toBe(false);
    });

    it("parses --verify-only as true", () => {
      const options = parseServerCliArguments(["--verify-only"]);
      expect(options.verifyOnly).toBe(true);
    });

    it("--verify-only does not require --workspace-root at the parse stage", () => {
      expect(() => parseServerCliArguments(["--verify-only"])).not.toThrow();
    });
  });

  describe("stripLeadingScriptSeparator (Phase 11.1)", () => {
    it("leaves argv without a leading separator untouched (direct node invocation)", () => {
      expect(stripLeadingScriptSeparator(["--workspace-root", "D:\\HallOfWisdom"])).toEqual([
        "--workspace-root",
        "D:\\HallOfWisdom",
      ]);
    });

    it("strips a single leading standalone separator", () => {
      expect(stripLeadingScriptSeparator(["--", "--workspace-root", "D:\\HallOfWisdom"])).toEqual([
        "--workspace-root",
        "D:\\HallOfWisdom",
      ]);
    });

    it("strips only one leading separator, leaving a second one for parseArgs to reject", () => {
      expect(
        stripLeadingScriptSeparator(["--", "--", "--workspace-root", "D:\\HallOfWisdom"]),
      ).toEqual(["--", "--workspace-root", "D:\\HallOfWisdom"]);
    });

    it("does not strip a separator that is not the first token", () => {
      expect(stripLeadingScriptSeparator(["--workspace-root", "--", "D:\\HallOfWisdom"])).toEqual([
        "--workspace-root",
        "--",
        "D:\\HallOfWisdom",
      ]);
    });

    it("does not alter a value containing two hyphens", () => {
      expect(stripLeadingScriptSeparator(["--workspace-root", "D:\\Foo--Bar"])).toEqual([
        "--workspace-root",
        "D:\\Foo--Bar",
      ]);
    });

    it("returns an empty array unchanged", () => {
      expect(stripLeadingScriptSeparator([])).toEqual([]);
    });
  });

  describe("pnpm '--' script-separator forwarding (Phase 11.1)", () => {
    it("parses direct argv with no separator (baseline)", () => {
      const options = parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom"]);
      expect(options.workspaceRoot).toBe("D:\\HallOfWisdom");
    });

    it("parses correctly with a leading standalone separator", () => {
      const options = parseServerCliArguments(["--", "--workspace-root", "D:\\HallOfWisdom"]);
      expect(options.workspaceRoot).toBe("D:\\HallOfWisdom");
    });

    it("parses --port after the separator", () => {
      const options = parseServerCliArguments([
        "--",
        "--workspace-root",
        "D:\\HallOfWisdom",
        "--port",
        "4310",
      ]);
      expect(options.port).toBe(4310);
    });

    it("still rejects a genuinely unexpected positional argument", () => {
      expect(() =>
        parseServerCliArguments(["--workspace-root", "D:\\HallOfWisdom", "unexpected-positional"]),
      ).toThrow(ServerCliError);
    });

    it("still rejects when more than one leading separator is present", () => {
      expect(() =>
        parseServerCliArguments(["--", "--", "--workspace-root", "D:\\HallOfWisdom"]),
      ).toThrow(ServerCliError);
    });

    it("still rejects an unknown flag after the separator, exactly like without one", () => {
      expect(() =>
        parseServerCliArguments([
          "--",
          "--workspace-root",
          "D:\\HallOfWisdom",
          "--not-a-real-flag",
        ]),
      ).toThrow(ServerCliError);
    });

    it("parses the exact argv pnpm forwards for the README's documented Hall Core startup command", () => {
      const options = parseServerCliArguments([
        "--",
        "--workspace-root",
        "D:\\HallOfWisdom",
        "--port",
        "4310",
        "--mock-scenario",
        "success",
        "--web-origin",
        "http://127.0.0.1:3000",
      ]);
      expect(options).toEqual({
        workspaceRoot: "D:\\HallOfWisdom",
        port: 4310,
        mockScenario: "success",
        webOrigin: "http://127.0.0.1:3000",
        verifyOnly: false,
      });
    });
  });
});
