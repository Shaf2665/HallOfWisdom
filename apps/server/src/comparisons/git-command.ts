import { runBoundedProcess } from "./bounded-process.js";
import { buildGitChildEnvironment } from "./git-environment.js";
import type { ProcessSpawner } from "./process-spawner.js";
import { GitCommandFailedError } from "./git-worktree-errors.js";

export interface GitCommandOptions {
  readonly spawner: ProcessSpawner;
  readonly gitExecutablePath: string;
  readonly timeoutMs: number;
}

/**
 * Runs one `git` command to completion in `cwd` and returns its stdout —
 * throws `GitCommandFailedError` on any non-zero exit, timeout, or spawn
 * failure. The one shared entry point every `git`-invoking module in
 * `comparisons/` uses (`GitWorktreeManager`, `result-evidence.ts`), so
 * environment sanitization (`buildGitChildEnvironment`) and failure
 * wrapping happen in exactly one place.
 */
export async function runGitCommand(
  args: readonly string[],
  cwd: string,
  options: GitCommandOptions,
): Promise<string> {
  const result = await runBoundedProcess({
    spawner: options.spawner,
    executablePath: options.gitExecutablePath,
    args,
    cwd,
    env: buildGitChildEnvironment(process.env),
    timeoutMs: options.timeoutMs,
  });
  if (result.exitCode !== 0 || result.timedOut || result.spawnError !== undefined) {
    throw new GitCommandFailedError(args, result);
  }
  return result.stdout;
}
