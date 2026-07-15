import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Writable } from "node:stream";
import type { AgentRegistry } from "./agent-registry.js";
import { parseCliArguments, type CliOptions } from "./cli-args.js";
import { createMockAgentRegistry } from "./mock-agent-composition-root.js";
import { validateWorkspace } from "./workspace-validation.js";
import { buildTaskInput } from "./build-task-input.js";
import { runTask } from "./runner-service.js";
import { installSignalCancellation } from "./signal-cancellation.js";
import { writeDiagnostic, writeJsonLine, formatErrorForDiagnostic } from "./cli-io.js";
import { EXIT_CODES } from "./exit-codes.js";
import { RunnerError } from "./errors.js";

export interface RunCliOptions {
  readonly argv: readonly string[];
  readonly stdout: Writable;
  readonly stderr: Writable;
  /** Defaults to the real `process.exit`; tests inject a spy so a forced second-Ctrl+C exit never kills the test runner. */
  readonly exit?: (code: number) => void;
  /**
   * Defaults to `createMockAgentRegistry` (the real development composition
   * root). Overridable so tests can register a capturing/fake `AgentAdapter`
   * and drive it through this exact same composition path — CLI parsing,
   * workspace validation, `buildTaskInput`, `runTask` — without needing a
   * real coding agent or spawning a child process.
   */
  readonly createRegistry?: (cliOptions: CliOptions) => AgentRegistry;
}

/**
 * Runs one Mock Agent task end to end: parse CLI args, validate the
 * workspace, build a validated `AgentTaskInput`, run it through the
 * generic runner service, and stream JSON Lines events to `stdout`. Never
 * calls `process.exit()` itself except via the injectable `exit` callback
 * used only for the forced-second-Ctrl+C path — the normal return value
 * (an exit code) is what the real entry point below uses to set
 * `process.exitCode`, letting Node exit naturally once I/O flushes.
 */
export async function runCli(options: RunCliOptions): Promise<number> {
  const exit = options.exit ?? ((code: number) => process.exit(code));

  let cliOptions;
  try {
    cliOptions = parseCliArguments(options.argv);
  } catch (error) {
    writeDiagnostic(options.stderr, formatErrorForDiagnostic(error));
    return EXIT_CODES.invalidInput;
  }

  let validatedWorkspace;
  try {
    validatedWorkspace = validateWorkspace({
      workspaceRoot: cliOptions.workspaceRoot,
      workingDirectory: cliOptions.workingDirectory,
    });
  } catch (error) {
    writeDiagnostic(options.stderr, formatErrorForDiagnostic(error));
    return EXIT_CODES.invalidInput;
  }

  const createRegistry = options.createRegistry ?? createMockAgentRegistry;
  let registry;
  try {
    registry = createRegistry(cliOptions);
  } catch (error) {
    writeDiagnostic(options.stderr, formatErrorForDiagnostic(error));
    return EXIT_CODES.invalidInput;
  }

  let adapter;
  try {
    adapter = registry.resolve(cliOptions.adapter);
  } catch (error) {
    writeDiagnostic(options.stderr, formatErrorForDiagnostic(error));
    return EXIT_CODES.invalidInput;
  }

  const runId = randomUUID();

  let taskInput;
  try {
    taskInput = buildTaskInput({
      cliOptions,
      validatedWorkspace,
      agentIdentity: adapter.descriptor.supportedAgent,
      runId,
    });
  } catch (error) {
    writeDiagnostic(options.stderr, formatErrorForDiagnostic(error));
    return EXIT_CODES.invalidInput;
  }

  const controller = new AbortController();
  const signalHandle = installSignalCancellation({
    onGracefulCancel: () => {
      writeDiagnostic(options.stderr, "Received interrupt signal; requesting cancellation...");
      controller.abort("SIGINT received");
    },
    onForceExit: () => {
      writeDiagnostic(options.stderr, "Received a second interrupt signal; forcing exit.");
      exit(EXIT_CODES.cancelled);
    },
  });

  try {
    const result = await runTask({
      registry,
      adapterId: cliOptions.adapter,
      taskInput,
      options: { signal: controller.signal },
      onEvent: (event) => {
        writeJsonLine(options.stdout, event);
      },
    });
    return result.exitCode;
  } catch (error) {
    const message =
      error instanceof RunnerError
        ? formatErrorForDiagnostic(error)
        : `Unexpected internal error: ${formatErrorForDiagnostic(error)}`;
    writeDiagnostic(options.stderr, message);
    return EXIT_CODES.internalError;
  } finally {
    signalHandle.uninstall();
  }
}

function isMainModule(): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) return false;
  return import.meta.url === pathToFileURL(entryArg).href;
}

if (isMainModule()) {
  runCli({ argv: process.argv.slice(2), stdout: process.stdout, stderr: process.stderr })
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${formatErrorForDiagnostic(error)}\n`);
      process.exitCode = EXIT_CODES.internalError;
    });
}
