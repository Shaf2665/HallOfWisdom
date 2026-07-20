import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

export interface FilePathSafetyOptions {
  /** Injectable for tests; defaults to the real, symlink-resolving `fs.realpathSync.native`. */
  readonly realpath?: (path: string) => string;
}

const defaultRealpath = (path: string): string => realpathSync.native(path);

/**
 * Resolves a provider-reported file path against the task's canonical
 * working directory and returns a normalized, forward-slash relative path
 * safe to put in a `file.changed` event — or `undefined` if the path
 * escapes the working directory (or resolves to the directory itself
 * rather than a file within it). The caller never emits an event for an
 * `undefined` result — see `event-mapper.ts`.
 *
 * Beyond the lexical `resolve`/`relative` check above, this also resolves
 * both the working directory and the candidate path through the
 * filesystem's own symlink resolution (mirroring
 * `runners/hall-runner/src/workspace-validation.ts`'s canonicalization of
 * `workspaceRoot`/`workingDirectory`) and re-checks containment against
 * the canonical forms — closing the gap where a symlink or junction
 * *inside* the working directory points outside it, which the lexical
 * check alone cannot see. This is a point-in-time check, not a guarantee
 * against the underlying filesystem object being replaced afterward (the
 * general TOCTOU class of race) — see
 * `docs/architecture/0008-claude-code-adapter.md`, "Provider-to-Hall
 * event mapping", for the precise scope. If the canonical form cannot be
 * resolved (e.g. the file no longer exists at this exact moment), this
 * falls back to the already-computed lexical result rather than treating
 * every such case as an escape — a transient inability to run the
 * stronger check must not silently suppress a genuine `file.changed`
 * event for an edit that actually succeeded inside the working directory.
 *
 * Never returns an absolute path: the working directory itself is never
 * disclosed through a normalized event.
 */
export function toSafeRelativeFilePath(
  rawPath: string,
  workingDirectory: string,
  options: FilePathSafetyOptions = {},
): string | undefined {
  const resolvedPath = resolve(workingDirectory, rawPath);
  const relativePath = relative(workingDirectory, resolvedPath);

  if (relativePath.length === 0 || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return undefined;
  }

  const realpath = options.realpath ?? defaultRealpath;
  try {
    const canonicalWorkingDirectory = realpath(workingDirectory);
    const canonicalResolvedPath = realpath(resolvedPath);
    const canonicalRelative = relative(canonicalWorkingDirectory, canonicalResolvedPath);
    if (
      canonicalRelative.length === 0 ||
      canonicalRelative.startsWith("..") ||
      isAbsolute(canonicalRelative)
    ) {
      return undefined;
    }
  } catch {
    // Could not resolve the canonical form right now (e.g. a benign race
    // with the file's own lifecycle) — fall back to the lexical result
    // computed above rather than failing closed.
  }

  return relativePath.split(sep).join("/");
}
