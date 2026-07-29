# 0012 — Controlled Multi-Agent Execution Comparison

Status: Phase 12 (deterministic implementation, real Claude Code + Codex comparison) and Phase 12.1
(source-repository-resolution hardening) are both complete. Builds on
[`0004-hall-core-server.md`](0004-hall-core-server.md) (`EventStore`/`EventBus`, the WebSocket event
route), [`0006-kanban-board.md`](0006-kanban-board.md) (task lifecycle, assignment-and-start
separation), and [`0011-agent-capabilities-trust-and-routing.md`](0011-agent-capabilities-trust-and-routing.md)
(capability/trust vocabulary, `evaluateCandidateEligibility`). Read those first.

## Why this phase exists

Every prior phase runs exactly one adapter against one task. There has never been a way to give the
same task to two agents and see, side by side, what each one actually produced. Phase 12 adds that,
deliberately narrowly: an operator picks a task and exactly two adapters; Hall Core prepares two
independent Git worktrees at the identical base commit; the operator explicitly starts each
candidate's run, one at a time; each candidate's outcome (status, changed files, diff stats, a
bounded diff) is shown side by side. There is no automatic winner, no AI judge, no merge, no commit,
no push — only an optional, non-binding operator note recording which candidate they preferred.

## What this phase deliberately does not do

Restated here because it shaped every design decision below, not just the UI copy:

- No automatic parallel execution — starting a candidate is explicit, one at a time. The store
  enforces this (`ComparisonStore.claimCandidateStart` rejects starting a second candidate while
  another is `running`), not just the UI.
- No AI judging, no automatic winner, no quality scoring.
- No agent reviewing another agent's work.
- No automatic merge, commit, or push of either candidate's changes.
- No branch publishing, no PR creation, no GitHub/Azure DevOps integration.
- No cost/token comparison, no model selection.
- No persistence across server restarts by default (in-memory, like every other Hall Core store at
  the time this phase was written) — Phase 13 later added an opt-in durable mode covering
  comparisons too; see
  [`0013-durable-persistence-and-recovery.md`](0013-durable-persistence-and-recovery.md).
- No CEO Agent, no agent-to-agent communication.
- No real Claude Code or Codex execution without the operator's own explicit, per-run action — this
  phase never spends provider usage on its own initiative.

## Domain model — `apps/server/src/comparisons/comparison-record.ts`

`AgentComparisonRecord` and `ComparisonCandidateRecord` are Hall-Core-local types (like `TaskRecord`),
not protocol/wire types — a comparison is a Hall Core concept, not something an adapter or another
process needs to understand.

**`ComparisonStatus`**: `draft` (snapshotted, no filesystem work yet) → `preparing` (worktrees being
created) → `ready` (worktrees exist, commit-verified, nothing started) → `running` (at least one
candidate started, not all candidates terminal yet) → `partially_completed` (all candidates terminal,
not all `completed`) / `completed` (all `completed`) / `failed` (`preparing` itself failed) /
`cancelled` (torn down via `DELETE` before finishing naturally) → `cleaning` → `cleaned`.
`cancelled`/`cleaning`/`cleaned` are governed only by the cleanup methods below and are never
recomputed from candidate status once set — a late-arriving candidate terminal event during cleanup
must not resurrect an outcome status and clobber them (`ComparisonStore#deriveComparisonStatus`'s doc
comment covers this explicitly; a dedicated test proves it).

**`CandidateStatus`**: `pending` → `prepared` → `running` → `completed` / `failed` / `cancelled`.

**`CleanupStatus`** (independent of `ComparisonStatus`): `not_started` / `in_progress` / `completed` /
`failed` — deliberately separate so a failed worktree removal can be retried (`claimCleanup` allows
re-entry from `failed`, rejects only from `in_progress` or `completed`) without losing the
comparison's own execution outcome.

**Source task snapshot policy**: `title`/`description`/`priority`/`requirements` are copied from the
source task once, at `POST /api/v1/comparisons`, and never re-read afterward — editing the source task
after a comparison exists does not change the comparison. `sourceTaskId` is retained only as a
reference for display/navigation, not as a live pointer.

