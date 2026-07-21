import { win32 as win32Path, posix as posixPath } from "node:path";

export type ExecutableKind = "native" | "shim";

export interface ResolvedExecutable {
  readonly path: string;
  readonly kind: ExecutableKind;
}

export type ExecutableResolutionReason = "not_found" | "timeout";

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

const DEFAULT_BINARY_NAME = "codex";
const DEFAULT_MAX_RESOLUTION_MS = 2000;
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Windows extensions this resolver accepts as a valid, safely-executable
 * result even though they are not a native process image: `cmd-shim`
 * (npm's own shim generator) always produces a `.cmd` launcher, and
 * sometimes a `.bat` one. Unlike the Claude Code adapter (which treats any
 * shim as an unsupported installation), this adapter *does* execute a
 * `.cmd`/`.bat` shim — through `cross-spawn` in `process-spawner.ts`,
 * never `shell: true` and never a manually concatenated command string.
 * `.ps1` is deliberately excluded: PowerShell scripts are not
 * automatically invoked by Windows `CreateProcess`/`cmd.exe` the way
 * `.cmd`/`.bat` are (they require an explicit `powershell -File`
 * invocation this adapter does not implement). This exclusion is
 * enforced explicitly below via `WINDOWS_NATIVE_EXTENSIONS` — an
 * allowlist of extensions this resolver ever acts on — rather than
 * relying only on the default `PATHEXT` fallback not listing `.PS1`:
 * the *resolving* process's real `PATHEXT` (untrusted-but-not-task-
 * controlled) could in principle list `.PS1` explicitly, and this
 * resolver must not silently start treating a PowerShell script as a
 * native executable if it ever does. See
 * `docs/architecture/0009-codex-adapter.md`, "Windows shim policy".
 */
const WINDOWS_NATIVE_EXTENSIONS = new Set([".exe", ".com"]);
const WINDOWS_CMD_SHIM_EXTENSIONS = new Set([".cmd", ".bat"]);

/**
 * Resolves the local Codex executable deterministically, without any
 * shell interpolation: every candidate path is built with `node:path`'s
 * platform-specific `join`, and existence is checked through the injected
 * `fs` probe only — never a shell `which`/`where` invocation. Never reads
 * task-controlled input; the only inputs are the resolving process's own
 * `PATH`/`PATHEXT` and a fixed, non-configurable binary name.
 *
 * Selection policy when multiple installations exist on `PATH`:
 * 1. A native executable (an extension Windows can run directly, or no
 *    extension, or — on POSIX — any real file found under the binary
 *    name) always wins over a `.cmd`/`.bat` shim, regardless of `PATH`
 *    order.
 * 2. Among candidates of the same kind, the first one found scanning
 *    `PATH` in order wins.
 * 3. If no native candidate exists anywhere on `PATH` but a `.cmd`/`.bat`
 *    shim does (the real npm-managed Windows install layout observed
 *    during Phase 10 reconnaissance: `codex.cmd` launching a Node
 *    wrapper, which in turn execs a deep, version-pinned native
 *    `codex.exe`), the shim is returned with `kind: "shim"` rather than
 *    reported unsupported.
 */
export function resolveCodexExecutable(options: ExecutableResolverOptions): ExecutableResolution {
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
        const isNativeExtension = WINDOWS_NATIVE_EXTENSIONS.has(lowerExtension);
        const isShimExtension = WINDOWS_CMD_SHIM_EXTENSIONS.has(lowerExtension);
        if (!isNativeExtension && !isShimExtension) continue;
        const candidatePath = pathImpl.join(directory, `${binaryName}${lowerExtension}`);
        if (!fs.isFile(candidatePath)) continue;
        if (isShimExtension) {
          shimFallback ??= { path: candidatePath, kind: "shim" };
        } else {
          return { found: true, executable: { path: candidatePath, kind: "native" } };
        }
      }

      // An extensionless file on Windows is *not* assumed native: npm's
      // own shim generator always creates this exact extensionless file
      // as a POSIX shell script (for Git Bash/WSL compatibility), never a
      // real Windows process image — confirmed live during Phase 10
      // instrumented reconnaissance (`file` reported "POSIX shell script,
      // ASCII text executable" for this exact path on the real installed
      // CLI). Windows `CreateProcess` cannot execute it directly. It is
      // therefore treated the same as a `.cmd`/`.bat` shim (lower
      // priority than any real `.exe`/`.com` found above), relying on
      // `process-spawner.ts`'s `cross-spawn` backend — which was also
      // confirmed live to correctly resolve and invoke the adjacent
      // `.cmd` shim even when handed this exact extensionless path
      // directly, via its own internal PATHEXT-aware resolution — rather
      // than this resolver asserting a "native" guarantee it cannot
      // actually verify from a file's mere existence.
      const extensionlessPath = pathImpl.join(directory, binaryName);
      if (fs.isFile(extensionlessPath)) {
        shimFallback ??= { path: extensionlessPath, kind: "shim" };
      }
    } else {
      const candidatePath = pathImpl.join(directory, binaryName);
      if (fs.isFile(candidatePath)) {
        return { found: true, executable: { path: candidatePath, kind: "native" } };
      }
    }
  }

  if (shimFallback) {
    return { found: true, executable: shimFallback };
  }
  return { found: false, reason: "not_found" };
}
