import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isContainedPath } from "./path-containment.js";
import {
  InvalidWorkingDirectoryError,
  InvalidWorkspaceRootError,
  WorkingDirectoryOutsideWorkspaceError,
} from "./errors.js";

export interface WorkspaceValidationInput {
  readonly workspaceRoot: string;
  readonly workingDirectory: string;
}

export interface ValidatedWorkspace {
  /** Canonical (symlink-resolved) absolute path to the workspace root. */
  readonly workspaceRoot: string;
  /** Canonical (symlink-resolved) absolute path to the working directory. */
  readonly workingDirectory: string;
}

/**
 * Windows and (by default) macOS filesystems are case-insensitive;
 * Linux is case-sensitive. This is a reasonable prototype default, not a
 * filesystem-level detection (an ext4 volume mounted case-insensitively,
 * or an APFS volume mounted case-sensitively, would defeat it) — a real
 * per-volume check is future work, not needed for this local prototype.
 */
function defaultCaseSensitivity(platform: NodeJS.Platform = os.platform()): boolean {
  return platform !== "win32" && platform !== "darwin";
}

function resolveExistingDirectory(
  rawPath: string,
  label: "workspace root" | "working directory",
  ErrorClass: typeof InvalidWorkspaceRootError | typeof InvalidWorkingDirectoryError,
): string {
  if (rawPath.trim().length === 0) {
    throw new ErrorClass(`${label} must not be empty`);
  }
  if (rawPath.includes("\0")) {
    throw new ErrorClass(`${label} must not contain NUL characters`);
  }
  if (!path.isAbsolute(rawPath)) {
    throw new ErrorClass(`${label} must be an absolute path: "${rawPath}"`);
  }

  let canonical: string;
  try {
    canonical = fs.realpathSync.native(rawPath);
  } catch {
    throw new ErrorClass(`${label} does not exist: "${rawPath}"`);
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(canonical);
  } catch {
    throw new ErrorClass(`${label} does not exist: "${rawPath}"`);
  }
  if (!stats.isDirectory()) {
    throw new ErrorClass(`${label} must be a directory, not a file: "${rawPath}"`);
  }

  return canonical;
}

/**
 * Validates that `workingDirectory` exists, is a real directory, and is
 * the workspace root or a descendant of it — resolving symlinks/junctions
 * on both paths first, so a symlink that already points outside the
 * workspace root at validation time is detected. This is Hall Runner's
 * responsibility per the adapter SDK contract: adapters (including Mock
 * Agent) receive `AgentTaskInput.workingDirectory` as an unvalidated
 * string and must not be trusted to check it themselves.
 *
 * This resolves symlinks and checks containment at one point in time; it
 * is not a guarantee against the underlying filesystem object being
 * replaced afterward (the general TOCTOU class of race). See
 * `docs/architecture/0003-hall-runner-boundary.md`'s "What this does and
 * does not guarantee" section for the precise scope of this check.
 */
export function validateWorkspace(input: WorkspaceValidationInput): ValidatedWorkspace {
  const workspaceRoot = resolveExistingDirectory(
    input.workspaceRoot,
    "workspace root",
    InvalidWorkspaceRootError,
  );
  const workingDirectory = resolveExistingDirectory(
    input.workingDirectory,
    "working directory",
    InvalidWorkingDirectoryError,
  );

  const contained = isContainedPath(workspaceRoot, workingDirectory, {
    caseSensitive: defaultCaseSensitivity(),
    path,
  });

  if (!contained) {
    throw new WorkingDirectoryOutsideWorkspaceError(workspaceRoot, workingDirectory);
  }

  return { workspaceRoot, workingDirectory };
}
