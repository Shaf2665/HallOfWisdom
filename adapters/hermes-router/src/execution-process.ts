import {
  spawn,
  type ChildProcessByStdio,
  type SpawnOptionsWithStdioTuple,
} from "node:child_process";
import type { Readable, Writable } from "node:stream";

type SpawnedChild = ChildProcessByStdio<Writable, Readable, Readable>;

export interface HermesProcessSpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly platform: NodeJS.Platform;
}

export interface SpawnedHermesProcess {
  readonly pid: number | undefined;
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(callback: (error: Error) => void): void;
  terminate(): void;
  forceTerminate(): void;
}

export interface HermesProcessSpawner {
  spawn(
    executablePath: string,
    args: readonly string[],
    options: HermesProcessSpawnOptions,
  ): SpawnedHermesProcess;
}

export function buildHermesNodeSpawnOptions(
  options: HermesProcessSpawnOptions,
): SpawnOptionsWithStdioTuple<"pipe", "pipe", "pipe"> {
  return {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: options.platform !== "win32",
  };
}

function killPosixGroup(child: SpawnedChild, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
}

class NodeSpawnedHermesProcess implements SpawnedHermesProcess {
  readonly #child: SpawnedChild;
  readonly #options: HermesProcessSpawnOptions;

  constructor(child: SpawnedChild, options: HermesProcessSpawnOptions) {
    this.#child = child;
    this.#options = options;
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  get stdin(): NodeJS.WritableStream {
    return this.#child.stdin;
  }

  get stdout(): NodeJS.ReadableStream {
    return this.#child.stdout;
  }

  get stderr(): NodeJS.ReadableStream {
    return this.#child.stderr;
  }

  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.#child.on("exit", callback);
  }

  onError(callback: (error: Error) => void): void {
    this.#child.on("error", callback);
  }

  terminate(): void {
    if (this.#options.platform === "win32") {
      this.#child.kill();
      return;
    }
    killPosixGroup(this.#child, "SIGTERM");
  }

  forceTerminate(): void {
    if (this.#options.platform !== "win32") {
      killPosixGroup(this.#child, "SIGKILL");
      return;
    }

    const pid = this.#child.pid;
    if (pid === undefined) {
      this.#child.kill("SIGKILL");
      return;
    }
    try {
      const taskkill = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        cwd: this.#options.cwd,
        env: this.#options.env,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      taskkill.on("error", () => this.#child.kill("SIGKILL"));
    } catch {
      this.#child.kill("SIGKILL");
    }
  }
}

export const nodeHermesProcessSpawner: HermesProcessSpawner = {
  spawn(executablePath, args, options) {
    const child = spawn(executablePath, [...args], buildHermesNodeSpawnOptions(options));
    return new NodeSpawnedHermesProcess(child, options);
  },
};
