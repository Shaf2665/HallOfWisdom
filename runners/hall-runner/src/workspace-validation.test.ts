import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateWorkspace } from "./workspace-validation.js";
import {
  InvalidWorkingDirectoryError,
  InvalidWorkspaceRootError,
  WorkingDirectoryOutsideWorkspaceError,
} from "./errors.js";

describe("validateWorkspace", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-runner-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("accepts the workspace root as its own working directory", () => {
    const result = validateWorkspace({ workspaceRoot: tempRoot, workingDirectory: tempRoot });
    expect(result.workspaceRoot).toBeTruthy();
    expect(result.workingDirectory).toBeTruthy();
  });

  it("accepts a valid descendant working directory", () => {
    const descendant = path.join(tempRoot, "src", "lib");
    fs.mkdirSync(descendant, { recursive: true });
    expect(() =>
      validateWorkspace({ workspaceRoot: tempRoot, workingDirectory: descendant }),
    ).not.toThrow();
  });

  it("accepts a working directory containing spaces", () => {
    const spaced = path.join(tempRoot, "Hall Of Wisdom src");
    fs.mkdirSync(spaced);
    expect(() =>
      validateWorkspace({ workspaceRoot: tempRoot, workingDirectory: spaced }),
    ).not.toThrow();
  });

  it("rejects an empty workspace root", () => {
    expect(() => validateWorkspace({ workspaceRoot: "", workingDirectory: tempRoot })).toThrow(
      InvalidWorkspaceRootError,
    );
  });

  it("rejects an empty working directory", () => {
    expect(() => validateWorkspace({ workspaceRoot: tempRoot, workingDirectory: "" })).toThrow(
      InvalidWorkingDirectoryError,
    );
  });

  it("rejects a relative workspace root", () => {
    expect(() =>
      validateWorkspace({ workspaceRoot: "relative/path", workingDirectory: tempRoot }),
    ).toThrow(InvalidWorkspaceRootError);
  });

  it("rejects a relative working directory", () => {
    expect(() =>
      validateWorkspace({ workspaceRoot: tempRoot, workingDirectory: "relative/path" }),
    ).toThrow(InvalidWorkingDirectoryError);
  });

  it("rejects a nonexistent workspace root", () => {
    const missing = path.join(tempRoot, "does-not-exist");
    expect(() => validateWorkspace({ workspaceRoot: missing, workingDirectory: tempRoot })).toThrow(
      InvalidWorkspaceRootError,
    );
  });

  it("rejects a nonexistent working directory", () => {
    const missing = path.join(tempRoot, "does-not-exist");
    expect(() => validateWorkspace({ workspaceRoot: tempRoot, workingDirectory: missing })).toThrow(
      InvalidWorkingDirectoryError,
    );
  });

  it("rejects a file passed instead of a directory", () => {
    const filePath = path.join(tempRoot, "file.txt");
    fs.writeFileSync(filePath, "content");
    expect(() =>
      validateWorkspace({ workspaceRoot: tempRoot, workingDirectory: filePath }),
    ).toThrow(InvalidWorkingDirectoryError);
  });

  it("rejects a working directory outside the workspace root", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hall-runner-outside-"));
    try {
      expect(() =>
        validateWorkspace({ workspaceRoot: tempRoot, workingDirectory: outside }),
      ).toThrow(WorkingDirectoryOutsideWorkspaceError);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a prefix-confusion sibling directory", () => {
    const sibling = `${tempRoot}-other`;
    fs.mkdirSync(sibling);
    try {
      expect(() =>
        validateWorkspace({ workspaceRoot: tempRoot, workingDirectory: sibling }),
      ).toThrow(WorkingDirectoryOutsideWorkspaceError);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("rejects a parent-traversal attempt (working directory is the parent of the workspace root)", () => {
    const nestedRoot = path.join(tempRoot, "workspace");
    fs.mkdirSync(nestedRoot);
    expect(() =>
      validateWorkspace({ workspaceRoot: nestedRoot, workingDirectory: tempRoot }),
    ).toThrow(WorkingDirectoryOutsideWorkspaceError);
  });

  it("rejects a NUL byte in the workspace root", () => {
    expect(() =>
      validateWorkspace({ workspaceRoot: `${tempRoot}\0`, workingDirectory: tempRoot }),
    ).toThrow(InvalidWorkspaceRootError);
  });

  it("rejects a symlink/junction that escapes the workspace root", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hall-runner-escape-target-"));
    const linkPath = path.join(tempRoot, "escape-link");
    try {
      fs.symlinkSync(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
    } catch {
      // Creating symlinks/junctions can require elevated privileges on some
      // Windows configurations; skip rather than fail the suite for an
      // environment limitation unrelated to the validation logic itself.
      fs.rmSync(outside, { recursive: true, force: true });
      return;
    }
    try {
      expect(() =>
        validateWorkspace({ workspaceRoot: tempRoot, workingDirectory: linkPath }),
      ).toThrow(WorkingDirectoryOutsideWorkspaceError);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
