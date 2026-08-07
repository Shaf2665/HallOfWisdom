import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentWorktreeGitOperationError } from "./agent-worktree-errors.js";
import {
  GIT_WORKTREE_LIST_MALFORMED_CODE,
  parseWorktreeListPorcelainZ,
} from "./worktree-list-parser.js";

const SHA1_HEAD = "a".repeat(40);
const SHA256_HEAD = "b".repeat(64);

/** A platform-native absolute path, built with `path.resolve()` off the current root/drive rather than a hard-coded OS-specific literal — resolves to e.g. `/hall-owned/wt_a` on POSIX or `D:\hall-owned\wt_a` on Windows (whichever drive the process happens to run from), matching what the runtime parser (which uses the current platform's `node:path`) actually accepts. Never touches the filesystem — the parser is pure string validation. */
function absPath(...segments: readonly string[]): string {
  return path.resolve(path.sep, ...segments);
}

/** Builds one complete, valid NUL-delimited record with an explicit attribute list — see `worktree-list-parser.ts`'s doc comment for the exact byte structure (each attribute NUL-terminated, one extra NUL as the record boundary). */
function buildRecord(attributes: readonly string[]): string {
  return attributes.map((attribute) => `${attribute}\0`).join("") + "\0";
}

function buildOutput(...records: readonly (readonly string[])[]): string {
  return records.map(buildRecord).join("");
}

