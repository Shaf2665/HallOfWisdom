import path from "node:path";

export class HallConfigPathPrecheckError extends Error {
  constructor(label: string, reason: string) {
    super(`${label} ${reason}`);
    this.name = "HallConfigPathPrecheckError";
  }
}

/**
 * Best-effort UX pre-check only — NOT the authoritative safety validation.
 * `apps/server`'s own startup path (canonicalization, mutual
 * non-containment, the configuration fingerprint) remains the sole source
 * of truth; this exists purely so `install.ps1` can reject an obviously
 * wrong path before spending time on a build.
 */
export function precheckHallOwnedPath(rawPath: string, label: string): void {
  if (rawPath.trim().length === 0) {
    throw new HallConfigPathPrecheckError(label, "must not be empty.");
  }
  if (!path.isAbsolute(rawPath)) {
    throw new HallConfigPathPrecheckError(label, "must be an absolute path.");
  }
  const normalized = path.resolve(rawPath);
  if (path.parse(normalized).root === normalized) {
    throw new HallConfigPathPrecheckError(label, "must not be a filesystem root.");
  }
}
