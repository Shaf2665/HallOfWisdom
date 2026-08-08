import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { isContainedPath, validateWorkspace } from "@hall-of-wisdom/hall-runner";
import { tryLoadConfig } from "@hall-of-wisdom/hall-config";
import { createHallCoreApp } from "./app.js";
import { createServerComposition } from "./composition/server-composition.js";
import { parseServerCliArguments, ServerCliError } from "./config/server-cli-args.js";
import { resolveServerConfig } from "./config/resolve-server-config.js";
import {
  DATABASE_BUSY_TIMEOUT_MS,
  DEFAULT_LIMITS,
  LOCAL_ONLY_HOST,
  SHUTDOWN_TIMEOUT_MS,
} from "./config/server-config.js";
import { installShutdownSignals } from "./process/signal-shutdown.js";
import { HallDatabase, type OwnershipFence } from "./persistence/database.js";
import { resolveDataDir } from "./persistence/database-config.js";
import { PersistenceError } from "./persistence/persistence-errors.js";
import { recordCleanShutdown } from "./persistence/boot-repository.js";
import type { InstanceOwnershipHandle } from "./persistence/instance-ownership.js";
import { openDurableStorage } from "./persistence/durable-startup.js";
import {
  startOwnershipFenceMonitor,
  type OwnershipFenceMonitorHandle,
} from "./persistence/ownership-fence-monitor.js";
import { runRestartRecovery, type RecoverySummary } from "./recovery/restart-recovery.js";
import { reconcileAllPlanProgress } from "./ceo-plans/ceo-plan-progress-reconciliation.js";
import { runCeoPlanExecutionRecovery } from "./ceo-execution/ceo-plan-execution-recovery.js";
import { canonicalizeHallOwnedRoot } from "./agent-worktrees/path-safety.js";
import { AgentWorktreePathError } from "./agent-worktrees/agent-worktree-errors.js";

const EXIT_INVALID_INPUT = 2;
const EXIT_INTERNAL_ERROR = 3;
const EXIT_FORCED_SHUTDOWN = 130;
/**
 * This instance's durable ownership epoch was superseded by another
 * instance (Phase 13.2) — distinguished from `EXIT_INTERNAL_ERROR` purely
 * for operator diagnosability in logs/process supervisors; nothing in this
 * codebase branches on the specific value.
 */
const EXIT_OWNERSHIP_LOST = 4;

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Runs the Hall Core server end to end: parse CLI args, canonicalize the
 * workspace root (reusing Hall Runner's `validateWorkspace` — passing the
 * root as both `workspaceRoot` and `workingDirectory`, since a root is
 * always trivially "contained" within itself, is a deliberate reuse of an
 * existing function rather than a new one), build the development
 * composition, start listening on `127.0.0.1` only, and install graceful
 * shutdown. Never calls `process.exit()` itself except via the
 * injectable-in-spirit forced-shutdown path below, mirroring
 * `runners/hall-runner/src/cli.ts`'s discipline of keeping `process.exit()`
 * at the process boundary only.
 */
