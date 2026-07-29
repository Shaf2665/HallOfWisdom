import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { InstanceOwnershipConflictError } from "./persistence-errors.js";

/**
 * Exclusive-ownership lock for a `--data-dir`, enforced by this module —
 * see `docs/architecture/0013-durable-persistence-and-recovery.md`,
 * "Durable single-instance ownership" for the full design rationale and
 * the empirical proof this is necessary (`node:sqlite`'s `DatabaseSync`
 * lets two processes open the same file with zero error; only an
 * individual conflicting write transaction is serialized, and even then
 * only once both processes are already mutating state — there is no
 * startup-time exclusivity of any kind on its own).
 *
 * The lock is a single fixed-name file (`LOCK_FILE_NAME`) directly under
 * the canonical `dataDir` — never a client-influenceable path (this
 * module has no HTTP-reachable entry point at all), never a second lock
 * layered on top of SQLite's own locking (the kickoff for this phase
 * explicitly asked for exactly one mechanism, not two).
 *
 * Protocol, precisely:
 *
 * 1. **Acquire**: atomically create the lock file (`wx` — fails with
 *    `EEXIST` if it already exists) containing a fresh random `token`,
 *    this process's `pid`/`hostname`/`execPath`, and an `acquiredAt` /
 *    `heartbeatAt` timestamp pair.
 * 2. **Contention**: if the file already exists, read and Zod-validate
 *    its content. Malformed or unreadable content is never treated as
 *    proof of anything — it fails closed, exactly like an unconfirmed
 *    live owner (never delete or overwrite a record this process cannot
 *    positively reason about).
 * 3. **Staleness test**: the existing record is "safely stale" —
 *    eligible for takeover — only when its `heartbeatAt` is older than
 *    `staleAfterMs`. Liveness (`process.kill(pid, 0)`) is consulted only
 *    to produce a clearer diagnostic message; it is deliberately **not**
 *    part of the staleness decision itself. A confirmed-alive PID with a
 *    fresh heartbeat is never treated as stale. A confirmed-dead PID
 *    with a heartbeat that hasn't yet passed `staleAfterMs` is also
 *    *not* treated as stale — the heartbeat is the single source of
 *    truth for "how recently was this process actively holding the
 *    lock," which is what actually matters for safety.
 * 4. **Takeover**: write a new record to a uniquely-named temp file,
 *    then atomically rename it over the lock file (`fs.renameSync` is an
 *    atomic replace on both POSIX and Windows). Immediately read the
 *    lock file back and confirm it holds *this* attempt's token — if a
 *    concurrent competitor's takeover landed after ours, the readback
 *    reveals their token instead, and this process fails closed rather
 *    than assuming it won. This closes the two-concurrent-stale-takeover
 *    race without needing any cross-process coordination beyond the
 *    filesystem's own atomic rename.
 * 5. **Heartbeat**: while held, the lock file's `heartbeatAt` is
 *    refreshed (same create-temp-then-rename pattern) every
 *    `heartbeatIntervalMs`. The timer is `unref()`d so it can never by
 *    itself keep the process alive.
 * 6. **Release**: clears the heartbeat timer and removes the lock file —
 *    but only if it still holds this process's own token (never remove
 *    a lock another process has since taken over, and never remove
 *    *any* other path). `release()` never throws.
 *
 * **Disclosed limitation, not hidden**: this scheme cannot distinguish
 * "the original owner is still alive but has been frozen/suspended
 * (debugger breakpoint, STOP signal, host hypervisor pause) for longer
 * than `staleAfterMs`" from "the original owner crashed." Both present
 * identically — a stale heartbeat — and both are treated as safe to take
 * over. This is the same inherent tradeoff every heartbeat/lease-based
 * ownership scheme makes (Kubernetes leader election, etcd leases,
 * etc.): the alternative (never allowing takeover without an
 * unambiguous liveness signal) would let a single crashed process
 * permanently brick the data directory, which requirement #6 of this
 * phase's kickoff explicitly rules out. `staleAfterMs`'s default is
 * chosen to comfortably exceed any normal GC pause or scheduling jitter.
 */

export const LOCK_FILE_NAME = "hall-core.lock";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 2000;
const DEFAULT_STALE_AFTER_MS = 20_000;

const ownershipRecordSchema = z
  .object({
    token: z.string().min(1),
    pid: z.number().int().positive(),
    hostname: z.string().min(1),
    execPath: z.string().min(1),
    bootId: z.string().min(1),
    acquiredAt: z.string().min(1),
    heartbeatAt: z.string().min(1),
  })
  .strict();

type OwnershipRecord = z.infer<typeof ownershipRecordSchema>;

