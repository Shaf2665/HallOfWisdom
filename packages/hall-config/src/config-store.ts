import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveHallConfigFilePath } from "./config-path.js";
import { parseHallConfig, type HallConfig } from "./schema.js";

export class HallConfigNotFoundError extends Error {
  constructor(configPath: string) {
    super(`No Hall configuration found at "${configPath}".`);
    this.name = "HallConfigNotFoundError";
  }
}

export interface LoadedHallConfig {
  readonly config: HallConfig;
  readonly path: string;
}

export function loadConfig(configPath: string = resolveHallConfigFilePath()): LoadedHallConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    throw new HallConfigNotFoundError(configPath);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Hall configuration at "${configPath}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { config: parseHallConfig(parsed), path: configPath };
}

/** Returns `undefined` (never throws) only when no config file exists yet — the normal "first run" case. A malformed or unsupported-version file still throws, so corruption is never silently treated as absence. */
export function tryLoadConfig(
  configPath: string = resolveHallConfigFilePath(),
): LoadedHallConfig | undefined {
  if (!fs.existsSync(configPath)) return undefined;
  return loadConfig(configPath);
}

/**
 * Atomic write: validates `config`, writes it to a fresh temp file in the
 * *same directory* as `configPath`, then `fs.renameSync`s it over the
 * target — an atomic replace on both POSIX and Windows (same-volume
 * rename), so an interrupted write can never leave a half-written config
 * file behind. Validates before touching the filesystem at all.
 */
export function saveConfig(
  config: HallConfig,
  configPath: string = resolveHallConfigFilePath(),
): void {
  const validated = parseHallConfig(config);
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(configPath)}.tmp-${randomUUID()}`);
  fs.writeFileSync(tmpPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, configPath);
}
