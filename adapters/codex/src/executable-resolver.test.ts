import { describe, expect, it } from "vitest";
import { resolveCodexExecutable, type FileSystemProbe } from "./executable-resolver.js";

function fakeFs(existingPaths: readonly string[]): FileSystemProbe {
  const set = new Set(existingPaths.map((path) => path.toLowerCase()));
  return { isFile: (path) => set.has(path.toLowerCase()) };
}

describe("resolveCodexExecutable — POSIX", () => {
  it("finds a native executable on PATH", () => {
    const result = resolveCodexExecutable({
      platform: "linux",
      pathValue: "/usr/local/bin:/usr/bin",
      fs: fakeFs(["/usr/local/bin/codex"]),
    });
    expect(result.found).toBe(true);
    expect(result.executable).toEqual({ path: "/usr/local/bin/codex", kind: "native" });
  });

  it("prefers the first PATH directory that has a match", () => {
    const result = resolveCodexExecutable({
      platform: "linux",
      pathValue: "/opt/first:/opt/second",
      fs: fakeFs(["/opt/first/codex", "/opt/second/codex"]),
    });
    expect(result.executable?.path).toBe("/opt/first/codex");
  });

  it("reports not_found when nothing matches", () => {
    const result = resolveCodexExecutable({
      platform: "linux",
      pathValue: "/usr/bin",
      fs: fakeFs([]),
    });
    expect(result.found).toBe(false);
    expect(result.reason).toBe("not_found");
  });

  it("handles an empty PATH safely", () => {
    const result = resolveCodexExecutable({ platform: "linux", pathValue: "", fs: fakeFs([]) });
    expect(result.found).toBe(false);
  });

  it("ignores empty PATH segments", () => {
    const result = resolveCodexExecutable({
      platform: "linux",
      pathValue: "::/usr/bin:",
      fs: fakeFs(["/usr/bin/codex"]),
    });
    expect(result.found).toBe(true);
  });
});

describe("resolveCodexExecutable — Windows", () => {
  it("finds a native .exe over an earlier-PATH .cmd shim", () => {
    const result = resolveCodexExecutable({
      platform: "win32",
      pathValue: "C:\\npm\\shim;C:\\Program Files\\Codex",
      pathExt: ".COM;.EXE;.BAT;.CMD",
      fs: fakeFs(["C:\\npm\\shim\\codex.cmd", "C:\\Program Files\\Codex\\codex.exe"]),
    });
    expect(result.found).toBe(true);
    expect(result.executable).toEqual({
      path: "C:\\Program Files\\Codex\\codex.exe",
      kind: "native",
    });
  });

  it("accepts a .cmd shim (kind: shim) when no native executable exists anywhere on PATH — the real npm-managed install layout", () => {
    const result = resolveCodexExecutable({
      platform: "win32",
      pathValue: "C:\\npm\\shim",
      pathExt: ".COM;.EXE;.BAT;.CMD",
      fs: fakeFs(["C:\\npm\\shim\\codex.cmd"]),
    });
    expect(result.found).toBe(true);
    expect(result.executable?.kind).toBe("shim");
  });

  it("treats .ps1 as neither native nor a resolvable shim", () => {
    const result = resolveCodexExecutable({
      platform: "win32",
      pathValue: "C:\\npm\\shim",
      pathExt: ".COM;.EXE;.BAT;.CMD;.PS1",
      fs: fakeFs(["C:\\npm\\shim\\codex.ps1"]),
    });
    expect(result.found).toBe(false);
  });

  it("treats an extensionless file as a shim, not native — matches the real npm-managed POSIX shim script confirmed live during Phase 10 reconnaissance", () => {
    const result = resolveCodexExecutable({
      platform: "win32",
      pathValue: "C:\\Users\\operator\\AppData\\Roaming\\npm",
      fs: fakeFs(["C:\\Users\\operator\\AppData\\Roaming\\npm\\codex"]),
    });
    expect(result.found).toBe(true);
    expect(result.executable?.kind).toBe("shim");
  });

  it("prefers a native .exe over an extensionless shim in the same directory", () => {
    const result = resolveCodexExecutable({
      platform: "win32",
      pathValue: "C:\\npm",
      fs: fakeFs(["C:\\npm\\codex", "C:\\npm\\codex.exe"]),
    });
    expect(result.executable).toEqual({ path: "C:\\npm\\codex.exe", kind: "native" });
  });

  it("falls back to the default PATHEXT when none is supplied", () => {
    const result = resolveCodexExecutable({
      platform: "win32",
      pathValue: "C:\\Program Files\\Codex",
      fs: fakeFs(["C:\\Program Files\\Codex\\codex.exe"]),
    });
    expect(result.found).toBe(true);
    expect(result.executable?.kind).toBe("native");
  });

  it("is deterministic across duplicate installations regardless of scan order", () => {
    const first = resolveCodexExecutable({
      platform: "win32",
      pathValue: "C:\\A;C:\\B",
      fs: fakeFs(["C:\\A\\codex.cmd", "C:\\B\\codex.exe"]),
    });
    const second = resolveCodexExecutable({
      platform: "win32",
      pathValue: "C:\\A;C:\\B",
      fs: fakeFs(["C:\\A\\codex.cmd", "C:\\B\\codex.exe"]),
    });
    expect(first).toEqual(second);
    expect(first.executable?.kind).toBe("native");
  });
});

describe("resolveCodexExecutable — bounded resolution time", () => {
  it("stops and reports timeout when resolution exceeds the bound", () => {
    let elapsed = 0;
    const result = resolveCodexExecutable({
      platform: "linux",
      pathValue: "/a:/b:/c",
      fs: fakeFs([]),
      maxResolutionMs: 10,
      nowMs: () => {
        elapsed += 20;
        return elapsed;
      },
    });
    expect(result.found).toBe(false);
    expect(result.reason).toBe("timeout");
  });
});

describe("resolveCodexExecutable — no shell interpolation", () => {
  it("never treats a PATH entry containing shell metacharacters as anything but a literal directory", () => {
    const result = resolveCodexExecutable({
      platform: "linux",
      pathValue: "/tmp/weird; rm -rf /:/usr/bin",
      fs: fakeFs(["/usr/bin/codex"]),
    });
    expect(result.found).toBe(true);
    expect(result.executable?.path).toBe("/usr/bin/codex");
  });
});
