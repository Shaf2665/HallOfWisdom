import {
  execFile,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";

export type DetectionProcessStatus =
  "success" | "spawn_error" | "timed_out" | "non_zero_exit" | "output_limit";

export interface DetectionProcessResult {
  readonly status: DetectionProcessStatus;
  readonly stdout: string;
}

export interface DetectionProcessOptions {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface DetectionProcessRunner {
  run(options: DetectionProcessOptions): Promise<DetectionProcessResult>;
}

export function buildExecFileOptions(
  options: DetectionProcessOptions,
): ExecFileOptionsWithStringEncoding {
  return {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: options.maxOutputBytes,
    shell: false,
    windowsHide: true,
  };
}

function classifyProcessError(error: ExecFileException): DetectionProcessStatus {
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "output_limit";
  if (error.killed) return "timed_out";
  return typeof error.code === "number" ? "non_zero_exit" : "spawn_error";
}

export const nodeDetectionProcessRunner: DetectionProcessRunner = {
  run(options) {
    return new Promise((resolve) => {
      try {
        execFile(
          options.executablePath,
          [...options.args],
          buildExecFileOptions(options),
          (error, stdout) => {
            if (error !== null) {
              resolve({ status: classifyProcessError(error), stdout: "" });
              return;
            }
            resolve({ status: "success", stdout });
          },
        );
      } catch {
        resolve({ status: "spawn_error", stdout: "" });
      }
    });
  },
};