**Never serialized**: absolute worktree paths, or the resolved source repository's own absolute path.
`ComparisonCandidateRecord` has no path field at all — `ComparisonOrchestrator` keeps two private
sidecar maps, neither ever exposed: `#worktreePaths: Map<candidateId, string>` and (Phase 12.1)
`#sourceRepositoryPaths: Map<comparisonId, string>`. `AgentComparisonRecord` does carry
`prepareFailureCode`/`prepareFailureReason` (Phase 12.1) — always a stable code and a hand-authored,
bounded, path-free string, never the raw error message a path might appear in.

## `ComparisonStore` — a separate revision mechanism, never `TaskStore`'s

`apps/server/src/comparisons/comparison-store.ts` copies `TaskStore`'s optimistic-concurrency pattern
verbatim (private `#revisions` map, bumped exactly once per successful mutation, never on a rejected
one) as its own, wholly independent aggregate — no shared base class, no reused revision counter.
Every atomic claim (`claimPreparing`, `claimCandidateStart`, `claimCleanup`) follows
`TaskStore.setRunId()`'s discipline: read the live record, validate, write — with zero `await` in
between, so two concurrent callers can never both win the same claim.

**Sequential-start enforcement lives in the store, not just the orchestrator or UI**:
`claimCandidateStart` rejects (`ComparisonStateConflictError`, 409) starting a candidate while any
_other_ candidate on the same comparison is `running`. This isn't only policy — two candidates
finalizing concurrently would run `git add -A`/`git diff` in two worktrees that share one `.git`
directory, the same class of real-`git`-under-load contention `GitWorktreeManager` already serializes
worktree _creation_ against.

## Git worktree isolation — `apps/server/src/comparisons/git-worktree-manager.ts`

`GitWorktreeManager` is the only component allowed to create, remove, or prune comparison worktrees.
It never creates a branch, commit, or remote reference — every worktree is `git worktree add
--detach <path> <baseCommit>`.

**Two-phase path safety.** A worktree's intended path (`<comparisonRoot>/<worktreeId>`) can't be
`realpath`-checked before it exists, so containment is checked twice: (1) lexically, against the
canonical `comparisonRoot`, before `git worktree add` runs, using a regex-validated,
server-generated `worktreeId` (never a client-supplied path fragment — `WORKTREE_ID_PATTERN =
/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/`); (2) after creation, the resulting directory is
`fs.realpathSync.native`-resolved and re-checked against `comparisonRoot` — closing the gap a
symlink/junction anywhere on the comparison-root path could otherwise open, the same technique
`@hall-of-wisdom/hall-runner`'s `validateWorkspace` uses for task working directories. The new
worktree's `HEAD` is also verified to match the requested `baseCommit` exactly (full 40-character SHA
comparison) before it is handed back — defense-in-depth against unexpected `git` behavior.

**`comparisonRoot` ⟂ `workspaceRoot` mutual non-containment**, checked once at server startup
(`server.ts`): neither may be nested inside, or an ancestor of, the other. Without this, `git worktree
add` could pollute or nest a comparison worktree inside the source repository itself.

**Removal**: `removeWorktree(repositoryPath, worktreePath)` refuses (rather than silently no-oping)
any path outside `comparisonRoot`, as a last line of defense even if a caller violates the "always
pass back the exact canonical path this manager returned" contract. Uses `git worktree remove
--force`, not a raw recursive delete — `git` itself refuses to remove a repository's main worktree,
which a raw `rm -rf` cannot distinguish. `pruneWorktrees` clears stale administrative metadata after
an out-of-band directory removal.

**Environment sanitization**: every `git` child process gets an allowlisted, minimal environment
(`git-environment.ts`) — never the full parent environment — plus fixed safety overrides
(`GIT_TERMINAL_PROMPT=0` so a command fails instead of hanging on a credential prompt, since none of
these commands ever touch a remote; `NO_COLOR=1` so output parsing never has to strip ANSI codes).

**Process spawning**: `node:child_process.spawn` directly, `shell: false`, argument arrays only — no
`cross-spawn` dependency needed (unlike the Codex/Claude Code adapters), since `git` ships as a real
executable on every supported platform, not an npm-installed `.cmd`/`.bat` shim.

**Real-`git` integration tests, not just a fake spawner.** Unit tests (`git-worktree-manager.test.ts`)
exercise error-wrapping, identifier validation, and containment refusal against a fake `ProcessSpawner`
for speed; `git-worktree-manager.integration.test.ts` runs every operation against real temp-directory
repositories — this is where worktree isolation, path safety, and dirty-worktree removal (a real agent
run always leaves modified + untracked files; every earlier removal test used an untouched worktree,
which proves nothing about `--force` actually handling dirty state) are actually proven, not mocked.

## `ComparisonOrchestrator` — reuses `runTask()` directly, no new coordinator

`apps/server/src/comparisons/comparison-orchestrator.ts`. `runners/hall-runner/src/runner-service.ts`'s
`runTask()` was already the reusable, provider-neutral, store-independent execution primitive Hall
Runner's own CLI uses — no extraction or duplication was needed. Candidate execution calls it directly
with a per-candidate `onEvent` sink and `AbortController`, mirroring `TaskOrchestrator#execute`/
`#handleEvent` exactly, just scoped by `candidateId` instead of `taskId`.

