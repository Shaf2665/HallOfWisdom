import { describe, expect, it } from "vitest";
import { toSafeRelativeFilePath } from "./file-path-safety.js";

const WORKDIR = "D:\\fixture\\workdir";

describe("toSafeRelativeFilePath", () => {
  it("converts an absolute in-directory path to a normalized relative path", () => {
    expect(toSafeRelativeFilePath("D:\\fixture\\workdir\\src\\a.ts", WORKDIR)).toBe("src/a.ts");
  });

  it("converts a relative in-directory path to a normalized relative path", () => {
    expect(toSafeRelativeFilePath("src\\a.ts", WORKDIR)).toBe("src/a.ts");
  });

  it("normalizes backslash separators to forward slashes", () => {
    expect(toSafeRelativeFilePath("a\\b\\c.ts", WORKDIR)).toBe("a/b/c.ts");
  });

  it("rejects a path that escapes the working directory via ..", () => {
    expect(toSafeRelativeFilePath("..\\outside.ts", WORKDIR)).toBeUndefined();
  });

  it("rejects an absolute path outside the working directory entirely", () => {
    expect(toSafeRelativeFilePath("D:\\other\\place.ts", WORKDIR)).toBeUndefined();
  });

  it("rejects a path resolving to the working directory itself", () => {
    expect(toSafeRelativeFilePath(".", WORKDIR)).toBeUndefined();
    expect(toSafeRelativeFilePath("D:\\fixture\\workdir", WORKDIR)).toBeUndefined();
  });

  it("rejects a deeply nested escape", () => {
    expect(
      toSafeRelativeFilePath("..\\..\\..\\Windows\\System32\\config.sys", WORKDIR),
    ).toBeUndefined();
  });

  it("never returns an absolute path", () => {
    const result = toSafeRelativeFilePath("nested\\file.ts", WORKDIR);
    expect(result).toBeDefined();
    if (result !== undefined) {
      expect(result.startsWith("D:")).toBe(false);
      expect(result.startsWith("/")).toBe(false);
    }
  });

  describe("canonical (realpath) escape detection", () => {
    it("rejects a path that is lexically inside but canonically escapes via a symlinked directory", () => {
      // Simulates "src" inside the working directory actually being a
      // symlink to an external location — the lexical check alone cannot
      // see this; only resolving through the filesystem's own symlink
      // resolution can.
      const fakeRealpath = (path: string): string => {
        if (path === WORKDIR) return WORKDIR;
        if (path === `${WORKDIR}\\src\\a.ts`) return "D:\\somewhere\\external\\a.ts";
        return path;
      };
      expect(
        toSafeRelativeFilePath("src\\a.ts", WORKDIR, { realpath: fakeRealpath }),
      ).toBeUndefined();
    });

    it("still accepts a path that is canonically inside the working directory", () => {
      const fakeRealpath = (path: string): string => path;
      expect(toSafeRelativeFilePath("src\\a.ts", WORKDIR, { realpath: fakeRealpath })).toBe(
        "src/a.ts",
      );
    });

    it("falls back to the lexical result when realpath cannot resolve the path", () => {
      const fakeRealpath = (): string => {
        throw new Error("ENOENT: no such file or directory");
      };
      expect(toSafeRelativeFilePath("src\\a.ts", WORKDIR, { realpath: fakeRealpath })).toBe(
        "src/a.ts",
      );
    });

    it("does not reject when the canonical working directory and path simply have different casing", () => {
      const fakeRealpath = (path: string): string => path.toLowerCase();
      expect(toSafeRelativeFilePath("src\\a.ts", WORKDIR, { realpath: fakeRealpath })).toBe(
        "src/a.ts",
      );
    });
  });
});
