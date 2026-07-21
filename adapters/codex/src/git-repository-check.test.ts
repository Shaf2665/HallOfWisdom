import { describe, expect, it } from "vitest";
import { isInsideGitRepository, type GitRepositoryProbe } from "./git-repository-check.js";

function fakeProbe(existingPaths: readonly string[]): GitRepositoryProbe {
  const set = new Set(existingPaths);
  return { exists: (path) => set.has(path) };
}

// node:path adapts to the host platform (win32 on this project's CI/dev
// machine), so fixture paths use path.join throughout rather than
// hardcoded POSIX separators — otherwise a Windows path.join("/repo",
// ".git") produces a backslash-joined path that would never match a
// POSIX-style fixture key.
import { join } from "node:path";

describe("isInsideGitRepository", () => {
  it("returns true when .git exists directly in the working directory", () => {
    const repo = join("C:\\", "repo");
    const result = isInsideGitRepository(repo, fakeProbe([join(repo, ".git")]));
    expect(result).toBe(true);
  });

  it("returns true when .git exists in an ancestor directory (a subdirectory of a repo)", () => {
    const repo = join("C:\\", "repo");
    const nested = join(repo, "src", "nested");
    const result = isInsideGitRepository(nested, fakeProbe([join(repo, ".git")]));
    expect(result).toBe(true);
  });

  it("returns true for a linked-worktree .git file, not only a .git directory", () => {
    // The probe only reports existence, not whether it's a file or a
    // directory — a worktree's .git is a text file, which is sufficient
    // evidence by design.
    const worktree = join("C:\\", "worktree");
    const result = isInsideGitRepository(worktree, fakeProbe([join(worktree, ".git")]));
    expect(result).toBe(true);
  });

  it("returns false when no ancestor has a .git entry", () => {
    const nested = join("C:\\", "not-a-repo", "nested");
    const result = isInsideGitRepository(nested, fakeProbe([]));
    expect(result).toBe(false);
  });

  it("stops at the filesystem root without an infinite loop", () => {
    const result = isInsideGitRepository("C:\\", fakeProbe([]));
    expect(result).toBe(false);
  });

  it("is bounded and does not hang for a very deep path with no .git anywhere", () => {
    const deepPath = join("C:\\", ...Array.from({ length: 500 }, (_, i) => `level${String(i)}`));
    const result = isInsideGitRepository(deepPath, fakeProbe([]));
    expect(result).toBe(false);
  });

  it("never invokes a shell command — only the injected probe is consulted", () => {
    const repo = join("C:\\", "repo");
    let calls = 0;
    const probe: GitRepositoryProbe = {
      exists: (path) => {
        calls += 1;
        return path === join(repo, ".git");
      },
    };
    isInsideGitRepository(repo, probe);
    expect(calls).toBeGreaterThan(0);
  });
});
