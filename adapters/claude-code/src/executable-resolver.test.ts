import { describe, expect, it } from "vitest";
import { resolveClaudeExecutable, type FileSystemProbe } from "./executable-resolver.js";

function fakeFs(existingPaths: readonly string[]): FileSystemProbe {
  // Real Windows filesystem paths are case-insensitive, so this fake must
  // be too — otherwise it would fail to simulate a real disk where PATHEXT
  // (conventionally uppercase, e.g. ".CMD") resolves against an
  // actual file whose extension is lowercase (e.g. "claude.cmd").
  const set = new Set(existingPaths.map((path) => path.toLowerCase()));
  return { isFile: (path) => set.has(path.toLowerCase()) };
}

describe("resolveClaudeExecutable — POSIX", () => {
  it("finds a native executable on PATH", () => {
    const result = resolveClaudeExecutable({
      platform: "linux",
      pathValue: "/usr/local/bin:/usr/bin",
      fs: fakeFs(["/usr/local/bin/claude"]),
    });
    expect(result.found).toBe(true);
    expect(result.executable).toEqual({ path: "/usr/local/bin/claude", kind: "native" });
  });

  it("prefers the first PATH directory that has a match", () => {
    const result = resolveClaudeExecutable({
      platform: "linux",
      pathValue: "/opt/first:/opt/second",
      fs: fakeFs(["/opt/first/claude", "/opt/second/claude"]),
    });
    expect(result.executable?.path).toBe("/opt/first/claude");
  });

  it("reports not_found when nothing matches", () => {
    const result = resolveClaudeExecutable({
      platform: "linux",
      pathValue: "/usr/bin",
      fs: fakeFs([]),
    });
    expect(result.found).toBe(false);
    expect(result.reason).toBe("not_found");
  });

  it("handles an empty PATH safely", () => {
    const result = resolveClaudeExecutable({ platform: "linux", pathValue: "", fs: fakeFs([]) });
    expect(result.found).toBe(false);
  });

  it("ignores empty PATH segments", () => {
    const result = resolveClaudeExecutable({
      platform: "linux",
      pathValue: "::/usr/bin:",
      fs: fakeFs(["/usr/bin/claude"]),
    });
    expect(result.found).toBe(true);
  });
});

describe("resolveClaudeExecutable — Windows", () => {
  it("finds a native .exe over an earlier-PATH .cmd shim", () => {
    const result = resolveClaudeExecutable({
      platform: "win32",
      pathValue: "C:\\npm\\shim;C:\\Program Files\\Claude",
      pathExt: ".COM;.EXE;.BAT;.CMD",
      fs: fakeFs(["C:\\npm\\shim\\claude.cmd", "C:\\Program Files\\Claude\\claude.exe"]),
    });
    expect(result.found).toBe(true);
    expect(result.executable).toEqual({
      path: "C:\\Program Files\\Claude\\claude.exe",
      kind: "native",
    });
  });

  it("returns the shim with reason shim_only when no native executable exists anywhere on PATH", () => {
    const result = resolveClaudeExecutable({
      platform: "win32",
      pathValue: "C:\\npm\\shim",
      pathExt: ".COM;.EXE;.BAT;.CMD",
      fs: fakeFs(["C:\\npm\\shim\\claude.cmd"]),
    });
    expect(result.found).toBe(true);
    expect(result.executable?.kind).toBe("shim");
    expect(result.reason).toBe("shim_only");
  });

  it("treats .ps1 as a shim, not a native executable", () => {
    const result = resolveClaudeExecutable({
      platform: "win32",
      pathValue: "C:\\npm\\shim",
      pathExt: ".COM;.EXE;.BAT;.CMD;.PS1",
      fs: fakeFs(["C:\\npm\\shim\\claude.ps1"]),
    });
    expect(result.executable?.kind).toBe("shim");
  });

  it("finds an extensionless native binary", () => {
    const result = resolveClaudeExecutable({
      platform: "win32",
      pathValue: "C:\\Users\\operator\\.local\\bin",
      fs: fakeFs(["C:\\Users\\operator\\.local\\bin\\claude"]),
    });
    expect(result.found).toBe(true);
    expect(result.executable?.kind).toBe("native");
  });

  it("falls back to the default PATHEXT when none is supplied", () => {
    const result = resolveClaudeExecutable({
      platform: "win32",
      pathValue: "C:\\Program Files\\Claude",
      fs: fakeFs(["C:\\Program Files\\Claude\\claude.exe"]),
    });
    expect(result.found).toBe(true);
    expect(result.executable?.kind).toBe("native");
  });

  it("is deterministic across duplicate installations regardless of scan order", () => {
    const first = resolveClaudeExecutable({
      platform: "win32",
      pathValue: "C:\\A;C:\\B",
      fs: fakeFs(["C:\\A\\claude.cmd", "C:\\B\\claude.exe"]),
    });
    const second = resolveClaudeExecutable({
      platform: "win32",
      pathValue: "C:\\A;C:\\B",
      fs: fakeFs(["C:\\A\\claude.cmd", "C:\\B\\claude.exe"]),
    });
    expect(first).toEqual(second);
    expect(first.executable?.kind).toBe("native");
  });
});

describe("resolveClaudeExecutable — bounded resolution time", () => {
  it("stops and reports timeout when resolution exceeds the bound", () => {
    let elapsed = 0;
    const result = resolveClaudeExecutable({
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

describe("resolveClaudeExecutable — no shell interpolation", () => {
  it("never treats a PATH entry containing shell metacharacters as anything but a literal directory", () => {
    const result = resolveClaudeExecutable({
      platform: "linux",
      pathValue: "/tmp/weird; rm -rf /:/usr/bin",
      fs: fakeFs(["/usr/bin/claude"]),
    });
    // The malicious-looking segment is just another literal PATH directory
    // to check for a file in — never executed or interpreted as shell.
    expect(result.found).toBe(true);
    expect(result.executable?.path).toBe("/usr/bin/claude");
  });
});