export async function runServer(argv: readonly string[]): Promise<number> {
  let overrides;
  try {
    overrides = parseServerCliArguments(argv);
  } catch (error) {
    console.error(formatError(error));
    return EXIT_INVALID_INPUT;
  }

  const persisted = tryLoadConfig()?.config;

  let cliOptions;
  try {
    cliOptions = resolveServerConfig(overrides, persisted);
  } catch (error) {
    console.error(formatError(error));
    return EXIT_INVALID_INPUT;
  }

  let workspaceRoot: string;
  try {
    workspaceRoot = validateWorkspace({
      workspaceRoot: cliOptions.workspaceRoot,
      workingDirectory: cliOptions.workspaceRoot,
    }).workspaceRoot;
  } catch (error) {
    console.error(formatError(error));
    return EXIT_INVALID_INPUT;
  }

  // Phase 12 — `--comparison-root` is optional; when supplied, it must
  // already exist (same requirement `--workspace-root` has) and must be
  // mutually non-contained with `workspaceRoot`: neither may be nested
  // inside, or an ancestor of, the other. Without this check, `git
  // worktree add` could pollute or nest a comparison worktree inside the
  // source repository itself (if comparisonRoot were inside workspaceRoot)
  // or vice versa. Checked once, at startup — never re-derived per request.
  let comparisonRoot: string | undefined;
  if (cliOptions.comparisonRoot !== undefined) {
    let canonicalComparisonRoot: string;
    try {
      canonicalComparisonRoot = validateWorkspace({
        workspaceRoot: cliOptions.comparisonRoot,
        workingDirectory: cliOptions.comparisonRoot,
      }).workspaceRoot;
    } catch (error) {
      console.error(formatError(error));
      return EXIT_INVALID_INPUT;
    }

    const caseSensitive = process.platform !== "win32" && process.platform !== "darwin";
    const nested =
      isContainedPath(workspaceRoot, canonicalComparisonRoot, { caseSensitive, path }) ||
      isContainedPath(canonicalComparisonRoot, workspaceRoot, { caseSensitive, path });
    if (nested) {
      console.error(
        `--comparison-root must not be nested inside, or an ancestor of, --workspace-root (workspaceRoot: "${workspaceRoot}", comparisonRoot: "${canonicalComparisonRoot}").`,
      );
      return EXIT_INVALID_INPUT;
    }
    comparisonRoot = canonicalComparisonRoot;
  }

  // Phase 13 — `--data-dir` is optional; when supplied, every store
  // composition builds below is the SQLite-backed durable sibling instead
  // of the in-memory one. `resolveDataDir` performs the full safety
  // validation (absolute, created if missing, symlink-canonicalized,
  // mutually non-contained with both `workspaceRoot` and `comparisonRoot`)
  // — see `persistence/database-config.ts`. Generated unconditionally (not
  // only in durable mode) so it can be reused as-is below for recovery.
  const bootId = randomUUID();

  // Phase 13.1 — exclusive ownership of `dataDir` must be acquired before
  // the database is even opened (requirement #1 of that phase's kickoff):
  // `node:sqlite` itself lets two processes open the same file with no
  // error at all, so ownership is a separate, dedicated mechanism, not a
  // byproduct of opening the database. See `instance-ownership.ts`.
  let db: HallDatabase | undefined;
  let ownershipHandle: InstanceOwnershipHandle | undefined;
  let ownershipFence: OwnershipFence | undefined;
  let agentWorktreeRoot: string | undefined;
  if (cliOptions.dataDir !== undefined) {
    try {
      const canonicalDataDir = resolveDataDir({
        dataDir: cliOptions.dataDir,
        workspaceRoot,
        comparisonRoot,
      });
      agentWorktreeRoot =
        cliOptions.agentWorktreeRoot === undefined
          ? undefined
          : canonicalizeHallOwnedRoot({
              rawOwnedRoot: cliOptions.agentWorktreeRoot,
              forbiddenRoots: [
                { canonicalPath: workspaceRoot, label: "workspace root" },
                { canonicalPath: canonicalDataDir, label: "data directory" },
                ...(comparisonRoot === undefined
                  ? []
                  : [{ canonicalPath: comparisonRoot, label: "comparison root" }]),
              ],
            });
      // Phase 13.2 — the filesystem lock, database open, migrations,
      // epoch acquisition, and fence-set sequence lives in one shared
      // function (`openDurableStorage`) so every durable Hall Core entry
      // point — this one and the E2E dual-fixture composition
      // (`apps/e2e/src/fixture-server.ts`) — runs the identical sequence,
      // never a reimplemented copy. See
      // `docs/architecture/0013-durable-persistence-and-recovery.md`.
      const opened = openDurableStorage({
        dataDir: canonicalDataDir,
        bootId,
        busyTimeoutMs: DATABASE_BUSY_TIMEOUT_MS,
      });
      db = opened.db;
      ownershipHandle = opened.ownershipHandle;
      ownershipFence = opened.ownershipFence;
    } catch (error) {
      console.error(formatError(error));
      return error instanceof PersistenceError || error instanceof AgentWorktreePathError
        ? EXIT_INVALID_INPUT
        : EXIT_INTERNAL_ERROR;
    }
  }

  let composition;
  try {
    composition = createServerComposition({
      workspaceRoot,
      mockScenario: cliOptions.mockScenario,
      mockStepDelayMs: cliOptions.mockStepDelayMs,
      limits: DEFAULT_LIMITS,
      enableCodexTrustedLocal: cliOptions.enableCodexTrustedLocal,
      comparisonRoot,
      agentWorktreeRoot,
      db,
      onExecutionError: (taskId, error) => {
        console.error(`Task ${taskId} execution failed: ${formatError(error)}`);
      },
      onComparisonExecutionError: (candidateId, error) => {
        console.error(
          `Comparison candidate ${candidateId} execution failed: ${formatError(error)}`,
        );
      },
    });
  } catch (error) {
    if (error instanceof ServerCliError) {
      console.error(formatError(error));
      db?.close();
      ownershipHandle?.release();
      return EXIT_INVALID_INPUT;
    }
    db?.close();
    ownershipHandle?.release();
    throw error;
  }

  // Restart recovery — must complete (including rehydrating
  // `ComparisonOrchestrator`'s in-memory worktree/source-repository path
  // maps) before `app.listen`, so no request is ever served against
  // stores a crash left inconsistent. See
  // `docs/architecture/0013-durable-persistence-and-recovery.md`.
  let recoverySummary: RecoverySummary | undefined;
  let previousShutdown: RecoverySummary["previousShutdown"] = "first_start";
  if (db !== undefined) {
    try {
      // In durable mode with comparisons enabled, `createComparisonComposition`
      // always constructs `comparisonInternalPaths` (see that function) — this
      // is never actually `undefined` here, but the field's type stays
      // optional to also cover ephemeral mode, so it is re-checked rather than
      // asserted.
      const comparisonInternalPaths = composition.comparison?.comparisonInternalPaths;
      const recovery = await runRestartRecovery({
        db,
        bootId,
        startedAt: new Date().toISOString(),
        workspaceRoot,
        comparisonRoot,
        taskStore: composition.taskStore,
        taskEventStore: composition.eventStore,
        comparison:
          composition.comparison !== undefined && comparisonInternalPaths !== undefined
            ? {
                comparisonStore: composition.comparison.comparisonStore,
                comparisonEventStore: composition.comparison.comparisonEventStore,
                comparisonInternalPaths,
                gitWorktreeManager: composition.comparison.gitWorktreeManager,
              }
            : undefined,
        agentWorktree:
          composition.agentWorktreeManager !== undefined && agentWorktreeRoot !== undefined
            ? {
                agentWorktreeStore: composition.agentWorktreeStore,
                agentWorktreeManager: composition.agentWorktreeManager,
                agentWorktreeRoot,
                agentExecutionArtifactStore: composition.agentExecutionArtifactStore,
                agentExecutionArtifactTerminalizer: composition.agentExecutionArtifactTerminalizer,
              }
            : undefined,
      });
      composition.comparison?.comparisonOrchestrator.rehydrateInternalPaths(
        recovery.internalPathsForRehydration,
      );
      recoverySummary = recovery.summary;
      previousShutdown = recovery.summary.previousShutdown;
    } catch (error) {
      console.error(formatError(error));
      db.close();
      ownershipHandle?.release();
      return error instanceof PersistenceError ? EXIT_INVALID_INPUT : EXIT_INTERNAL_ERROR;
    }
  }

  // Phase 14.1 — idempotent backstop for any CEO plan progress
  // transition missed while the process was down (e.g. every child of a
  // delegated plan finished right before a crash, with no chance for the
  // task-mutation hook to notify the synchronizer) — see
  // `reconcileAllPlanProgress`'s doc comment. Runs once per boot, after
  // restart recovery, in both durable and ephemeral mode: a harmless
  // no-op in ephemeral mode, since a fresh in-memory start has no plans
  // to reconcile.
  reconcileAllPlanProgress(composition.ceoPlans.orchestrator);

  // Phase 15 — decides what to do with every previously-configured
  // autonomous plan run BEFORE the scheduler's task-mutation bridge is
  // allowed to react to anything: pause on an unclean restart (no
  // automatic retry of interrupted work), or rebuild the dependency index
  // and revalidate-and-continue on a clean one. Must run after
  // `runRestartRecovery` (whose own `reconcileTasks` step already mutated
  // `taskStore` for any genuinely interrupted child task) and before
  // `activateAutonomousScheduling()` — see both functions' doc comments.
  // A harmless no-op in ephemeral mode (`previousShutdown` stays
  // "first_start" and no run can already exist).
  await runCeoPlanExecutionRecovery({
    planRunStore: composition.ceoExecution.planRunStore,
    signalStore: composition.ceoExecution.signalStore,
    taskStore: composition.taskStore,
    scheduler: composition.ceoExecution.scheduler,
    planStore: composition.ceoPlans.planStore,
    postBoardAudit: composition.ceoExecution.postBoardAudit,
    previousShutdown,
    now: new Date().toISOString(),
    runAtomicUnit: composition.ceoExecution.runAtomicUnit,
  });
  composition.activateAutonomousScheduling();

  // Phase 13.2, kickoff §3/§10 — "health must not report ready" once this
  // instance has lost durable ownership. `readiness` is the same object
  // reference `runControlledShutdown` below flips to `false` as the very
  // first thing it does (both on a graceful shutdown and on ownership
  // loss) — `GET /api/v1/health` starts returning 503/"not_ready"
  // immediately, for the full duration of the (possibly multi-second,
  // given `SHUTDOWN_TIMEOUT_MS`) shutdown sequence, not just once the
  // process finally exits.
  const readiness = { ready: true };

  const app = await createHallCoreApp({
    orchestrator: composition.orchestrator,
    taskStore: composition.taskStore,
    eventStore: composition.eventStore,
    eventBus: composition.eventBus,
    boardStore: composition.boardStore,
    messageStore: composition.messageStore,
    messageBus: composition.messageBus,
    registry: composition.registry,
    comparison: composition.comparison,
    ceoPlanOrchestrator: composition.ceoPlans.orchestrator,
    ceoExecution: composition.ceoExecution,
    webOrigin: cliOptions.webOrigin,
    limits: DEFAULT_LIMITS,
    storageMode: db !== undefined ? "durable" : "in-memory",
    recoverySummary,
    readiness,
  });

  // `cliOptions.port` is always defined here — `resolveServerConfig` already
  // applies the CLI/persisted/built-in-default precedence (including
  // `DEFAULT_PORT` as the final fallback) before this function ever sees it.
  const port = cliOptions.port;

  try {
    await app.listen({ port, host: LOCAL_ONLY_HOST });
  } catch (error) {
    app.log.error({ err: error }, "failed to start Hall Core server");
    db?.close();
    ownershipHandle?.release();
    return EXIT_INTERNAL_ERROR;
  }

  app.log.info(
    `Hall Core is listening on http://${LOCAL_ONLY_HOST}:${String(port)} — bound to localhost only, not reachable from the network. Approved web origin: ${cliOptions.webOrigin}.`,
  );
  if (cliOptions.enableCodexTrustedLocal) {
    app.log.warn(
      "Codex trusted-local mode is enabled: if every other precondition passes, Codex will run with this operator's own filesystem permissions and Codex's internal sandbox/approval protections will be bypassed for its tasks.",
    );
  }
  if (comparisonRoot !== undefined) {
    app.log.info(`Multi-agent comparison is enabled. Comparison root: ${comparisonRoot}`);
  }

  let resolveExitCode!: (code: number) => void;
  const exitCodePromise = new Promise<number>((resolve) => {
    resolveExitCode = resolve;
  });

  // Phase 13.2 — shared by both shutdown triggers: an operator-initiated
  // graceful shutdown (SIGINT/SIGTERM/stdin) and an involuntary one
  // triggered by the ownership-fence monitor below noticing this instance
  // has been displaced. Both run the identical sequence; only the exit
  // code and log message differ. `shuttingDown` guards against either
  // trigger firing twice or the two racing each other.
  let shuttingDown = false;
  const runControlledShutdown = (exitCode: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    readiness.ready = false;
    fenceMonitorHandle?.stop();
    void (async () => {
      try {
        // Phase 15.3 — cancels the retry-due wake timer, if armed, so a
        // pending `setTimeout` never holds the process open past this
        // controlled shutdown.
        composition.ceoExecution.scheduler.stop();
        await composition.orchestrator.shutdown(SHUTDOWN_TIMEOUT_MS);
        // Deliberately does NOT call `cleanupComparison` for every
        // comparison here: shutdown aborts active runs and preserves
        // worktrees for manual reconciliation on the next start, exactly
        // like `ComparisonOrchestrator.shutdown()`'s own doc comment
        // describes — it is not the same operation as an operator's
        // explicit `DELETE`.
        await composition.comparison?.comparisonOrchestrator.shutdown(SHUTDOWN_TIMEOUT_MS);
        await app.close();
        // Marks this boot's shutdown clean only once every active run has
        // been given the chance to settle and the HTTP server itself has
        // stopped accepting requests — the next startup's recovery reads
        // this to distinguish a graceful exit from a crash (see
        // `reconcile-tasks.ts`'s doc comment: this marker is diagnostic
        // only, never itself the gate for whether reconciliation runs).
        // On the ownership-loss path this write is itself fenced (see
        // `boot-repository.ts`) and simply throws `OwnershipLostError`,
        // caught below exactly like any other failure to record it — a
        // displaced instance can never write a clean-shutdown marker under
        // its lost epoch (kickoff §3).
        if (db !== undefined) {
          try {
            recordCleanShutdown(db, bootId, new Date().toISOString());
          } catch (error) {
            // Best-effort: a failure to write the marker must not prevent
            // shutdown from completing — the next startup simply treats
            // this boot as unclean (safe default) and reconciles
            // accordingly, exactly as it would after a real crash.
            app.log.warn(
              { err: error },
              "failed to record clean-shutdown marker; next startup will treat this boot as unclean",
            );
          }
          db.close();
          ownershipHandle?.release();
        }
      } finally {
        resolveExitCode(exitCode);
      }
    })();
  };

  // Started only once the app exists (this monitor's shutdown path needs
  // `app`/`composition`, both of which are only available by this point) —
  // a purely proactive, best-effort layer on top of the authoritative
  // per-transaction fence every durable write already goes through; see
  // `ownership-fence-monitor.ts`'s doc comment for why a brief window with
  // no monitor running yet (during recovery, above) is safe.
  let fenceMonitorHandle: OwnershipFenceMonitorHandle | undefined;
  if (db !== undefined && ownershipFence !== undefined) {
    const fence = ownershipFence;
    fenceMonitorHandle = startOwnershipFenceMonitor({
      db,
      fence,
      onOwnershipLost: () => {
        app.log.error(
          "Durable ownership has been superseded by another Hall Core instance; beginning controlled shutdown.",
        );
        runControlledShutdown(EXIT_OWNERSHIP_LOST);
      },
    });
  }

  const signalHandle = installShutdownSignals({
    onGracefulShutdown: () => {
      app.log.info("Received interrupt/terminate signal; shutting down gracefully...");
      runControlledShutdown(0);
    },
    onForceExit: () => {
      app.log.warn("Received a second interrupt/terminate signal; forcing exit.");
      process.exit(EXIT_FORCED_SHUTDOWN);
    },
  });

  const exitCode = await exitCodePromise;
  signalHandle.uninstall();
  return exitCode;
}

function isMainModule(): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) return false;
  return import.meta.url === pathToFileURL(entryArg).href;
}

if (isMainModule()) {
  runServer(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(formatError(error));
      process.exitCode = EXIT_INTERNAL_ERROR;
    });
}
