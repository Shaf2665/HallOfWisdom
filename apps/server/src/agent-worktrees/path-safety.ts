import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isContainedPath } from "@hall-of-wisdom/hall-runner";
import { AgentWorktreePathError } from "./agent-worktree-errors.js";

export interface CanonicalOwnedRootInput {
  readonly rawOwnedRoot: string;
  readonly canonicalSourceRepositoryRoot: string;
}

export interface CanonicalHallOwnedRootInput {
  readonly rawOwnedRoot: string;
  readonly forbiddenRoots: readonly {
    readonly canonicalPath: string;
    readonly label: string;
  }[];
}

export interface ContainmentCheckOptions {
  readonly rootPath: string;
  readonly candidatePath: string;
  readonly description: string;
}

export function defaultCaseSensitivity(platform: NodeJS.Platform = os.platform()): boolean {
  return platform !== "win32" && platform !== "darwin";
}

export function assertSafePathToken(token: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(token)) {
    throw new AgentWorktreePathError(`${label} must be a bounded safe identifier.`);
  }
}

export function canonicalizeExistingDirectory(rawPath: string, label: string): string {
  if (rawPath.trim().length === 0) {
    throw new AgentWorktreePathError(`${label} must not be empty.`);
  }
  if (rawPath.includes("\0")) {
    throw new AgentWorktreePathError(`${label} must not contain NUL characters.`);
  }
  if (!path.isAbsolute(rawPath)) {
    throw new AgentWorktreePathError(`${label} must be absolute.`);
  }
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(rawPath);
  } catch {
    throw new AgentWorktreePathError(`${label} must exist.`);
  }
  let stats: fs.Stats;
  try {
    stats = fs.statSync(canonical);
  } catch {
    throw new AgentWorktreePathError(`${label} must exist.`);
  }
  if (!stats.isDirectory()) {
    throw new AgentWorktreePathError(`${label} must be a directory.`);
  }
  return canonical;
}

export function canonicalizeOwnedRoot(input: CanonicalOwnedRootInput): string {
  const normalized = normalizeAbsoluteNonRootPath(input.rawOwnedRoot, "Hall-owned worktree root");
  const intendedOwnedRoot = canonicalizeIntendedPath(normalized, "Hall-owned worktree root");
  assertMutualNonContainment({
    a: intendedOwnedRoot,
    aLabel: "Hall-owned worktree root",
    b: input.canonicalSourceRepositoryRoot,
    bLabel: "source repository",
  });

  fs.mkdirSync(intendedOwnedRoot, { recursive: true });
  const canonicalOwnedRoot = canonicalizeExistingDirectory(
    intendedOwnedRoot,
    "Hall-owned worktree root",
  );
  assertMutualNonContainment({
    a: canonicalOwnedRoot,
    aLabel: "Hall-owned worktree root",
    b: input.canonicalSourceRepositoryRoot,
    bLabel: "source repository",
  });
  return canonicalOwnedRoot;
}

export function canonicalizeHallOwnedRoot(input: CanonicalHallOwnedRootInput): string {
  const normalized = normalizeAbsoluteNonRootPath(input.rawOwnedRoot, "Hall-owned worktree root");
  assertExistingFinalPathIsNotLink(normalized, "Hall-owned worktree root");
  const intendedOwnedRoot = canonicalizeIntendedPath(normalized, "Hall-owned worktree root");
  for (const forbidden of input.forbiddenRoots) {
    assertMutualNonContainment({
      a: intendedOwnedRoot,
      aLabel: "Hall-owned worktree root",
      b: forbidden.canonicalPath,
      bLabel: forbidden.label,
    });
  }

  fs.mkdirSync(intendedOwnedRoot, { recursive: true });
  assertExistingFinalPathIsNotLink(intendedOwnedRoot, "Hall-owned worktree root");
  const canonicalOwnedRoot = canonicalizeExistingDirectory(
    intendedOwnedRoot,
    "Hall-owned worktree root",
  );
  if (!samePath(canonicalOwnedRoot, intendedOwnedRoot)) {
    throw new AgentWorktreePathError("Hall-owned worktree root must not be a symlink or junction.");
  }
  for (const forbidden of input.forbiddenRoots) {
    assertMutualNonContainment({
      a: canonicalOwnedRoot,
      aLabel: "Hall-owned worktree root",
      b: forbidden.canonicalPath,
      bLabel: forbidden.label,
    });
  }
  return canonicalOwnedRoot;
}

export function assertContainedPath(options: ContainmentCheckOptions): void {
  if (!isPathContained(options.rootPath, options.candidatePath)) {
    throw new AgentWorktreePathError(`${options.description} must remain inside its owned root.`);
  }
}

export function isPathContained(rootPath: string, candidatePath: string): boolean {
  return isContainedPath(rootPath, candidatePath, {
    caseSensitive: defaultCaseSensitivity(),
    path,
  });
}

export function samePath(a: string, b: string): boolean {
  return isPathContained(a, b) && isPathContained(b, a);
}

function normalizeAbsoluteNonRootPath(rawPath: string, label: string): string {
  if (rawPath.trim().length === 0) {
    throw new AgentWorktreePathError(`${label} must not be empty.`);
  }
  if (rawPath.includes("\0")) {
    throw new AgentWorktreePathError(`${label} must not contain NUL characters.`);
  }
  if (containsControlCharacter(rawPath)) {
    throw new AgentWorktreePathError(`${label} must not contain control characters.`);
  }
  if (!path.isAbsolute(rawPath)) {
    throw new AgentWorktreePathError(`${label} must be absolute.`);
  }
  const normalized = path.resolve(rawPath);
  if (path.parse(normalized).root === normalized) {
    throw new AgentWorktreePathError(`${label} must not be a filesystem root.`);
  }
  return normalized;
}

function containsControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function assertExistingFinalPathIsNotLink(rawPath: string, label: string): void {
  if (!fs.existsSync(rawPath)) return;
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(rawPath);
  } catch {
    throw new AgentWorktreePathError(`${label} must be inspectable.`);
  }
  if (stats.isSymbolicLink()) {
    throw new AgentWorktreePathError(`${label} must not be a symlink or junction.`);
  }
}

function canonicalizeIntendedPath(normalizedPath: string, label: string): string {
  const parsed = path.parse(normalizedPath);
  let cursor = normalizedPath;
  const missingSegments: string[] = [];

  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor || cursor === parsed.root) {
      throw new AgentWorktreePathError(`${label} must have an existing parent directory.`);
    }
    missingSegments.unshift(path.basename(cursor));
    cursor = parent;
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(cursor);
  } catch {
    throw new AgentWorktreePathError(`${label} parent must exist.`);
  }
  if (!stats.isDirectory()) {
    throw new AgentWorktreePathError(`${label} parent must be a directory.`);
  }

  let canonicalAncestor: string;
  try {
    canonicalAncestor = fs.realpathSync.native(cursor);
  } catch {
    throw new AgentWorktreePathError(`${label} parent must be canonicalizable.`);
  }
  return path.resolve(canonicalAncestor, ...missingSegments);
}

function assertMutualNonContainment(input: {
  readonly a: string;
  readonly aLabel: string;
  readonly b: string;
  readonly bLabel: string;
}): void {
  if (isPathContained(input.a, input.b)) {
    throw new AgentWorktreePathError(`${input.bLabel} must not be inside ${input.aLabel}.`);
  }
  if (isPathContained(input.b, input.a)) {
    throw new AgentWorktreePathError(`${input.aLabel} must not be inside ${input.bLabel}.`);
  }
}
