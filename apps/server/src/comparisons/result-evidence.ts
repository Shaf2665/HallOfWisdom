import { runGitCommand, type GitCommandOptions } from "./git-command.js";
import type { CandidateResultEvidence, ChangedFileEntry } from "./comparison-record.js";

export interface CaptureResultEvidenceOptions extends GitCommandOptions {
  readonly maxChangedFiles: number;
  readonly maxDiffChars: number;
}

interface NumstatEntry {
  readonly additions: number;
  readonly deletions: number;
  readonly path: string;
}

/**
 * `git diff --numstat`/`--name-status` render a rename as `old => new`
 * (optionally with a shared `{...}` prefix/suffix for a partial-path
 * rename, e.g. `src/{old.ts => new.ts}`) — this collapses either form
 * down to just the final (new) path, which is what `relativePath` reports
 * for a renamed file. The pre-rename path is intentionally not retained:
 * `ChangedFileEntry` reports *current* state, not history.
 */
function normalizeDiffPath(raw: string): string {
  const braceMatch = /^(.*)\{.* => (.*)\}(.*)$/.exec(raw);
  if (braceMatch) {
    const [, prefix, after, suffix] = braceMatch;
    return `${prefix ?? ""}${after ?? ""}${suffix ?? ""}`;
  }
  const simpleMatch = /^.* => (.*)$/.exec(raw);
  if (simpleMatch?.[1] !== undefined) {
    return simpleMatch[1];
  }
  return raw;
}

function parseNumstat(output: string): NumstatEntry[] {
  return output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [addRaw, delRaw, ...pathParts] = line.split("\t");
      const isBinary = addRaw === "-" || delRaw === "-";
      return {
        additions: isBinary ? 0 : Number(addRaw ?? 0),
        deletions: isBinary ? 0 : Number(delRaw ?? 0),
        path: normalizeDiffPath(pathParts.join("\t")),
      };
    });
}

function parseNameStatus(output: string): Map<string, ChangedFileEntry["changeType"]> {
  const map = new Map<string, ChangedFileEntry["changeType"]>();
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    const [statusRaw, ...pathParts] = line.split("\t");
    const path = normalizeDiffPath(pathParts.join("\t"));
    const statusChar = statusRaw?.[0];
    const changeType: ChangedFileEntry["changeType"] =
      statusChar === "A"
        ? "added"
        : statusChar === "D"
          ? "deleted"
          : statusChar === "R"
            ? "renamed"
            : "modified";
    map.set(path, changeType);
  }
  return map;
}

/**
 * Captures bounded, path-relative, credential-free evidence of what a
 * candidate's agent actually changed inside its worktree, comparing the
 * working tree (including untracked new files) against the worktree's
 * `HEAD` (the shared `baseCommit`). Never exposes the worktree's absolute
 * path, raw process reasoning, tokens, or cost — only file-level stats
 * and a bounded unified diff. See
 * `docs/architecture/0012-controlled-agent-comparison.md`, "Result
 * evidence bounding."
 *
 * `git add -A` is run first to stage every change (including untracked
 * files) so a single `git diff --cached` pass captures everything — this
 * mutates the *disposable* worktree's own index, never the source
 * repository's, and the worktree is removed shortly after this runs.
 */
export async function captureResultEvidence(
  worktreePath: string,
  options: CaptureResultEvidenceOptions,
): Promise<CandidateResultEvidence> {
  await runGitCommand(["add", "-A"], worktreePath, options);

  const [numstatOutput, nameStatusOutput] = await Promise.all([
    runGitCommand(["diff", "--cached", "--numstat", "HEAD"], worktreePath, options),
    runGitCommand(["diff", "--cached", "--name-status", "HEAD"], worktreePath, options),
  ]);

  const entries = parseNumstat(numstatOutput);
  const typeByPath = parseNameStatus(nameStatusOutput);

  const totalAdditions = entries.reduce((sum, entry) => sum + entry.additions, 0);
  const totalDeletions = entries.reduce((sum, entry) => sum + entry.deletions, 0);

  const changedFiles: ChangedFileEntry[] = entries
    .slice(0, options.maxChangedFiles)
    .map((entry) => ({
      relativePath: entry.path,
      changeType: typeByPath.get(entry.path) ?? "modified",
      additions: entry.additions,
      deletions: entry.deletions,
    }));

  let truncated = entries.length > options.maxChangedFiles;
  let boundedDiff: string | undefined;
  if (entries.length > 0) {
    const diffOutput = await runGitCommand(
      ["diff", "--cached", "--no-color", "--unified=3", "HEAD"],
      worktreePath,
      options,
    );
    if (diffOutput.length > options.maxDiffChars) {
      boundedDiff = diffOutput.slice(0, options.maxDiffChars);
      truncated = true;
    } else {
      boundedDiff = diffOutput;
    }
  }

  return { changedFiles, totalAdditions, totalDeletions, boundedDiff, truncated };
}
