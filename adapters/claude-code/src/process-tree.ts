import { tmpdir } from "node:os";
import type { ProcessSpawner } from "./process-spawner.js";

/**
 * Sends a signal to a real POSIX process group. Isolated behind this tiny
 * interface specifically so tests never call the real `process.kill` —
 * this package spawns and terminates real Claude Code processes, and an
 * accidental real kill in a test could target an unrelated PID (including,
 * in the worst case, this very session). `killProcessGroup` in
 * `claude-code-run.test.ts`/`process-tree.test.ts` always injects a fake.
 */
export interface PosixGroupKiller {
  killGroup(pid: number, signal: NodeJS.Signals): void;
}

export const realPosixGroupKiller: PosixGroupKiller = {
  killGroup(pid, signal) {
    try {
      // A negative PID targets the whole process group when the child was
      // spawned with `detached: true` on POSIX (see `process-spawner.ts`),
      // making the child the group leader — this is what reaches
      // grandchild processes Claude Code itself spawns (e.g. its Bash
      // tool), not just the direct child.
      process.kill(-pid, signal);
    } catch (error) {
      // ESRCH: the process (or group) is already gone — a legitimate,
      // expected race with the process exiting on its own, not an error
      // this function should propagate.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  },
};

export interface ProcessTreeOptions {
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  readonly spawner: ProcessSpawner;
  /**
   * Reused as-is from the sanitized child environment `ClaudeCodeRun`
   * already built for the main `claude` process (see `environment.ts`'s
   * `buildChildEnvironment`) — it already carries `PATH`/`SYSTEMROOT`/
   * `WINDIR`/`COMSPEC`/`TEMP`/`TMP`, which is what `taskkill.exe` needs to
   * reliably resolve and run. An empty environment risks `taskkill.exe`
   * failing to resolve at all on some Windows configurations, silently
   * turning the force-kill phase into a no-op.
   */
  readonly env: Readonly<Record<string, string>>;
  readonly posixGroupKiller?: PosixGroupKiller;
}

/**
 * First-phase, cooperative termination request. On POSIX this sends
 * `SIGTERM` to the whole process group. Windows has no portable
 * equivalent of a graceful, catchable signal for an arbitrary external
 * process tree — the direct child's own best-effort `kill()` (issued by
 * the caller, `ClaudeCodeRun`, before calling this) is the only
 * "graceful" step available there; this function is a deliberate no-op
 * on Windows, with `forceTerminateProcessTree`'s `taskkill /T /F` doing
 * the actual, guaranteed cleanup once the bounded grace period elapses.
 */
export function requestGracefulTermination(options: ProcessTreeOptions): void {
  if (options.platform === "win32") return;
  (options.posixGroupKiller ?? realPosixGroupKiller).killGroup(options.pid, "SIGTERM");
}

/**
 * Second-phase, guaranteed termination of the whole process tree, called
 * once the bounded grace period has elapsed without the process exiting
 * on its own. On Windows, invokes `taskkill.exe /PID <pid> /T /F` through
 * the same `ProcessSpawner` every other process launch in this package
 * uses — `pid` is always a real numeric PID read from a
 * `SpawnedProcessHandle` this adapter itself created, never a value
 * derived from task text, and the arguments are a fixed argv array
 * (`shell: false`), never a constructed command string. `/T` targets the
 * whole tree (not just the direct child); `/F` forces termination.
 */
export function forceTerminateProcessTree(options: ProcessTreeOptions): void {
  if (options.platform === "win32") {
    const handle = options.spawner.spawn(
      "taskkill.exe",
      ["/PID", String(options.pid), "/T", "/F"],
      { cwd: tmpdir(), env: options.env },
    );
    // Best-effort: taskkill's own failure (e.g. the process already
    // exited) is not something this cleanup path needs to react to.
    handle.onError(() => undefined);
    return;
  }
  (options.posixGroupKiller ?? realPosixGroupKiller).killGroup(options.pid, "SIGKILL");
}
