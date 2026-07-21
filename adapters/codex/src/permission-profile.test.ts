import { describe, expect, it } from "vitest";
import { buildCodexArgv } from "./permission-profile.js";

const WORKDIR = "D:\\HallOfWisdom\\.tmp\\codex-adapter-smoke";

describe("buildCodexArgv — required fixed profile", () => {
  const argv = buildCodexArgv(WORKDIR);

  it("starts with exec", () => {
    expect(argv[0]).toBe("exec");
  });

  it("includes --json", () => {
    expect(argv).toContain("--json");
  });

  it("includes --ephemeral", () => {
    expect(argv).toContain("--ephemeral");
  });

  it("includes --ignore-user-config", () => {
    expect(argv).toContain("--ignore-user-config");
  });

  it("includes --ignore-rules", () => {
    expect(argv).toContain("--ignore-rules");
  });

  it("includes --strict-config", () => {
    expect(argv).toContain("--strict-config");
  });

  it("includes --sandbox workspace-write", () => {
    const index = argv.indexOf("--sandbox");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(argv[index + 1]).toBe("workspace-write");
  });

  it('includes -c approval_policy="never" (the exec-compatible equivalent of --ask-for-approval never)', () => {
    expect(argv).toContain('approval_policy="never"');
  });

  it("includes -c sandbox_workspace_write.network_access=false", () => {
    expect(argv).toContain("sandbox_workspace_write.network_access=false");
  });

  it('includes -c web_search="disabled"', () => {
    expect(argv).toContain('web_search="disabled"');
  });

  it("includes an explicit --cd with the exact working directory", () => {
    const index = argv.indexOf("--cd");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(argv[index + 1]).toBe(WORKDIR);
  });

  it("ends with the stdin-prompt sentinel '-'", () => {
    expect(argv[argv.length - 1]).toBe("-");
  });

  it("never includes the task prompt itself anywhere in argv", () => {
    expect(argv.some((entry) => entry.includes("Task title"))).toBe(false);
  });

  it("never includes --ask-for-approval (confirmed invalid on codex exec, exit code 2, live — approval_policy is used instead)", () => {
    expect(argv).not.toContain("--ask-for-approval");
  });
});

describe("buildCodexArgv — Phase 10.1: explicit feature disabling", () => {
  const argv = buildCodexArgv(WORKDIR);

  it.each(["hooks", "plugins", "plugin_sharing", "remote_plugin", "multi_agent"])(
    "includes --disable %s",
    (feature) => {
      const index = argv.indexOf("--disable");
      const disabledFeatures = argv.reduce<string[]>((acc, entry, i) => {
        if (argv[i - 1] === "--disable") acc.push(entry);
        return acc;
      }, []);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(disabledFeatures).toContain(feature);
    },
  );

  it("passes each --disable as a separate argv element paired with its feature name, never a joined string", () => {
    const disablePairs = argv.reduce<[string, string][]>((acc, entry, i) => {
      if (entry === "--disable") acc.push([entry, argv[i + 1] ?? ""]);
      return acc;
    }, []);
    expect(disablePairs).toHaveLength(5);
    for (const [, feature] of disablePairs) {
      expect(feature.length).toBeGreaterThan(0);
      expect(feature).not.toContain(" ");
    }
  });
});

describe("buildCodexArgv — excludes every forbidden flag", () => {
  const argv = buildCodexArgv(WORKDIR).join(" ");

  it("never passes --ask-for-approval (confirmed invalid on codex exec, exit code 2, live)", () => {
    expect(argv).not.toContain("--ask-for-approval");
  });

  it("never passes --dangerously-bypass-approvals-and-sandbox", () => {
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("never passes --dangerously-bypass-hook-trust", () => {
    expect(argv).not.toContain("--dangerously-bypass-hook-trust");
  });

  it("never passes --skip-git-repo-check", () => {
    expect(argv).not.toContain("--skip-git-repo-check");
  });

  it("never passes --oss or --local-provider", () => {
    expect(argv).not.toContain("--oss");
    expect(argv).not.toContain("--local-provider");
  });

  it("never passes --profile", () => {
    expect(argv).not.toContain("--profile");
  });

  it("never passes --add-dir", () => {
    expect(argv).not.toContain("--add-dir");
  });

  it("never passes -m/--model or a model override", () => {
    expect(argv).not.toContain("--model");
    expect(argv).not.toMatch(/\s-m\s/);
  });

  it("never passes --image, --output-schema, or --output-last-message", () => {
    expect(argv).not.toContain("--image");
    expect(argv).not.toContain("--output-schema");
    expect(argv).not.toContain("--output-last-message");
  });

  it("never passes a resume subcommand", () => {
    expect(argv).not.toContain("resume");
  });

  it("never passes danger-full-access as the sandbox mode", () => {
    expect(argv).not.toContain("danger-full-access");
  });
});

describe("buildCodexArgv — the working directory is the only variable input", () => {
  it("produces byte-identical argv for two calls with the same working directory", () => {
    expect(buildCodexArgv(WORKDIR)).toEqual(buildCodexArgv(WORKDIR));
  });

  it("only the --cd value differs between two different working directories", () => {
    const a = buildCodexArgv("C:\\a");
    const b = buildCodexArgv("C:\\b");
    const diffIndices = a
      .map((value, index) => (value !== b[index] ? index : -1))
      .filter((i) => i >= 0);
    expect(diffIndices).toEqual([a.indexOf("--cd") + 1]);
  });

  it("a task-text-injection attempt used as the working directory does not introduce new flags — it becomes only the --cd value", () => {
    const malicious =
      "C:\\evil --dangerously-bypass-approvals-and-sandbox --sandbox danger-full-access";
    const argv = buildCodexArgv(malicious);
    // The malicious string appears exactly once, as the literal --cd value.
    const occurrences = argv.filter((entry) => entry === malicious);
    expect(occurrences).toHaveLength(1);
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv.filter((entry) => entry === "--sandbox")).toHaveLength(1);
  });
});
