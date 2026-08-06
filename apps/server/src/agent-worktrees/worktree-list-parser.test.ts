import { describe, expect, it } from "vitest";
import { AgentWorktreeGitOperationError } from "./agent-worktree-errors.js";
import {
  GIT_WORKTREE_LIST_MALFORMED_CODE,
  parseWorktreeListPorcelainZ,
} from "./worktree-list-parser.js";

/** Builds valid `git worktree list --porcelain -z` bytes — each worktree becomes its own minimal record (just the `worktree <path>` attribute), matching the real NUL-delimited structure confirmed against a real Git 2.54 invocation (see this module's own doc comment). */
function porcelainZ(paths: readonly string[]): string {
  return paths.map((worktreePath) => `worktree ${worktreePath}\0\0`).join("");
}

function expectMalformed(fn: () => void): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AgentWorktreeGitOperationError);
  const error = thrown as AgentWorktreeGitOperationError;
  expect(error.safeFailureCode).toBe(GIT_WORKTREE_LIST_MALFORMED_CODE);
}

describe("parseWorktreeListPorcelainZ", () => {
  it("parses a valid primary checkout (single record, with HEAD/branch attributes present)", () => {
    const paths = parseWorktreeListPorcelainZ(
      `worktree C:\\repo\0HEAD ${"a".repeat(40)}\0branch refs/heads/main\0\0`,
    );
    expect(paths).toEqual(["C:\\repo"]);
  });

  it("parses multiple valid worktrees in one output", () => {
    const paths = parseWorktreeListPorcelainZ(
      porcelainZ(["C:\\repo", "C:\\repo\\wt_a", "C:\\repo\\wt_b"]),
    );
    expect(paths).toEqual(["C:\\repo", "C:\\repo\\wt_a", "C:\\repo\\wt_b"]);
  });

  it("preserves paths containing spaces exactly", () => {
    const withSpaces = "C:\\Users\\Some User\\hall owned\\wt_1";
    const paths = parseWorktreeListPorcelainZ(porcelainZ([withSpaces]));
    expect(paths).toEqual([withSpaces]);
  });

  it("preserves valid non-ASCII paths exactly", () => {
    const nonAscii = "C:\\hall-owned\\wt-ünïcödé-日本語";
    const paths = parseWorktreeListPorcelainZ(porcelainZ([nonAscii]));
    expect(paths).toEqual([nonAscii]);
  });

  it("returns an empty list for genuinely empty output, not an error", () => {
    expect(parseWorktreeListPorcelainZ("")).toEqual([]);
  });

  it("fails closed when a record's first attribute is not a worktree field", () => {
    expectMalformed(() => {
      parseWorktreeListPorcelainZ(`HEAD ${"a".repeat(40)}\0branch refs/heads/main\0\0`);
    });
  });

  it("fails closed on a relative path", () => {
    expectMalformed(() => {
      parseWorktreeListPorcelainZ(porcelainZ(["relative/path"]));
    });
  });

  it("fails closed on an empty worktree path", () => {
    expectMalformed(() => {
      parseWorktreeListPorcelainZ("worktree \0\0");
    });
  });

  it("fails closed on a malformed record separator (two records fused by a single NUL instead of double)", () => {
    // A well-formed two-record output is "worktree A\0\0worktree B\0\0"; a
    // single missing NUL merges both `worktree` attributes into one
    // record, which is never valid, real Git structure.
    expectMalformed(() => {
      parseWorktreeListPorcelainZ("worktree /a\0worktree /b\0\0");
    });
  });

  it("fails closed on an incomplete final record (no closing record-separator NUL)", () => {
    expectMalformed(() => {
      parseWorktreeListPorcelainZ("worktree /a\0\0worktree /b");
    });
  });

  it("fails closed on output that does not end on a NUL at all", () => {
    expectMalformed(() => {
      parseWorktreeListPorcelainZ("worktree /a");
    });
  });

  it("fails closed on duplicate/invalid record structure — the same worktree path registered twice", () => {
    expectMalformed(() => {
      parseWorktreeListPorcelainZ(porcelainZ(["C:\\repo\\wt_a", "C:\\repo\\wt_a"]));
    });
  });

  it("fails closed on a record with more than one worktree attribute", () => {
    expectMalformed(() => {
      parseWorktreeListPorcelainZ("worktree /a\0worktree /a-again\0\0");
    });
  });

  it("never trims meaningful leading or trailing content from a valid path", () => {
    // A path that legitimately ends in a space is unusual but must not be
    // silently altered — this parser's job is byte-exact reconstruction,
    // not opinion about what a path "should" look like.
    const trailingSpace = "C:\\hall-owned\\wt_trailing ";
    const paths = parseWorktreeListPorcelainZ(porcelainZ([trailingSpace]));
    expect(paths[0]).toBe(trailingSpace);
  });
});
