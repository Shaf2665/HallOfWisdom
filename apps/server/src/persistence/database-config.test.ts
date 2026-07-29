import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataDirValidationError } from "./persistence-errors.js";
import { resolveDataDir } from "./database-config.js";

describe("resolveDataDir", () => {
  let workspaceRoot: string;
  let comparisonRoot: string;
  let parent: string;

  beforeEach(() => {
    parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "hall-datadir-test-")));
    workspaceRoot = path.join(parent, "workspace");
    comparisonRoot = path.join(parent, "comparisons");
    fs.mkdirSync(workspaceRoot);
    fs.mkdirSync(comparisonRoot);
  });

  afterEach(() => {
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it("rejects a relative dataDir", () => {
    expect(() => resolveDataDir({ dataDir: "relative/path", workspaceRoot })).toThrow(
      DataDirValidationError,
    );
  });

  it("creates the directory when missing and returns its canonical path", () => {
    const raw = path.join(parent, "data");
    const resolved = resolveDataDir({ dataDir: raw, workspaceRoot });
    expect(fs.existsSync(raw)).toBe(true);
    expect(resolved).toBe(fs.realpathSync.native(raw));
  });

  it("rejects dataDir equal to workspaceRoot", () => {
    expect(() => resolveDataDir({ dataDir: workspaceRoot, workspaceRoot })).toThrow(
      DataDirValidationError,
    );
  });

  it("rejects dataDir nested under workspaceRoot", () => {
    const nested = path.join(workspaceRoot, "data");
    expect(() => resolveDataDir({ dataDir: nested, workspaceRoot })).toThrow(
      DataDirValidationError,
    );
  });

  it("rejects workspaceRoot nested under dataDir", () => {
    const dataDir = parent;
    expect(() => resolveDataDir({ dataDir, workspaceRoot })).toThrow(DataDirValidationError);
  });

  it("rejects dataDir nested under comparisonRoot", () => {
    const nested = path.join(comparisonRoot, "data");
    expect(() => resolveDataDir({ dataDir: nested, workspaceRoot, comparisonRoot })).toThrow(
      DataDirValidationError,
    );
  });

  it("rejects comparisonRoot nested under dataDir", () => {
    const dataDir = parent;
    expect(() => resolveDataDir({ dataDir, workspaceRoot: parent, comparisonRoot })).toThrow(
      DataDirValidationError,
    );
  });

  it("accepts three valid, mutually separate roots", () => {
    const dataDir = path.join(parent, "data");
    const resolved = resolveDataDir({ dataDir, workspaceRoot, comparisonRoot });
    expect(resolved).toBe(fs.realpathSync.native(dataDir));
  });

  it("rejects a dataDir that is actually a file, not a directory", () => {
    const filePath = path.join(parent, "not-a-dir.txt");
    fs.writeFileSync(filePath, "hello");
    expect(() => resolveDataDir({ dataDir: filePath, workspaceRoot })).toThrow(
      DataDirValidationError,
    );
  });

  it("resolves a symlinked dataDir through realpath before checking containment", () => {
    const real = path.join(parent, "real-data");
    fs.mkdirSync(real);
    const link = path.join(parent, "link-data");
    try {
      fs.symlinkSync(real, link, "junction");
    } catch {
      return; // symlink creation can require elevated privileges on some environments — skip rather than fail the suite there.
    }
    const resolved = resolveDataDir({ dataDir: link, workspaceRoot });
    expect(resolved).toBe(fs.realpathSync.native(real));
  });

  it("rejects a symlinked dataDir that resolves inside workspaceRoot", () => {
    const insideWorkspace = path.join(workspaceRoot, "real-data");
    fs.mkdirSync(insideWorkspace);
    const link = path.join(parent, "link-into-workspace");
    try {
      fs.symlinkSync(insideWorkspace, link, "junction");
    } catch {
      return;
    }
    expect(() => resolveDataDir({ dataDir: link, workspaceRoot })).toThrow(DataDirValidationError);
  });
});
