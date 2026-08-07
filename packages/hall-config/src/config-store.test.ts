import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HallConfigNotFoundError, loadConfig, saveConfig, tryLoadConfig } from "./config-store.js";
import { HallConfigValidationError, UnsupportedHallConfigSchemaVersionError } from "./schema.js";

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hall-config-store-test-"));
  configPath = path.join(tmpDir, "nested", "config.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const VALID_CONFIG = {
  schemaVersion: 1 as const,
  workspaceRoot: "D:\\HallOfWisdom",
  comparisonRoot: null,
  dataDir: undefined,
  agentWorktreeRoot: undefined,
  hallCorePort: 4310,
  hallWebPort: 3000,
  codexTrustedLocal: false,
};

describe("saveConfig / loadConfig round-trip", () => {
  it("creates the directory and writes a readable config", () => {
    saveConfig(VALID_CONFIG, configPath);
    const loaded = loadConfig(configPath);
    expect(loaded.config.workspaceRoot).toBe("D:\\HallOfWisdom");
    expect(loaded.path).toBe(configPath);
  });

  it("overwrites an existing config atomically (no leftover temp files)", () => {
    saveConfig(VALID_CONFIG, configPath);
    saveConfig({ ...VALID_CONFIG, workspaceRoot: "D:\\Other" }, configPath);
    const loaded = loadConfig(configPath);
    expect(loaded.config.workspaceRoot).toBe("D:\\Other");
    const dirEntries = fs.readdirSync(path.dirname(configPath));
    expect(dirEntries).toEqual(["config.json"]);
  });

  it("rejects saving an invalid config before ever touching the file", () => {
    expect(() => saveConfig({ ...VALID_CONFIG, workspaceRoot: "" } as never, configPath)).toThrow();
    expect(fs.existsSync(configPath)).toBe(false);
  });
});

describe("loadConfig", () => {
  it("throws HallConfigNotFoundError when no file exists", () => {
    expect(() => loadConfig(configPath)).toThrow(HallConfigNotFoundError);
  });

  it("throws HallConfigValidationError on malformed JSON content", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{ not valid json", "utf8");
    expect(() => loadConfig(configPath)).toThrow();
  });

  it("throws HallConfigValidationError on schema-invalid JSON content", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1 }), "utf8");
    expect(() => loadConfig(configPath)).toThrow(HallConfigValidationError);
  });

  it("throws UnsupportedHallConfigSchemaVersionError on a future schema version", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ ...VALID_CONFIG, schemaVersion: 2 }), "utf8");
    expect(() => loadConfig(configPath)).toThrow(UnsupportedHallConfigSchemaVersionError);
  });
});

describe("tryLoadConfig", () => {
  it("returns undefined (never throws) when no file exists", () => {
    expect(tryLoadConfig(configPath)).toBeUndefined();
  });

  it("returns the loaded config when the file exists", () => {
    saveConfig(VALID_CONFIG, configPath);
    expect(tryLoadConfig(configPath)?.config.workspaceRoot).toBe("D:\\HallOfWisdom");
  });

  it("still throws on a malformed existing file (never masks corruption as absence)", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{ not valid json", "utf8");
    expect(() => tryLoadConfig(configPath)).toThrow();
  });
});
