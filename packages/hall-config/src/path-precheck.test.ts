import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { HallConfigPathPrecheckError, precheckHallOwnedPath } from "./path-precheck.js";
import { TEST_DATA_DIR } from "./test-paths.js";

describe("precheckHallOwnedPath", () => {
  it("accepts a plausible absolute path", () => {
    expect(() => {
      precheckHallOwnedPath(TEST_DATA_DIR, "dataDir");
    }).not.toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => {
      precheckHallOwnedPath("", "dataDir");
    }).toThrow(HallConfigPathPrecheckError);
  });

  it("rejects a blank string", () => {
    expect(() => {
      precheckHallOwnedPath("   ", "dataDir");
    }).toThrow(HallConfigPathPrecheckError);
  });

  it("rejects a relative path", () => {
    expect(() => {
      precheckHallOwnedPath("relative\\path", "dataDir");
    }).toThrow(HallConfigPathPrecheckError);
  });

  it("rejects a bare filesystem root", () => {
    const root = os.platform() === "win32" ? "D:\\" : "/";
    expect(() => {
      precheckHallOwnedPath(root, "dataDir");
    }).toThrow(HallConfigPathPrecheckError);
  });

  it("includes the label in the error message", () => {
    expect(() => {
      precheckHallOwnedPath("", "agentWorktreeRoot");
    }).toThrow(/agentWorktreeRoot/);
  });

  it("accepts a path built with path.join to prove platform-appropriate separators work", () => {
    const candidate = path.join(path.parse(TEST_DATA_DIR).root, "HallOfWisdomData");
    expect(() => {
      precheckHallOwnedPath(candidate, "dataDir");
    }).not.toThrow();
  });
});
