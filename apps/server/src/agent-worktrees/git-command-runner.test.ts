import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AgentWorktreeGitOperationError } from "./agent-worktree-errors.js";
import {
  assertGitSuccess,
  buildAgentWorktreeGitEnvironment,
  NodeGitCommandRunner,
  type GitProcessSpawner,
  type SpawnedGitProcessHandle,
} from "./git-command-runner.js";

describe("NodeGitCommandRunner", () => {
  it("uses structured arguments, shell false, bounded output, and sanitized environment", async () => {
    const calls: {
      readonly executablePath: string;
      readonly args: readonly string[];
      readonly shell: false;
      readonly env: Readonly<Record<string, string>>;
    }[] = [];
    const spawner: GitProcessSpawner = {
      spawn(executablePath, args, options) {
        calls.push({ executablePath, args, shell: options.shell, env: options.env });
        return completedProcess("ok\n", "", 0);
      },
    };
    const runner = new NodeGitCommandRunner({
      gitExecutablePath: "git",
      parentEnv: {
        PATH: "safe-path",
        GIT_DIR: "evil",
        GIT_WORK_TREE: "evil",
        GIT_INDEX_FILE: "evil",
        SECRET_TOKEN: "secret",
      },
      spawner,
    });
    const result = await runner.run({
      args: ["worktree", "add", "--detach", "Repo With Spaces;$(x)", "HEAD"],
      cwd: "C:\\Repo With Spaces",
      timeoutMs: 1000,
    });
    expect(result.stdout).toBe("ok\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "worktree",
      "add",
      "--detach",
      "Repo With Spaces;$(x)",
      "HEAD",
    ]);
    expect(calls[0]?.shell).toBe(false);
    expect(calls[0]?.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(calls[0]?.env.GIT_DIR).toBeUndefined();
    expect(calls[0]?.env.GIT_WORK_TREE).toBeUndefined();
    expect(calls[0]?.env.GIT_INDEX_FILE).toBeUndefined();
    expect(calls[0]?.env.SECRET_TOKEN).toBeUndefined();
  });

  it("rejects empty commands", () => {
    const runner = new NodeGitCommandRunner({ spawner: fakeSpawner() });
    expect(() => runner.run({ args: [], cwd: "C:\\Repo", timeoutMs: 1000 })).toThrow(
      AgentWorktreeGitOperationError,
    );
  });

  it("caps stdout and stderr", async () => {
    const runner = new NodeGitCommandRunner({
      spawner: {
        spawn() {
          return completedProcess("x".repeat(20), "y".repeat(20), 0);
        },
      },
    });
    const result = await runner.run({
      args: ["status"],
      cwd: "C:\\Repo",
      timeoutMs: 1000,
      maxOutputChars: 5,
    });
    expect(result.stdout).toBe("xxxxx");
    expect(result.stderr).toBe("yyyyy");
  });

  it("converts Git stderr to a bounded safe failure", () => {
    expect(() =>
      assertGitSuccess(
        {
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: `secret ${"x".repeat(800)}`,
          timedOut: false,
          spawnError: undefined,
        },
        "GIT_FAILED",
      ),
    ).toThrow(AgentWorktreeGitOperationError);
  });

  it("buildAgentWorktreeGitEnvironment removes repository-redirection variables", () => {
    const env = buildAgentWorktreeGitEnvironment({
      PATH: "safe",
      GIT_DIR: "evil",
      GIT_OBJECT_DIRECTORY: "evil",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "evil",
    });
    expect(env.PATH).toBe("safe");
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_OBJECT_DIRECTORY).toBeUndefined();
    expect(env.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeUndefined();
  });
});

function fakeSpawner(): GitProcessSpawner {
  return {
    spawn() {
      return completedProcess("", "", 0);
    },
  };
}

function completedProcess(
  stdoutText: string,
  stderrText: string,
  exitCode: number,
): SpawnedGitProcessHandle {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const exitCallbacks: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  queueMicrotask(() => {
    stdout.end(stdoutText);
    stderr.end(stderrText);
    for (const callback of exitCallbacks) callback(exitCode, null);
  });
  return {
    stdin,
    stdout,
    stderr,
    onExit(callback) {
      exitCallbacks.push(callback);
    },
    onError(callback) {
      void callback;
    },
    kill() {
      return true;
    },
  };
}
