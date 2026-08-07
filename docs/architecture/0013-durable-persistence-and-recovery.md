# 0013 — Durable State Persistence and Restart Recovery

Status: Phase 13, Phase 13.1 — Durable Browser Restart, Process-Test Reliability and
Single-Instance Ownership — and Phase 13.2 — Durable Ownership Fencing and Full Comparison Restart
Verification — are all complete. Phase 16.5 (merged, including its post-merge hardening — see
"Agent-worktree reconciliation (Phase 16.5)" below) extends this document's restart-recovery
pipeline with a fourth reconciliation pass, alongside task and comparison reconciliation, for
Hall-owned isolated agent worktrees and their execution artifacts. Phase 16.6 (explicitly authorized
real Codex smoke verification and exact sandbox-equivalence proof) has not been started. Phase 13.1
closed three verification gaps the original Phase 13
report disclosed rather than papering over: it added exclusive single-instance ownership of a
durable `--data-dir` (this document did not previously claim, and the architecture did not
previously provide, any protection against two Hall Core processes sharing one database — see
"Durable single-instance ownership" below), replaced the production-binary crash test's silent
`describe.skipIf` with a dedicated `process-tests/` directory and a mandatory
`pnpm verify:process-recovery` command that cannot silently skip, and added a genuine
browser-driven Playwright durable-restart spec (`apps/e2e/tests/durable-restart.spec.ts`) after
determining the original "fight Playwright's shared server lifecycle" concern could be resolved by
giving the spec its own dedicated Hall Core and Hall Web processes rather than reusing the shared
fixture pair. Phase 13.1's own filesystem lock, however, only answered "who may _start_" — it did
nothing to stop an already-running instance that merely _freezes_ (rather than crashes) from
resuming and committing a write after a legitimate takeover. Phase 13.2 closes that gap with a
second, independent layer — a database-level ownership epoch checked inside every durable
transaction — and separately proves a full multi-agent comparison can be genuinely restarted and
continued (candidate B started via a real UI click, not a REST-call substitute) across a durable
restart. See "Database ownership fencing (Phase 13.2)" below. Builds on
[`0004-hall-core-server.md`](0004-hall-core-server.md) (`TaskStore`/`EventStore`, the "Why
persistence is deferred" section this phase resolves), [`0006-kanban-board.md`](0006-kanban-board.md)
and [`0007-communication-boards.md`](0007-communication-boards.md) (the other in-memory stores this
phase adds a durable sibling for), and [`0012-controlled-agent-comparison.md`](0012-controlled-agent-comparison.md)
(the comparison feature's `ComparisonStore`/candidate worktrees, also covered). Read those first.

## Why this phase exists

Every prior phase's state — tasks, normalized events, communication boards and messages,
multi-agent comparisons — lived only in process memory. A Hall Core restart, whether deliberate or a
crash, silently discarded everything. This was an explicit, accepted prototype limitation through
Phase 12, not an oversight (see `0004-hall-core-server.md`, "Why persistence is deferred"). Phase 13
resolves it, but narrowly: an operator who wants Hall Core to survive a restart can opt in
(`--data-dir`); every existing ephemeral (in-memory) test and startup path remains byte-identical to
before. This is purely additive — no domain semantics changed, no automatic provider resume/retry
was introduced, and no new browser-reachable capability was added.

## What this phase deliberately does not do

- No change to domain semantics. `TaskStatus`, `ComparisonStatus`, event ordering rules, capacity
  limits — none of it changed. Durable mode changes only where state is written, never what is
  allowed to happen to it.
- No automatic resume or retry of a real provider run after a restart. A run an unclean shutdown
  left non-terminal is marked `failed` with a synthetic interrupted-run event — never silently
  restarted, never retried, regardless of how close to completion it may have been.
- No cloud database, no external database server, no ORM. `node:sqlite`'s `DatabaseSync` only, one
  file per `--data-dir`, one process at a time.
- No encryption at rest, no multi-process/clustered access to the same database file, no online
  schema migration UI — a version mismatch the running code doesn't know how to migrate fails
  closed at startup rather than guessing.
- No automatic backup, export, or import tooling.
- No change to what a client can request over HTTP/WebSocket. Durability is entirely a
  server-composition-time decision (`--data-dir` present or not); no request body field, query
  parameter, or response field lets a client choose or discover the underlying file path.
- No real Claude Code or Codex execution and no provider subscription usage anywhere in this phase's
  own development or testing — every test uses Mock Agent or a fixture adapter whose `startTask()`
  rejects unconditionally.

## Architecture — the storage-port pattern

Every store (`TaskStore`, `EventStore`, `BoardStore`, `MessageStore`, `ComparisonStore`) already had
a stable public method surface. Phase 13 does not modify any of those classes' bodies. Instead:

1. A port interface (`TaskStorePort`, `NormalizedEventStorePort`, `BoardStorePort`,
   `MessageStorePort`, `ComparisonStorePort`) is declared matching each store's existing public
   shape exactly, and the existing class gains an `implements` clause.
2. A SQLite-backed sibling class is added per store (`SqliteTaskStore`, `SqliteEventStore`,
   `SqliteBoardStore`, `SqliteMessageStore`, `SqliteComparisonStore`), implementing the same port.
3. Every consumer that previously received a store by its concrete class type — `TaskOrchestrator`,
   `ComparisonOrchestrator`, every route's `Deps` interface, `app.ts`, both composition roots — was
   widened to accept the port interface instead. This was a large but entirely mechanical, type-only
   change across roughly fifteen files: TypeScript's native `#private` class fields make two
   structurally-identical classes nominally incompatible, so `SqliteTaskStore` could not otherwise
   satisfy a parameter typed as the concrete `TaskStore` class. No existing test that does
   `new TaskStore(...)` needed to change.
4. Composition (`server-composition.ts` / `comparison-composition-root.ts`) picks which concrete
   class to construct based solely on whether a `db: HallDatabase | undefined` was supplied.

This directly reproduces the design 0012 already used for `ComparisonStore` vs. `TaskStore` (two
structurally similar but independent revision mechanisms) — Phase 13 is that same pattern applied
once per store, plus one new port per store, not a shared base class or generic persistence
abstraction. Domain services never import `node:sqlite` directly; `HallDatabase`
(`persistence/database.ts`) is the one class in the package allowed to.

## The persistence module — `apps/server/src/persistence/`

Pure SQLite plumbing, no domain knowledge:

- **`database.ts`** — `HallDatabase`, a thin wrapper around `node:sqlite`'s `DatabaseSync`. Opens
  with `PRAGMA foreign_keys = ON` and a bounded `PRAGMA busy_timeout`; extension loading is never
  enabled (the module's own default). `open()` for a real on-disk file under `--data-dir`
  (`hall-core.db`), `openInMemory()` for tests that need real SQLite semantics without touching
  disk. `close()` is idempotent. One connection per Hall Core process — `node:sqlite` is
  synchronous, so every query already runs on the main thread without a connection pool to manage.
- **`transaction.ts`** — `withTransaction(db, fn)`: `BEGIN IMMEDIATE` / `fn()` / `COMMIT`, rolling
  back and rethrowing on any error. Kept short-lived — no `await` ever happens inside a transaction,
  since `node:sqlite` is synchronous and holding a write lock across an `await` would block every
  other caller in the same process for no reason.
- **`migrations.ts`** — an ordered array of `{version, description, up(db)}`. Migration 1 is the
  complete Phase 13 schema: `tasks`, `task_working_directories`, `events` (shared by task and
  comparison-candidate streams, discriminated by a `stream_kind` column), `boards`, `messages`,
  `comparisons`, `comparison_candidates`, `comparison_internal_paths`,
  `comparison_candidate_worktrees`, `server_metadata`, `boots`, `schema_migrations`. Every
  private/internal-only column (working directories, resolved source-repository paths, candidate
  worktree paths) lives in its own table, never as a column on a public-facing table — a structural
  guarantee, not a convention, since the repository queries that build a public `TaskRecord`/
  `AgentComparisonRecord` never join against those tables at all. Migration 2 adds the durable
  ownership fence (Phase 13.2, below); migration 3 adds the CEO plan control plane
  (`ceo_plans`/`ceo_plan_versions`/`ceo_approvals`/`ceo_delegation_links`, Phase 14 — see
  [`0014-ceo-planning-approval-and-delegation.md`](0014-ceo-planning-approval-and-delegation.md));
  migration 4 adds `ceo_plans.last_progress_fingerprint` (nullable `TEXT`), the idempotency guard
  behind Phase 14.1's event-driven progress synchronizer — see `0014`'s "Progress synchronization"
  section; migration 9 (Phase 16.5) adds nullable `agent_worktrees.adapter_id`/`agent_id` columns —
  see "Agent-worktree reconciliation (Phase 16.5)" below for why they exist and why they are
  nullable.
- **`migration-runner.ts`** — reads `schema_migrations`' recorded max version, applies whichever
  migrations are missing, one transaction per migration, recording the version row only on success.
  Fails closed (`UnsupportedSchemaVersionError`) if the database's recorded version exceeds the highest
  version this build of Hall Core knows about — a newer Hall Core writing to a database, followed by
  an older Hall Core binary pointed at the same `--data-dir`, refuses to start rather than silently
  operating on a schema it doesn't fully understand.
- **`persistence-errors.ts`** — a `PersistenceError` hierarchy. Every error this layer throws is
  hand-authored and bounded; none of them ever include a raw `node:sqlite` error message or a
  filesystem path in anything that could reach an HTTP response.
- **`database-config.ts`** — `resolveDataDir()`: absolute-path requirement, create-if-missing,
  `fs.realpathSync.native` canonicalization, and mutual non-containment checks against both
  `workspaceRoot` and `comparisonRoot` (in both directions) — the same symlink-safe containment
  technique `@hall-of-wisdom/hall-runner`'s `validateWorkspace` and `GitWorktreeManager`'s
  `comparisonRoot` check already use, reused directly rather than reimplemented a third time.
- One `*-repository.ts` per store (`task-repository.ts`, `task-event-repository.ts`,
  `board-repository.ts`, `board-message-repository.ts`, `comparison-repository.ts`,
  `comparison-event-repository.ts`, `server-metadata-repository.ts`, `boot-repository.ts`) — each
  owns its own prepared statements and does the row-to-domain-object mapping, re-validating every
  JSON column through its existing Zod protocol schema on every read. A row is never trusted just
  because Hall Core itself wrote it.

## Revision / optimistic concurrency

Every mutating repository method runs
`UPDATE ... SET ..., revision = revision + 1 WHERE id = ? AND revision = ?` inside a short
transaction. `StatementSync.run()`'s `changes === 0` means the revision was stale, and the
repository throws the exact same conflict error class the in-memory store already throws for the
same situation (e.g. `TaskStateConflictError`) — so `TaskOrchestrator`/`ComparisonOrchestrator`
never need to know which backend is active. There is no read-check-write gap and no second version
token that could leak into a JSON response; the check and the write are the same SQL statement.

## Events — one table, discriminated by stream kind

A single physical `events` table backs both the task event stream and the comparison-candidate
event stream, distinguished by a `stream_kind` column (`'task'` or `'comparison_candidate'`) plus
`stream_id`, with `UNIQUE(stream_kind, stream_id, sequence)`. Each `SqliteEventStore` instance is
constructed with a fixed `streamKind`, mirroring the two already-separate `EventStore`/`EventBus`
pairs composition already builds (one for tasks, one for comparison candidates) — cross-stream
contamination is structurally impossible, not just avoided by convention: the unique index itself is
scoped by `stream_kind`, not only by `stream_id`.

## Internal-only fields — never in the public port surface

Task working directories, resolved comparison source-repository paths, and candidate worktree paths
each get their own private table plus narrow accessor methods on the concrete SQLite class
(`setWorkingDirectory`/`getWorkingDirectory` on `SqliteTaskStore`, mirroring the pattern
`TaskStore` already established in Phase 12.1; `SqliteComparisonInternalPaths` for the comparison
side). None of these are returned by any port method's `get()`/`list()`, and none are touched by the
port interface's contract at all — `ComparisonInternalPathsPort` is a deliberately separate
interface (`setSourceRepositoryPath`, `deleteSourceRepositoryPath`, `setWorktreePath`,
`deleteWorktreePath`, `listAll()`), never folded into `ComparisonStorePort`.

**Why `ComparisonOrchestrator` needs an explicit rehydration step.** `ComparisonOrchestrator` keeps
its own in-memory sidecar maps (`#sourceRepositoryPaths`, `#worktreePaths` — see
`0012-controlled-agent-comparison.md`) for the lifetime of the process; these are never queried from
the store on every access. A fresh `ComparisonOrchestrator` instance built after a restart has empty
maps even though the underlying paths are durably persisted — persisted data alone is not sufficient
for the orchestrator to act on it. `rehydrateInternalPaths(paths)` (a new public method) restores
both maps from `restart-recovery.ts`'s output, and `server.ts` calls it once, right after
`createServerComposition` and before the recovery pass's other effects are relied upon.
`durable-restart.test.ts` proves this is load-bearing, not decorative: it demonstrates a real
`cleanupComparison` call against worktrees that are genuinely still on disk after a restart, and
shows it only succeeds at actually removing them once rehydration has run first.

## Restart recovery — `apps/server/src/recovery/`

`runRestartRecovery()` (`restart-recovery.ts`) runs once, at composition time, before `app.listen()`:

1. **Configuration fingerprint check** (`server-metadata-repository.ts`). A reused `--data-dir`'s
   recorded `workspaceRoot`/`comparisonRoot`/`agentWorktreeRoot` (canonical paths) must match this
   startup's — a mismatch fails closed with `ConfigurationFingerprintMismatchError` rather than
   silently operating on state that was written against a different filesystem layout. Recorded on
   first use; a startup that omits `--comparison-root` is still allowed even if one was previously
   recorded (comparisons are optional at every startup, durable or not) — `--agent-worktree-root` is
   stricter and may not be omitted once recorded; see "Agent-worktree-root durable fingerprint"
   under "Agent-worktree reconciliation (Phase 16.5)" below for why.
2. **Previous boot lookup** (`boot-repository.ts`). The `boots` table holds one row per process
   lifetime, in strict `rowid` order (never `started_at`, which can tie under fast restarts).
   `getPreviousBoot` determines `previousShutdown: "clean" | "unclean" | "first_start"` from
   whether the prior row has a `cleanShutdownAt` timestamp. This is the one, single, strictly
   validated vocabulary for this field everywhere it appears — protocol/schema, REST, Hall Web,
   tests, and docs — see "Durable single-instance ownership" below and Phase 13.1's report for why
   an earlier draft's `"none"` was renamed: it read ambiguously (as "no status available" rather
   than "this is genuinely the first boot"), while the UI's own display label was already "First
   startup." An unrecognized stored or transmitted value fails Zod validation rather than being
   passed through.
3. **Record this boot started.**
4. **Reconcile tasks** (`reconcile-tasks.ts`) — see "Reconciliation" below.
5. **Reconcile agent worktrees** (Phase 16.5, `reconcile-agent-worktrees.ts`) — only if a full
   bundled `{agentWorktreeStore, agentWorktreeManager, agentWorktreeRoot,
agentExecutionArtifactStore, agentExecutionArtifactTerminalizer}` input was provided (i.e.,
   isolated agent-worktree execution is composed at all this startup). Deliberately runs
   immediately after task reconciliation and before comparison reconciliation — see "Agent-worktree
   reconciliation (Phase 16.5)" below for why the ordering against step 4 specifically matters.
6. **Reconcile comparisons** (`reconcile-comparisons.ts`) — only if a full bundled
   `{comparisonStore, comparisonEventStore, comparisonInternalPaths, gitWorktreeManager}` input was
   provided (i.e., comparisons are composed at all this startup).
7. **Classify comparison worktrees + scan for orphans** (`classify-comparison-worktrees.ts`) — see
   below.
8. **Persist a bounded recovery summary** (counts only, never a path or `bootId`) and return it.

## Reconciliation — projections are caches, the event log is truth

`TaskStore.eventCount`/`lastSequence` (and the comparison-candidate equivalents) are fast-path
projections, not the authoritative record — the `events` table is. `reconcileTasks`/
`reconcileComparisons` "catch up" any stale projection at every durable startup by replaying
`taskStore.recordEventMeta()` once per event the store hadn't yet accounted for, exactly reproducing
what the normal event-handling path would have done had a crash not interrupted it partway through.

For each task/candidate with a run in progress:

- If the **last recorded event is already terminal** (`run.completed`/`run.failed`/
  `run.cancelled`) but the store's status field never caught up — the crash landed between
  `eventStore.append()` committing and the following `TaskStore.updateStatus()`/`setCompleted()`
  calls — replay just those status-side effects. This whole replay is wrapped in a `try`/`catch`: an
  `assigned -> completed` illegal transition should be structurally unreachable here (event N+1 can
  only ever be appended after event N's status commit already succeeded, within the same process
  lifetime that appended it), but an unexpected `InvalidTaskTransitionError` falls through to the
  interrupted-run path below rather than crashing startup — defense in depth around a proof, not a
  substitute for one.
- Otherwise (the last event is non-terminal, or there are zero events at all) and a `runId` is still
  set — genuinely interrupted. Synthesize exactly one terminal event
  (`HALL_RESTART_INTERRUPTED_RUN` for tasks, an equivalent pair of codes for comparison candidates —
  `RESTART_INTERRUPTED_CANDIDATE_RUN_CODE`/`RESTART_INTERRUPTED_PREPARATION_CODE` — distinguishing a
  candidate mid-execution from a comparison caught mid-`preparing`) via
  `buildInfrastructureFailureEvent`, append it, and mark the task/candidate failed. Never resume,
  never retry a real provider.

**Idempotent by construction, not by tracking "was the last shutdown unclean."** Every step is keyed
off currently-persisted state (task/candidate status, `cleanupStatus`), never off whether the
previous shutdown was unclean — so a second consecutive unclean restart is provably a no-op for
anything the first pass already reconciled. `reconcile-tasks.test.ts` and
`restart-recovery.test.ts` both call the reconciliation functions twice in a row and assert the
second pass changes nothing.

## Worktree health classification — `classify-comparison-worktrees.ts`

Each known candidate worktree path is classified into exactly one of:
`healthy | interrupted | workspace_missing | workspace_unverified | cleanup_required |
unsafe_path`. The classification result deliberately carries no path field — only
`{candidateId, comparisonId, health}` — so a recovery summary can be safely logged or exposed over
HTTP without ever leaking a filesystem path.

**A real false-positive, found and fixed during this phase's own testing, not a hypothetical.**
`git rev-parse --show-toplevel` succeeding only proves a path is _somewhere inside_ a Git repository
— it walks up the directory tree to any ancestor `.git`, it does not prove the path itself is a
worktree's own toplevel. On this development machine, the OS temp directory (where tests create
their fixture directories) happens to sit inside an ancestor Git repository, so a plain non-Git
directory was initially misclassified `healthy` instead of `workspace_unverified`. The fix requires
the resolved toplevel (canonicalized via `fs.realpathSync.native`) to exactly equal the
canonicalized worktree path itself — a genuine `git worktree add` result is always its own
toplevel, so this closes the gap without weakening the check for real worktrees.

`scanOrphanWorktrees` separately counts (never names or paths) `comparisonRoot`'s direct children
that aren't in any persisted worktree record, tolerating a missing `comparisonRoot` by returning 0
rather than throwing.

## Agent-worktree reconciliation (Phase 16.5) — `apps/server/src/recovery/reconcile-agent-worktrees.ts`

Phase 16.1–16.4 built durable Hall-owned isolated Git worktrees and immutable execution artifacts
(see [`0016-codex-worktree-execution.md`](0016-codex-worktree-execution.md)) but left their
lifecycle unsafe across a crash: a worktree interrupted mid-creation, mid-cleanup, or never cleaned
up at all simply sat there forever, and a crash between authoritative task terminalization and
artifact persistence could leave a terminal run with no artifact and no path to recover one safely.
Phase 16.5 closes both gaps with a fourth reconciliation pass, `reconcileAgentWorktrees`, composed
into `runRestartRecovery` only when isolated agent-worktree execution is actually configured this
boot (durable storage, an explicit Hall-owned worktree root, and the worktree
store/manager/artifact-store/terminalizer all present).

**Ordering matters.** This pass runs immediately after `reconcileTasks` and before comparison
reconciliation. It depends on `reconcileTasks` having already turned any genuinely mid-flight run's
event stream terminal — a synthetic `run.failed` carrying `HALL_RESTART_INTERRUPTED_RUN` — so by
the time agent-worktree reconciliation looks for "the exact terminal event for this Hall agent-run
ID," one already exists for a run that really was still running at crash time. This function never
synthesizes a terminal outcome itself; it only ever looks for one that already exists in the event
log, which is why the ordering is load-bearing rather than incidental.

**Deterministic, per-record, keyed off currently-persisted status** — the same "idempotent by
construction, not by tracking whether the previous shutdown was unclean" discipline `reconcileTasks`
already established:

- **`creating`** — treated as interrupted creation, never reused. Recorded with the stable code
  `HALL_RESTART_INTERRUPTED_WORKTREE_CREATION` (`markCreationFailed`), then handed to
  `AgentWorktreeManager.cleanupWorktree` exactly like every other cleanup path below. That one
  function already handles a worktree whose directory never got created (both path and Git
  registration absent → marked `cleaned` immediately), a worktree Git had already registered before
  the crash (`git worktree remove --force` succeeds normally), and an unregistered partial
  directory a crash left behind mid-`git worktree add` (removal fails closed with
  `cleanup_failed` — never a recursive filesystem delete as a fallback, so an unrelated leftover
  file next to a genuinely partial worktree survives).
- **`creation_failed`**, **`cleanup_pending`**, **`cleanup_failed`** — each gets exactly one
  `cleanupWorktree` attempt per boot, simply because this pass visits every persisted record once.
  A `cleanup_failed` worktree that fails again stays `cleanup_failed`, recoverable on the next
  restart — never an unbounded retry loop within one boot.
- **`ready`** — resolves the exact terminal event for this worktree's `hallAgentRunId` from the
  task's own event stream (`NormalizedEventStorePort.list(hallTaskId)`, which holds the full,
  continuous per-task stream across every retry — filtering by `event.runId` finds the exact run
  regardless of what the task's current, possibly-retried assignment now says). If no terminal
  event exists yet, or the worktree record predates Phase 16.5's immutable `adapterId`/`agentId`
  columns (a legacy row), or the event stream's own `agentId` disagrees with the identity captured
  at worktree creation, reconciliation retains the worktree and counts it as reconciliation-blocked
  — it never fabricates a terminal outcome or an identity it cannot prove. Otherwise it builds an
  `AgentExecutionTerminalSnapshot` directly from that durable evidence — deliberately NOT through
  `buildAgentExecutionTerminalSnapshot`, which validates identity against the CURRENT, possibly
  superseded `TaskRecord` and would incorrectly reject an old run's reconstruction once a newer
  retry has moved the task's live assignment on — and hands it to the same
  `AgentExecutionArtifactTerminalizer` runtime cleanup uses. That terminalizer is already
  idempotent by `hallAgentRunId`: an existing, semantically matching artifact is accepted
  (`artifactsConfirmed`); a genuine mismatch throws `AgentExecutionArtifactMismatchError`, which
  this pass treats as blocked and never deletes the worktree over; a missing artifact is
  reconstructed from real Git evidence collected through the same worktree (`artifactsRecovered`).
  Only once that succeeds does cleanup run.
- **`cleaned`** — normally a no-op. If the recorded path reappears on disk (`fs.lstatSync`
  succeeding where it should now fail) — **or** Git's own worktree registration for it reappears
  (see "Git registration reconciliation" below) — this is reported as a bounded inconsistency
  (`inconsistentCleanedDirectoryCount`/`inconsistentCleanedRegistrationCount`, counted
  independently) and nothing more: never auto-deleted, never pruned, and the record is never
  transitioned backward out of `cleaned`.

**Filesystem orphan scanning** mirrors `scanOrphanWorktrees` above: a bounded count of the owned
root's direct child directories (and, as of this hardening pass, symlink/junction entries — never
silently skipped purely because they are not an ordinary directory) not backed by any persisted
worktree record, excluding the one directory the manager itself creates and is never a worktree
(`_hall_empty_hooks` — see `agent-worktree-manager.ts`'s `canonicalizeEmptyHooksDirectory`).
Counted, never named, never touched. A missing owned root (isolation configured but nothing ever
created there yet) is a legitimate zero; a root that exists but could not be listed (permissions,
an unreadable filesystem) is instead reported through `registrationInspectionFailureCount` — never
silently folded into the same zero.

**Git registration reconciliation** (added in this hardening pass) inspects Git's own worktree
registrations, not just the filesystem, through a new read-only
`AgentWorktreeManager.listRegisteredWorktreePaths(sourceRepositoryRoot)` (the bounded Git runner,
never a second ad hoc invocation; truncated output fails closed rather than returning a partial
list). It processes each unique persisted source repository exactly once, in deterministic
(sorted) order, and only ever classifies a registration that resolves INSIDE the Hall-owned owned
root — the primary checkout, any comparison worktree, and anything else Git happens to have
registered elsewhere are read but never touched, counted, or acted on by this feature at all. A
registration under the owned root with no matching persisted record is counted as an orphan
registration (`orphanWorktreeRegistrationCount`) — never deleted, never pruned (`git worktree
prune` is never called). A source repository whose registrations could not be inspected (missing
repository, a Git failure of any kind, truncated output) contributes to
`registrationInspectionFailureCount` rather than being silently treated as "no registrations."

**Cleanup security is entirely delegated, never reimplemented here.** Every deletion this pass ever
performs goes through the pre-existing `AgentWorktreeManager.cleanupWorktree` (Phase 16.1), which
already reconstructs the expected `wt_<id>` path from the canonical owned root, rejects symlink or
junction substitution, verifies mutual root containment, verifies Git still registers the worktree,
and removes it only via `git worktree remove --force` through the bounded Git runner — never `rm
-rf`, never a directory-name pattern match, never trusting a persisted absolute path without
reconstructing and re-validating it first. This reconciliation pass decides WHETHER and WHEN to call
that function; it never decides HOW a worktree is removed.

**Runtime cleanup (the same-session mirror of this restart pass)** lives in
`TaskOrchestrator#terminalizeExecution` (`apps/server/src/tasks/task-orchestrator.ts`) and
`IsolatedAgentExecutionCoordinator#cleanupWorktree` (`apps/server/src/agent-execution/`). After an
isolated run reaches `run.completed`/`run.failed`/`run.cancelled`, the orchestrator first calls the
artifact terminalizer; only once that resolves without throwing does it request cleanup for the
exact worktree ID carried on that run's own terminal snapshot — never re-derived from the task's
current (possibly already-retried) record, so a slow old-run cleanup can never target a newer
retry's worktree. `IsolatedAgentExecutionCoordinator#cleanupWorktree` never throws back into the
orchestrator: a cleanup failure is caught, logged, and left for the next restart's reconciliation
pass — it never changes the task's already-committed terminal status, never touches the artifact,
and never affects a subsequent governed retry (each retry gets its own fresh worktree, keyed by its
own `hallAgentRunId`).

**Migration 9** adds nullable `agent_worktrees.adapter_id`/`agent_id` columns, captured once at
worktree-creation time from the same values `IsolatedAgentExecutionCoordinator.prepare()` already
has (the adapter id it was asked to isolate, and the agent id from the task's assigned identity).
They exist because `TaskRecord.adapterId`/`agentId` are mutable — a governed retry overwrites them
with the new run's identity — so they cannot be trusted to identify which adapter/agent owned an
OLDER run's worktree once a restart needs to reconstruct that run's artifact. Both columns are
nullable specifically so existing rows created before this migration keep loading (as `undefined` in
`AgentWorktreeRecord`) rather than failing closed at the schema level; reconciliation is what treats
that `undefined` as "cannot be safely reconstructed," never the migration itself.

**Recovery summary.** `RecoverySummary.agentWorktree` (`undefined` when isolated agent-worktree
execution is not composed this boot) adds bounded counts only —
`worktreesScanned`/`interruptedCreationCount`/`artifactsRecovered`/`artifactsConfirmed`/
`cleanupAttempts`/`worktreesCleaned`/`cleanupFailures`/`reconciliationBlockedCount`/
`inconsistentCleanedDirectoryCount`/`inconsistentCleanedRegistrationCount`/
`orphanWorktreeDirectoryCount`/`orphanWorktreeRegistrationCount`/
`registrationInspectionFailureCount` — persisted the same way every other `RecoverySummary` field
already is, in `boots.recovery_summary_json`. This is deliberately internal: unlike
`worktreeHealthCounts`/`orphanWorktreeCount` (the comparison-side equivalents, which `GET
/api/v1/system/storage` already curates into its response), Phase 16.5 does not add these new
fields to that route's response shape or to Hall Web's `SystemStorageResponse` schema — no new
route, endpoint field, or UI was added for this phase; the counts exist for the audit trail and for
tests, not for browser display.

**Agent-worktree-root durable fingerprint** (added in this hardening pass) extends
`checkOrRecordConfigurationFingerprint` (`server-metadata-repository.ts`, see "Restart recovery"
above) with a third scoped root, `agentWorktreeRoot`, alongside `workspaceRoot`/`comparisonRoot`.
It is deliberately stricter than `comparisonRoot`: once recorded, a later startup may not omit it
(unlike `comparisonRoot`, which may be freely dropped) — Phase 16.5 reconciliation depends on
knowing exactly where every persisted worktree lives, and silently treating "the flag was omitted"
as "isolation is now disabled" would leave real Git worktrees permanently unreconciled without an
operator ever deciding that. On a database that already has persisted `agent_worktrees` rows but no
recorded fingerprint (a legacy database, or one enabling isolation for the first time after
already creating worktrees some other way), the newly supplied root is never trusted blindly: every
persisted row's reconstructed `<root>/wt_<worktreeId>` path must exactly match its stored
`worktree_path` (case-correct per platform) before the root is recorded at all; a single mismatch
fails startup closed without recording anything. All validation for one call happens before any
write, so a `comparisonRoot` conflict can never leave a bootstrapped `agentWorktreeRoot` behind, or
vice versa.

**Legacy omitted-root rejection (post-merge Phase 16.5 hardening).** The case above — a supplied
root against pre-existing rows — was covered from the first Phase 16.5 merge. A narrower gap
remained: a database with `agent_worktrees` rows but **no** recorded root, started with the root
**omitted again**, fell through every branch of the original function untouched and booted
successfully, composing no agent-worktree manager and silently skipping reconciliation for those
rows indefinitely — the exact "isolation is now disabled" outcome the stricter-than-`comparisonRoot`
design was meant to prevent, just reached from the "never recorded" side instead of the
"recorded-then-omitted" side. `checkOrRecordConfigurationFingerprint` now checks
`hasAnyAgentWorktreeRows(db)` (a plain `SELECT 1 FROM agent_worktrees LIMIT 1` existence check —
never a path read, never a guess) whenever no root is recorded and none is supplied, and fails
closed with the same bounded `ConfigurationFingerprintMismatchError("agentWorktreeRoot")` the other
branches already use. Because this throw happens before `runRestartRecovery` does anything else, the
server never binds its port, never records a boot-ready state, and never touches a worktree or
artifact record for a startup rejected this way; supplying the exact previously-proven root on a
later startup still succeeds, exactly as it did before this fix, proven by a dedicated real-process
test (`phase-16-5-worktree-recovery.test.ts`, "legacy database ... rejects an omitted agent-worktree
root") that seeds a real row via the real built binary, confirms a second boot without the root is
refused (no health response, no new boot row, the row itself untouched), then confirms a third boot
with the correct root recovers cleanly.

**The fully missing fingerprint case (final review correction).** The check above was originally
nested inside the existing-database comparison branch alone, guarded by `storedWorkspaceRoot !==
undefined`. That left one narrower gap: a database where **no** fingerprint key had ever been
recorded — not even `workspaceRoot` — but `agent_worktrees` rows already existed (an out-of-band
insert before the fingerprint mechanism ever ran once) would take the brand-new-database bootstrap
branch instead, which never checked for existing rows at all, and would boot successfully with the
root omitted. The `hasAnyAgentWorktreeRows` check now runs once, unconditionally, before either
branch — it depends only on whether a root was ever recorded and whether one was supplied this boot,
never on whether `workspaceRoot` happens to already be recorded — so both the "recorded, then
omitted," the "never recorded, existing database," and the "never recorded anything at all" cases all
fail closed the same way, and no fingerprint write (including `workspaceRoot` itself) survives a
rejected call. A completely empty database with no worktree rows at all still bootstraps normally
with an omitted root, exactly as before. Covered by four new tests in
`server-metadata-repository.test.ts` (rejects the fully-missing case; writes nothing on rejection;
remains recoverable with the exact proven root afterward; a truly empty database still succeeds) and
a narrow real-process test (`phase-16-5-worktree-recovery.test.ts`, "completely fresh database ...
rejects an omitted agent-worktree root") that seeds a worktree row via direct migration + SQL insert
with no server ever having booted against that data directory first, then confirms a single boot
attempt is refused (exit code `2`, no boot record, no fingerprint key of any kind recorded) —
deliberately a single boot attempt, not a duplicate of the three-boot scenario above.

**Atomic fingerprint writes (post-merge Phase 16.5 hardening).** Before this hardening pass, each of
`workspaceRoot`/`comparisonRoot`/`agentWorktreeRoot`'s conditional writes went through its own
independent `withTransaction` call — validation for one logical startup call happened up front, but
the writes themselves were three separate commits. A failure between the second and third write
(a disk error, a lost connection, anything `setValue`'s underlying `INSERT ... ON CONFLICT` could
throw) could leave one key durably recorded while another silently wasn't, for the same call that was
supposed to be all-or-nothing. Both write sites in `checkOrRecordConfigurationFingerprint` (the
brand-new-database bootstrap, and the existing-database additive-write path) now wrap every `setValue`
call for that site inside one outer `withTransaction`; because `withTransaction` already supports
nested calls via `SAVEPOINT` (see "Nested transactions" — used elsewhere for CEO plan delegation), the
inner `setValue` calls participate in the same outer `BEGIN IMMEDIATE`/`COMMIT` rather than opening
their own, so a failure on any one key rolls back every key from that same call. Durable ownership
fencing is unaffected — it is still checked exactly once per logical call, on the outer transaction's
`BEGIN IMMEDIATE`, rather than once per key as before. Fault-injection tests in
`server-metadata-repository.test.ts` prove this directly: a `db.prepare` spy throws on the second (of
two) or third (of three) `INSERT INTO server_metadata` call within one logical startup call, and the
test asserts that **no** key from that call — not even the ones whose insert already ran — was left
committed.

**Strict Git worktree registration parsing (post-merge Phase 16.5 hardening).** Every registration
inspection call site — ready-worktree validation, cleanup's registration check, and restart's
orphan/reappearance scan — previously called `git worktree list --porcelain` (the plain, newline
oriented form) through its own ad hoc line filter (`line.startsWith("worktree ")`), which silently
dropped any line it didn't recognize rather than distinguishing "no more worktrees" from "output that
doesn't look like what Git normally produces." `agent-worktrees/worktree-list-parser.ts` replaces
this with one strict parser, shared by all three call sites through a single private
`#listRegisteredWorktreePathsStrict` helper on `AgentWorktreeManager`, built on Git's machine-safe
`git worktree list --porcelain -z` form: every attribute line is NUL-terminated instead of
newline-terminated, and each worktree record is terminated by one additional NUL beyond its last
attribute — a structure that survives paths containing spaces, newlines, or non-ASCII characters
without any escaping ambiguity (confirmed directly against a real Git 2.54 invocation). Never exposes
raw Git output or the parsed paths themselves in its own error messages — only the bounded failure
code.

_Empty output (final review correction)._ The parser originally treated zero-byte stdout as a
trivially valid empty registration list. That was wrong: a successful `git worktree list --porcelain
-z` invocation against any repository — even a fresh one — always reports at least one record (the
primary checkout, or a bare record for a bare repository), so genuinely empty stdout with a `0` exit
code is never legitimate proof that nothing is registered; it can only mean the parser was invoked
against something other than real `worktree list -z` output. Empty stdout now fails closed with the
same bounded `GIT_WORKTREE_LIST_MALFORMED` code as every other malformed shape, both at the direct
parser level and everywhere that flows through it: `AgentWorktreeManager.cleanupWorktree` no longer
risks reading empty output as "not registered, therefore already cleaned" for a worktree whose path
is also missing — the registration check now throws before that comparison is ever reached, so the
record is left exactly where cleanup left it, never marked `cleaned`; and restart's orphan/
reappearance scan (`inspectGitRegistrations`) counts it as a bounded inspection failure through the
same catch path it already uses for a hard Git failure or truncated output, never a silent zero.

_Complete record validation (final review correction)._ The parser originally validated only a
record's first (`worktree`) attribute and rejected duplicate registered paths — every other attribute
was accepted unconditionally, including unknown labels, duplicate `HEAD`/`branch`/`detached`
attributes, and structurally impossible combinations (a `bare` record also carrying `HEAD`, or a
non-bare record with neither `branch` nor `detached`). The parser now validates a record's complete
attribute set against the documented `git-worktree(1)` porcelain vocabulary — `HEAD <object-id>`,
`branch <ref>`, `bare`, `detached`, `locked [<reason>]`, `prunable [<reason>]` — and fails closed on
anything outside it: an attribute label that isn't one of those six is rejected rather than silently
skipped, so a future Git format addition Hall doesn't yet understand fails closed instead of silently
passing through unvalidated; no label may appear twice; `HEAD` and `branch` require a non-empty
value (`HEAD`'s value must additionally be a valid 40-character SHA-1 or 64-character SHA-256 hex
object id — never hard-coded to only one length); `bare`/`detached` must carry no value; a record must
be either a bare record (`worktree` + `bare` and nothing else — Hall has no defined semantics for
`bare` combined with anything else, including `locked`/`prunable`, since real Git never emits that
combination for a primary bare repository) or a non-bare record with `HEAD` and exactly one of
`branch`/`detached` (`locked`/`prunable` optional on top, with any reason text — including one
containing spaces, newlines, or non-ASCII characters — preserved and accepted without alteration).
Duplicate registered paths are compared with the same platform-correct, case-aware equality
(`samePath`) every other path comparison in this package uses, not raw string equality, so two
records that differ only by case on a case-insensitive filesystem (Windows, macOS) are still caught as
duplicates. This applies even when Git's own exit code is `0` — a bounded failure is reported exactly
like a hard Git failure or truncated output, never treated as "zero registrations." Covered directly
by `worktree-list-parser.test.ts` (pure parser tests, organized by valid platform-native/POSIX/
Windows-specific records and malformed byte-layout/complete-record-validation cases: branch and
detached worktrees, bare repositories, locked/prunable with and without a reason, SHA-1 and SHA-256
HEAD values, every duplicate-label and missing/conflicting-state combination, unknown attributes,
empty output, and Windows-case-variant duplicate paths gated to `win32`) and by manager-level tests in
`agent-worktree-manager.test.ts` (real multi-worktree Git output including spaces and non-ASCII
paths, truncated output, exit-code-zero malformed output, exit-code-zero empty output, and cleanup's
missing-path-plus-empty-output case) and `reconcile-agent-worktrees.test.ts` (malformed and empty
output both increment `registrationInspectionFailureCount` rather than `orphanWorktreeRegistrationCount`
staying at zero).

_Cross-platform test coverage (final review correction)._ The parser's own tests previously
hard-coded Windows-style paths (`C:\repo`) in every "valid" case, which would fail on POSIX because
`path.isAbsolute`/`path.resolve` are the current platform's `node:path` — a Windows-style backslash
path is not absolute on Linux or macOS. Generic "valid record" tests now build paths with
`path.resolve(path.sep, ...)`, which resolves to a real absolute path on whichever platform the test
actually runs on (`/repo` on POSIX, `D:\repo` — or whichever drive — on Windows), so the same test
body exercises real platform-native path validation everywhere. `it.runIf(process.platform ===
"win32")` and `it.runIf(process.platform !== "win32")` gate the handful of cases that are genuinely
platform-specific by construction: a literal drive-letter path, and the Windows-case-insensitive
duplicate-path check (POSIX filesystems are case-sensitive by default, so the same input would not be
a duplicate there). This correction was scoped to the parser and the parser-adjacent manager tests
added by this hotfix; it deliberately does not touch the pre-existing `agentWorktreeRoot` fingerprint
tests above, which compare fingerprint strings directly (`assertAgentWorktreeRootIdentity`/
`hasAnyAgentWorktreeRows` never call `path.isAbsolute`) and predate this hotfix's own work — a
separate, pre-existing platform limitation of the base Phase 16.5 merge, out of scope here.

Phase 16.6 (explicitly authorized real Codex smoke verification and exact sandbox-equivalence
proof) is unaffected by and unrelated to this phase, and has not been started.

## CLI — `--data-dir`

Added to `server-cli-args.ts` exactly mirroring `--comparison-root`'s existing optional-string
pattern. `server.ts` performs the actual filesystem work: `resolveDataDir()` (absolute, create if
missing, canonicalize, mutual non-containment against both `workspaceRoot` and `comparisonRoot`) —
a nested or ancestor relationship among any of the three roots fails startup with exit code 2 before
a port is ever bound, verified by `server.test.ts`.

## Durable single-instance ownership (Phase 13.1) — `apps/server/src/persistence/instance-ownership.ts`

**The gap, found by direct empirical testing, not assumed.** Before Phase 13.1, nothing prevented
two Hall Core processes from opening the same `--data-dir` at once. A throwaway script opening two
`node:sqlite` `DatabaseSync` handles against the same file confirmed both succeed with zero error;
only an actually-conflicting write transaction (`BEGIN IMMEDIATE` from the second handle while the
first holds one) throws — and only once both processes are already mutating state. There is no
startup-time exclusivity of any kind from SQLite alone: two concurrent processes would both run
migrations (idempotent, so survivable) and both run restart recovery, both write a boot row, and
both serve requests, with revisions/sequences merely serialized ad hoc by SQLite's own locking
rather than one instance being cleanly rejected.

**The mechanism**: a single fixed-name lock file (`hall-core.lock`) directly under the canonical
`dataDir` — never a second lock layered on top of SQLite's own locking, never a client-reachable
path (this module has no HTTP entry point). Acquired via an atomic create (`wx` — fails with
`EEXIST` if the file exists) containing a fresh random `token`, this process's `pid`/`hostname`/
`execPath`, and an `acquiredAt`/`heartbeatAt` timestamp pair. While held, `heartbeatAt` is refreshed
every 2 seconds (default) via a create-temp-file-then-atomic-rename pattern — the same pattern used
for a **stale takeover**: write a fresh record to a uniquely-named temp file, `fs.renameSync` it
over the lock file (atomic replace on both POSIX and Windows), then immediately read the lock file
back and confirm it holds _this_ attempt's token — if a concurrent competitor's takeover landed
first, the readback reveals their token instead, and this process fails closed rather than assuming
it won. This closes the two-concurrent-stale-takeover race using only the filesystem's own atomic
rename, no cross-process coordination.

**Staleness is heartbeat-only, deliberately** (default `staleAfterMs`: 20 seconds — ten heartbeat
intervals). A liveness probe (`process.kill(pid, 0)`) exists and is consulted for the rejection
diagnostic's wording, but never gates the staleness _decision_ itself — only `heartbeatAt`'s age
does. This is a deliberate response to a real failure mode of PID-based liveness alone: if a
crashed process's PID happens to be reassigned by the OS to some unrelated, currently-running
program before a new Hall Core instance starts, a PID-liveness check would report "alive" forever,
permanently bricking the data directory (violating the explicit requirement that a crashed owner
must not do that) — a stale heartbeat is immune to this because only the genuine, running Hall Core
process was ever writing it. **Disclosed limitation, not hidden**: this scheme cannot distinguish
"the original owner is still alive but has been frozen/suspended longer than `staleAfterMs`" from
"the original owner crashed" — both present identically (a stale heartbeat), and both are treated
as safe to take over. This is the same tradeoff every heartbeat/lease-based ownership scheme makes
(Kubernetes leader election, etcd leases); the alternative — never allowing takeover without an
unambiguous liveness signal — is exactly what would let one crashed process brick the directory
forever. **This ambiguity itself is not resolved by Phase 13.2 below, and does not need to be**: what
Phase 13.2 closes is the _consequence_ — if the "frozen" half of this ambiguity turns out to be true
and the original owner resumes, it is now structurally incapable of committing any durable mutation,
regardless of what its own filesystem-lock state believes. See "Database ownership fencing (Phase
13.2)," directly below.

**Malformed or unreadable lock content is never treated as evidence of anything** — Zod-validated
on every read; a parse or shape failure fails closed exactly like an unconfirmed live owner, never
attempting a takeover. **`release()` never removes a lock a later instance has since taken over** —
it re-reads and checks the token matches its own before deleting, is idempotent, and never throws.
Ownership metadata (the lock file's own JSON content, the `dataDir` path, the lock file path) is
never exposed in any HTTP response, any CLI diagnostic string, or any log line a route could ever
forward — `InstanceOwnershipConflictError`'s message is a small, fixed set of generic reasons,
verified by a dedicated test to never contain the data directory path.

**Acquired before `HallDatabase.open()`** (before migrations, before any database mutation) and
held for the database's entire lifetime; released only after `db.close()` on a graceful shutdown,
or from every startup-failure `catch` block (a partially-completed startup — e.g. ownership
acquired but the database file turns out to be corrupt — releases the lock before returning a
non-zero exit code, verified by `server.test.ts`, so a single failed attempt can never leave a
dangling lock blocking every subsequent legitimate start).

**Windows compatibility, verified empirically, not assumed**: `fs.writeFileSync(path, content,
{flag: "wx"})`, `fs.renameSync`, `fs.readFileSync`, `fs.unlinkSync`, `process.kill(pid, 0)`,
`crypto.randomUUID()` — all built-in Node primitives with well-defined, consistent cross-platform
behavior; zero new dependencies, native or otherwise.

## Database ownership fencing (Phase 13.2) — `apps/server/src/persistence/transaction.ts`

**The gap Phase 13.1's filesystem lock alone cannot close.** The lock in the previous section
answers "who may _start_" — it says nothing about a process that is already running. Concretely:
Instance A owns `dataDir` and is heartbeating normally → A's event loop is frozen (a debugger
breakpoint, a STOP signal, a paused hypervisor — precisely the "disclosed limitation" the previous
section names) for longer than `staleAfterMs` → Instance B legitimately takes over, since A's
heartbeat has genuinely gone stale → A resumes execution, with no idea it has been displaced, and
attempts to commit a mutation through the SQLite connection it has held open the entire time. A
startup-time lock cannot prevent this — A never tried to _start_ again, it just kept running. Phase
13.2 closes this with a second, independent layer: a database-level fencing token, checked inside
every durable write.

**The fence: `durable_ownership`, a single-row table** (migration 2 — `id` is always `1`, enforced
by a `CHECK`), holding `owner_token` (opaque, random) and a monotonically increasing `epoch`.
`acquireDatabaseEpoch(db, ownerToken)` (`persistence/database-ownership-fence.ts`) reads the current
epoch (if any), writes `{ownerToken, epoch: current + 1}`, and returns it — called once at startup,
_after_ the filesystem lock and `runMigrations`, via `openDurableStorage`
(`persistence/durable-startup.ts`), the one function every durable entry point calls for this whole
sequence (see "One fenced transaction boundary" below for why sharing code matters here
specifically). `acquired_at`/`heartbeat_at` are diagnostic only — the filesystem lock's own
heartbeat remains the sole staleness authority; this table never becomes a second, competing
staleness mechanism.

**Every transaction re-verifies the fence, inside its own transaction.** `withTransaction`
(`persistence/transaction.ts`) is already "the one place transaction boundaries are drawn for the
whole persistence layer" (Phase 13's own framing) — Phase 13.2 adds exactly one thing to it: once
`HallDatabase.setOwnershipFence(fence)` has been called (right after `acquireDatabaseEpoch`, before
recovery — so recovery's own writes are fenced too), every subsequent `withTransaction(db, fn)` call
re-reads `durable_ownership` immediately after `BEGIN IMMEDIATE` and confirms it still matches this
process's `{ownerToken, epoch}` _before_ `fn` runs. A mismatch throws `OwnershipLostError`, which the
function's existing `catch` rolls back and rethrows exactly like any other failure — `fn` never
executes, nothing is written, and (because every mutation-then-publish call site in this codebase
already does the publish strictly _after_ a successful `withTransaction` — the same
"persistence-before-publication" invariant Phase 13 established) no event is ever published and no
in-memory projection is ever touched for a rejected mutation. Migrations and the epoch-acquisition
transaction itself run _before_ the fence is set, so they are correctly unfenced — there is nothing
to check against yet, since they are what creates the fence. Read-only queries are **never** fenced
by design: a displaced instance may keep serving briefly-stale reads harmlessly (they cannot write
regardless), and fencing reads would add real complexity for no safety benefit.

Because `BEGIN IMMEDIATE` acquires SQLite's write lock up front, the fence check and the mutation
that follows it are atomic with respect to any other writer — including a legitimate new owner's own
epoch-bump transaction. A frozen A's resumed `BEGIN IMMEDIATE` either runs _before_ B's epoch bump
(A's own epoch still matches — this is the ordinary, correct, no-conflict case) or _after_ it (A's
read now sees B's epoch, rejects, rolls back) — there is no gap in which A's write could land between
B's takeover and A's next check.

**One fenced transaction boundary, not per-repository checks — audited, not assumed.** The kickoff
for this phase was explicit that fencing must live in exactly one shared function. A grep audit of
every mutating call (`.run(` on an INSERT/UPDATE/DELETE) across `apps/server/src` — the actual
acceptance criterion, not the unit tests alone — found four files issuing raw, unwrapped
`db.prepare(...).run(...)` calls with no `withTransaction` at all: `boot-repository.ts`,
`server-metadata-repository.ts`, `boards/sqlite-board-store.ts`, and
`comparisons/sqlite-comparison-internal-paths.ts`. All four were converted to route every mutation
through `withTransaction`. The same audit also caught a fifth, easy-to-miss gap already inside a
file that otherwise used `withTransaction` correctly: `SqliteTaskStore.setWorkingDirectory` (a
single-statement, easy-to-overlook write to a private internal-paths table) bypassed it entirely.
Fixed the same way. After these fixes, every durable mutation in the codebase — tasks, task events,
boards, board messages, comparisons, comparison candidates, candidate events, comparison internal
paths (source-repository and worktree paths), boot/shutdown records, and recovery summaries — is
fenced through this one function.

**Heartbeat renewal cannot overwrite another owner's record — a real bug found and fixed, not just a
requirement satisfied on paper.** Phase 13.1's filesystem-lock heartbeat _unconditionally_ overwrote
`hall-core.lock` with its own record on every tick. Tracing the frozen-then-resumed scenario through
that code: if A's heartbeat timer has a tick still pending when A resumes (exactly the scenario this
phase is about), that tick fires and blindly renames its own fresh record over the lock file —
resurrecting A's filesystem ownership _over_ B's legitimate one, even though the database fence
already correctly rejects A's writes. Worse, this chains directly into `release()`: if A's resumed
shutdown later calls `release()`, it now reads back its _own_, just-resurrected token and deletes
B's lock — exactly "a displaced instance must never delete the replacement owner's lock," violated
via a side door. Fixed in `instance-ownership.ts`'s heartbeat tick: it now reads the current lock
record _before_ writing; a confirmed (successfully-read, schema-valid), _different_ token stops the
timer and logs a diagnostic (no path, no token) instead of overwriting — an ambiguous read (missing
or malformed) is treated as transient and still retries next tick, so a filesystem hiccup can never
falsely trigger this. Covered by a dependency-injected regression test in
`instance-ownership.test.ts` using the same fake-filesystem/fake-clock harness Phase 13.1 already
built.

**Proactive detection layered on top — never the safety guarantee itself.**
`ownership-fence-monitor.ts`'s `startOwnershipFenceMonitor` polls `durable_ownership` every 2
seconds and, on a confirmed mismatch, calls `onOwnershipLost` exactly once. This exists purely so a
displaced instance notices and begins controlled shutdown sooner than "the next time it happens to
attempt a write" — the per-transaction fence above is what actually guarantees correctness
regardless of whether this monitor is running at all. `server.ts`/`fixture-server.ts` wire
`onOwnershipLost` to the same `runControlledShutdown` function a graceful SIGINT/SIGTERM/stdin
shutdown uses (a `shuttingDown` guard makes both triggers idempotent against each other), with a
distinct exit code (`EXIT_OWNERSHIP_LOST`) purely for operator log diagnosability.

**Controlled shutdown flips readiness to not-ready _immediately_, before anything else.**
`readiness.ready = false` is the first line of `runControlledShutdown` — before
`orchestrator.shutdown(SHUTDOWN_TIMEOUT_MS)`, before `comparisonOrchestrator.shutdown(...)`, before
`app.close()`. `GET /api/v1/health` (`routes/health.ts`) checks a shared, mutable `readiness` ref on
every request and returns `503`/`{"status":"not_ready"}` once it is flipped — for the entire
shutdown sequence, which can run for several seconds (bounded by `SHUTDOWN_TIMEOUT_MS`, 5 seconds,
times two orchestrators), not merely in the instant before the process exits. This closes an
otherwise-real window: without it, a load balancer or health-checking harness polling `/health`
during a multi-second shutdown would see `200`/`"ok"` and keep routing writes to an instance that
already rejects every one of them. `readiness` is an optional field on `CreateHallCoreAppOptions`
(`undefined` — every pre-Phase-13.2 caller and test — means always-ready, byte-identical to before).
A mutation that reaches a route despite this (a request already in flight when the flip happens) is
mapped by the central error handler (`errors/error-handler.ts`) to a dedicated `503`/
`"OWNERSHIP_LOST"` response rather than falling through to a generic, unmapped `500`.

**Deliberately not added: a public `active`/`ownership_lost`/`unavailable` storage-status enum.**
Considered per this phase's kickoff. `GET /api/v1/health`'s not-ready flip already covers the actual
operational need (stop routing new work to a displaced instance); a second, separate public enum on
`GET /api/v1/system/storage` would add API surface for little marginal benefit beyond what the
health check already signals. As always: owner token, epoch, and every other internal fencing field
never reach any HTTP response, WebSocket message, or CLI diagnostic — verified the same way every
other internal-only field in this codebase is (dedicated tests asserting the fields are simply never
present in a public shape).

**Frozen-owner proof — a real child process, not a simulation.** Kickoff §6 explicitly required
proving this against a _frozen_, not merely _crashed_, instance — a `SIGKILL`led process's
connection is gone along with the process, which cannot demonstrate "a still-open original
connection resumes and is rejected." `apps/server/src/process-tests/frozen-owner-child.ts` is a
small, test-only, interactive child process (ships in `dist/process-tests/` alongside the existing
`process-test-support.ts`, never imported by any production path, never reachable via a CLI flag)
that acquires ownership and stays alive, listening on stdin for commands
(`PAUSE-HEARTBEAT`/`MUTATE`/`RELEASE-ATTEMPT`/`EXIT`) so a test can freeze it, let a real second
instance (the actual `dist/server.js` production binary) legitimately take over after real
`staleAfterMs` elapses, then command the _original, still-open_ connection to attempt a write. See
"Testing" below for the full proof this enables.

**`withTransaction` is reentrant — a nested call becomes a `SAVEPOINT`, not a second top-level
transaction.** This is what lets Phase 14's delegation atomic unit span four stores whose
individual repositories each already call `withTransaction` internally: the outer call opens the
real `BEGIN IMMEDIATE`/fence-check/`COMMIT`, and every nested call inside it opens/releases a named
`SAVEPOINT` instead, rolling back to that savepoint (not the whole transaction) on a nested
failure the outer call recovers from. **(Phase 14.1)** added dedicated regression coverage for this
specifically at multiple levels of nesting — `transaction.test.ts`, "nested calls": an inner
`SAVEPOINT` that succeeds is still rolled back if the outer transaction later fails; an inner
failure the outer call catches and continues past leaves no partial state from the inner attempt;
ownership loss detected at the outer boundary fails every nested `SAVEPOINT` together, not just the
outermost; no premature publication occurs from an inner `SAVEPOINT` alone; and four levels of
nesting with a failure at the innermost level leaves zero partial state at any level.

## Ownership fencing extended to CEO plan execution (Phase 15.1)

`SqliteCeoPlanRunStore` and `SqliteExecutionSignalStore` (the durable execution scheduler's own
stores) get the exact same fencing guarantee as every other table for free — because every one of
their mutating methods routes through the same `withTransaction`, they need no fencing logic of
their own. `ceo-plan-execution-ownership-fencing.test.ts` proves this directly against the
execution surface specifically (not just the generic `withTransaction` boundary above), covering
all 14 named execution-scheduler mutations a frozen instance must be unable to perform (configure/
start/pause/resume/cancel a run, insert/coalesce/claim a signal, create an attempt, update step
runtime, schedule a retry, open the circuit breaker, append an event/intervention, post a Board
message), against both ephemeral and durable backends, plus that a rejected mutation never
publishes to `PlanRunEventBus` (structurally guaranteed: the store write throws before any event
object exists to publish) and that the Board-audit dedup key a rejected attempt tried to claim is
still claimable by the legitimate new owner. The existing real-child-process frozen-owner test
(`process-tests/frozen-owner-child.ts`/`frozen-owner-restart.test.ts`, above) was extended with a
`MUTATE-EXECUTION` command exercising a genuine `SqliteCeoPlanRunStore.configureRun` call from the
same frozen connection, so the execution surface is proven fenced through a real second OS process
too, not only in-process. "Instance A cannot overwrite or remove B's lock" is proven at the
filesystem-lock layer above (`release()` never removes a lock a later instance has since taken
over) — `acquireDatabaseEpoch` is intentionally always-successful for whoever calls it (required
for legitimate restart reacquisition), so there is no equivalent "cannot overwrite" guarantee at
the database-epoch layer, nor should there be.

## Startup and shutdown ordering — `server.ts`

```
parse CLI
  -> validate workspaceRoot
  -> validate comparisonRoot (if present)
  -> if --data-dir present:
       resolveDataDir()
         -> openDurableStorage():
              acquireInstanceOwnership() -> HallDatabase.open() -> runMigrations()
                -> acquireDatabaseEpoch() -> db.setOwnershipFence()
  -> createServerComposition({ ..., db })
  -> if db present: runRestartRecovery(...) -> ComparisonOrchestrator.rehydrateInternalPaths(...)
       (now fenced, since the fence was set above, before this call)
  -> createHallCoreApp({ ..., storageMode, recoverySummary, readiness })
  -> app.listen()
  -> if db present: startOwnershipFenceMonitor({ onOwnershipLost: runControlledShutdown })
```

`openDurableStorage` (`persistence/durable-startup.ts`) is the one function that performs the whole
fs-lock-then-database-then-epoch sequence — every durable Hall Core entry point calls it, including
the E2E dual-fixture composition (see "Testing" below), so there is exactly one implementation of
this sequence to ever verify, never a parallel copy that could silently drift from what production
actually does.

`runControlledShutdown` is shared by both shutdown triggers — an operator-initiated graceful
shutdown (SIGINT/SIGTERM, or — Phase 13.1 — a `"SHUTDOWN\n"` line on stdin; see "Graceful shutdown
from a spawned child process" below) and an involuntary one triggered by the ownership-fence monitor
above noticing this instance has been displaced. Both run the identical sequence, differing only in
exit code: `readiness.ready = false` (immediately — see "Database ownership fencing" above) ->
`fenceMonitorHandle.stop()` -> `orchestrator.shutdown()` -> `comparison.shutdown()` -> `app.close()`
-> (if durable) `recordCleanShutdown(db, bootId, timestamp)` — itself wrapped in its own `try`/`catch`
so a marker-write failure can never produce an unhandled rejection during shutdown, and (Phase
13.2) itself a fenced write: a displaced instance's attempt to write this marker is rejected by the
exact same mechanism as any other mutation, structurally guaranteeing it can never mark its own
unclean boot "clean" under a lost epoch — `db.close()` -> `ownershipHandle.release()`. The
clean-shutdown marker is the one and only signal `getPreviousBoot` uses to report
`previousShutdown: "clean"` on the next boot — anything that skips it (a hard kill, a crash, a
rejected fenced write, an unhandled exception before this line runs) is reported `"unclean"`.

## Graceful shutdown from a spawned child process (Phase 13.1)

`ChildProcess.kill()` on Windows is documented — and was independently re-confirmed by direct
experiment while building Phase 13.1's Playwright spec — to terminate the child forcefully
regardless of the signal name passed. Three approaches were tried against a minimal probe script
before concluding this: `child.kill("SIGINT")` (Node's own documented behavior: treated as SIGKILL
on Windows), `taskkill /PID <pid>` without `/F` (also does not reach a spawned Node process's own
signal handler in this environment), and `child.kill("SIGBREAK")` from a `detached: true` child in
its own process group (Node's own `child_process.kill()` implementation still forcefully terminates
regardless of the signal string given). There is no way, using only Node's built-in `child_process`
API, for a parent Node process to gracefully signal a child Node process on Windows.

`installShutdownSignals` (`apps/server/src/process/signal-shutdown.ts`) therefore also installs a
stdin-based trigger, sharing the same first-signal-graceful/second-signal-forced state SIGINT/SIGTERM
already use: a non-interactive (piped, not a TTY) stdin receiving the exact line `"SHUTDOWN"`
triggers the identical graceful-shutdown path a real SIGINT would. It is inert whenever stdin is an
interactive TTY — a real terminal's own Ctrl+C already works natively on every platform, unaffected
by this. This is not a network- or browser-reachable capability: stdin is already fully controlled
by whatever process spawned Hall Core, so this grants no capability beyond what that parent process
already had. `apps/e2e/tests/durable-restart.spec.ts` is what actually needs it — see "Testing"
below.

## `GET /api/v1/system/storage`

Modeled on the existing `health` route's "bounded, safe fields only" discipline
(`routes/system.ts`). Returns `{mode: "durable" | "in-memory", ready, schemaVersion, startedAt,
previousShutdown, recovery}` — `recovery` is a curated subset of the internal `RecoverySummary`
(counts only). `schemaVersion`, `previousShutdown`, and `recovery` are all `null` in ephemeral mode.
Never a `bootId`, never a filesystem path, never a raw error, and (Phase 13.2) never an owner token
or ownership epoch.

**Phase 13.2 — `GET /api/v1/health`'s readiness flip.** Once an instance loses durable ownership (or
is otherwise mid-controlled-shutdown), `GET /api/v1/health` returns `503`/`{"status":"not_ready"}`
immediately, for the entire shutdown sequence — see "Database ownership fencing" above. No new
public enum was added to `GET /api/v1/system/storage` itself for this — see that section for why.

## Web — `/system`

Follows the existing `/agents` page's convention exactly: a thin `page.tsx` wrapper
(`ApplicationShell` + `ServerStatus` + `StorageStatus`), a `components/system/storage-status.tsx`
component doing the data fetching through `lib/api-client.ts` + Zod-validated
`lib/api-schemas.ts` schemas, and an `ApiClientError`-safe error path that never surfaces a raw
error to the page. In-memory mode renders an explanatory notice instead of a recovery section;
durable mode renders per-metric stat cards plus worktree-health badges, only showing non-zero
counts.

## The one cross-store invariant durable mode actually guarantees

`TaskOrchestrator#handleEvent`/`ComparisonOrchestrator#handleCandidateEvent` both call
`eventStore.append()` — its own committed SQLite transaction — strictly before
`eventBus.publish()`. This is proven empirically, not just by reading the source:
`events/persistence-before-publication.test.ts` builds a real `SqliteEventStore`, subscribes to a
real `EventBus`, and for every published event asserts the event store's last row for that stream
already equals the just-published event's id at the moment the subscriber callback fires — before
the subscriber could have done anything else. This is deliberately the _only_ cross-store ordering
claim made. `TaskStore`'s projection fields (`eventCount`, status) are **not** claimed to be
committed atomically with the event write — see "Reconciliation" above for why that gap exists and
how a restart repairs it. Overclaiming cross-store atomicity here would have been the wrong
invariant to test; this suite tests the one that actually holds.

## Testing — what was covered, at which layer, and what deliberately was not

Coverage spans shared contract-test suites run against both backends (in-memory and SQLite), plus
targeted integration tests at five distinct layers, rather than one flat list of individually named
tests mechanically restating the same invariant once per store:

1. **Pure module tests** — `reconcile-tasks.test.ts`, `reconcile-comparisons.test.ts`,
   `classify-comparison-worktrees.test.ts` (real Git), `restart-recovery.test.ts` (real on-disk
   `HallDatabase.open`/close/reopen), `server-metadata-repository.test.ts`, `boot-repository.test.ts`,
   and (Phase 13.1) `instance-ownership.test.ts` (14 dependency-injected tests: fake filesystem, fake
   clock, fake liveness probe — acquisition, contention, staleness-boundary timing, malformed-record
   safety, PID-reuse-tolerant takeover, race-safe release, independent data directories, the "never
   leaks the path in an error message" guarantee, and — Phase 13.2 — the heartbeat-resurrection
   regression test described above) — the recovery/ownership logic itself, isolated from composition.
   Phase 13.2 adds the equivalent for the database fence: `database-ownership-fence.test.ts` (epoch
   acquisition — initial owner gets epoch 1, reacquisition and takeover always get a strictly greater
   epoch, independent databases have independent sequences), `transaction.test.ts`'s new "ownership
   fencing" suite (a rejected fenced transaction throws `OwnershipLostError`, rolls back every write
   it attempted, leaves a pre-existing row's revision counter untouched, never reaches code that would
   publish an event or update a projection, and leaves the database fully usable by the legitimate new
   owner immediately afterward — proven once at the `withTransaction` level, which every repository in
   the codebase routes through, so one test proves it for every table), and
   `ownership-fence-monitor.test.ts` (fake timers: never fires while still the owner, fires exactly
   once on the first tick after displacement, `stop()` prevents any future call, a single failed tick
   never throws or false-triggers).
2. **Real composition-root restart tests** — `composition/durable-restart.test.ts` drives the actual
   `createServerComposition`/`createComparisonComposition` functions `server.ts` calls, through real
   close/reopen cycles against the same `--data-dir`: a task's terminal outcome, a communication
   board and its messages, and a comparison's worktrees (proving `rehydrateInternalPaths` is
   load-bearing, per "Internal-only fields" above).
3. **Real HTTP server tests** — `server.test.ts`'s `runServer()` boots the actual CLI entry point
   in-process against the same `--data-dir` across multiple full SIGINT-driven boot/shutdown cycles
   (real `fetch()` calls against `/api/v1/system/storage`), asserting `previousShutdown` reports
   `"first_start"` then `"clean"`; plus (Phase 13.1) dedicated ownership-lifecycle tests: the lock
   file exists exactly while a durable instance is running and is gone immediately after a graceful
   shutdown (with a fresh instance reacquiring it with no staleness wait, since it was genuinely
   released, not merely stale), and a startup failure occurring _after_ ownership was already
   acquired (a corrupt pre-existing `hall-core.db` file, forcing `HallDatabase.open`/`runMigrations`
   to throw) still releases the lock, so a subsequent legitimate start is never blocked by the failed
   attempt's leftover lock.
4. **Real OS-process tests** (`apps/server/src/process-tests/**`, run via the dedicated
   `pnpm verify:process-recovery` command — see "Process-level verification" below), each spawning
   the actual built `dist/server.js` binary as a genuine child process, never an in-process function
   call and never a synthetic `process.emit`:
   - `hard-crash-restart.test.ts` — creates and completes a task over real HTTP, `SIGKILL`s the
     process (no shutdown handler runs, so the lock file is left behind with a fresh heartbeat), then
     proves _both_ halves of the ownership-staleness contract for real: an immediate restart attempt
     is rejected (the crashed owner's lock is still fresh), and a retry loop polling every 2 seconds
     eventually succeeds once the real default `staleAfterMs` (20 seconds — the production CLI has no
     override flag, so this genuinely waits out the real default rather than a shortened test-only
     value) has elapsed, at which point `previousShutdown` reports `"unclean"`, the completed task
     survived, and no duplicate task record exists.
   - `concurrent-instance-rejected.test.ts` — the required "at least one real child-process test"
     proving ownership exclusivity while both processes are genuinely alive simultaneously: a second
     instance targeting the same `dataDir` (different port) is rejected within seconds — no
     staleness wait needed, since the first instance's heartbeat is fresh — while the first instance
     stays fully healthy and responsive throughout; direct SQLite inspection afterward confirms
     exactly one boot row and exactly one task row exist (the second instance never got far enough to
     write either), and the rejected instance's own stderr/stdout is asserted to never contain the
     data directory path or the lock file name.
   - `interrupted-run-restart.test.ts` — the one scenario the original Phase 13 report explicitly
     flagged as module/composition-level only, now closed at the process level: using the existing,
     already-legitimate `--mock-scenario cancellable --mock-step-delay-ms 5000` flags (not a new
     fixture, not a production testing backdoor), a task is confirmed genuinely `running` before the
     process is `SIGKILL`ed mid-run; after the real binary restarts (waiting out the same real
     staleness window), the task is confirmed `failed` with the `HALL_RESTART_INTERRUPTED_RUN` code
     and never `completed` — proving interrupted-run reconciliation through the actual production
     binary, not only through direct calls to `reconcileTasks`.
   - **(Phase 13.2)** `frozen-owner-restart.test.ts` — the core proof this phase's kickoff most
     emphasized, spelled out in full: `frozen-owner-child.ts` (A) acquires ownership and opens the
     database; a `MUTATE` command confirms it can genuinely write; `PAUSE-HEARTBEAT` stops its
     heartbeat without releasing ownership (frozen, not dead); the test waits out real `staleAfterMs`
     while the actual `dist/server.js` production binary (B) starts against the same `dataDir` and
     legitimately takes over; B is confirmed able to mutate via a real REST call; A — using its
     _original, never-reopened_ connection — is commanded to `MUTATE` again and the response confirms
     rejection with `OwnershipLostError`, specifically by the database fence, not any filesystem
     check; A's `RELEASE-ATTEMPT` is confirmed to leave B fully healthy afterward; direct SQLite
     inspection confirms exactly one row exists in A's own pre-displacement scratch table (its one
     legitimate write, and no more) and exactly one task row exists (B's). Every spawned process and
     port is confirmed cleaned up in `afterEach`, matching every other test in this directory. Passed
     reliably across repeated runs, both solo and alongside the other three process-level tests.

   These tests are deliberately **excluded** from the default `vitest.config.ts` (`exclude:
["src/process-tests/**"]`) and run only via a second config, `vitest.process.config.ts` (`pnpm run
test:process` in this package). A plain `pnpm test` — including on a completely fresh checkout
   that has never run `pnpm build` — never depends on `dist/` and never silently skips or fails
   because of it; each process-test file's `requireBuiltDist()` throws a clear, actionable error
   (naming the exact build command) rather than a silent `describe.skipIf`, so `pnpm --filter
@hall-of-wisdom/hall-core run test:process` run directly on a stale checkout fails loudly instead
   of passing green with untested coverage. The root `pnpm verify:process-recovery` script chains
   `pnpm --filter @hall-of-wisdom/hall-core run build` before `test:process`, so the one documented,
   required command always runs against a fresh build.

5. **Genuine browser-driven restart** — `apps/e2e/tests/durable-restart.spec.ts` (Phase 13.1),
   covering the full 38-step workflow the Phase 13.1 kickoff specified: create a deferred task with
   requirements (via the pre-existing "Simulation / testing" profile) and route-and-assign it to Mock
   Agent without starting it; post a General-board message and a task-board message; create, prepare,
   and run a comparison; record a non-binding preference; gracefully stop Hall Core through the real
   browser (Hall Web and the page stay open — see "Graceful shutdown from a spawned child process"
   above); start a second real Hall Core instance against the same `dataDir`/`workspaceRoot`/
   `comparisonRoot`; confirm Hall Web reconnects and every piece of state — task status/assignment/
   requirements, both messages (no duplicates), the comparison, candidate A's completed result, and
   the preference note — survived intact; clean up; confirm `/system` reports a clean shutdown; and
   confirm no data-directory/database/lock-file path is ever visible, at both desktop and a
   390×844 mobile viewport, with zero console errors. It spawns its own dedicated, real Hall Core
   binary and its own dedicated real Hall Web dev server (own ports, own `.next` build directory —
   see the spec's own doc comment for why two `next dev` instances can't share one project
   directory), entirely outside Playwright's shared `webServer` config, specifically so it can never
   reintroduce the `EADDRINUSE` class of bug this repository already found and fixed once for the
   shared fixture pair. Stable across repeated solo runs and repeated full-suite runs alongside the
   existing 11 specs (12/12 passing, zero port leakage, zero interference).

   **Two adaptations, found empirically while building this spec and disclosed here, not silently
   substituted**: the real production binary always registers exactly three adapters (Mock Agent,
   Claude Code, Codex) — there is no way, through the real CLI, to register a second Mock-Agent-like
   adapter whose `startTask()` deterministically completes (unlike `apps/e2e`'s own
   `fixture-server.ts`, which is explicitly never reachable through any production CLI flag). Worse,
   the real "Compare agents" dialog does not even offer Codex as a selectable option in strict mode
   (confirmed empirically — its `<option>` is disabled). So this spec's two comparison candidates are
   Mock Agent (started and completed for real, both before the restart and verified surviving it) and
   Claude Code (prepared only — pure Git worktree creation, no adapter method call at all — and never
   started, before or after the restart, so no real Claude Code process is ever spawned; its
   untouched `Prepared` state is what's verified surviving the restart instead). Cleanup requires
   every candidate to reach a terminal status, so the never-started Claude Code candidate is
   `Cancel`led (a safe, no-execution action) rather than started, solely to reach a cleanup-eligible
   state. Neither adaptation weakens what the spec actually proves about restart durability; both are
   documented in the spec's own file-level doc comment as well.

6. **(Phase 13.2) Genuine browser-driven comparison restart, both candidates genuinely started** —
   `apps/e2e/tests/dual-fixture-durable-restart.spec.ts`, additive to (never a replacement for) item
   5's production-binary spec, closing exactly the gap that spec's own doc comment discloses: this
   one uses `apps/e2e/src/fixture-server.ts`'s two comparison fixture adapters (`hall.e2e-comparison-
a`/`-b` — genuinely completing, deterministic, no network or provider usage, already used by the
   non-durable `agent-comparison.spec.ts`) so _both_ candidates can actually be started through real
   UI clicks. `fixture-server.ts` is optionally durable — controlled entirely by environment variables
   the harness sets (`HALL_CORE_E2E_DATA_DIR`/`_WORKSPACE_ROOT`/`_COMPARISON_ROOT`; never a CLI flag,
   never reachable through the production binary) — and, critically, calls the exact same
   `openDurableStorage`/`createCoreStoresComposition`/ownership-fence-monitor/`runControlledShutdown`
   sequence `server.ts` itself uses (see "Database ownership fencing" above), so this spec exercises
   the real fence end to end through a browser, not a parallel reimplementation of it. The flow:
   create a Ready source task, create a comparison against both fixture adapters, prepare, start
   candidate A and confirm it completes (event count exactly 2), confirm candidate B stays `Prepared`
   with zero events, record a preference, gracefully stop Hall Core A (Hall Web and the browser stay
   open), start Hall Core B against the same `dataDir`/`workspaceRoot`/`comparisonRoot`, confirm
   reconnection, confirm candidate A's result and the preference both survived, then **genuinely click
   Start on candidate B** — the one hard requirement this spec exists to prove, never a direct REST
   call standing in for it — confirm it completes with its own correct event count (2), confirm
   candidate A's own count is unaffected (still exactly 2 — proving the two candidates' event streams
   never crossed), clean up, confirm cleanup persists across a reload, and confirm no absolute path or
   database filename is ever visible. Spawns its own dedicated fixture Hall Core and Hall Web pair on
   their own dedicated ports, exactly like item 5's spec, for the same `EADDRINUSE`-avoidance reason.
   Passed reliably across repeated runs, both solo and alongside the full existing suite.

   **After candidate B completes**, the spec also opens both candidates' diff/evidence regions
   through the real UI (the `<details>`/`<summary>` "Show diff" disclosure each `CandidatePanel`
   already renders): confirms each candidate's own controlled file (`candidate-a-output.txt` /
   `candidate-b-output.txt`) and its own controlled content appear in its own panel and never in the
   other's; confirms candidate A's evidence — captured once right after the restart, before B was
   ever started, and again after B completed — is byte-for-byte unchanged; and confirms neither
   panel's evidence region ever contains an absolute path, `owner_token`/`epoch`/`heartbeat_at`, or
   any other diagnostic that should never reach the browser. Deliberately asserts structure (which
   file, which content, unchanged across B's run) rather than the raw diff text or its whitespace.
   Neither candidate's Start control is touched again during this verification.

   **A genuine bug found and fixed while building this spec, disclosed here**: an externally-supplied
   `workspaceRoot`/`comparisonRoot` (built from `os.tmpdir()` in the _harness's own_ process) was
   passed through to the fixture composition without canonicalization, while the git-worktree
   containment checks internally compare against `fs.realpathSync.native`-resolved paths — on this
   development machine, `os.tmpdir()` returns Windows' short (8.3) path form (`MOHAMM~1`) while Git
   itself resolves to the long form (`Mohammed Shafiq`), so a genuinely-contained worktree path failed
   containment purely from string-form mismatch, not any real escape. Fixed by canonicalizing every
   workspace/comparison root through `fs.realpathSync.native` in `fixture-server.ts` regardless of
   whether it was freshly created or externally supplied.

7. **(Phase 15.5) Genuine browser-driven CEO-execution restart, both clean and unclean** —
   `apps/e2e/tests/ceo-plan-execution-clean-restart.spec.ts` and
   `-unclean-restart.spec.ts`, applying this same dedicated-process/dedicated-port pattern to
   Phase 15's autonomous execution runs specifically (a delegated plan under autonomous execution,
   not a comparison or a plain task). `fixture-server.ts` did not previously call this phase's own
   `runRestartRecovery()` at all — `previousShutdown` was hardcoded to `"first_start"` in every
   fixture-composition boot, so nothing could prove real crash-vs-clean classification through the
   dual-fixture harness. Closed by a new opt-in env var, `HALL_CORE_E2E_ENABLE_RESTART_RECOVERY=1`
   (never a CLI flag, never reachable through the production binary, matching every other
   `fixture-server.ts` env-gated behavior described above): when set, the fixture composition calls
   the exact same `runRestartRecovery()` production uses, strictly before
   `reconcileAllPlanProgress()`, matching `server.ts`'s own ordering. Left unset (the default), every
   other existing fixture-based spec keeps its prior, unaffected behavior. See
   `docs/architecture/0015-autonomous-plan-execution-and-scheduling.md`'s "Known Phase-15
   limitations" for what these two specs proved. Phase 15.5 found a genuine operator-recovery gap
   this way (neither Resume nor manual "Retry step" relaunched a step an unclean restart had
   abandoned); Phase 15.6 closed it (`CeoPlanExecutionScheduler.retryAbandonedStep()`, see that
   document's "Explicit abandoned-step recovery" section) and extended the unclean-restart spec to
   prove the fix through to the replacement attempt's genuine natural completion, run 5/5
   consecutive times.

## Process-level verification — `pnpm verify:process-recovery`

The one command that must be run (beyond `pnpm test`) to genuinely exercise the real production
binary's crash/restart/ownership behavior, rather than only the source it was compiled from:

```powershell
pnpm verify:process-recovery
```

Equivalent to `pnpm --filter @hall-of-wisdom/hall-core run build && pnpm --filter
@hall-of-wisdom/hall-core run test:process` — always rebuilds first, so it can never silently pass
against a stale `dist/`. Takes roughly 65 seconds (three of the four original tests each genuinely
wait out the real 20-second ownership-staleness default — Phase 13.2 added the frozen-owner test
alongside the original three). See "Testing," item 4, above for what each of those four tests in
`src/process-tests/` proves.

**(Phase 16.5)** `phase-16-5-worktree-recovery.test.ts` adds three real-process scenarios (seven
total across the directory, up from the original four), all for restart-safe worktree reconciliation,
driven entirely through the actual
`dist/server.js` binary and a real, disposable Git repository — no model-backed provider task is
ever run. It uses `spawnRealServerWithStdin`/`gracefulStop` (the documented stdin `"SHUTDOWN\n"`
graceful-shutdown trigger — see "Graceful shutdown from a spawned child process" above) between
boots specifically so its three real restarts complete in a few seconds rather than each waiting
out the ownership-staleness window a `SIGKILL` would force: a real Mock Agent task is created and
completed through the real HTTP API; a real Git worktree tied to that exact completed run is then
created in-process (through the same `AgentWorktreeManager`/`SqliteAgentWorktreeStore` production
uses) against the same database file, with no execution artifact yet, plus a second worktree
staged at the crash boundary "`cleanup_pending` after Git removal committed but before the durable
`cleaned` status was written"; a real restart then recovers the missing artifact from durable
evidence, persists it, and safely removes both worktrees; a second real restart proves the result
is idempotent (no duplicate artifact, no state regression); and direct SQLite/Git/filesystem
inspection afterward confirms the primary checkout's `HEAD`, tracked files, and working-tree
cleanliness were never touched, and that a seeded orphan directory under the owned root survived
every restart untouched.

**(post-merge Phase 16.5 hardening)** The second scenario in the same file proves the legacy
omitted-root rejection (see "Legacy omitted-root rejection" above) through the real binary: a first
boot establishes a database with no root ever supplied; a real `agent_worktrees` row is then seeded
directly via SQL; a second boot attempt, still omitting the root, is proven refused —
`attemptStart`/`waitForNonZeroExit` confirm it never answers `/api/v1/health` and exits with code
`2`, and direct database inspection afterward confirms the boot count is still `1` and the seeded row
is byte-for-byte untouched; a third boot supplying the exact proven root then succeeds and durably
records it.

**(final review correction)** The third scenario, a separate describe block in the same file, proves
the narrower "fully missing fingerprint" rejection (see "The fully missing fingerprint case" above):
a data directory is seeded directly — migrations run and a real `agent_worktrees` row inserted via SQL
— with no server ever having booted against it, so no fingerprint of any kind (not even
`workspaceRoot`) has ever been recorded. A single boot attempt with the root omitted is proven refused
the same way (exit code `2`, no health response), and direct inspection afterward confirms zero boot
rows, no `agentWorktreeRoot` or `workspaceRoot` fingerprint key recorded, and the seeded row untouched.
Deliberately a single boot attempt rather than the second scenario's three-boot flow, since its only
purpose is to prove the brand-new-database bootstrap branch is now covered too.

## Security review performed this phase

- **SQL injection**: every query in every `*-repository.ts` uses `node:sqlite`'s prepared
  statements with bound parameters; no string concatenation into SQL anywhere in the persistence
  layer.
- **Path traversal / symlink escape for `--data-dir`**: closed the same way `--comparison-root`
  already was — lexical containment plus a post-canonicalization (`fs.realpathSync.native`) mutual
  non-containment check against both `workspaceRoot` and `comparisonRoot`, at startup, before the
  database is even opened.
- **No path or raw error leakage over HTTP**: `PersistenceError`'s hierarchy never carries a raw
  `node:sqlite` message or filesystem path; `GET /api/v1/system/storage` and the `/system` page
  return/render only the curated, bounded field set described above.
- **No client-controlled storage location or backend selection**: durability is decided once, at
  process startup, from a CLI flag only — no request field of any kind lets a client discover the
  database file's path or influence which backend composition selected.
- **Fail-closed on configuration drift**: reusing a `--data-dir` against a different
  `workspaceRoot`/`comparisonRoot` than it was first opened with refuses to start
  (`ConfigurationFingerprintMismatchError`), rather than silently mixing state written under one
  filesystem layout with a startup pointed at a different one.
- **Fail-closed on an unknown future schema**: a database whose recorded schema version exceeds
  what the running build knows about refuses to start, rather than guessing at forward
  compatibility.
- **No automatic provider action after a crash**: reconciliation only ever marks an interrupted run
  failed; it is structurally incapable of resuming or retrying a real Claude Code/Codex invocation —
  there is no code path in `reconcile-tasks.ts`/`reconcile-comparisons.ts` that calls an adapter at
  all.
- **No real Claude Code/Codex execution or subscription usage** anywhere in this phase's own
  development or testing.
- **(Phase 13.1) Two Hall Core processes cannot silently share one durable database**: verified
  both empirically (the original gap) and by dedicated real-child-process tests
  (`concurrent-instance-rejected.test.ts`) proving the second instance is rejected before writing a
  boot record, a task, or any other durable state.
- **(Phase 13.1) Ownership metadata is never exposed publicly**: the lock file's content, the
  `dataDir` path, and the lock file name never appear in any HTTP response, CLI diagnostic, or the
  rejected instance's own stdout/stderr — verified by a dedicated unit test and by a real-process
  test asserting the rejected child's captured output never contains either string.
- **(Phase 13.1) No arbitrary file deletion**: `instance-ownership.ts`'s `release()` and takeover
  paths only ever operate on the one fixed `hall-core.lock` filename constructed from the already-
  validated, server-CLI-only canonical `dataDir` — never a client- or configuration-supplied path.
- **(Phase 13.1) The stdin graceful-shutdown trigger is not a new attack surface**: inert on an
  interactive TTY; on a piped stdin, it only ever triggers the same graceful-shutdown code path a
  real SIGINT already can, and stdin is already exclusively controlled by whatever process spawned
  Hall Core — no new capability is granted to any party that didn't already have full control over
  that process's own creation.
- **(Phase 13.2) A frozen-then-resumed former owner cannot commit a durable mutation**: proven at
  three independent layers — unit tests of `withTransaction`'s fence check, a real dedicated
  child-process test using a genuinely frozen (heartbeat-paused, connection never reopened) instance
  displaced by the real production binary, and the fact that every durable mutation in the codebase
  was grep-audited to confirm it actually routes through the one fenced boundary (four files plus one
  easy-to-miss single-statement write were found bypassing it and fixed — see "Database ownership
  fencing" above).
- **(Phase 13.2) A displaced instance cannot resurrect its own filesystem lock over the legitimate
  new owner's**: the heartbeat-overwrite bug described above — found, fixed, and covered by a
  dependency-injected regression test — closes a path that would otherwise have let a resumed former
  owner's `release()` call delete the new owner's lock.
- **(Phase 13.2) Owner tokens and ownership epochs never reach any public surface**: neither
  `GET /api/v1/system/storage`, `GET /api/v1/health`, any other HTTP response, any WebSocket message,
  nor any CLI diagnostic ever includes `owner_token`, `epoch`, `acquired_at`, or `heartbeat_at` — the
  `durable_ownership` table is read only by the fence check itself, the heartbeat monitor, and tests.
- **(Phase 13.2) No production testing endpoint or CLI flag was added**: `frozen-owner-child.ts` is a
  standalone test-only process, never imported by `server.ts`/`server-composition.ts` and never
  reachable via any CLI argument on the real binary; the dual-fixture E2E composition
  (`fixture-server.ts`) is controlled entirely by environment variables the Playwright harness sets,
  the same pattern already established (and already accepted) for Phase 11.1/12's existing fixture
  composition.
- **(Phase 13.2) No real Claude Code/Codex execution or subscription usage** anywhere in this phase's
  own development or testing — the E2E dual-fixture composition's two adapters are deterministic,
  offline, no-network fixtures, and the frozen-owner process test never spawns a provider process of
  any kind.

## What's next

Phase 13 — Durable State Persistence and Restart Recovery — Phase 13.1 — Durable Browser Restart,
Process-Test Reliability and Single-Instance Ownership — and Phase 13.2 — Durable Ownership Fencing
and Full Comparison Restart Verification — are all complete.

Phase 14 — CEO Agent Planning, Approval-Gated Delegation and Plan Tracking — followed and reused
this exact storage-port pattern for its own plan store (`SqliteCeoPlanStore` alongside
`InMemoryCeoPlanStore`, both behind `CeoPlanStorePort`, both run against one shared contract test
suite), added its own migration to this schema, and extended restart-recovery testing to cover a
delegated plan's version/approval/delegation-link/event history surviving an unclean restart
byte-identical. See
[`0014-ceo-planning-approval-and-delegation.md`](0014-ceo-planning-approval-and-delegation.md) for
the full design.
