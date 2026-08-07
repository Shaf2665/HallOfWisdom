import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { HallConfigPathPrecheckError, precheckHallOwnedPath } from "./path-precheck.js";

describe("precheckHallOwnedPath", () => {
  it("accepts a plausible absolute path", () => {
    expect(() => {
      precheckHallOwnedPath("D:\\HallOfWisdomData", "dataDir");
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
    const candidate = path.join(os.platform() === "win32" ? "D:\\" : "/", "HallOfWisdomData");
    expect(() => {
      precheckHallOwnedPath(candidate, "dataDir");
    }).not.toThrow();
  });
});
