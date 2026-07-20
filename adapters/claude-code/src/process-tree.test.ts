import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { forceTerminateProcessTree, requestGracefulTermination } from "./process-tree.js";
import type { PosixGroupKiller } from "./process-tree.js";
import type { ProcessSpawner, SpawnedProcessHandle } from "./process-spawner.js";

function fakeKiller() {
  const calls: { pid: number; signal: NodeJS.Signals }[] = [];
  const killer: PosixGroupKiller = {
    killGroup(pid, signal) {
      calls.push({ pid, signal });
    },
  };
  return { killer, calls };
}

class FakeHandle implements SpawnedProcessHandle {
  readonly pid = 999;
  readonly stdout = new EventEmitter() as unknown as NodeJS.ReadableStream;
  readonly stderr = new EventEmitter() as unknown as NodeJS.ReadableStream;
  onExit(): void {
    // unused
  }
  onError(): void {
    // unused
  }
  kill(): boolean {
    return true;
  }
}

function fakeSpawner() {
  const calls: {
    executablePath: string;
    args: readonly string[];
    env: Readonly<Record<string, string>>;
  }[] = [];
  const spawner: ProcessSpawner = {
    spawn: (executablePath, args, options) => {
      calls.push({ executablePath, args, env: options.env });
      return new FakeHandle();
    },
  };
  return { spawner, calls };
}

describe("requestGracefulTermination — POSIX", () => {
  it("sends SIGTERM to the process group via the injected killer", () => {
    const { killer, calls } = fakeKiller();
    const { spawner } = fakeSpawner();
    requestGracefulTermination({
      platform: "linux",
      pid: 4242,
      spawner,
      env: {},
      posixGroupKiller: killer,
    });
    expect(calls).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });

  it("never calls the real process.kill (only the injected fake)", () => {
    const { killer, calls } = fakeKiller();
    const { spawner } = fakeSpawner();
    requestGracefulTermination({
      platform: "darwin",
      pid: 1,
      spawner,
      env: {},
      posixGroupKiller: killer,
    });
    expect(calls).toHaveLength(1);
  });
});

describe("requestGracefulTermination — Windows", () => {
  it("is a no-op on Windows (no spawn, no killer call)", () => {
    const { killer, calls: killCalls } = fakeKiller();
    const { spawner, calls: spawnCalls } = fakeSpawner();
    requestGracefulTermination({
      platform: "win32",
      pid: 4242,
      spawner,
      env: {},
      posixGroupKiller: killer,
    });
    expect(killCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(0);
  });
});

describe("forceTerminateProcessTree — POSIX", () => {
  it("sends SIGKILL to the process group", () => {
    const { killer, calls } = fakeKiller();
    const { spawner } = fakeSpawner();
    forceTerminateProcessTree({
      platform: "linux",
      pid: 4242,
      spawner,
      env: {},
      posixGroupKiller: killer,
    });
    expect(calls).toEqual([{ pid: 4242, signal: "SIGKILL" }]);
  });
});

describe("forceTerminateProcessTree — Windows", () => {
  it("invokes taskkill with a trusted numeric PID, /T, and /F as separate argv entries", () => {
    const { killer } = fakeKiller();
    const { spawner, calls } = fakeSpawner();
    forceTerminateProcessTree({
      platform: "win32",
      pid: 4242,
      spawner,
      env: {},
      posixGroupKiller: killer,
    });
    expect(calls[0]?.executablePath).toBe("taskkill.exe");
    expect(calls[0]?.args).toEqual(["/PID", "4242", "/T", "/F"]);
  });

  it("never constructs a shell command string for taskkill", () => {
    const { killer } = fakeKiller();
    const { spawner, calls } = fakeSpawner();
    forceTerminateProcessTree({
      platform: "win32",
      pid: 1337,
      spawner,
      env: {},
      posixGroupKiller: killer,
    });
    for (const call of calls) {
      for (const arg of call.args) {
        expect(arg).not.toContain(" ");
        expect(arg).not.toContain(";");
        expect(arg).not.toContain("&");
      }
    }
  });

  it("passes the PID as a plain numeric string derived only from options.pid", () => {
    const { killer } = fakeKiller();
    const { spawner, calls } = fakeSpawner();
    forceTerminateProcessTree({
      platform: "win32",
      pid: 55,
      spawner,
      env: {},
      posixGroupKiller: killer,
    });
    expect(calls[0]?.args[1]).toBe("55");
    expect(Number.isInteger(Number(calls[0]?.args[1]))).toBe(true);
  });

  it("passes the sanitized child environment through to the taskkill spawn call, never an empty env", () => {
    // Regression test: taskkill.exe was previously spawned with env: {},
    // risking a resolution failure on some Windows configurations (no
    // PATH/SYSTEMROOT for the OS to find taskkill.exe with) that would
    // silently turn the force-kill phase into a no-op.
    const { killer } = fakeKiller();
    const { spawner, calls } = fakeSpawner();
    const sanitizedEnv = { PATH: "C:\\Windows\\System32", SYSTEMROOT: "C:\\Windows" };
    forceTerminateProcessTree({
      platform: "win32",
      pid: 4242,
      spawner,
      env: sanitizedEnv,
      posixGroupKiller: killer,
    });
    expect(calls[0]?.env).toEqual(sanitizedEnv);
  });
});
