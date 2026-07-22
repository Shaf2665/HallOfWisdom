import { describe, expect, it } from "vitest";
import { buildCodexArgv, buildCodexTrustedLocalArgv } from "./permission-profile.js";

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

describe("buildCodexTrustedLocalArgv — Phase 10.2 Paperclip-compatible trusted-local profile", () => {
  const argv = buildCodexTrustedLocalArgv(WORKDIR);

  it("starts with exec", () => {
    expect(argv[0]).toBe("exec");
  });

  it("includes --json", () => {
    expect(argv).toContain("--json");
  });

  it("includes --dangerously-bypass-approvals-and-sandbox (the Paperclip-compatible bypass flag)", () => {
    expect(argv).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("includes --ephemeral, --ignore-user-config, --ignore-rules, --strict-config (isolation retained even in bypass mode)", () => {
    expect(argv).toContain("--ephemeral");
    expect(argv).toContain("--ignore-user-config");
    expect(argv).toContain("--ignore-rules");
    expect(argv).toContain("--strict-config");
  });

  it.each(["hooks", "plugins", "plugin_sharing", "remote_plugin", "multi_agent"])(
    "includes --disable %s",
    (feature) => {
      const disabledFeatures = argv.reduce<string[]>((acc, entry, i) => {
        if (argv[i - 1] === "--disable") acc.push(entry);
        return acc;
      }, []);
      expect(disabledFeatures).toContain(feature);
    },
  );

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

  it("never includes --sandbox (the bypass flag replaces sandbox enforcement; combining them would be a misleading policy)", () => {
    expect(argv).not.toContain("--sandbox");
    expect(argv).not.toContain("workspace-write");
    expect(argv).not.toContain("danger-full-access");
    expect(argv).not.toContain("read-only");
  });

  it("never includes -c approval_policy=..., sandbox_workspace_write.network_access=..., or web_search=... (sandbox-layer config, irrelevant once bypassed)", () => {
    expect(argv.some((entry) => entry.includes("approval_policy"))).toBe(false);
    expect(argv.some((entry) => entry.includes("sandbox_workspace_write"))).toBe(false);
    expect(argv.some((entry) => entry.includes("web_search"))).toBe(false);
  });

  it("never includes --ask-for-approval (not a valid codex exec flag)", () => {
    expect(argv).not.toContain("--ask-for-approval");
  });

  it("never includes --dangerously-bypass-hook-trust", () => {
    expect(argv).not.toContain("--dangerously-bypass-hook-trust");
  });
});

describe("buildCodexTrustedLocalArgv — excludes every forbidden flag", () => {
  const argv = buildCodexTrustedLocalArgv(WORKDIR).join(" ");

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

  it("never passes --search or fast-mode/service-tier config", () => {
    expect(argv).not.toContain("--search");
    expect(argv).not.toContain("service_tier");
    expect(argv).not.toContain("fast_mode");
  });

  it("never passes --image, --output-schema, or --output-last-message", () => {
    expect(argv).not.toContain("--image");
    expect(argv).not.toContain("--output-schema");
    expect(argv).not.toContain("--output-last-message");
  });

  it("never passes a resume subcommand", () => {
    expect(argv).not.toContain("resume");
  });
});

describe("buildCodexTrustedLocalArgv — the working directory is the only variable input", () => {
  it("produces byte-identical argv for two calls with the same working directory", () => {
    expect(buildCodexTrustedLocalArgv(WORKDIR)).toEqual(buildCodexTrustedLocalArgv(WORKDIR));
  });

  it("only the --cd value differs between two different working directories", () => {
    const a = buildCodexTrustedLocalArgv("C:\\a");
    const b = buildCodexTrustedLocalArgv("C:\\b");
    const diffIndices = a
      .map((value, index) => (value !== b[index] ? index : -1))
      .filter((i) => i >= 0);
    expect(diffIndices).toEqual([a.indexOf("--cd") + 1]);
  });

  it("a task-text-injection attempt used as the working directory does not introduce new flags — it becomes only the --cd value", () => {
    const malicious = "C:\\evil --sandbox danger-full-access --model gpt-evil";
    const argv = buildCodexTrustedLocalArgv(malicious);
    const occurrences = argv.filter((entry) => entry === malicious);
    expect(occurrences).toHaveLength(1);
    expect(argv).not.toContain("--sandbox");
    expect(argv).not.toContain("--model");
  });
});

describe("buildCodexTrustedLocalArgv — Paperclip parity (Phase 10.2)", () => {
  it("uses the Paperclip-compatible trusted-local Codex execution profile", () => {
    // The essential shape of Paperclip's own working core path
    // (codex-args.ts, buildCodexExecArgs, bypass === true):
    // ["exec", "--json", ..., "--dangerously-bypass-approvals-and-sandbox", ..., "-"].
    // Hall's profile additionally layers its own configuration-isolation
    // flags (--ephemeral, --ignore-user-config, --ignore-rules,
    // --strict-config, --disable ...) that Paperclip's own argv builder
    // does not include — see the Phase 10.2 Paperclip comparison notes —
    // but the essential bypass/stdin/json shape matches.
    const argv = buildCodexTrustedLocalArgv(WORKDIR);
    expect(argv[0]).toBe("exec");
    expect(argv).toContain("--json");
    expect(argv).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv.at(-1)).toBe("-");
    // Paperclip never combines the bypass flag with --sandbox or any
    // approval/network/web-search config key (codex-args.ts never emits
    // both); Hall's profile matches that, not merely by omission but by
    // design (see buildCodexTrustedLocalArgv's own doc comment).
    expect(argv).not.toContain("--sandbox");
    expect(argv.some((entry) => entry.includes("approval_policy"))).toBe(false);
  });
});

describe("buildCodexArgv vs buildCodexTrustedLocalArgv — strict profile is untouched", () => {
  it("buildCodexArgv still never includes --dangerously-bypass-approvals-and-sandbox", () => {
    expect(buildCodexArgv(WORKDIR)).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("buildCodexArgv still includes --sandbox workspace-write and the approval/network/web-search config keys", () => {
    const argv = buildCodexArgv(WORKDIR);
    expect(argv).toContain("--sandbox");
    expect(argv).toContain('approval_policy="never"');
    expect(argv).toContain("sandbox_workspace_write.network_access=false");
    expect(argv).toContain('web_search="disabled"');
  });
});