/** Narrow, injectable clock — real wall-clock time by default, deterministic in tests. */
export interface OwnershipClock {
  now(): Date;
}

const realClock: OwnershipClock = { now: () => new Date() };

/**
 * Narrow, injectable liveness probe. `"alive"`/`"dead"` are only ever
 * used for the diagnostic message — see the module doc comment on why
 * the staleness *decision* itself is heartbeat-only. `"unknown"` covers
 * `EPERM` (process exists under another identity) and any other
 * unexpected error probing the PID.
 */
export interface ProcessLivenessProbe {
  check(pid: number): "alive" | "dead" | "unknown";
}

const realLivenessProbe: ProcessLivenessProbe = {
  check(pid) {
    try {
      // Signal 0 tests process existence without sending a real signal —
      // supported on both POSIX and Windows by Node's `process.kill`.
      process.kill(pid, 0);
      return "alive";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return "dead";
      if (code === "EPERM") return "unknown";
      return "unknown";
    }
  },
};

/** Narrow filesystem surface this module needs — real `node:fs` by default, fully fakeable in tests without touching disk. */
export interface OwnershipFileSystem {
  /** Atomic create-only write; must throw with `.code === "EEXIST"` if the path already exists. */
  createExclusive(filePath: string, content: string): void;
  /** Throws (any error) if the path does not exist or cannot be read. */
  read(filePath: string): string;
  /** Atomic replace — must overwrite an existing target on every supported platform. */
  renameOverwrite(from: string, to: string): void;
  /** Best-effort removal; the caller only ever calls this after confirming ownership. */
  remove(filePath: string): void;
}

const realFileSystem: OwnershipFileSystem = {
  createExclusive(filePath, content) {
    fs.writeFileSync(filePath, content, { flag: "wx" });
  },
  read(filePath) {
    return fs.readFileSync(filePath, "utf8");
  },
  renameOverwrite(from, to) {
    fs.renameSync(from, to);
  },
  remove(filePath) {
    fs.unlinkSync(filePath);
  },
};

export interface InstanceOwnershipOptions {
  /** Canonical, already-validated `dataDir` — the lock file is always exactly `<dataDir>/hall-core.lock`, never a client- or config-influenced path. */
  readonly dataDir: string;
  readonly bootId: string;
  readonly heartbeatIntervalMs?: number;
  readonly staleAfterMs?: number;
  readonly clock?: OwnershipClock;
  readonly livenessProbe?: ProcessLivenessProbe;
  readonly fileSystem?: OwnershipFileSystem;
  readonly pid?: number;
  readonly hostname?: string;
  readonly execPath?: string;
  /**
   * Injectable, defaulting to a fresh `randomUUID()` — `server.ts` passes
   * its own pre-generated token here so the *same* opaque identity is used
   * for both this filesystem lock and the database ownership fence
   * (`database-ownership-fence.ts`), letting `acquireDatabaseEpoch` be
   * called with the identical token this lock was acquired under. Two
   * distinct mechanisms, one shared instance identity.
   */
  readonly token?: string;
}

export interface InstanceOwnershipHandle {
  /** Idempotent, never throws. Removes the lock file only if it still holds this process's own token. */
  release(): void;
  /**
   * Stops the periodic heartbeat refresh without releasing the lock —
   * never called by production `server.ts` (which always heartbeats for
   * as long as it holds ownership). Exists so the frozen-owner process
   * test (Phase 13.2 kickoff §6) can deterministically produce a
   * genuinely stale-but-not-released lock from a process that is still
   * alive and still holds its original database connection open, which
   * is exactly the "frozen, not crashed" scenario that test proves is
   * safe — a `SIGKILL`led process cannot be used for that proof, since
   * its connection is gone along with the process. Idempotent, never
   * throws.
   */
  pauseHeartbeat(): void;
}

