import type nodePath from "node:path";

/**
 * The subset of `node:path` this module needs. Accepting it as a
 * parameter — defaulting to the real `node:path` — lets tests exercise
 * Windows (`path.win32`) and POSIX (`path.posix`) containment semantics
 * explicitly and deterministically, regardless of which OS actually runs
 * the test suite.
 */
export type PathModule = Pick<typeof nodePath, "relative" | "isAbsolute">;

export interface ContainmentOptions {
  /** Whether path comparison should be case-sensitive (true on Linux; false on Windows and, by default, macOS). */
  readonly caseSensitive: boolean;
  readonly path: PathModule;
}

/**
 * True if `candidatePath` is `rootPath` itself, or a descendant of it.
 *
 * Deliberately does **not** use string-prefix matching (`candidate.startsWith(root)`):
 * that scheme incorrectly treats `C:\workspace-other` as contained within
 * `C:\workspace` (or `/workspace-other` within `/workspace`) because the
 * string "C:\workspace" is literally a prefix of "C:\workspace-other".
 * Using `path.relative` and checking the result never starts with `..`
 * (and is never itself an absolute path, which happens on Windows when
 * the two paths are on different drives) avoids that class of bug
 * entirely. Both inputs are expected to already be resolved, absolute,
 * canonical paths — this function does no filesystem I/O and no
 * normalization beyond what `path.relative` itself performs.
 */
export function isContainedPath(
  rootPath: string,
  candidatePath: string,
  options: ContainmentOptions,
): boolean {
  const normalize = (value: string): string =>
    options.caseSensitive ? value : value.toLowerCase();

  const relative = options.path.relative(normalize(rootPath), normalize(candidatePath));

  if (relative === "") return true;
  if (options.path.isAbsolute(relative)) return false;
  if (relative === "..") return false;
  return !relative.startsWith("../") && !relative.startsWith("..\\");
}
