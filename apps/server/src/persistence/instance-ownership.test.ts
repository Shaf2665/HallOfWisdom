import { describe, expect, it, vi } from "vitest";
import { InstanceOwnershipConflictError } from "./persistence-errors.js";
import {
  acquireInstanceOwnership,
  LOCK_FILE_NAME,
  type OwnershipClock,
  type OwnershipFileSystem,
  type ProcessLivenessProbe,
} from "./instance-ownership.js";

/** In-memory fake — never touches disk, deterministic, exercises the exact `EEXIST`/read/rename-overwrite/remove contract `instance-ownership.ts` requires. */
class FakeFileSystem implements OwnershipFileSystem {
  readonly #files = new Map<string, string>();

  createExclusive(filePath: string, content: string): void {
    if (this.#files.has(filePath)) {
      const error = new Error("file already exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    }
    this.#files.set(filePath, content);
  }

  read(filePath: string): string {
    const content = this.#files.get(filePath);
    if (content === undefined) {
      const error = new Error("no such file") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return content;
  }

  renameOverwrite(from: string, to: string): void {
    const content = this.#files.get(from);
    if (content === undefined) throw new Error("rename source missing");
    this.#files.delete(from);
    this.#files.set(to, content);
  }

  remove(filePath: string): void {
    this.#files.delete(filePath);
  }

  /** Test-only helper — writes directly, bypassing the exclusive-create contract, to simulate a pre-existing lock file. */
  seed(filePath: string, content: string): void {
    this.#files.set(filePath, content);
  }

  has(filePath: string): boolean {
    return this.#files.has(filePath);
  }

  raw(filePath: string): string | undefined {
    return this.#files.get(filePath);
  }
}

class FakeClock implements OwnershipClock {
  #current: Date;
  constructor(initial: Date) {
    this.#current = initial;
  }
  now(): Date {
    return this.#current;
  }
  advanceMs(ms: number): void {
    this.#current = new Date(this.#current.getTime() + ms);
  }
}

function fakeProbe(result: "alive" | "dead" | "unknown"): ProcessLivenessProbe {
  return { check: () => result };
}

const DATA_DIR = "C:\\fake\\hall-core-data";
const LOCK_PATH = `${DATA_DIR}\\${LOCK_FILE_NAME}`;

describe("acquireInstanceOwnership", () => {
  it("the first instance acquires ownership and writes a lock record under dataDir", () => {
    const fileSystem = new FakeFileSystem();
    const handle = acquireInstanceOwnership({
      dataDir: DATA_DIR,
      bootId: "boot-1",
      fileSystem,
      clock: new FakeClock(new Date("2026-01-01T00:00:00.000Z")),
    });

    expect(fileSystem.has(LOCK_PATH)).toBe(true);
    handle.release();
  });

  it("a second attempt with a fresh heartbeat fails closed even when the recorded PID is reported dead", () => {
    const fileSystem = new FakeFileSystem();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00.000Z"));
    const first = acquireInstanceOwnership({
      dataDir: DATA_DIR,
      bootId: "boot-1",
      fileSystem,
      clock,
      livenessProbe: fakeProbe("alive"),
    });

    clock.advanceMs(1000); // well under the default 20s staleAfterMs
    expect(() =>
      acquireInstanceOwnership({
        dataDir: DATA_DIR,
        bootId: "boot-2",
        fileSystem,
        clock,
        livenessProbe: fakeProbe("dead"),
      }),
    ).toThrow(InstanceOwnershipConflictError);

    first.release();
  });

  it("a confirmed-alive owner with a fresh heartbeat is never displaced", () => {
    const fileSystem = new FakeFileSystem();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00.000Z"));
    const first = acquireInstanceOwnership({
      dataDir: DATA_DIR,
      bootId: "boot-1",
      fileSystem,
      clock,
      livenessProbe: fakeProbe("alive"),
    });
    const beforeAttempt = fileSystem.raw(LOCK_PATH);

    expect(() =>
      acquireInstanceOwnership({
        dataDir: DATA_DIR,
        bootId: "boot-2",
        fileSystem,
        clock,
        livenessProbe: fakeProbe("alive"),
      }),
    ).toThrow(InstanceOwnershipConflictError);

    // The rejected attempt must never have mutated the existing record.
    expect(fileSystem.raw(LOCK_PATH)).toBe(beforeAttempt);
    first.release();
  });

  it("a stale heartbeat (beyond staleAfterMs) is safely taken over by a new instance", () => {
    const fileSystem = new FakeFileSystem();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00.000Z"));
    const stalenessWindowMs = 5000;
    acquireInstanceOwnership({
      dataDir: DATA_DIR,
      bootId: "boot-1",
      fileSystem,
      clock,
      staleAfterMs: stalenessWindowMs,
      livenessProbe: fakeProbe("dead"),
    });
    // Simulate a crash: no release() call, no further heartbeats.

    clock.advanceMs(stalenessWindowMs + 1);
    const second = acquireInstanceOwnership({
      dataDir: DATA_DIR,
      bootId: "boot-2",
      fileSystem,
      clock,
      staleAfterMs: stalenessWindowMs,
      livenessProbe: fakeProbe("dead"),
    });

    const record = JSON.parse(fileSystem.raw(LOCK_PATH) ?? "{}") as { bootId: string };
    expect(record.bootId).toBe("boot-2");
    second.release();
  });

  it("takeover is offered regardless of what the liveness probe reports, once the heartbeat is stale (documented tradeoff)", () => {
    const fileSystem = new FakeFileSystem();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00.000Z"));
    const stalenessWindowMs = 5000;
    acquireInstanceOwnership({
      dataDir: DATA_DIR,
      bootId: "boot-1",
      fileSystem,
      clock,
      staleAfterMs: stalenessWindowMs,
      livenessProbe: fakeProbe("alive"), // e.g. PID reuse by an unrelated live process
    });

    clock.advanceMs(stalenessWindowMs + 1);
    const second = acquireInstanceOwnership({
      dataDir: DATA_DIR,
      bootId: "boot-2",
      fileSystem,
      clock,
      staleAfterMs: stalenessWindowMs,
      livenessProbe: fakeProbe("alive"),
    });

    const record = JSON.parse(fileSystem.raw(LOCK_PATH) ?? "{}") as { bootId: string };
    expect(record.bootId).toBe("boot-2");
    second.release();
  });

  it("malformed ownership metadata fails safely and never attempts a takeover", () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.seed(LOCK_PATH, "{ not: valid, json");

    expect(() =>
      acquireInstanceOwnership({
        dataDir: DATA_DIR,
        bootId: "boot-2",
        fileSystem,
        clock: new FakeClock(new Date()),
      }),
    ).toThrow(InstanceOwnershipConflictError);
    // The malformed content must be left exactly as-is — no takeover attempt.
    expect(fileSystem.raw(LOCK_PATH)).toBe("{ not: valid, json");
  });

  it("ownership metadata with the wrong shape (valid JSON, wrong fields) also fails safely", () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.seed(LOCK_PATH, JSON.stringify({ unexpected: "shape" }));

    expect(() =>
      acquireInstanceOwnership({
        dataDir: DATA_DIR,
        bootId: "boot-2",
        fileSystem,
        clock: new FakeClock(new Date()),
      }),
    ).toThrow(InstanceOwnershipConflictError);
  });

  it("graceful release removes the lock file, and a new instance can then acquire it immediately", () => {
    const fileSystem = new FakeFileSystem();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00.000Z"));
    const first = acquireInstanceOwnership({
      dataDir: DATA_DIR,
      bootId: "boot-1",
      fileSystem,
      clock,
    });
    first.release();
    expect(fileSystem.has(LOCK_PATH)).toBe(false);

    // No staleness wait needed — the lock is gone entirely, not merely stale.
    const second = acquireInstanceOwnership({
      dataDir: DATA_DIR,
      bootId: "boot-2",
      fileSystem,
      clock,
    });
    expect(fileSystem.has(LOCK_PATH)).toBe(true);
    second.release();
  });

  it("release() is idempotent and never throws, even if the lock file is already gone", () => {
    const fileSystem = new FakeFileSystem();
    const handle = acquireInstanceOwnership({
      dataDir: DATA_DIR,
      bootId: "boot-1",
      fileSystem,
      clock: new FakeClock(new Date()),
    });
    fileSystem.remove(LOCK_PATH); // simulate external interference
    expect(() => {
      handle.release();
      handle.release();
    }).not.toThrow();
  });

  it("release() never removes a lock a later instance has since taken over", () => {
    const fileSystem = new FakeFileSystem();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00.000Z"));
    const stalenessWindowMs = 1000;
    const first = acquireInstanceOwnership({
      dataDir: DATA_DIR,
      bootId: "boot-1",
      fileSystem,
      clock,
      staleAfterMs: stalenessWindowMs,
    });

    clock.advanceMs(stalenessWindowMs + 1);
    const second = acquireInstanceOwnership({
      dataDir: DATA_DIR,
      bootId: "boot-2",
      fileSystem,
      clock,
      staleAfterMs: stalenessWindowMs,
    });

    // `first` believes it still owns the lock (it was never told about the
    // takeover) but must not be able to destroy `second`'s legitimate claim.
    first.release();
    expect(fileSystem.has(LOCK_PATH)).toBe(true);
    const record = JSON.parse(fileSystem.raw(LOCK_PATH) ?? "{}") as { bootId: string };
    expect(record.bootId).toBe("boot-2");

    second.release();
  });

  // Kickoff §4 — "heartbeat renewal cannot overwrite another owner's
  // record" and "a failed or ambiguous heartbeat does not silently
  // continue forever." Models the resume-and-resurrect scenario the
  // unconditional-overwrite version of this heartbeat was vulnerable to:
  // a frozen former owner's *pending* heartbeat tick fires only after a
  // legitimate takeover has already happened.
  it("a heartbeat tick observing another instance's token never overwrites its record, and stops ticking", async () => {
    vi.useFakeTimers();
    try {
      const fileSystem = new FakeFileSystem();
      const clock = new FakeClock(new Date("2026-01-01T00:00:00.000Z"));
      const stalenessWindowMs = 1000;
      const heartbeatIntervalMs = 10;
      const first = acquireInstanceOwnership({
        dataDir: DATA_DIR,
        bootId: "boot-1",
        fileSystem,
        clock,
        staleAfterMs: stalenessWindowMs,
        heartbeatIntervalMs,
      });

      clock.advanceMs(stalenessWindowMs + 1);
      const second = acquireInstanceOwnership({
        dataDir: DATA_DIR,
        bootId: "boot-2",
        fileSystem,
        clock,
        staleAfterMs: stalenessWindowMs,
        heartbeatIntervalMs,
      });

      // `first`'s heartbeat timer is still ticking (it was never told
      // about the takeover) — its next tick must not resurrect its own
      // record over `second`'s legitimate one.
      await vi.advanceTimersByTimeAsync(heartbeatIntervalMs * 2);
      let record = JSON.parse(fileSystem.raw(LOCK_PATH) ?? "{}") as { bootId: string };
      expect(record.bootId).toBe("boot-2");

      // And it never resurrects it later either — the timer stopped
      // itself rather than silently retrying forever.
      await vi.advanceTimersByTimeAsync(heartbeatIntervalMs * 10);
      record = JSON.parse(fileSystem.raw(LOCK_PATH) ?? "{}") as { bootId: string };
      expect(record.bootId).toBe("boot-2");

      first.release();
      second.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("different data directories are owned completely independently", () => {
    const fileSystem = new FakeFileSystem();
    const a = acquireInstanceOwnership({
      dataDir: "C:\\fake\\data-a",
      bootId: "boot-a",
      fileSystem,
      clock: new FakeClock(new Date()),
    });
    const b = acquireInstanceOwnership({
      dataDir: "C:\\fake\\data-b",
      bootId: "boot-b",
      fileSystem,
      clock: new FakeClock(new Date()),
    });

    expect(fileSystem.has(`C:\\fake\\data-a\\${LOCK_FILE_NAME}`)).toBe(true);
    expect(fileSystem.has(`C:\\fake\\data-b\\${LOCK_FILE_NAME}`)).toBe(true);
    a.release();
    b.release();
  });

  it("no ownership error message ever contains the data directory path", () => {
    const fileSystem = new FakeFileSystem();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00.000Z"));
    const first = acquireInstanceOwnership({
      dataDir: DATA_DIR,
      bootId: "boot-1",
      fileSystem,
      clock,
    });

    try {
      acquireInstanceOwnership({ dataDir: DATA_DIR, bootId: "boot-2", fileSystem, clock });
      expect.unreachable("expected a conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(InstanceOwnershipConflictError);
      const message = (error as Error).message;
      expect(message).not.toContain(DATA_DIR);
      expect(message).not.toContain(LOCK_FILE_NAME);
    } finally {
      first.release();
    }
  });

  it("a heartbeat strictly younger than staleAfterMs is refused; the boundary itself is treated as stale", () => {
    const fileSystem = new FakeFileSystem();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00.000Z"));
    const staleAfterMs = 5000;
    const first = acquireInstanceOwnership({
      dataDir: DATA_DIR,
      bootId: "boot-1",
      fileSystem,
      clock,
      staleAfterMs,
    });

    clock.advanceMs(staleAfterMs - 1); // one millisecond short of the boundary
    expect(() =>
      acquireInstanceOwnership({
        dataDir: DATA_DIR,
        bootId: "boot-2",
        fileSystem,
        clock,
        staleAfterMs,
      }),
    ).toThrow(InstanceOwnershipConflictError);

    clock.advanceMs(1); // now exactly at the boundary
    const second = acquireInstanceOwnership({
      dataDir: DATA_DIR,
      bootId: "boot-2",
      fileSystem,
      clock,
      staleAfterMs,
    });
    const record = JSON.parse(fileSystem.raw(LOCK_PATH) ?? "{}") as { bootId: string };
    expect(record.bootId).toBe("boot-2");

    first.release();
    second.release();
  });
});