/** A complete, valid non-bare (branch) record for each given path — the common case most "valid path extraction" tests want, not the minimal/incomplete form. */
function porcelainZ(paths: readonly string[]): string {
  return buildOutput(
    ...paths.map((worktreePath, index) => [
      `worktree ${worktreePath}`,
      `HEAD ${SHA1_HEAD}`,
      `branch refs/heads/branch-${String(index)}`,
    ]),
  );
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
  describe("valid records (platform-native paths)", () => {
    it("parses a valid branch worktree (single record, with HEAD/branch attributes present)", () => {
      const p = absPath("repo");
      const paths = parseWorktreeListPorcelainZ(
        buildRecord([`worktree ${p}`, `HEAD ${SHA1_HEAD}`, "branch refs/heads/main"]),
      );
      expect(paths).toEqual([p]);
    });

    it("parses a valid detached worktree", () => {
      const p = absPath("repo", "wt_detached");
      const paths = parseWorktreeListPorcelainZ(
        buildRecord([`worktree ${p}`, `HEAD ${SHA1_HEAD}`, "detached"]),
      );
      expect(paths).toEqual([p]);
    });

    it("parses a valid bare repository record", () => {
      const p = absPath("bare-repo.git");
      const paths = parseWorktreeListPorcelainZ(buildRecord([`worktree ${p}`, "bare"]));
      expect(paths).toEqual([p]);
    });

    it("accepts a locked worktree with a reason", () => {
      const p = absPath("repo", "wt_locked");
      const paths = parseWorktreeListPorcelainZ(
        buildRecord([
          `worktree ${p}`,
          `HEAD ${SHA1_HEAD}`,
          "detached",
          "locked administratively locked",
        ]),
      );
      expect(paths).toEqual([p]);
    });

    it("accepts a locked worktree with no reason", () => {
      const p = absPath("repo", "wt_locked_no_reason");
      const paths = parseWorktreeListPorcelainZ(
        buildRecord([`worktree ${p}`, `HEAD ${SHA1_HEAD}`, "detached", "locked"]),
      );
      expect(paths).toEqual([p]);
    });

    it("accepts a prunable worktree with a reason", () => {
      const p = absPath("repo", "wt_prunable");
      const paths = parseWorktreeListPorcelainZ(
        buildRecord([
          `worktree ${p}`,
          `HEAD ${SHA1_HEAD}`,
          "detached",
          "prunable gitdir file points to non-existent location",
        ]),
      );
      expect(paths).toEqual([p]);
    });

    it("accepts a prunable worktree with no reason", () => {
      const p = absPath("repo", "wt_prunable_no_reason");
      const paths = parseWorktreeListPorcelainZ(
        buildRecord([`worktree ${p}`, `HEAD ${SHA1_HEAD}`, "detached", "prunable"]),
      );
      expect(paths).toEqual([p]);
    });

    it("accepts a locked AND prunable worktree together", () => {
      const p = absPath("repo", "wt_locked_prunable");
      const paths = parseWorktreeListPorcelainZ(
        buildRecord([
          `worktree ${p}`,
          `HEAD ${SHA1_HEAD}`,
          "branch refs/heads/feature",
          "locked",
          "prunable",
        ]),
      );
      expect(paths).toEqual([p]);
    });

    it("accepts a SHA-1 (40 hex character) HEAD value", () => {
      const p = absPath("repo", "wt_sha1");
      const paths = parseWorktreeListPorcelainZ(
        buildRecord([`worktree ${p}`, `HEAD ${SHA1_HEAD}`, "detached"]),
      );
      expect(paths).toEqual([p]);
    });

    it("accepts a SHA-256 (64 hex character) HEAD value, without hard-coding only the SHA-1 length", () => {
      const p = absPath("repo", "wt_sha256");
      const paths = parseWorktreeListPorcelainZ(
        buildRecord([`worktree ${p}`, `HEAD ${SHA256_HEAD}`, "detached"]),
      );
      expect(paths).toEqual([p]);
    });

    it("parses multiple valid worktrees in one output", () => {
      const paths = parseWorktreeListPorcelainZ(
        porcelainZ([absPath("repo"), absPath("repo", "wt_a"), absPath("repo", "wt_b")]),
      );
      expect(paths).toEqual([absPath("repo"), absPath("repo", "wt_a"), absPath("repo", "wt_b")]);
    });

    it("preserves paths containing spaces exactly", () => {
      const withSpaces = absPath("Some User", "hall owned", "wt_1");
      const paths = parseWorktreeListPorcelainZ(porcelainZ([withSpaces]));
      expect(paths).toEqual([withSpaces]);
    });

    it("preserves valid non-ASCII paths exactly", () => {
      const nonAscii = absPath("hall-owned", "wt-ünïcödé-日本語");
      const paths = parseWorktreeListPorcelainZ(porcelainZ([nonAscii]));
      expect(paths).toEqual([nonAscii]);
    });

    it("never trims meaningful leading or trailing content from a valid path", () => {
      // A path that legitimately ends in a space is unusual but must not
      // be silently altered — this parser's job is byte-exact
      // reconstruction, not opinion about what a path "should" look like.
      const trailingSpace = absPath("hall-owned", "wt_trailing ");
      const paths = parseWorktreeListPorcelainZ(porcelainZ([trailingSpace]));
      expect(paths[0]).toBe(trailingSpace);
    });

    it("preserves a locked/prunable reason containing spaces, newlines, and non-ASCII characters", () => {
      const p = absPath("repo", "wt_reason_chars");
      // The reason itself is never returned by this function, but a
      // record containing one must still parse successfully rather than
      // being corrupted or rejected by unusual reason content.
      const paths = parseWorktreeListPorcelainZ(
        buildRecord([
          `worktree ${p}`,
          `HEAD ${SHA1_HEAD}`,
          "detached",
          "locked reason with spaces, a\nnewline, and 日本語",
        ]),
      );
      expect(paths).toEqual([p]);
    });
  });

  describe("valid records (POSIX-specific)", () => {
    it.runIf(process.platform !== "win32")("parses a plain POSIX absolute path", () => {
      const paths = parseWorktreeListPorcelainZ(
        buildRecord(["worktree /home/user/repo", `HEAD ${SHA1_HEAD}`, "branch refs/heads/main"]),
      );
      expect(paths).toEqual(["/home/user/repo"]);
    });
  });

  describe("valid records (Windows-specific)", () => {
    it.runIf(process.platform === "win32")("parses a drive-letter Windows path", () => {
      const paths = parseWorktreeListPorcelainZ(
        buildRecord(["worktree C:\\repo", `HEAD ${SHA1_HEAD}`, "branch refs/heads/main"]),
      );
      expect(paths).toEqual(["C:\\repo"]);
    });

    it.runIf(process.platform === "win32")(
      "rejects a duplicate path that differs only by Windows-style case variation",
      () => {
        const base = absPath("Hall-Owned", "wt_a");
        const upper = base.toUpperCase();
        expectMalformed(() => {
          parseWorktreeListPorcelainZ(porcelainZ([base, upper]));
        });
      },
    );
  });

  describe("malformed structure — byte layout", () => {
    it("returns fails closed on genuinely empty output (never proof that no registration exists)", () => {
      expectMalformed(() => {
        parseWorktreeListPorcelainZ("");
      });
    });

    it("fails closed when a record's first attribute is not a worktree field", () => {
      expectMalformed(() => {
        parseWorktreeListPorcelainZ(buildRecord([`HEAD ${SHA1_HEAD}`, "branch refs/heads/main"]));
      });
    });

    it("fails closed on a relative path", () => {
      expectMalformed(() => {
        parseWorktreeListPorcelainZ(
          buildRecord(["worktree relative/path", `HEAD ${SHA1_HEAD}`, "branch refs/heads/main"]),
        );
      });
    });

    it("fails closed on an empty worktree path", () => {
      expectMalformed(() => {
        parseWorktreeListPorcelainZ("worktree \0\0");
      });
    });

    it("fails closed on a malformed record separator (two records fused by a single NUL instead of double)", () => {
      const a = absPath("a");
      const b = absPath("b");
      // A well-formed two-record output has a double-NUL between records;
      // a single missing NUL merges both worktrees' attributes into one
      // record, which surfaces as a duplicate `worktree` attribute.
      expectMalformed(() => {
        parseWorktreeListPorcelainZ(`worktree ${a}\0worktree ${b}\0\0`);
      });
    });

    it("fails closed on an incomplete final record (no closing record-separator NUL)", () => {
      const a = absPath("a");
      const b = absPath("b");
      expectMalformed(() => {
        parseWorktreeListPorcelainZ(`worktree ${a}\0\0worktree ${b}`);
      });
    });

    it("fails closed on output that does not end on a NUL at all", () => {
      expectMalformed(() => {
        parseWorktreeListPorcelainZ(`worktree ${absPath("a")}`);
      });
    });

    it("fails closed on a record with more than one worktree attribute", () => {
      const a = absPath("a");
      const aAgain = absPath("a-again");
      expectMalformed(() => {
        parseWorktreeListPorcelainZ(`worktree ${a}\0worktree ${aAgain}\0\0`);
      });
    });
  });

  describe("malformed structure — complete record validation", () => {
    it("fails closed on duplicate registered paths (same path, two records)", () => {
      const p = absPath("hall-owned", "wt_a");
      expectMalformed(() => {
        parseWorktreeListPorcelainZ(porcelainZ([p, p]));
      });
    });

    it("fails closed on a duplicate HEAD attribute", () => {
      const p = absPath("repo");
      expectMalformed(() => {
        parseWorktreeListPorcelainZ(
          buildRecord([
            `worktree ${p}`,
            `HEAD ${SHA1_HEAD}`,
            `HEAD ${SHA1_HEAD}`,
            "branch refs/heads/main",
          ]),
        );
      });
    });

    it("fails closed on a duplicate branch attribute", () => {
      const p = absPath("repo");
      expectMalformed(() => {
        parseWorktreeListPorcelainZ(
          buildRecord([
            `worktree ${p}`,
            `HEAD ${SHA1_HEAD}`,
            "branch refs/heads/a",
            "branch refs/heads/b",
          ]),
        );
      });
    });

    it("fails closed on a duplicate detached attribute", () => {
      const p = absPath("repo");
      expectMalformed(() => {
        parseWorktreeListPorcelainZ(
          buildRecord([`worktree ${p}`, `HEAD ${SHA1_HEAD}`, "detached", "detached"]),
        );
      });
    });

    it("fails closed on an unrecognized attribute label", () => {
      const p = absPath("repo");
      expectMalformed(() => {
        parseWorktreeListPorcelainZ(
          buildRecord([
            `worktree ${p}`,
            `HEAD ${SHA1_HEAD}`,
            "branch refs/heads/main",
            "futurefield some-value",
          ]),
        );
      });
    });

    it("fails closed on a worktree-only record (no HEAD, no branch/detached, not bare)", () => {
      const p = absPath("repo");
      expectMalformed(() => {
        parseWorktreeListPorcelainZ(buildRecord([`worktree ${p}`]));
      });
    });

    it("fails closed when HEAD is missing from a non-bare record", () => {
      const p = absPath("repo");
      expectMalformed(() => {
        parseWorktreeListPorcelainZ(buildRecord([`worktree ${p}`, "branch refs/heads/main"]));
      });
    });

    it("fails closed when both branch and detached are missing from a non-bare record", () => {
      const p = absPath("repo");
      expectMalformed(() => {
        parseWorktreeListPorcelainZ(buildRecord([`worktree ${p}`, `HEAD ${SHA1_HEAD}`]));
      });
    });

    it("fails closed when branch and detached are both present", () => {
      const p = absPath("repo");
      expectMalformed(() => {
        parseWorktreeListPorcelainZ(
          buildRecord([`worktree ${p}`, `HEAD ${SHA1_HEAD}`, "branch refs/heads/main", "detached"]),
        );
      });
    });

    it("fails closed when bare is combined with HEAD", () => {
      const p = absPath("repo");
      expectMalformed(() => {
        parseWorktreeListPorcelainZ(buildRecord([`worktree ${p}`, "bare", `HEAD ${SHA1_HEAD}`]));
      });
    });

    it("fails closed when bare is combined with branch", () => {
      const p = absPath("repo");
      expectMalformed(() => {
        parseWorktreeListPorcelainZ(
          buildRecord([`worktree ${p}`, "bare", "branch refs/heads/main"]),
        );
      });
    });

    it("fails closed when bare is combined with detached", () => {
      const p = absPath("repo");
      expectMalformed(() => {
        parseWorktreeListPorcelainZ(buildRecord([`worktree ${p}`, "bare", "detached"]));
      });
    });

    it("fails closed on an empty branch value", () => {
      const p = absPath("repo");
      expectMalformed(() => {
        parseWorktreeListPorcelainZ(buildRecord([`worktree ${p}`, `HEAD ${SHA1_HEAD}`, "branch "]));
      });
    });

    it("fails closed on an invalid (wrong-length) HEAD value", () => {
      const p = absPath("repo");
      expectMalformed(() => {
        parseWorktreeListPorcelainZ(
          buildRecord([`worktree ${p}`, "HEAD deadbeef", "branch refs/heads/main"]),
        );
      });
    });

    it("fails closed on a bare attribute carrying an unexpected value", () => {
      const p = absPath("repo");
      expectMalformed(() => {
        parseWorktreeListPorcelainZ(buildRecord([`worktree ${p}`, "bare extra"]));
      });
    });
  });
});
