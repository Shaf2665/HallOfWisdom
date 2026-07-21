import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

/** Minimal, injectable existence check — no real `fs` access needed for tests. */
export interface GitRepositoryProbe {
  exists(path: string): boolean;
}

export const realGitRepositoryProbe: GitRepositoryProbe = {
  exists(path: string): boolean {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  },
};

const MAX_ANCESTOR_LEVELS = 128;

/**
 * Detects whether `workingDirectory` is inside a Git repository by
 * walking up its ancestors looking for a `.git` entry — a plain
 * `fs.existsSync` check via the injected probe, never a `git` (or any
 * other) shell invocation. Bounded to `MAX_ANCESTOR_LEVELS` ancestor
 * checks and stops once `path.dirname` stops changing (the filesystem
 * root). A `.git` entry may be a directory (a normal repository) or a
 * file (a linked worktree, whose `.git` is a text file pointing at the
 * real git directory elsewhere) — either is sufficient evidence of a real
 * repository for this check's purpose; it does not need to resolve or
 * trust the file's contents, only its presence.
 *
 * Codex normally requires a Git repository and this adapter never passes
 * `--skip-git-repo-check` for a normal task (see
 * `docs/architecture/0009-codex-adapter.md`, "Git repository policy") —
 * this check runs *before* spawning Codex at all, so a non-repository
 * working directory fails closed with a Hall-specific diagnostic
 * (`CODEX_GIT_REPOSITORY_REQUIRED`) rather than depending on however
 * Codex's own internal check happens to fail.
 */
export function isInsideGitRepository(
  workingDirectory: string,
  probe: GitRepositoryProbe = realGitRepositoryProbe,
): boolean {
  let currentDirectory = workingDirectory;
  for (let level = 0; level < MAX_ANCESTOR_LEVELS; level += 1) {
    if (probe.exists(join(currentDirectory, ".git"))) {
      return true;
    }
    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return false;
    }
    currentDirectory = parentDirectory;
  }
  return false;
}
