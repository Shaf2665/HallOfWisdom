import { describe, expect, it } from "vitest";
import {
  DEFAULT_HALL_CORE_PORT,
  DEFAULT_HALL_WEB_PORT,
  HALL_CONFIG_SCHEMA_VERSION,
  HallConfigValidationError,
  UnsupportedHallConfigSchemaVersionError,
  parseHallConfig,
} from "./schema.js";
import {
  TEST_AGENT_WORKTREE_ROOT,
  TEST_COMPARISON_ROOT,
  TEST_DATA_DIR,
  TEST_WORKSPACE_ROOT,
} from "./test-paths.js";

const BASE = {
  schemaVersion: 1,
  workspaceRoot: TEST_WORKSPACE_ROOT,
  comparisonRoot: null,
};

describe("parseHallConfig", () => {
  it("parses a minimal valid config, applying port/codex defaults", () => {
    const config = parseHallConfig(BASE);
    expect(config.workspaceRoot).toBe(TEST_WORKSPACE_ROOT);
    expect(config.hallCorePort).toBe(DEFAULT_HALL_CORE_PORT);
    expect(config.hallWebPort).toBe(DEFAULT_HALL_WEB_PORT);
    expect(config.codexTrustedLocal).toBe(false);
    expect(config.comparisonRoot).toBeNull();
    expect(config.dataDir).toBeUndefined();
    expect(config.agentWorktreeRoot).toBeUndefined();
  });

  it("parses a fully populated config", () => {
    const config = parseHallConfig({
      ...BASE,
      dataDir: TEST_DATA_DIR,
      agentWorktreeRoot: TEST_AGENT_WORKTREE_ROOT,
      comparisonRoot: TEST_COMPARISON_ROOT,
      hallCorePort: 5000,
      hallWebPort: 5001,
      codexTrustedLocal: true,
    });
    expect(config.dataDir).toBe(TEST_DATA_DIR);
    expect(config.comparisonRoot).toBe(TEST_COMPARISON_ROOT);
    expect(config.codexTrustedLocal).toBe(true);
  });

  it("rejects a missing workspaceRoot", () => {
    expect(() => parseHallConfig({ ...BASE, workspaceRoot: undefined })).toThrow(
      HallConfigValidationError,
    );
  });

  it("rejects a missing comparisonRoot key entirely (must be string or null, never absent)", () => {
    const { comparisonRoot: _omit, ...withoutComparisonRoot } = BASE;
    expect(() => parseHallConfig(withoutComparisonRoot)).toThrow(HallConfigValidationError);
  });

  it("rejects an unknown extra field (.strict())", () => {
    expect(() => parseHallConfig({ ...BASE, unknownField: "x" })).toThrow(HallConfigValidationError);
  });

  it("rejects an out-of-range hallCorePort", () => {
    expect(() => parseHallConfig({ ...BASE, hallCorePort: 99999 })).toThrow(HallConfigValidationError);
  });

  it("throws UnsupportedHallConfigSchemaVersionError for a newer schemaVersion", () => {
    expect(() => parseHallConfig({ ...BASE, schemaVersion: 2 })).toThrow(
      UnsupportedHallConfigSchemaVersionError,
    );
  });

  it("rejects schemaVersion 0 as a generic validation error, not unsupported-version", () => {
    expect(() => parseHallConfig({ ...BASE, schemaVersion: 0 })).toThrow(HallConfigValidationError);
  });

  it("never accidentally exposes credential-shaped fields (documentation-as-test)", () => {
    const config = parseHallConfig(BASE);
    expect(Object.keys(config)).not.toContain("token");
    expect(Object.keys(config)).not.toContain("apiKey");
    expect(Object.keys(config)).not.toContain("password");
  });

  it("HALL_CONFIG_SCHEMA_VERSION is 1", () => {
    expect(HALL_CONFIG_SCHEMA_VERSION).toBe(1);
  });
});