function readExistingRecord(
  fileSystem: OwnershipFileSystem,
  lockPath: string,
): OwnershipRecord | undefined {
  let raw: string;
  try {
    raw = fileSystem.read(lockPath);
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = ownershipRecordSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

/**
 * Acquires exclusive ownership of `options.dataDir`, or throws
 * `InstanceOwnershipConflictError`. Synchronous, matching every other
 * startup-time persistence check in this codebase (`resolveDataDir`,
 * `checkOrRecordConfigurationFingerprint`). Must be called before
 * `HallDatabase.open()` — see `server.ts`'s startup ordering and this
 * phase's kickoff, requirement #1.
 */
export function acquireInstanceOwnership(
  options: InstanceOwnershipOptions,
): InstanceOwnershipHandle {
  const fileSystem = options.fileSystem ?? realFileSystem;
  const clock = options.clock ?? realClock;
  const livenessProbe = options.livenessProbe ?? realLivenessProbe;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const pid = options.pid ?? process.pid;
  const hostname = options.hostname ?? os.hostname();
  const execPath = options.execPath ?? process.execPath;

  const lockPath = path.join(options.dataDir, LOCK_FILE_NAME);
  const token = options.token ?? randomUUID();

  function buildRecord(): OwnershipRecord {
    return {
      token,
      pid,
      hostname,
      execPath,
      bootId: options.bootId,
      acquiredAt: clock.now().toISOString(),
      heartbeatAt: clock.now().toISOString(),
    };
  }

  function tryCreateFresh(): boolean {
    try {
      fileSystem.createExclusive(lockPath, JSON.stringify(buildRecord()));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw new InstanceOwnershipConflictError(
        "the ownership lock could not be created for an unexpected filesystem reason",
      );
    }
  }

  if (!tryCreateFresh()) {
    const existing = readExistingRecord(fileSystem, lockPath);
    if (existing === undefined) {
      throw new InstanceOwnershipConflictError(
        "an existing ownership record could not be safely confirmed dead",
      );
    }

    const heartbeatAgeMs = clock.now().getTime() - Date.parse(existing.heartbeatAt);
    const heartbeatIsFresh = !Number.isFinite(heartbeatAgeMs) || heartbeatAgeMs < staleAfterMs;
    if (heartbeatIsFresh) {
      const liveness = livenessProbe.check(existing.pid);
      throw new InstanceOwnershipConflictError(
        liveness === "dead"
          ? "the recorded owner process is gone but its heartbeat is still recent — refusing to take over prematurely"
          : "an active owner's heartbeat is still recent",
      );
    }

    // Heartbeat is stale beyond the grace window — safe to attempt a
    // takeover regardless of what the liveness probe reports (see the
    // module doc comment's "Disclosed limitation").
    const takeoverRecord = buildRecord();
    const tmpPath = `${lockPath}.tmp-${token}`;
    try {
      fileSystem.createExclusive(tmpPath, JSON.stringify(takeoverRecord));
      fileSystem.renameOverwrite(tmpPath, lockPath);
    } catch {
      throw new InstanceOwnershipConflictError(
        "a stale ownership takeover attempt failed for an unexpected filesystem reason",
      );
    }

    const verify = readExistingRecord(fileSystem, lockPath);
    if (verify?.token !== token) {
      throw new InstanceOwnershipConflictError(
        "lost a concurrent race to take over a stale ownership record",
      );
    }
  }

  let released = false;
  const heartbeatTimer = setInterval(() => {
    // Kickoff §4 — "heartbeat renewal cannot overwrite another owner's
    // record" and "a heartbeat observing another token reports ownership
    // loss; a failed or ambiguous heartbeat does not silently continue
    // forever." Read-before-write closes a real bug the unconditional
    // overwrite this replaced would otherwise have: if this process was
    // frozen long enough for a legitimate takeover to happen and then
    // resumes, a *pending* heartbeat tick would blindly overwrite the new
    // owner's lock record with this (stale) instance's own token —
    // resurrecting this instance's filesystem ownership out from under
    // the legitimate owner, which would then chain into `release()`
    // later deleting *their* lock (exactly the failure §4/§5-15
    // prohibits). Only a successfully-read, schema-valid, *different*
    // token counts as a confirmed loss — `readExistingRecord` already
    // collapses "unreadable" and "malformed" down to `undefined`, and an
    // ambiguous read like that must never be treated as loss (it stays
    // best-effort and simply retries next tick, same as any other
    // transient failure below).
    const current = readExistingRecord(fileSystem, lockPath);
    if (current !== undefined && current.token !== token) {
      clearInterval(heartbeatTimer);
      console.error(
        "Hall Core: this instance's filesystem ownership lock has been taken over by another instance; heartbeat refresh stopped.",
      );
      return;
    }

    const tmpPath = `${lockPath}.tmp-${token}`;
    try {
      fileSystem.createExclusive(tmpPath, JSON.stringify(buildRecord()));
      fileSystem.renameOverwrite(tmpPath, lockPath);
    } catch {
      // Best-effort: a single missed heartbeat tick must never crash the
      // running server. The next tick retries.
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref();

  let heartbeatPaused = false;

  return {
    release(): void {
      if (released) return;
      released = true;
      clearInterval(heartbeatTimer);
      try {
        const current = readExistingRecord(fileSystem, lockPath);
        if (current?.token === token) {
          fileSystem.remove(lockPath);
        }
      } catch {
        // Best-effort cleanup — release() must never throw.
      }
    },
    pauseHeartbeat(): void {
      if (heartbeatPaused) return;
      heartbeatPaused = true;
      clearInterval(heartbeatTimer);
    },
  };
}
