import { pathToFileURL } from "node:url";
import { validateWorkspace } from "@hall-of-wisdom/hall-runner";
import { createHallCoreApp } from "./app.js";
import { createMockAgentServerComposition } from "./composition/mock-agent-composition-root.js";
import { parseServerCliArguments, ServerCliError } from "./config/server-cli-args.js";
import {
  DEFAULT_LIMITS,
  DEFAULT_PORT,
  LOCAL_ONLY_HOST,
  SHUTDOWN_TIMEOUT_MS,
} from "./config/server-config.js";
import { installShutdownSignals } from "./process/signal-shutdown.js";

const EXIT_INVALID_INPUT = 2;
const EXIT_INTERNAL_ERROR = 3;
const EXIT_FORCED_SHUTDOWN = 130;

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Runs the Hall Core server end to end: parse CLI args, canonicalize the
 * workspace root (reusing Hall Runner's `validateWorkspace` — passing the
 * root as both `workspaceRoot` and `workingDirectory`, since a root is
 * always trivially "contained" within itself, is a deliberate reuse of an
 * existing function rather than a new one), build the development
 * composition, start listening on `127.0.0.1` only, and install graceful
 * shutdown. Never calls `process.exit()` itself except via the
 * injectable-in-spirit forced-shutdown path below, mirroring
 * `runners/hall-runner/src/cli.ts`'s discipline of keeping `process.exit()`
 * at the process boundary only.
 */
export async function runServer(argv: readonly string[]): Promise<number> {
  let cliOptions;
  try {
    cliOptions = parseServerCliArguments(argv);
  } catch (error) {
    console.error(formatError(error));
    return EXIT_INVALID_INPUT;
  }

  let workspaceRoot: string;
  try {
    workspaceRoot = validateWorkspace({
      workspaceRoot: cliOptions.workspaceRoot,
      workingDirectory: cliOptions.workspaceRoot,
    }).workspaceRoot;
  } catch (error) {
    console.error(formatError(error));
    return EXIT_INVALID_INPUT;
  }

  let composition;
  try {
    composition = createMockAgentServerComposition({
      workspaceRoot,
      mockScenario: cliOptions.mockScenario,
      mockStepDelayMs: cliOptions.mockStepDelayMs,
      limits: DEFAULT_LIMITS,
      onExecutionError: (taskId, error) => {
        console.error(`Task ${taskId} execution failed: ${formatError(error)}`);
      },
    });
  } catch (error) {
    if (error instanceof ServerCliError) {
      console.error(formatError(error));
      return EXIT_INVALID_INPUT;
    }
    throw error;
  }

  const app = await createHallCoreApp({
    orchestrator: composition.orchestrator,
    taskStore: composition.taskStore,
    eventStore: composition.eventStore,
    eventBus: composition.eventBus,
    boardStore: composition.boardStore,
    messageStore: composition.messageStore,
    messageBus: composition.messageBus,
    registry: composition.registry,
    webOrigin: cliOptions.webOrigin,
    limits: DEFAULT_LIMITS,
  });

  const port = cliOptions.port ?? DEFAULT_PORT;

  try {
    await app.listen({ port, host: LOCAL_ONLY_HOST });
  } catch (error) {
    app.log.error({ err: error }, "failed to start Hall Core server");
    return EXIT_INTERNAL_ERROR;
  }

  app.log.info(
    `Hall Core is listening on http://${LOCAL_ONLY_HOST}:${String(port)} — bound to localhost only, not reachable from the network. Approved web origin: ${cliOptions.webOrigin}.`,
  );

  let resolveExitCode!: (code: number) => void;
  const exitCodePromise = new Promise<number>((resolve) => {
    resolveExitCode = resolve;
  });

  const signalHandle = installShutdownSignals({
    onGracefulShutdown: () => {
      app.log.info("Received interrupt/terminate signal; shutting down gracefully...");
      void (async () => {
        try {
          await composition.orchestrator.shutdown(SHUTDOWN_TIMEOUT_MS);
          await app.close();
        } finally {
          resolveExitCode(0);
        }
      })();
    },
    onForceExit: () => {
      app.log.warn("Received a second interrupt/terminate signal; forcing exit.");
      process.exit(EXIT_FORCED_SHUTDOWN);
    },
  });

  const exitCode = await exitCodePromise;
  signalHandle.uninstall();
  return exitCode;
}

function isMainModule(): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) return false;
  return import.meta.url === pathToFileURL(entryArg).href;
}

if (isMainModule()) {
  runServer(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(formatError(error));
      process.exitCode = EXIT_INTERNAL_ERROR;
    });
}
