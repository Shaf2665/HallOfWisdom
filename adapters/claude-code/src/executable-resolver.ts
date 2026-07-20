import { win32 as win32Path, posix as posixPath } from "node:path";

export type ExecutableKind = "native" | "shim";

export interface ResolvedExecutable {
  readonly path: string;
  readonly kind: ExecutableKind;
}

export type ExecutableResolutionReason = "not_found" | "shim_only" | "timeout";

export interface ExecutableResolution {
  readonly found: boolean;
  readonly executable?: ResolvedExecutable;
  readonly reason?: ExecutableResolutionReason;
}

/** Minimal, injectable filesystem check — no real `fs` access needed for tests. */
export interface FileSystemProbe {
  isFile(path: string): boolean;
}

export interface ExecutableResolverOptions {
  readonly platform: NodeJS.Platform;
  /** The resolving process's own PATH (never the sanitized child environment — see `environment.ts`). */
  readonly pathValue: string;
  /** Windows PATHEXT, ignored on non-Windows platforms. */
  readonly pathExt?: string;
  readonly fs: FileSystemProbe;
  readonly binaryName?: string;
  readonly nowMs?: () => number;
  readonly maxResolutionMs?: number;
}

const DEFAULT_BINARY_NAME = "claude";
const DEFAULT_MAX_RESOLUTION_MS = 2000;
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * File extensions that Windows cannot directly execute as a process image
 * (they require an interpreter — `cmd.exe` for `.bat`/`.cmd`, PowerShell
 * for `.ps1`). An npm-installed Claude Code CLI commonly ships as one of
 * these. Spawning one safely without `shell: true` would require a small,
 * well-reviewed shim-invocation helper this package deliberately does not
 * build for Phase 9 — instead, finding only a shim is reported as an
 * unsupported installation (`reason: "shim_only"`), and the operator is
 * pointed at installing the native binary. See
 * `docs/architecture/0008-claude-code-adapter.md`, "Executable resolution
 * policy".
 */
const WINDOWS_SHIM_EXTENSIONS = new Set([".cmd", ".bat", ".ps1"]);

/**
 * Resolves the local Claude Code executable deterministically, without any
 * shell interpolation: every candidate path is built with `node:path`'s
 * platform-specific `join`, and existence is checked through the injected
 * `fs` probe only — never a shell `which`/`where` invocation. Never reads
 * task-controlled input; the only inputs are the resolving process's own
 * `PATH`/`PATHEXT` and a fixed, non-configurable binary name.
 *
 * Selection policy when multiple installations exist on `PATH`:
 * 1. A native executable (an extension Windows can run directly, or no
 *    extension) always wins over a shim, regardless of `PATH` order.
 * 2. Among native candidates, the first one found scanning `PATH` in order
 *    wins.
 * 3. If no native candidate exists anywhere on `PATH` but a shim does, the
 *    shim is returned with `reason: "shim_only"` so the caller can report
 *    a safe "unsupported installation type" diagnostic rather than
 *    silently trying to run it.
 */
export function resolveClaudeExecutable(options: ExecutableResolverOptions): ExecutableResolution {
  const { platform, pathValue, fs } = options;
  const binaryName = options.binaryName ?? DEFAULT_BINARY_NAME;
  const nowMs = options.nowMs ?? Date.now;
  const maxResolutionMs = options.maxResolutionMs ?? DEFAULT_MAX_RESOLUTION_MS;
  const isWindows = platform === "win32";
  const pathImpl = isWindows ? win32Path : posixPath;

  const directories = pathValue
    .split(pathImpl.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const startedAt = nowMs();
  let shimFallback: ResolvedExecutable | undefined;

  for (const directory of directories) {
    if (nowMs() - startedAt > maxResolutionMs) {
      return { found: false, reason: "timeout" };
    }

    if (isWindows) {
      const extensions = (
        options.pathExt && options.pathExt.length > 0 ? options.pathExt : DEFAULT_PATHEXT
      )
        .split(";")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

      for (const extension of extensions) {
        const lowerExtension = extension.toLowerCase();
        const candidatePath = pathImpl.join(directory, `${binaryName}${lowerExtension}`);
        if (!fs.isFile(candidatePath)) continue;
        if (WINDOWS_SHIM_EXTENSIONS.has(lowerExtension)) {
          shimFallback ??= { path: candidatePath, kind: "shim" };
        } else {
          return { found: true, executable: { path: candidatePath, kind: "native" } };
        }
      }

      // Windows CreateProcess can execute an extensionless file directly
      // if its bytes are a valid process image — a real, if uncommon, case
      // for some native installers.
      const extensionlessPath = pathImpl.join(directory, binaryName);
      if (fs.isFile(extensionlessPath)) {
        return { found: true, executable: { path: extensionlessPath, kind: "native" } };
      }
    } else {
      const candidatePath = pathImpl.join(directory, binaryName);
      if (fs.isFile(candidatePath)) {
        return { found: true, executable: { path: candidatePath, kind: "native" } };
      }
    }
  }

  if (shimFallback) {
    return { found: true, executable: shimFallback, reason: "shim_only" };
  }
  return { found: false, reason: "not_found" };
}
