import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./run-cli.js";
import { saveConfig } from "./config-store.js";

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hall-config-cli-test-"));
  configPath = path.join(tmpDir, "config.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function captureStdout() {
  const lines: string[] = [];
  return { lines, writeStdout: (text: string) => lines.push(text) };
}

const VALID_CANDIDATE = {
  schemaVersion: 1,
  workspaceRoot: "D:\\HallOfWisdom",
  comparisonRoot: null,
  hallCorePort: 4310,
  hallWebPort: 3000,
  codexTrustedLocal: false,
};

function parseOutput(line: string | undefined): unknown {
  if (line === undefined) throw new Error("No output line");
  return JSON.parse(line);
}

describe("runCli status", () => {
  it("reports exists:false when no config file is present", () => {
    const out = captureStdout();
    const code = runCli(["status", "--path", configPath], { stdin: "", writeStdout: out.writeStdout });
    expect(code).toBe(0);
    expect(parseOutput(out.lines[0])).toEqual({
      exists: false,
      path: configPath,
      config: null,
      error: null,
    });
  });

  it("reports the loaded config when present", () => {
    saveConfig(VALID_CANDIDATE as never, configPath);
    const out = captureStdout();
    const code = runCli(["status", "--path", configPath], { stdin: "", writeStdout: out.writeStdout });
    expect(code).toBe(0);
    const parsed = parseOutput(out.lines[0]);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Invalid parsed object");
    }
    const obj = parsed as { exists?: unknown; config?: unknown };
    expect(obj.exists).toBe(true);
    if (typeof obj.config !== "object" || obj.config === null) {
      throw new Error("Invalid config object");
    }
    const config = obj.config as { workspaceRoot?: unknown };
    expect(config.workspaceRoot).toBe("D:\\HallOfWisdom");
  });

  it("reports a non-null error (still exit 0) for a malformed existing file, never crashing install.ps1's status check", () => {
    fs.writeFileSync(configPath, "{ not json", "utf8");
    const out = captureStdout();
    const code = runCli(["status", "--path", configPath], { stdin: "", writeStdout: out.writeStdout });
    expect(code).toBe(0);
    const parsed = parseOutput(out.lines[0]);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Invalid parsed object");
    }
    const obj = parsed as { error?: unknown };
    expect(obj.error).not.toBeNull();
  });
});

describe("runCli validate", () => {
  it("reports valid:true for a well-formed candidate", () => {
    const out = captureStdout();
    const code = runCli(["validate", "--path", configPath], {
      stdin: JSON.stringify(VALID_CANDIDATE),
      writeStdout: out.writeStdout,
    });
    expect(code).toBe(0);
    expect(parseOutput(out.lines[0])).toEqual({ valid: true, errors: [] });
  });

  it("reports valid:false and exit 1 for malformed stdin JSON", () => {
    const out = captureStdout();
    const code = runCli(["validate", "--path", configPath], { stdin: "{ not json", writeStdout: out.writeStdout });
    expect(code).toBe(1);
    const parsed = parseOutput(out.lines[0]);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Invalid parsed object");
    }
    const obj = parsed as { valid?: unknown; errors?: unknown; saved?: unknown };
    expect(obj.valid).toBe(false);
    expect(Array.isArray(obj.errors) ? obj.errors.length : 0).toBeGreaterThan(0);
    expect(obj.saved).toBeUndefined();
  });

  it("reports valid:false for a schema-invalid candidate", () => {
    const out = captureStdout();
    const code = runCli(["validate", "--path", configPath], {
      stdin: JSON.stringify({ ...VALID_CANDIDATE, workspaceRoot: undefined }),
      writeStdout: out.writeStdout,
    });
    expect(code).toBe(1);
  });

  it("reports valid:false for a relative workspaceRoot (path pre-check)", () => {
    const out = captureStdout();
    const code = runCli(["validate", "--path", configPath], {
      stdin: JSON.stringify({ ...VALID_CANDIDATE, workspaceRoot: "relative\\path" }),
      writeStdout: out.writeStdout,
    });
    expect(code).toBe(1);
    const parsed = parseOutput(out.lines[0]);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Invalid parsed object");
    }
    const obj = parsed as { errors?: unknown; valid?: unknown; saved?: unknown };
    if (!Array.isArray(obj.errors)) {
      throw new Error("Invalid errors array");
    }
    expect(String(obj.errors[0])).toMatch(/workspaceRoot/);
    expect(obj.valid).toBe(false);
    expect(obj.saved).toBeUndefined();
  });

  it("never writes a file", () => {
    runCli(["validate", "--path", configPath], { stdin: JSON.stringify(VALID_CANDIDATE), writeStdout: () => undefined });
    expect(fs.existsSync(configPath)).toBe(false);
  });
});

describe("runCli save", () => {
  it("saves a valid candidate and reports saved:true", () => {
    const out = captureStdout();
    const code = runCli(["save", "--path", configPath], {
      stdin: JSON.stringify(VALID_CANDIDATE),
      writeStdout: out.writeStdout,
    });
    expect(code).toBe(0);
    expect(parseOutput(out.lines[0])).toEqual({ saved: true, path: configPath });
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it("does not save an invalid candidate", () => {
    const out = captureStdout();
    const code = runCli(["save", "--path", configPath], {
      stdin: JSON.stringify({ ...VALID_CANDIDATE, workspaceRoot: "relative" }),
      writeStdout: out.writeStdout,
    });
    expect(code).toBe(1);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("reports saved:false and exit 1 for malformed stdin JSON, never including valid key", () => {
    const out = captureStdout();
    const code = runCli(["save", "--path", configPath], { stdin: "{ not json", writeStdout: out.writeStdout });
    expect(code).toBe(1);
    const parsed = parseOutput(out.lines[0]);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Invalid parsed object");
    }
    const obj = parsed as { saved?: unknown; errors?: unknown; valid?: unknown };
    expect(obj.saved).toBe(false);
    expect(Array.isArray(obj.errors) ? obj.errors.length : 0).toBeGreaterThan(0);
    expect(obj.valid).toBeUndefined();
  });

  it("reports saved:false for a relative workspaceRoot (path pre-check), never including valid key", () => {
    const out = captureStdout();
    const code = runCli(["save", "--path", configPath], {
      stdin: JSON.stringify({ ...VALID_CANDIDATE, workspaceRoot: "relative\\path" }),
      writeStdout: out.writeStdout,
    });
    expect(code).toBe(1);
    const parsed = parseOutput(out.lines[0]);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Invalid parsed object");
    }
    const obj = parsed as { errors?: unknown; saved?: unknown; valid?: unknown };
    if (!Array.isArray(obj.errors)) {
      throw new Error("Invalid errors array");
    }
    expect(String(obj.errors[0])).toMatch(/workspaceRoot/);
    expect(obj.saved).toBe(false);
    expect(obj.valid).toBeUndefined();
  });
});

describe("runCli unknown command", () => {
  it("reports an error and exit 1", () => {
    const out = captureStdout();
    const code = runCli(["not-a-command"], { stdin: "", writeStdout: out.writeStdout });
    expect(code).toBe(1);
    const parsed = parseOutput(out.lines[0]);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Invalid parsed object");
    }
    const obj = parsed as { error?: unknown };
    expect(String(obj.error)).toMatch(/Unknown command/);
  });
});