**`EventStore`/`EventBus` are dedicated, fresh instances** (`comparisonEventStore`/
`comparisonEventBus` in `comparison-composition-root.ts`) — never the task ones. A comparison
candidate's event stream can never share a capacity budget with, or be confused for, a real task's.
Keyed by `candidateId` (a server-generated UUID), which also serves as the synthetic `taskId` passed
into the adapter's `AgentTaskInput` for this run — there is no real `HallTask` involved; a minimal one
is constructed from the comparison's snapshotted title/description/priority/requirements.

**`baseCommit` resolved exactly once, in `prepareComparison`, and shared by both candidates.**
Resolving it per-candidate would open a window for a commit landing between the two candidates'
worktree creation to silently diverge them — the entire point of "same base commit" would be
undermined by a race no test would catch without specifically looking for it.

**Worktree creation is sequential, not parallel**, for the same reason candidate _execution_ is
sequential: `git worktree add` takes repository-level locks against the same source repository.

**Prepare is atomic.** If the second candidate's worktree creation fails after the first succeeded,
the first is rolled back (best-effort `removeWorktree`) before the comparison is marked `failed` — a
dedicated real-`git` integration test injects a spawner that fails a specific `worktree add` call
number and asserts the first worktree is gone afterward, not left behind consuming disk space.

**Re-eligibility at start, never trusted from prepare.** `startCandidate` re-runs a fresh `detect()`
and (if the comparison carries `requirements`) `evaluateCandidateEligibility` — the exact same function
Phase 11's routing uses, never a second, divergent compatibility algorithm — immediately before
starting, and rolls the atomic `runId`/`agentId` claim back (`clearCandidateStart`) if the adapter is
no longer eligible. The worktree itself is never touched by this rollback, so a retry can reuse it.

