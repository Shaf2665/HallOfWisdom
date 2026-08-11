import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HALL_CONFIG_DIR_ENV_OVERRIDE,
  HALL_CONFIG_FILE_NAME,
  resolveHallConfigDir,
  resolveHallConfigFilePath,
} from "./config-path.js";
import { TEST_CONFIG_DIR } from "./test-paths.js";

describe("resolveHallConfigDir", () => {
  it("uses %LOCALAPPDATA%\\HallOfWisdom on win32", () => {
    const dir = resolveHallConfigDir({ LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local" }, "win32");
    expect(dir).toBe(path.join("C:\\Users\\Test\\AppData\\Local", "HallOfWisdom"));
  });

  it("falls back to homedir-derived Local path on win32 when LOCALAPPDATA is unset", () => {
    const dir = resolveHallConfigDir({}, "win32");
    expect(dir.endsWith(path.join("AppData", "Local", "HallOfWisdom"))).toBe(true);
  });

  it("uses ~/Library/Application Support/HallOfWisdom on darwin", () => {
    const dir = resolveHallConfigDir({}, "darwin");
    expect(dir.endsWith(path.join("Library", "Application Support", "HallOfWisdom"))).toBe(true);
  });

  it("uses $XDG_CONFIG_HOME/hall-of-wisdom on linux when set", () => {
    const dir = resolveHallConfigDir({ XDG_CONFIG_HOME: "/home/test/.config" }, "linux");
    expect(dir).toBe(path.join("/home/test/.config", "hall-of-wisdom"));
  });

  it("falls back to ~/.config/hall-of-wisdom on linux when XDG_CONFIG_HOME is unset", () => {
    const dir = resolveHallConfigDir({}, "linux");
    expect(dir.endsWith(path.join(".config", "hall-of-wisdom"))).toBe(true);
  });

  it("HALL_CONFIG_DIR env override wins on every platform", () => {
    const override = { [HALL_CONFIG_DIR_ENV_OVERRIDE]: TEST_CONFIG_DIR };
    expect(resolveHallConfigDir(override, "win32")).toBe(TEST_CONFIG_DIR);
    expect(resolveHallConfigDir(override, "linux")).toBe(TEST_CONFIG_DIR);
  });

  it("ignores a blank HALL_CONFIG_DIR override", () => {
    const dir = resolveHallConfigDir({ [HALL_CONFIG_DIR_ENV_OVERRIDE]: "   ", LOCALAPPDATA: "C:\\LA" }, "win32");
    expect(dir).toBe(path.join("C:\\LA", "HallOfWisdom"));
  });
});

describe("resolveHallConfigFilePath", () => {
  it("appends config.json to the resolved directory", () => {
    const filePath = resolveHallConfigFilePath({ LOCALAPPDATA: "C:\\LA" }, "win32");
    expect(filePath).toBe(path.join("C:\\LA", "HallOfWisdom", HALL_CONFIG_FILE_NAME));
  });
});
