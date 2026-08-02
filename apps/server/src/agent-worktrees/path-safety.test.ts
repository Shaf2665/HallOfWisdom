import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentWorktreePathError } from "./agent-worktree-errors.js";
import {
  assertContainedPath,
  canonicalizeExistingDirectory,
  canonicalizeOwnedRoot,
  isPathContained,
} from "./path-safety.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync.native(dir);
}

describe("agent worktree path safety", () => {
  it("rejects a relative owned root", () => {
    const source = tempRoot("hall-source-");
    expect(() =>
      canonicalizeOwnedRoot({
        rawOwnedRoot: "relative-root",
        canonicalSourceRepositoryRoot: source,
      }),
    ).toThrow(AgentWorktreePathError);
  });

  it("rejects a filesystem root as the owned root", () => {
    const source = tempRoot("hall-source-");
    expect(() =>
      canonicalizeOwnedRoot({
        rawOwnedRoot: path.parse(source).root,
        canonicalSourceRepositoryRoot: source,
      }),
    ).toThrow(AgentWorktreePathError);
  });

  it("allows paths containing spaces", () => {
    const base = tempRoot("hall path safety ");
    fs.mkdirSync(path.join(base, "Source Repo"), { recursive: true });
    const source = fs.realpathSync.native(path.join(base, "Source Repo"));
    const owned = canonicalizeOwnedRoot({
      rawOwnedRoot: path.join(base, "Owned Worktrees"),
      canonicalSourceRepositoryRoot: source,
    });
    expect(owned).toContain("Owned Worktrees");
  });

  it("rejects an owned root inside the source repository", () => {
    const source = tempRoot("hall-source-");
    expect(() =>
      canonicalizeOwnedRoot({
        rawOwnedRoot: path.join(source, "agent-worktrees"),
        canonicalSourceRepositoryRoot: source,
      }),
    ).toThrow(AgentWorktreePathError);
  });

  it("rejects a source repository inside the owned root", () => {
    const root = tempRoot("hall-owned-");
    fs.mkdirSync(path.join(root, "repo"), { recursive: true });
    const source = fs.realpathSync.native(path.join(root, "repo"));
    expect(() =>
      canonicalizeOwnedRoot({
        rawOwnedRoot: root,
        canonicalSourceRepositoryRoot: source,
      }),
    ).toThrow(AgentWorktreePathError);
  });

  it("rejects symlink escapes where supported", () => {
    const base = tempRoot("hall-symlink-");
    fs.mkdirSync(path.join(base, "source"), { recursive: true });
    fs.mkdirSync(path.join(base, "outside"), { recursive: true });
    const source = fs.realpathSync.native(path.join(base, "source"));
    const outside = fs.realpathSync.native(path.join(base, "outside"));
    const link = path.join(source, "link");
    try {
      fs.symlinkSync(outside, link, "junction");
    } catch {
      return undefined;
    }
    const canonical = canonicalizeExistingDirectory(link, "linked directory");
    expect(() => {
      assertContainedPath({
        rootPath: source,
        candidatePath: canonical,
        description: "linked directory",
      });
    }).toThrow(AgentWorktreePathError);
  });

  it("does not treat prefix-confusion siblings as contained", () => {
    const root = path.win32.resolve("C:\\Projects\\Repo");
    const sibling = path.win32.resolve("C:\\Projects\\Repo-other");
    expect(isPathContained(root, sibling)).toBe(false);
  });

  it("uses case-insensitive containment on Windows-style paths", () => {
    if (process.platform === "win32" || process.platform === "darwin") {
      expect(isPathContained("C:\\Projects\\Repo", "c:\\projects\\repo\\apps")).toBe(true);
    } else {
      expect(isPathContained("C:\\Projects\\Repo", "c:\\projects\\repo\\apps")).toBe(false);
    }
  });
});