**Cleanup waits for finalization, not just the run's own event stream — this was a real bug found and
fixed during this phase's own development, not a hypothetical.** `runTask()`'s promise resolves the
moment the adapter's event stream ends (i.e. right after the terminal event), which is _before_
result-evidence capture (`captureResultEvidence`'s `git add -A` / multiple `git diff` passes against
the candidate's own worktree) has necessarily finished — that capture runs fire-and-forget from the
event handler, tracked in a separate `#activeFinalizations` map specifically because it is not
covered by `runTask()`'s own promise. Earlier versions of `cleanupComparison`/`shutdown()` waited only
on `#activeExecutions`, so calling cleanup immediately after a candidate finished could remove the
worktree while `git add`/`git diff` was still reading/writing that worktree's index underneath it —
observed directly, on this repository's own Windows dev machine, as a `fatal: ambiguous argument
'HEAD'` / `ENOENT` failure once the fix was temporarily reverted to confirm the regression test
actually catches it. The fix is a second, sequential bounded wait (same grace timeout, applied twice):
first for `#activeExecutions` to settle, then — only once that has happened, since a candidate's
terminal event synchronously registers its finalization promise before `runTask()` itself resolves —
for `#activeFinalizations`. A regression test (`comparison-orchestrator.integration.test.ts`, "cleanup
waits for in-flight result-evidence capture") asserts the _captured evidence itself_ survives an
immediate cleanup call, not merely that cleanup "succeeds" (which it trivially does either way, since
a lost evidence-capture race is caught and logged rather than thrown) — a weaker assertion was
verified NOT to catch the bug before this one replaced it.

## Phase 12.1 — source repository resolution

**The defect, found during the real (authorized) Claude Code + Codex comparison run.**
`ComparisonOrchestrator.prepareComparison` originally used the server's own `--workspace-root` flag
directly as the Git repository every comparison prepares against — never the source task's own working
directory. `workspaceRoot` is a trusted **security boundary** (the set of directories Hall tasks are
allowed to touch), not itself a repository: it need not be a Git repository at all, may contain several
independent repositories, and is very often _dirty_ (an operator's own real, uncommitted development
work sitting in it — exactly Hall of Wisdom's own checkout during that real run). Because preparation
required `workspaceRoot` itself to be clean, the real run could only proceed after a verification
workaround: temporarily restarting Hall Core with `--workspace-root` pointed at a disposable, clean
fixture repository instead of the real `D:\HallOfWisdom` checkout. That workaround was correct and safe
for a one-off verification (see "Real Claude Code + Codex comparison" below) but was never the intended
production architecture.

**The fix — `apps/server/src/comparisons/source-repository-resolution.ts`.** A comparison's source
repository is now always resolved from its source task's own stored working directory, never from
`workspaceRoot` directly:

1. `TaskStore` gained a private, never-serialized `workingDirectory` side-table (`setWorkingDirectory`/
   `getWorkingDirectory`), populated once by `TaskOrchestrator` at task creation. This mirrors, but is
   distinct from, `TaskOrchestrator`'s own pre-existing `#pendingWorkingDirectories` (which is a
   once-only cache consumed and cleared by `startTask()`): a comparison may need to read a deferred
   task's working directory long after creation, without that task ever going through
   `TaskOrchestrator.assignTask()`/`startTask()` at all, so this store is never cleared.
2. `resolveSourceRepositoryRoot()` reads that raw, relative working directory; rejects a task with none
   at all (`SourceWorkingDirectoryRequiredError`); resolves and canonicalizes it against `workspaceRoot`
   via the exact same `validateWorkspace` helper (`@hall-of-wisdom/hall-runner`) `TaskOrchestrator`
   already uses for task execution — existence, is-a-directory, and symlink/junction-resolved
   containment, all in one call; then calls `GitWorktreeManager.resolveRepositoryRoot()` (`git rev-parse
--show-toplevel`, already existed, previously unused by the orchestrator) to find the actual
   repository root, which may be an ancestor of the task's working directory or the directory itself;
   then re-validates that resolved root against `workspaceRoot` a second, independent time — defense in
   depth against a repository whose real top-level somehow resolves outside the workspace boundary.
3. `ComparisonOrchestrator.prepareComparison` calls this once, before any Git work, and uses the
   resolved repository root — never `workspaceRoot` — for the cleanliness check, `HEAD` resolution, and
   both candidates' worktree creation. The resolved root is kept in the new `#sourceRepositoryPaths`
   sidecar map for the comparison's whole lifetime (not just the duration of `prepareComparison`):
   `cleanupComparison`'s `git worktree remove` also needs the real repository as its working directory,
   not `workspaceRoot`, which may no longer even be a Git repository.

**Cleanliness now applies only to the resolved repository.** `workspaceRoot` need not be a Git
repository and may be dirty; an unrelated repository nested elsewhere under `workspaceRoot` may be
dirty; only the specific repository a task's working directory resolves to must be clean
(`SourceRepositoryNotCleanError`, surfaced as `COMPARISON_SOURCE_REPOSITORY_DIRTY`).

**New safe failure codes**, all reachable only through `prepareComparison`'s existing record-based
failure path (never thrown as an HTTP error — preparation failures are data, exactly like the
pre-existing worktree-creation failures) and now visible on `AgentComparisonRecord` as
`prepareFailureCode`/`prepareFailureReason` (previously a comparison-level, non-candidate-specific
prepare failure had no reason visible anywhere in the response at all — this Phase closed that gap
too):

| Code                                           | Cause                                                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `COMPARISON_SOURCE_WORKING_DIRECTORY_REQUIRED` | The source task has no working directory set.                                                                              |
| `COMPARISON_SOURCE_WORKING_DIRECTORY_INVALID`  | The working directory does not exist or is not a directory.                                                                |
| `COMPARISON_SOURCE_OUTSIDE_WORKSPACE`          | The working directory, or the Git repository resolved from it, escapes `workspaceRoot` (including via a symlink/junction). |
| `COMPARISON_SOURCE_NOT_GIT_REPOSITORY`         | The working directory is not inside any Git repository.                                                                    |
| `COMPARISON_SOURCE_REPOSITORY_DIRTY`           | The resolved repository has uncommitted changes.                                                                           |
| `COMPARISON_PREPARE_FAILED`                    | Generic fallback (worktree-creation failure, or any other unexpected internal error) — unchanged from before this phase.   |

**Still true, restated:** the browser can never supply a repository path or a Git ref — the
create-comparison request schema (`createComparisonRequestSchema`, `.strict()`) only ever accepts
`sourceTaskId` and `candidateAdapterIds`; a request that adds any other field (e.g. an attempted
`repositoryPath`/`baseCommit` override) is rejected with 400 before it ever reaches the orchestrator.

## Result evidence — `apps/server/src/comparisons/result-evidence.ts`

`captureResultEvidence` compares a candidate's worktree (including untracked new files) against its
own `HEAD` (the shared `baseCommit`). `git add -A` stages everything first — this mutates only the
disposable worktree's own index, never the source repository's, and the worktree is removed shortly
after — so a single `git diff --cached` pass captures modified, added, and deleted files uniformly,
including files the agent never `git add`ed itself.

**Bounded, never leaking internals**: `changedFiles` (capped at `maxChangedFiles`, default 500) are
repository-relative paths with add/delete counts and a change type; `boundedDiff` is a unified diff
capped at `maxDiffChars` (default 200,000), with `truncated: true` set whenever either bound is hit.
Never an absolute path, raw stderr, provider reasoning, tokens, or cost — a dedicated test asserts the
returned evidence's serialized JSON never contains the worktree's own absolute path string.

## REST API — `apps/server/src/routes/comparisons.ts`

`POST /api/v1/comparisons` (create, 201), `GET /api/v1/comparisons` (list), `GET
/api/v1/comparisons/:comparisonId` (detail, 404 if unknown), `POST .../prepare` (200, or the record
with `status: "failed"` — prepare failures are data, not a thrown error, so the UI can show exactly
which candidate's worktree creation failed), `POST .../candidates/:candidateId/start` (202), `POST
.../candidates/:candidateId/cancel` (202 — cancels a `pending`/`prepared` candidate synchronously, or
flags + aborts a `running` one), `POST .../preference` (`{candidateId: string | null, note?}` — `null`
clears it), `DELETE /api/v1/comparisons/:comparisonId` (tears down; always returns the record, never
throws on a partial failure, so a failed cleanup can be retried via a second `DELETE`).

Candidate events stream over `GET /api/v1/comparisons/:comparisonId/candidates/:candidateId/events`
(WebSocket), mirroring `routes/task-events.ts`'s exact safety mechanisms verbatim: exact-Origin
validation first, `afterSequence` replay-then-live-subscribe ordering (subscribed before reading
stored history, to avoid a gap), `bufferedAmount`-based backpressure, and the same close-code
vocabulary (4400/4403/4404/4503/4504/1000/1003) — just keyed by `candidateId`, and additionally
validated that the candidate actually belongs to the given `comparisonId` (closes 4404 otherwise, so a
client cannot stream events for a candidate under a comparison it does not belong to).

Every comparison route is entirely optional at the composition level: `apps/server/src/app.ts` only
registers them when `--comparison-root` was supplied at startup (see below) — omitting the flag means
these routes don't exist at all, verified by a route test asserting 404 on a harness built without
comparisons enabled.

## Startup configuration — `--comparison-root`

Optional CLI flag (`apps/server/src/config/server-cli-args.ts`). When omitted, the comparison feature
is not composed at all — every existing startup command remains valid without it. When supplied,
`server.ts` validates it exists (same requirement `--workspace-root` has, via
`@hall-of-wisdom/hall-runner`'s `validateWorkspace`) and checks mutual non-containment against
`workspaceRoot` before ever constructing a `GitWorktreeManager`. `--workspace-root` itself need not be
a Git repository, and need not be clean — see "Phase 12.1 — source repository resolution" above; each
comparison's actual source repository is resolved per-task, from that task's own working directory,
somewhere inside `workspaceRoot`. New `ServerLimits` fields
(`maxComparisons`, `maxEventsPerComparisonCandidate`, `maxSubscribersPerComparisonCandidate`,
`gitCommandTimeoutMs`, `maxComparisonChangedFiles`, `maxComparisonDiffChars`,
`comparisonCleanupGraceTimeoutMs`) follow the exact same bounded-defaults discipline
`DEFAULT_LIMITS` already established.

Example startup with comparisons enabled:

```powershell
pnpm --filter @hall-of-wisdom/hall-core run dev -- --workspace-root D:\HallOfWisdom --comparison-root D:\HallOfWisdomComparisons --port 4310
```

`D:\HallOfWisdomComparisons` must already exist and must not be nested inside, or an ancestor of,
`D:\HallOfWisdom`. `D:\HallOfWisdom` itself may be a dirty Git repository (Hall of Wisdom's own real
development checkout usually is) — that no longer blocks comparisons; only the specific repository a
comparison's source task actually points its working directory at must be clean.

## Security review performed this phase

- **Path traversal / symlink escape**: closed by the two-phase containment check in
  `GitWorktreeManager` (see above), proven by both fake-spawner unit tests (prefix-confusion sibling
  directories, path-traversal identifiers) and real-`git` integration tests.
- **Command injection**: every `git` invocation uses a fixed executable path and an argument array,
  `shell: false` always — no string concatenation into a shell command anywhere in this feature.
- **Credential/secret leakage**: the allowlisted `git` child environment (see above) never forwards
  the parent process's full environment; result evidence and error messages are hand-bounded, never
  raw stderr or process output.
- **No client-controlled repository**: the source repository is always resolved server-side from the
  source task's own stored working directory (see "Phase 12.1 — source repository resolution" above) —
  there is no request field anywhere in this feature that lets a client specify a repository path or a
  Git ref directly; `createComparisonRequestSchema` is `.strict()` and rejects any attempt to add one.
- **Workspace containment is enforced twice, independently** (Phase 12.1): once on the task's own
  working directory, once on the Git repository resolved from it — a repository whose real top-level
  somehow disagrees with the task's own containment check is still rejected.
- **No silent capability/trust weakening**: `startCandidate` re-runs the exact same
  `evaluateCandidateEligibility` Phase 11 routing uses; it is never bypassed, relaxed, or duplicated
  with looser logic for the comparison path.
- **Concurrency**: every atomic claim (`claimPreparing`, `claimCandidateStart`, `claimCleanup`) follows
  `TaskStore.setRunId()`'s snapshot-then-write-with-no-await-gap discipline; sequential-start and
  cleanup-vs-running races are covered by dedicated tests (store-level and real-`git`
  orchestrator-level).
- **No unbounded process execution**: every `git` command is `runBoundedProcess`-wrapped with a
  configurable timeout and capped output buffering, identical in structure to the Codex/Claude Code
  adapters' own bounded-process pattern.

## Real Claude Code + Codex comparison (Phase 12 — completed, authorized, one-off)

With explicit, narrowly-scoped operator authorization, a single real comparison was run end to end
against genuine Claude Code (isolated) and Codex (trusted-local) invocations — exactly one invocation
of each, zero retries. Both candidates started from the identical base commit of a disposable fixture
repository, ran in separate detached worktrees, and both completed successfully with independent,
correct implementations of the same task (Claude Code's candidate added 13 passing tests; Codex's
candidate added 4 passing tests — both fully satisfied the task's stated requirements). Hall Core never
declared a winner, never merged or committed either candidate's changes, and the operator's recorded
preference had no side effects. This run only proceeded after a temporary startup workaround
(`--workspace-root` pointed at the clean fixture repository itself, since the real `D:\HallOfWisdom`
checkout was — and normally is — dirty with real development work) — that workaround, and the
production architecture defect it revealed, is what Phase 12.1 (above) fixes. No further real Claude
Code or Codex execution is needed or authorized for this feature; any future real-provider run requires
its own separate, explicit approval per this phase's kickoff instructions.

**Trusted-local Codex, restated from the real run**: it retains the Hall Core operating-system user's
broader filesystem permissions for the duration of its run — the worktree/prompt-scoped checks this
feature performs are not an OS-level sandbox confinement boundary. The `/agents` page's own
trusted-local warning already says this explicitly; the real run confirmed the warning text and its
implications hold under a genuine invocation, not just in the abstract.

## What's next

Phase 12 (deterministic implementation + the real comparison above) and Phase 12.1
(source-repository-resolution hardening) are both complete. Phase 13 — Durable State Persistence
and Restart Recovery — followed and is documented separately; see
[`0013-durable-persistence-and-recovery.md`](0013-durable-persistence-and-recovery.md).
