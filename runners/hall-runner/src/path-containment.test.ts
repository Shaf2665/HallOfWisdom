import path from "node:path";
import { describe, expect, it } from "vitest";
import { isContainedPath } from "./path-containment.js";

describe("isContainedPath (Windows semantics, path.win32)", () => {
  it("treats the workspace root itself as contained", () => {
    expect(
      isContainedPath("C:\\workspace", "C:\\workspace", { caseSensitive: false, path: path.win32 }),
    ).toBe(true);
  });

  it("treats a descendant directory as contained", () => {
    expect(
      isContainedPath("C:\\workspace", "C:\\workspace\\src\\lib", {
        caseSensitive: false,
        path: path.win32,
      }),
    ).toBe(true);
  });

  it("is case-insensitive by default (Windows)", () => {
    expect(
      isContainedPath("C:\\Workspace", "c:\\workspace\\SRC", {
        caseSensitive: false,
        path: path.win32,
      }),
    ).toBe(true);
  });

  it("rejects a prefix-confusion sibling directory (C:\\workspace-other)", () => {
    expect(
      isContainedPath("C:\\workspace", "C:\\workspace-other\\file", {
        caseSensitive: false,
        path: path.win32,
      }),
    ).toBe(false);
  });

  it("rejects a parent-traversal path", () => {
    expect(
      isContainedPath("C:\\workspace\\project", "C:\\workspace", {
        caseSensitive: false,
        path: path.win32,
      }),
    ).toBe(false);
  });

  it("rejects a directory on a different drive", () => {
    expect(
      isContainedPath("C:\\workspace", "D:\\workspace\\file", {
        caseSensitive: false,
        path: path.win32,
      }),
    ).toBe(false);
  });

  it("handles paths containing spaces", () => {
    expect(
      isContainedPath("C:\\Projects\\Hall Of Wisdom", "C:\\Projects\\Hall Of Wisdom\\src dir", {
        caseSensitive: false,
        path: path.win32,
      }),
    ).toBe(true);
  });
});

describe("isContainedPath (POSIX semantics, path.posix)", () => {
  it("treats the workspace root itself as contained", () => {
    expect(
      isContainedPath("/workspace", "/workspace", { caseSensitive: true, path: path.posix }),
    ).toBe(true);
  });

  it("treats a descendant directory as contained", () => {
    expect(
      isContainedPath("/workspace", "/workspace/src/lib", {
        caseSensitive: true,
        path: path.posix,
      }),
    ).toBe(true);
  });

  it("is case-sensitive by default (POSIX)", () => {
    expect(
      isContainedPath("/workspace", "/Workspace/src", { caseSensitive: true, path: path.posix }),
    ).toBe(false);
  });

  it("rejects a prefix-confusion sibling directory (/workspace-other)", () => {
    expect(
      isContainedPath("/workspace", "/workspace-other/file", {
        caseSensitive: true,
        path: path.posix,
      }),
    ).toBe(false);
  });

  it("rejects a parent-traversal path", () => {
    expect(
      isContainedPath("/workspace/project", "/workspace", {
        caseSensitive: true,
        path: path.posix,
      }),
    ).toBe(false);
  });

  it("handles paths containing spaces", () => {
    expect(
      isContainedPath("/home/user/Hall Of Wisdom", "/home/user/Hall Of Wisdom/src dir", {
        caseSensitive: true,
        path: path.posix,
      }),
    ).toBe(true);
  });
});
