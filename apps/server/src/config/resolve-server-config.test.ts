import { describe, expect, it } from "vitest";
import type { HallConfig } from "@hall-of-wisdom/hall-config";
import { resolveServerConfig } from "./resolve-server-config.js";
import { ServerCliError } from "./server-cli-args.js";
import type { ServerCliOverrides } from "./server-cli-args.js";

const NO_OVERRIDES: ServerCliOverrides = { verifyOnly: false };

const PERSISTED: HallConfig = {
  schemaVersion: 1,
  workspaceRoot: "D:\\PersistedWorkspace",
  comparisonRoot: null,
  hallCorePort: 4400,
  hallWebPort: 3300,
  codexTrustedLocal: false,
};

describe("resolveServerConfig — workspaceRoot precedence", () => {
  it("throws ServerCliError when neither CLI nor persisted config supplies workspaceRoot", () => {
    expect(() => resolveServerConfig(NO_OVERRIDES, undefined)).toThrow(ServerCliError);
  });

  it("uses persisted workspaceRoot when CLI omits it", () => {
    const resolved = resolveServerConfig(NO_OVERRIDES, PERSISTED);
    expect(resolved.workspaceRoot).toBe("D:\\PersistedWorkspace");
  });

  it("CLI workspaceRoot wins over persisted", () => {
    const resolved = resolveServerConfig(
      { ...NO_OVERRIDES, workspaceRoot: "D:\\CliWorkspace" },
      PERSISTED,
    );
    expect(resolved.workspaceRoot).toBe("D:\\CliWorkspace");
  });
});

describe("resolveServerConfig — port precedence", () => {
  it("falls back to the built-in DEFAULT_PORT when neither source supplies it", () => {
    const resolved = resolveServerConfig(
      { ...NO_OVERRIDES, workspaceRoot: "D:\\W" },
      undefined,
    );
    expect(resolved.port).toBe(4310);
  });

  it("uses persisted hallCorePort when CLI omits --port", () => {
    const resolved = resolveServerConfig({ ...NO_OVERRIDES, workspaceRoot: "D:\\W" }, PERSISTED);
    expect(resolved.port).toBe(4400);
  });

  it("CLI --port wins over persisted hallCorePort", () => {
    const resolved = resolveServerConfig(
      { ...NO_OVERRIDES, workspaceRoot: "D:\\W", port: 9999 },
      PERSISTED,
    );
    expect(resolved.port).toBe(9999);
  });
});

describe("resolveServerConfig — webOrigin derivation from hallWebPort", () => {
  it("defaults to http://127.0.0.1:3000 when nothing supplies webOrigin or hallWebPort", () => {
    const resolved = resolveServerConfig({ ...NO_OVERRIDES, workspaceRoot: "D:\\W" }, undefined);
    expect(resolved.webOrigin).toBe("http://127.0.0.1:3000");
  });

  it("derives webOrigin from persisted hallWebPort when --web-origin is omitted", () => {
    const resolved = resolveServerConfig({ ...NO_OVERRIDES, workspaceRoot: "D:\\W" }, PERSISTED);
    expect(resolved.webOrigin).toBe("http://127.0.0.1:3300");
  });

  it("explicit --web-origin always wins, even over a persisted hallWebPort", () => {
    const resolved = resolveServerConfig(
      { ...NO_OVERRIDES, workspaceRoot: "D:\\W", webOrigin: "http://127.0.0.1:6000" },
      PERSISTED,
    );
    expect(resolved.webOrigin).toBe("http://127.0.0.1:6000");
  });

  it("a persisted hallWebPort change can never silently create a CORS mismatch (documentation-as-test)", () => {
    const changedPortConfig: HallConfig = { ...PERSISTED, hallWebPort: 4444 };
    const resolved = resolveServerConfig({ ...NO_OVERRIDES, workspaceRoot: "D:\\W" }, changedPortConfig);
    expect(resolved.webOrigin).toBe("http://127.0.0.1:4444");
  });
});

describe("resolveServerConfig — enableCodexTrustedLocal precedence", () => {
  it("defaults to false when neither source supplies it", () => {
    const resolved = resolveServerConfig({ ...NO_OVERRIDES, workspaceRoot: "D:\\W" }, undefined);
    expect(resolved.enableCodexTrustedLocal).toBe(false);
  });

  it("uses persisted codexTrustedLocal when CLI omits the flag", () => {
    const resolved = resolveServerConfig(
      { ...NO_OVERRIDES, workspaceRoot: "D:\\W" },
      { ...PERSISTED, codexTrustedLocal: true },
    );
    expect(resolved.enableCodexTrustedLocal).toBe(true);
  });

  it("CLI --enable-codex-trusted-local wins over a persisted false", () => {
    const resolved = resolveServerConfig(
      { ...NO_OVERRIDES, workspaceRoot: "D:\\W", enableCodexTrustedLocal: true },
      { ...PERSISTED, codexTrustedLocal: false },
    );
    expect(resolved.enableCodexTrustedLocal).toBe(true);
  });
});

describe("resolveServerConfig — comparisonRoot", () => {
  it("is undefined when persisted comparisonRoot is null and CLI omits it", () => {
    const resolved = resolveServerConfig({ ...NO_OVERRIDES, workspaceRoot: "D:\\W" }, PERSISTED);
    expect(resolved.comparisonRoot).toBeUndefined();
  });

  it("uses a persisted non-null comparisonRoot when CLI omits it", () => {
    const resolved = resolveServerConfig(
      { ...NO_OVERRIDES, workspaceRoot: "D:\\W" },
      { ...PERSISTED, comparisonRoot: "D:\\PersistedComparisons" },
    );
    expect(resolved.comparisonRoot).toBe("D:\\PersistedComparisons");
  });

  it("CLI --comparison-root wins over a persisted value", () => {
    const resolved = resolveServerConfig(
      { ...NO_OVERRIDES, workspaceRoot: "D:\\W", comparisonRoot: "D:\\CliComparisons" },
      { ...PERSISTED, comparisonRoot: "D:\\PersistedComparisons" },
    );
    expect(resolved.comparisonRoot).toBe("D:\\CliComparisons");
  });
});

describe("resolveServerConfig — dataDir / agentWorktreeRoot / mock fields", () => {
  it("dataDir and agentWorktreeRoot stay undefined in ephemeral mode with no persisted config (existing dev startup unaffected)", () => {
    const resolved = resolveServerConfig({ ...NO_OVERRIDES, workspaceRoot: "D:\\W" }, undefined);
    expect(resolved.dataDir).toBeUndefined();
    expect(resolved.agentWorktreeRoot).toBeUndefined();
  });

  it("mockScenario/mockStepDelayMs come from CLI only, never from persisted config", () => {
    const resolved = resolveServerConfig(
      { ...NO_OVERRIDES, workspaceRoot: "D:\\W", mockScenario: "success", mockStepDelayMs: 5 },
      PERSISTED,
    );
    expect(resolved.mockScenario).toBe("success");
    expect(resolved.mockStepDelayMs).toBe(5);
  });
});

describe("resolveServerConfig — verifyOnly passthrough", () => {
  it("carries verifyOnly through unchanged", () => {
    const resolved = resolveServerConfig(
      { ...NO_OVERRIDES, workspaceRoot: "D:\\W", verifyOnly: true },
      undefined,
    );
    expect(resolved.verifyOnly).toBe(true);
  });
});
