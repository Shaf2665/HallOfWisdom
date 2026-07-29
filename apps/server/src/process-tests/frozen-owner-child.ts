import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { acquireInstanceOwnership } from "../persistence/instance-ownership.js";
import { acquireDatabaseEpoch } from "../persistence/database-ownership-fence.js";
import { withTransaction } from "../persistence/transaction.js";
import { OwnershipLostError } from "../persistence/persistence-errors.js";

/**
 * Test-only child process for the frozen-owner fencing proof (Phase 13.2
 * kickoff §6) — never imported by any production code path, never
 * reachable via a CLI flag or HTTP route on the real server binary.
 * Ships in `dist/` alongside `process-test-support.ts` for the same
 * reason: it is a genuine Node.js *process*, spawned via
 * `node <this file>`, so it has to be plain compiled JS the test harness
 * can invoke directly.
 *
 * A `SIGKILL`led process (as `hard-crash-restart.test.ts` uses) proves
 * crash-recovery, but its database connection dies with it — it cannot
 * prove the scenario this phase's kickoff is actually worried about: a
 * process that is merely frozen/paused, still holding its *original*
 * connection open, that later resumes and attempts a write. This script
 * stays alive and interactive specifically so a test can freeze it, let a
 * real second instance take over, and then command the *same* original
 * process to attempt a mutation through the *same* original connection.
 *
 * Protocol: line-delimited commands on stdin, one JSON object per line on
 * stdout in response.
 *   (on startup)     -> {"event":"ready","ownerToken":string,"epoch":number}
 *   PAUSE-HEARTBEAT  -> {"event":"heartbeat-paused"}
 *   MUTATE           -> {"event":"mutate-result","ok":true} | {"event":"mutate-result","ok":false,"error":string}
 *   RELEASE-ATTEMPT  -> {"event":"release-attempted"}
 *   EXIT             -> process exits 0, without releasing ownership
 */

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function main(): void {
  const dataDir = process.argv[2];
  if (dataDir === undefined) {
    console.error("usage: frozen-owner-child.js <dataDir>");
    process.exit(1);
  }

  // This script deliberately skips `resolveDataDir`'s full
  // canonicalization/containment validation (irrelevant here — there is
  // no workspaceRoot/comparisonRoot involved), but still needs to create
  // the directory itself, exactly like `resolveDataDir` does for the real
  // server, since `acquireInstanceOwnership`'s lock-file creation
  // requires the parent directory to already exist.
  fs.mkdirSync(dataDir, { recursive: true });

  const ownerToken = randomUUID();
  const ownershipHandle = acquireInstanceOwnership({
    dataDir,
    bootId: randomUUID(),
    token: ownerToken,
  });
  const db = HallDatabase.open({ dataDir, busyTimeoutMs: 2000 });
  runMigrations(db);
  const fence = acquireDatabaseEpoch(db, ownerToken);
  db.setOwnershipFence(fence);
  db.exec(
    "CREATE TABLE IF NOT EXISTS frozen_owner_test_scratch (id INTEGER PRIMARY KEY, v TEXT NOT NULL)",
  );

  emit({ event: "ready", ownerToken, epoch: fence.epoch });

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const command = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      handleCommand(command);
    }
  });

  function handleCommand(command: string): void {
    switch (command) {
      case "PAUSE-HEARTBEAT": {
        ownershipHandle.pauseHeartbeat();
        emit({ event: "heartbeat-paused" });
        break;
      }
      case "MUTATE": {
        try {
          withTransaction(db, () => {
            db.prepare("INSERT INTO frozen_owner_test_scratch (v) VALUES (?)").run(
              `attempt-${String(Date.now())}`,
            );
          });
          emit({ event: "mutate-result", ok: true });
        } catch (error) {
          emit({
            event: "mutate-result",
            ok: false,
            error: error instanceof OwnershipLostError ? "OwnershipLostError" : String(error),
          });
        }
        break;
      }
      case "RELEASE-ATTEMPT": {
        ownershipHandle.release();
        emit({ event: "release-attempted" });
        break;
      }
      case "EXIT": {
        process.exit(0);
        break;
      }
      default: {
        // Unknown command — ignored rather than crashing the process, so
        // a stray blank line from the parent's stdin writer is harmless.
        break;
      }
    }
  }
}

main();
