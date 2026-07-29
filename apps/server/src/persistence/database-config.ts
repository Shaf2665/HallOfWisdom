import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isContainedPath } from "@hall-of-wisdom/hall-runner";
import { DataDirValidationError } from "./persistence-errors.js";

export interface ResolveDataDirOptions {
  /** Raw `--data-dir` CLI value. */
  readonly dataDir: string;
  /** Canonical, already-validated workspace root. */
  readonly workspaceRoot: string;
  /** Canonical, already-validated comparison root, when comparisons are enabled. */
  readonly comparisonRoot?: string | undefined;
}

function defaultCaseSensitivity(platform: NodeJS.Platform = os.platform()): boolean {
  return platform !== "win32" && platform !== "darwin";
}

/**
 * Validates and canonicalizes `--data-dir` per
 * `docs/architecture/0013-durable-persistence-and-recovery.md`,
 * "Data-directory safety": must be absolute; created if missing; resolved
 * through `fs.realpathSync.native` (which also resolves any symlink or
 * junction on the path, closing the same class of escape
 * `@hall-of-wisdom/hall-runner`'s `validateWorkspace` closes for task
 * working directories) *before* the containment checks run, so a symlink
 * that points outside a protected root is caught, not trusted; mutually
 * non-contained with both `workspaceRoot` and `comparisonRoot` in both
 * directions. Every error message is deliberately generic — never embeds
 * the rejected path — so it stays safe to propagate as far as a CLI
 * startup diagnostic without extra rewrapping (this is a startup-only
 * path, never reachable from a route, but the discipline costs nothing
 * and matches every other safety error in this codebase).
 */
export function resolveDataDir(options: ResolveDataDirOptions): string {
  const raw = options.dataDir;
  if (!path.isAbsolute(raw)) {
    throw new DataDirValidationError("--data-dir must be an absolute path.");
  }

  try {
    fs.mkdirSync(raw, { recursive: true });
  } catch {
    throw new DataDirValidationError("--data-dir could not be created.");
  }

  let canonicalDataDir: string;
  try {
    canonicalDataDir = fs.realpathSync.native(raw);
  } catch {
    throw new DataDirValidationError("--data-dir could not be resolved after creation.");
  }

  const stats = fs.statSync(canonicalDataDir);
  if (!stats.isDirectory()) {
    throw new DataDirValidationError("--data-dir must be a directory, not a file.");
  }

  const caseSensitive = defaultCaseSensitivity();
  const containmentOptions = { caseSensitive, path };

  const dataDirInsideWorkspace = isContainedPath(
    options.workspaceRoot,
    canonicalDataDir,
    containmentOptions,
  );
  const workspaceInsideDataDir = isContainedPath(
    canonicalDataDir,
    options.workspaceRoot,
    containmentOptions,
  );
  if (dataDirInsideWorkspace || workspaceInsideDataDir) {
    throw new DataDirValidationError(
      "--data-dir must not be nested inside, or an ancestor of, --workspace-root.",
    );
  }

  if (options.comparisonRoot !== undefined) {
    const dataDirInsideComparisonRoot = isContainedPath(
      options.comparisonRoot,
      canonicalDataDir,
      containmentOptions,
    );
    const comparisonRootInsideDataDir = isContainedPath(
      canonicalDataDir,
      options.comparisonRoot,
      containmentOptions,
    );
    if (dataDirInsideComparisonRoot || comparisonRootInsideDataDir) {
      throw new DataDirValidationError(
        "--data-dir must not be nested inside, or an ancestor of, --comparison-root.",
      );
    }
  }

  return canonicalDataDir;
}
