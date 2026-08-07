import { saveConfig, tryLoadConfig } from "./config-store.js";
import { resolveHallConfigFilePath } from "./config-path.js";
import {
  HallConfigValidationError,
  UnsupportedHallConfigSchemaVersionError,
  parseHallConfig,
  type HallConfig,
} from "./schema.js";
import { HallConfigPathPrecheckError, precheckHallOwnedPath } from "./path-precheck.js";

export interface CliIo {
  readonly stdin: string;
  writeStdout(text: string): void;
}

function precheckAllPaths(config: HallConfig): string[] {
  const errors: string[] = [];
  const checks: readonly (readonly [string, string | undefined | null])[] = [
    ["workspaceRoot", config.workspaceRoot],
    ["dataDir", config.dataDir],
    ["agentWorktreeRoot", config.agentWorktreeRoot],
    ["comparisonRoot", config.comparisonRoot],
  ];
  for (const [label, value] of checks) {
    if (value === undefined || value === null) continue;
    try {
      precheckHallOwnedPath(value, label);
    } catch (error) {
      errors.push(error instanceof HallConfigPathPrecheckError ? error.message : String(error));
    }
  }
  return errors;
}

function extractPathFlag(rest: readonly string[]): string | undefined {
  const index = rest.indexOf("--path");
  return index === -1 ? undefined : rest[index + 1];
}

/** Process-free CLI core, directly unit-testable. `cli.ts` is the thin process wrapper around this. */
export function runCli(argv: readonly string[], io: CliIo): number {
  const [command, ...rest] = argv;
  const configPath = extractPathFlag(rest) ?? resolveHallConfigFilePath();

  if (command === "status") {
    try {
      const loaded = tryLoadConfig(configPath);
      io.writeStdout(
        JSON.stringify({
          exists: loaded !== undefined,
          path: configPath,
          config: loaded?.config ?? null,
          error: null,
        }),
      );
    } catch (error) {
      io.writeStdout(
        JSON.stringify({
          exists: true,
          path: configPath,
          config: null,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return 0;
  }

  if (command === "validate" || command === "save") {
    let candidate: HallConfig;
    try {
      candidate = parseHallConfig(JSON.parse(io.stdin));
    } catch (error) {
      const message =
        error instanceof HallConfigValidationError || error instanceof UnsupportedHallConfigSchemaVersionError
          ? error.message
          : `stdin was not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
      io.writeStdout(JSON.stringify({ valid: false, saved: false, errors: [message] }));
      return 1;
    }

    const pathErrors = precheckAllPaths(candidate);
    if (pathErrors.length > 0) {
      io.writeStdout(JSON.stringify({ valid: false, saved: false, errors: pathErrors }));
      return 1;
    }

    if (command === "validate") {
      io.writeStdout(JSON.stringify({ valid: true, errors: [] }));
      return 0;
    }

    try {
      saveConfig(candidate, configPath);
    } catch (error) {
      io.writeStdout(
        JSON.stringify({ saved: false, errors: [error instanceof Error ? error.message : String(error)] }),
      );
      return 1;
    }
    io.writeStdout(JSON.stringify({ saved: true, path: configPath }));
    return 0;
  }

  io.writeStdout(
    JSON.stringify({ error: `Unknown command "${String(command)}". Expected status, validate, or save.` }),
  );
  return 1;
}
