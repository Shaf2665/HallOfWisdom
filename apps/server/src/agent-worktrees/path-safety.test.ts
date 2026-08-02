import fs from "node:fs";
import { execFileSync } from "node:child_process";
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

  it("rejects an owned root inside the source repository before creating it", () => {
    const source = createGitRepository("hall-source-");
    const statusBefore = gitStatus(source);
    const proposed = path.join(source, ".hall-worktrees");
    expect(() =>
      canonicalizeOwnedRoot({
        rawOwnedRoot: proposed,
        canonicalSourceRepositoryRoot: source,
      }),
    ).toThrow(AgentWorktreePathError);
    expect(fs.existsSync(proposed)).toBe(false);
    expect(gitStatus(source)).toEqual(statusBefore);
  });

  it("rejects an owned root equal to the source repository", () => {
    const source = tempRoot("hall-source-");
    expect(() =>
      canonicalizeOwnedRoot({
        rawOwnedRoot: source,
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

  it("allows a prefix-confusion sibling owned root", () => {
    const base = tempRoot("hall-prefix-confusion-");
    fs.mkdirSync(path.join(base, "repo"), { recursive: true });
    const source = fs.realpathSync.native(path.join(base, "repo"));
    const owned = canonicalizeOwnedRoot({
      rawOwnedRoot: path.join(base, "repo-other"),
      canonicalSourceRepositoryRoot: source,
    });
    expect(owned).toBe(fs.realpathSync.native(path.join(base, "repo-other")));
  });

  it("rejects an existing owned-root parent symlink that would redirect creation into source", () => {
    const base = tempRoot("hall-owned-parent-link-");
    fs.mkdirSync(path.join(base, "source"), { recursive: true });
    const source = fs.realpathSync.native(path.join(base, "source"));
    const link = path.join(base, "linked-parent");
    try {
      fs.symlinkSync(source, link, "junction");
    } catch {
      return undefined;
    }
    const proposed = path.join(link, "would-be-owned");

    expect(() =>
      canonicalizeOwnedRoot({
        rawOwnedRoot: proposed,
        canonicalSourceRepositoryRoot: source,
      }),
    ).toThrow(AgentWorktreePathError);
    expect(fs.existsSync(path.join(source, "would-be-owned"))).toBe(false);
  });

  it("uses case-insensitive containment on Windows-style paths", () => {
    if (process.platform === "win32" || process.platform === "darwin") {
      expect(isPathContained("C:\\Projects\\Repo", "c:\\projects\\repo\\apps")).toBe(true);
    } else {
      expect(isPathContained("C:\\Projects\\Repo", "c:\\projects\\repo\\apps")).toBe(false);
    }
  });
});

function createGitRepository(prefix: string): string {
  const repo = tempRoot(prefix);
  git(["init", "-b", "main"], repo);
  git(["config", "user.name", "Hall Test"], repo);
  git(["config", "user.email", "hall-test@example.invalid"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "initial"], repo);
  return repo;
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
  }).trim();
}

function gitStatus(repo: string): {
  readonly head: string;
  readonly status: string;
} {
  return {
    head: git(["rev-parse", "--verify", "HEAD^{commit}"], repo),
    status: git(["status", "--porcelain=v1", "--untracked-files=all"], repo),
  };
}
