import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";

/** Minimal, injectable writability check — no real filesystem access needed for tests. */
export interface WorkspaceWritabilityProbe {
  isWritable(directoryPath: string): boolean;
}

/**
 * Phase 10.2 — trusted-local mode's own writability preflight. Unlike
 * `isInsideGitRepository` (a pure existence check), writability cannot be
 * answered reliably by an ACL/mode-bit inspection alone on Windows, so
 * this creates a uniquely-named, empty sentinel file directly inside
 * `directoryPath` and immediately removes it — the same real
 * write-then-remove probe technique Phase 10.1 used to diagnose the
 * Windows sandbox account's own restrictions (see
 * `docs/architecture/0009-codex-adapter.md`, "Windows sandbox diagnosis").
 * `wx` (write, fail if exists) means this can never silently overwrite an
 * existing file even under a UUID collision. Bounded to this one directory
 * only — never recurses, never touches an ancestor or sibling.
 */
export const realWorkspaceWritabilityProbe: WorkspaceWritabilityProbe = {
  isWritable(directoryPath: string): boolean {
    const sentinelPath = join(
      directoryPath,
      `.codex-trusted-local-writability-probe-${randomUUID()}`,
    );
    try {
      writeFileSync(sentinelPath, "", { flag: "wx" });
    } catch {
      return false;
    }
    try {
      rmSync(sentinelPath, { force: true });
    } catch {
      // The write succeeded — directory is writable — even if cleanup
      // itself failed for an unrelated reason (e.g. a concurrent actor).
    }
    return true;
  },
};
