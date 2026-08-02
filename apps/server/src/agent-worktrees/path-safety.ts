import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isContainedPath } from "@hall-of-wisdom/hall-runner";
import { AgentWorktreePathError } from "./agent-worktree-errors.js";

export interface CanonicalOwnedRootInput {
  readonly rawOwnedRoot: string;
  readonly canonicalSourceRepositoryRoot: string;
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
  const rawOwnedRoot = input.rawOwnedRoot;
  if (rawOwnedRoot.trim().length === 0) {
    throw new AgentWorktreePathError("Hall-owned worktree root must not be empty.");
  }
  if (rawOwnedRoot.includes("\0")) {
    throw new AgentWorktreePathError("Hall-owned worktree root must not contain NUL characters.");
  }
  if (!path.isAbsolute(rawOwnedRoot)) {
    throw new AgentWorktreePathError("Hall-owned worktree root must be absolute.");
  }
  const normalized = path.resolve(rawOwnedRoot);
  if (path.parse(normalized).root === normalized) {
    throw new AgentWorktreePathError("Hall-owned worktree root must not be a filesystem root.");
  }
  fs.mkdirSync(normalized, { recursive: true });
  const canonicalOwnedRoot = canonicalizeExistingDirectory(normalized, "Hall-owned worktree root");
  assertMutualNonContainment({
    a: canonicalOwnedRoot,
    aLabel: "Hall-owned worktree root",
    b: input.canonicalSourceRepositoryRoot,
    bLabel: "source repository",
  });
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
