import os from "node:os";
import path from "node:path";

export const HALL_CONFIG_DIR_ENV_OVERRIDE = "HALL_CONFIG_DIR";
export const HALL_CONFIG_FILE_NAME = "config.json";

/**
 * Resolves Hall's persisted-configuration directory. Deliberately
 * machine-local (Windows `%LOCALAPPDATA%`, not Roaming): this file stores
 * machine-specific absolute paths that must never sync across machines via
 * a roaming profile. Overridable via `HALL_CONFIG_DIR` so tests never touch
 * a real user profile.
 */
export function resolveHallConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env[HALL_CONFIG_DIR_ENV_OVERRIDE];
  if (override !== undefined && override.trim().length > 0) {
    return override;
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    const base =
      localAppData !== undefined && localAppData.trim().length > 0
        ? localAppData
        : path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "HallOfWisdom");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "HallOfWisdom");
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME;
  const base =
    xdgConfigHome !== undefined && xdgConfigHome.trim().length > 0
      ? xdgConfigHome
      : path.join(os.homedir(), ".config");
  return path.join(base, "hall-of-wisdom");
}

export function resolveHallConfigFilePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(resolveHallConfigDir(env, platform), HALL_CONFIG_FILE_NAME);
}
