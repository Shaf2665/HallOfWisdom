# 0015 — Autonomous Plan Execution, Dependency-Aware Scheduling and Operator Intervention

> **Status: the Phase 15.5 operator-recovery gap is resolved (Phase 15.6).** The durable execution
> core, REST API, WebSocket publish-after-commit stream, Hall Web execution UI and operator
> dialogs, Kanban execution badges, and dedicated retry/circuit-breaker/launch-TOCTOU/durable-restart
> Playwright coverage (including dedicated clean-restart and unclean-restart browser specs) are all
> implemented and tested — reachable end-to-end through Hall Web and the REST API, not just at the
> unit level. Phase 15.5 found that after an unclean restart abandons a step to
> `awaiting_intervention`, neither an explicit operator Resume nor a manual "Retry step" relaunched
> it. Phase 15.6 closes this: Resume alone still starts nothing (deliberately, unchanged), and
> "Retry step" now routes a step whose latest attempt is genuinely `"abandoned"` through a new,
> narrow, explicit-operator-only governed recovery path
> (`CeoPlanExecutionScheduler.retryAbandonedStep()`) that revalidates full launch eligibility and
> creates exactly one new attempt with a new task-run ID — see "Explicit abandoned-step recovery"
> below and `docs/architecture/0015-security-review-matrix.md` scenario 23 for the executable
> proof, including 5/5 consecutive unclean-restart and 3/3 consecutive clean-restart Playwright
> runs.
>
> **Phase 15.1 hardening:** abandoned-step retry is now crash-safe after the operator clicks
> "Retry step". The operator's intent is recorded first in a durable, idempotent
> `ceo_plan_abandoned_retry_intents` row keyed to the exact abandoned attempt; restart
> reconciliation may continue the retry only from that row, never from inferred task state or a
> Board message. Attempt listing order is now a documented store contract.

## Why this phase exists

Phase 14 lets an operator approve and delegate a CEO plan into real child tasks, but every child
task still has to be started by hand, one at a time, from the Kanban board. Phase 15 adds a
narrow, explicitly-authorized autonomous execution mode: once a plan is delegated, an operator may
separately configure an execution policy and explicitly start autonomous execution, after which
Hall Core's own scheduler — never a second AI planner — starts only the plan's own already-approved
child tasks, in dependency order, within a conservative, immutable policy envelope.

## What this phase deliberately does not do

Approval and delegation alone start nothing (Phase 14 behavior unchanged). The scheduler never
creates a plan, a plan step, or a child task; never rewrites plan requirements; never changes the
approved adapter; never replans; never skips a required step; never starts work before explicit
execution authorization; never continues scheduling after ownership fencing is lost; never blindly
retries after an unclean restart. See "Known Phase-15 limitations" for the complete list of
explicitly out-of-scope capabilities (dynamic step creation, step skipping, adapter reassignment,
cost/token budget enforcement, multi-node scheduling, recurring routines, and more).

## Paperclip inspiration and Hall-specific differences

This phase's design was informed by publicly-documented autonomous-agent orchestration concepts
(durable work queues, dependency-aware scheduling, circuit breakers) as general design research,
not by inspecting or copying any Paperclip source code — no Paperclip repository was cloned,
vendored, or read during this work. Every concept below is an independent implementation:

- **Event-first, targeted scheduling** instead of periodic full-plan polling: `enqueueSignal`
  targets exactly one run, and signal processing targets only the specific steps a signal's
  reasons imply, via O(1) dependency-index lookups (`ceo-plan-step-readiness.ts`).
- **SQLite epoch fencing for every mutation**, reusing Phase 13's `withTransaction`
  ownership-fenced transaction boundary — not a bespoke locking scheme.
- **Pauses after an unclean restart instead of blind retry** — `ceo-plan-execution-recovery.ts`
  marks every previously-running autonomous run `awaiting_intervention` and abandons (never
  auto-retries) any non-terminal attempt.
- **A bounded, three-condition no-progress circuit breaker** (`ceo-plan-execution-circuit-breaker.ts`),
  not a general "AI judgment" mechanism — every input is a small, already-persisted counter.
- **Reports only enforceable local limits** (concurrency, attempt counts, elapsed time) — never a
  fabricated token cost or subscription budget; the execution policy is explicitly labeled
  "Execution limits," never "Cost budget."
- No unsubstantiated performance-superiority claim is made anywhere in this document or the code.
  Hall-local, deterministic operation-count efficiency tests (kickoff §12) are implemented and
  passing — `ceo-plan-execution-efficiency.test.ts`, 5 tests: incremental dependency evaluation
  touches only the affected step at 100×20-run scale; duplicate-signal coalescing; a genuinely idle
  scheduler performs zero mutations; a test-only naive-baseline comparison proves Hall's real
  incremental path does materially less work than an intentionally naive full scan (never shipped,
  never composed into the real scheduler); and cross-run fairness under repeated re-signaling. **No
  direct external benchmark against Paperclip (or any other system) has been performed, and none of
  these tests claim one** — see that file's own doc comment.

## Execution safety model

```
Plan generated -> revised -> submitted -> approved (exact version) -> delegated
  -> child tasks created/assigned/unstarted (Phase 14, unchanged)
  -> operator configures execution policy
  -> operator explicitly starts autonomous execution
  -> scheduler starts eligible child tasks
  -> operator may pause / resume / retry / cancel / emergency-stop
```

Two execution modes exist on `CeoPlanRun.executionMode`: `manual` (the scheduler structurally
never claims a signal for this run — enforced in `CeoPlanExecutionScheduler.tick()` via an
explicit `executionMode === "autonomous"` filter, not left to callers) and `autonomous` (requires
an immutable policy snapshot and an explicit start).

## Persistence — `apps/server/src/ceo-execution/`

- **`ceo-plan-run-store-port.ts`** + `in-memory-ceo-plan-run-store.ts` / `sqlite-ceo-plan-run-store.ts`
  — runs, step-execution projections, attempts, circuit state, interventions, events, and
  Board-audit dedup keys, behind one port with in-memory/SQLite siblings selected by composition
  exactly like every other Phase 13/14 store.
- **`execution-signal-store-port.ts`** + in-memory/SQLite siblings — the durable execution-signal
  queue: coalescing (equivalent pending signals merge; reasons combine into a bounded unique set;
  priority may only increase; `availableAt` uses the earliest safe eligible time), atomic claim
  with a leased owner token, and bounded reconciliation hooks.
- **Migration 5** (`persistence/migrations.ts`) creates `ceo_plan_runs`, `ceo_plan_step_executions`,
  `ceo_plan_step_attempts`, `ceo_plan_execution_signals`, `ceo_plan_execution_events`,
  `ceo_plan_execution_circuit_state`, `ceo_plan_execution_interventions`,
  `ceo_plan_execution_board_audit`, with partial unique indexes enforcing "at most one active run
  per plan" and "at most one active attempt per step" at the database level, independent of
  application code (proven by raw-SQL tests in `migrations.ceo-execution.test.ts`).
- **`claimAttempt`** (added to the port after the initial implementation, closing a review
  finding) creates an attempt AND marks its step execution "claimed" as one operation, rather than
  two separate store calls whose interleaving could leave an attempt row with no matching
  step-execution update. In SQLite mode this is genuinely atomic (one outer `withTransaction`,
  `SAVEPOINT` rollback on failure). In ephemeral mode the guarantee comes from a different
  mechanism, not from the store method itself: `claimAttempt`'s one real production call site
  (`CeoPlanExecutionScheduler#tryAdvanceStep`) always wraps it in `SchedulerDeps.runAtomicUnit`,
  which for ephemeral mode is `createEphemeralAtomicUnit({ planRunStore, signalStore })` — it
  snapshots both stores before the call and restores them wholesale on any throw. A dedicated
  failure-injection test (`ceo-plan-execution-atomicity.contract.ts`, "attempt creation: an
  injected step-execution failure during claimAttempt leaves NO dangling attempt row, and a retry
  succeeds exactly once") forces `upsertStepExecution` to throw mid-`claimAttempt` and confirms
  both the attempt row and the step-execution update roll back together, with the attempt count
  unchanged and the retry succeeding exactly once. No partial state (an attempt row with no
  step-execution linkage, an `activeAttemptId` pointing at a rolled-back attempt, or the reverse)
  is observable in either mode — snapshot/restore and `SAVEPOINT` are different implementations of
  the same all-or-nothing guarantee for this span.
- **Migration 6** adds `ceo_plan_abandoned_retry_intents`, a private execution-runtime table used
  only for explicit abandoned-step retry recovery. It stores bounded metadata only: run ID, step ID,
  child task ID, the exact abandoned attempt ID, the fixed human operator actor, request time, and
  an optional replacement attempt ID once claim succeeds. It never stores provider output. The
  unique `(run_id, plan_step_id, abandoned_attempt_id)` key makes repeated/replayed operator Retry
  requests idempotent; a unique replacement-attempt link preserves the one-replacement-attempt
  invariant.
- `listAttempts(runId, stepId)` returns attempts ordered by `attemptNumber ASC`. `listAttempts(runId)`
  returns a deterministic run-wide order of `planStepId ASC, attemptNumber ASC`. SQLite uses
  explicit `ORDER BY` clauses; the in-memory implementation sorts explicitly too.

## Dependency-aware, incremental scheduling — `ceo-plan-step-readiness.ts`

`buildDependencyIndex` builds a deterministic adjacency index (dependents + dependencies) for one
immutable plan version, once, at run configuration or recovery time — never rebuilt per signal.
`evaluateDependencyReadiness` is a pure, O(dependency-count) check for exactly one step: a failed
or cancelled dependency blocks readiness exactly like each other (never silently treated as
success), and readiness requires every dependency to be `completed`. An explicit test proves a
20-step dependency chain touches only the one directly-affected dependent on a single signal, not
all 20 steps.

## Event-first scheduler — `ceo-plan-execution-scheduler.ts`

`CeoPlanExecutionScheduler` is the one class allowed to call `TaskOrchestrator.startTask` on the
execution path — the same call a human clicking "Start task" already uses, never a bypass of it,
never a direct adapter call.

- `enqueueSignal` inserts (or coalesces into) a durable signal, then drains claimable work
  immediately — no polling interval for the common case.
- `tick()` claims at most one signal, scoped to `running` **and** `autonomous` runs only, and
  processes only the steps that signal's reasons imply (self, and/or direct dependents).
- `#tryAdvanceStep` is the atomic claim -> attempt -> start-intent path: dependency readiness,
  circuit state, `maxConcurrentSteps`, per-adapter capacity (default 1 active run per adapter
  unless a bounded `adapterConcurrencyOverrides` policy override applies), and
  `maxAttemptsPerStep` are all revalidated immediately before `claimAttempt` + `startTask`.
- `onChildTaskMutated(childTaskId)` is the bridge from a real child-task status transition back
  into the scheduler — looked up via `listStepExecutionsByChildTask`, bounded to that task's own
  small link set, never a scan of unrelated tasks or plans.
- `emergencyStop(runId)` is a separate, explicit, destructive action from `pauseRun`: it pauses
  scheduling first, then calls `TaskOrchestrator.requestCancellation` for every currently active
  (`claimed`/`starting`/`running`) step's own linked child task — scoped strictly to that run,
  recording each outcome individually, and never reporting overall success if even one
  cancellation attempt failed.

## Retry classification and circuit breaker

`ceo-plan-execution-retries.ts` classifies a failed attempt from the adapter/orchestrator's own
honest `retryable` hint (never from matching error text) into
`transient | permanent | security | ownership_lost | cancelled | requirements_changed |
adapter_unavailable | unknown`; only `transient`, under `allowAutomaticTransientRetry` and below
`maxAttemptsPerStep`, is ever retried automatically, with a bounded backoff.

`ceo-plan-execution-circuit-breaker.ts` trips on three deterministic, already-persisted counters
(`consecutiveFailures`, `consecutiveSameCodeFailures`, `noProgressAttempts`) compared against
policy thresholds — never on raw provider output or a qualitative judgment. `rapid_attempt_churn`,
`adapter_flapping`, and `half_open` are intentionally not implemented this phase (see that file's
doc comment for the documented rationale); every resume path already requires explicit operator
action, a stronger guarantee than an automatic half-open probe.

## Restart recovery — `ceo-plan-execution-recovery.ts`

Runs once, in `server.ts`, strictly **after** Phase 13's `runRestartRecovery` returns and
**before** the scheduler's task-mutation bridge is armed (`composition.activateAutonomousScheduling()`).
Ordering is the entire safety property: `runRestartRecovery`'s own `reconcileTasks` step mutates
`taskStore` directly (marking any genuinely-interrupted child task `failed`, unconditionally,
regardless of shutdown cleanliness — Phase 13 behavior, unchanged); if the scheduler bridge were
armed before this function decided what to do with each run, that reconciliation could trigger
live scheduling decisions against stale, not-yet-reconciled run state.

- **Unclean restart**: every run still `running` is paused to `awaiting_intervention`
  (`recoveryClassification: "unclean_paused"`); every non-terminal attempt is marked `abandoned`
  (never `failed` — the process can no longer vouch for it, but it may have genuinely completed
  out-of-band); pending signals are cancelled; exactly one bounded `ceo.execution.recovery_paused`
  event and one dedup-gated Board summary are appended. Idempotent across repeated unclean
  restarts.
- **Clean restart**: the run's dependency index (a derived projection, never persisted) is rebuilt
  from its exact approved plan version (`CeoPlanStorePort.getVersion(planId, planVersion)`), and
  one `startup_reconciliation` signal is enqueued so the scheduler revalidates every step fresh
  against current persisted state before starting anything new.

## Explicit abandoned-step recovery — `retryAbandonedStep()` (Phase 15.6)

Unclean-restart recovery (above) never auto-retries an abandoned step, by design — durable
execution state, not a live process, is the only thing that can vouch for what genuinely happened.
Making forward progress on that step is therefore always two separate, explicit operator actions,
never one and never automatic:

1. **Resume** (`POST .../resume`) moves the run from `awaiting_intervention` back to `running`,
   rotates and validates `activeGeneration`, resets the circuit breaker, and — as of Phase 15.6 —
   rebuilds the scheduler's in-memory dependency index from the approved plan version (closing the
   gap a genuinely fresh cross-process scheduler instance would otherwise hit; see "Known
   Phase-15 limitations" for the two-cause root cause this closes). **Resume itself starts nothing
   and enqueues no automatic retry** — this is deliberate and unchanged from Phase 15.5, and is
   its own regression-tested property (a Resume that silently relaunched an abandoned step would be
   a far more dangerous bug than the one Phase 15.5 found).
2. **Retry step**, on the specific abandoned step, routes through
   `CeoPlanExecutionScheduler.retryAbandonedStep(runId, planStepId)` — reachable only from an
   explicit operator "Retry step" click (or the equivalent `POST .../steps/:stepId/retry` call),
   never from the automatic scheduler. It verifies, synchronously and with no `await` before the
   one atomic commit: the step belongs to the run; the run is `"running"` (i.e. already resumed);
   the step is `"awaiting_intervention"`; the linked task exists; the step's latest attempt is
   genuinely `"abandoned"` (never `"failed"` — that remains `#prepareTaskRetryIfEligible`'s job,
   unchanged, and still excludes restart-interrupted tasks for every automatic/ordinary caller);
   the task's own failure carries `HALL_RESTART_INTERRUPTED_RUN` specifically; the step's
   `attemptCount` is below `policySnapshot.maxAttemptsPerStep` (**the abandoned attempt itself
   counts toward this budget** — a deliberate bounded-recovery decision: a run configured at the
   protocol minimum of 1 has no in-place recovery path and must be cancelled and restarted instead;
   raise it to at least 2 if in-place recovery matters); a committed terminal event exists for the
   previous task run; the approved adapter/agent assignment is still present; and the scheduler's
   dependency index for this run exists (fails loudly if Resume never ran in this process instance,
   rather than silently dropping the signal). On success it first records the durable
   abandoned-retry intent row keyed to that exact abandoned attempt, appends one
   `ceo.execution.retry_requested` event attributed to `"human:local-operator"` (never the
   scheduler's own `system:ceo-scheduler` actor), and posts one dedup-gated Board summary keyed by
   the specific abandoned attempt being recovered. Only after that durable intent exists does it
   call the same `TaskOrchestrator.prepareRetry()` atomic, revision-CAS commit
   `#prepareTaskRetryIfEligible` already uses, persist/coalesce the `operator_manual_retry` signal,
   and hand off to the ordinary claim-then-launch tail — re-running `startTask()`'s full eligibility
   chain (adapter detection, capability/execution-trust evidence, workspace validation,
   revision/assignment CAS) and creating exactly one new attempt with exactly one new task-run ID.
   When that replacement attempt is claimed, the intent row is linked to the exact replacement
   attempt before any adapter launch is attempted. The old provider process and the old task-run ID
   are never revived or reused; the abandoned attempt row and the original task-run ID's history are
   preserved unchanged.

   Crash boundaries after the operator click are recoverable: after intent recording but before
   task preparation, restart recovery prepares the task and continues from the intent; after task
   preparation but before signal/claim, recovery persists or coalesces the scheduler signal and
   drains it; after signal persistence but before claim, replay coalesces with the existing signal
   or claims exactly one replacement attempt; after replacement-attempt claim but before adapter
   launch, recovery preserves the unlaunched claimed attempt and starts that same attempt, rather
   than creating attempt 3. If adapter launch was already durably reached (the task has a run ID, or
   the attempt has a task-run ID), an unclean restart abandons that replacement attempt like any
   other interrupted provider attempt and does not relaunch it automatically. Another operator
   decision is required.

   A legacy partial state created before this hardening — task assigned, step
   `awaiting_intervention`, latest attempt `abandoned`, no replacement attempt, and no pending
   signal — is not auto-repaired, because the old schema has no durable proof that the operator
   clicked Retry. Recovery fails closed instead of guessing intent.

Every rejection throws `CeoPlanExecutionAbandonedRetryNotEligibleError` (409, a bounded,
pre-written safe reason — never raw error text, a path, an owner token, or a revision/epoch value)
— a loud, explicit rejection, never a silent no-op, since this is always an explicit operator
request. There is no generic "reset failed task" REST route, and no browser-suppliable input can
choose the failure classification, actor, attempt status, or recovery reason.

## Composition wiring — `ceo-plan-execution-composition.ts`, `mock-agent-composition-root.ts`

`createCeoPlanExecutionComposition` builds the plan-run store, signal store, and scheduler on top
of the exact same `taskStore`/`taskOrchestrator`/`boardStore`/`messageStore` instances Phase 14's
`ceoPlans` composition already uses — never a second, competing set.

The task-mutation bridge (`createCoreStoresComposition`'s `onTaskMutated` callback) forwards to
`scheduler.onChildTaskMutated` **only** on a terminal child-task status transition
(`completed`/`failed`/`cancelled`) — the only transition the scheduler itself ever acts on — and
**only after** `ServerComposition.activateAutonomousScheduling()` has been called. That function is
deliberately not invoked automatically inside composition; `server.ts` calls it only after
`runCeoPlanExecutionRecovery` has finished deciding what to do with every previously-configured
run, closing the ordering hazard described above. In ephemeral mode (no `--data-dir`), there is no
restart sequence at all, so recovery is a harmless no-op and the bridge is armed immediately.

## Durable ownership fencing and in-memory atomicity

Every durable mutation goes through `withTransaction`, reused (not reimplemented) from Phase 13.2,
reentrant via `SAVEPOINT` so a scheduler operation that spans multiple store calls (e.g.
`claimAttempt`'s attempt-insert + step-projection-update) composes atomically without this module
exposing a generic transaction API. Ephemeral-mode atomicity for the plan-run and signal stores
comes from each store's own single-threaded, no-`await`-gap mutation methods, plus their
`snapshot()`/`restore()` pairs, which **are** wired into `createEphemeralAtomicUnit`'s cross-store
coordinator: `ceo-plan-execution-composition.ts` constructs it as
`createEphemeralAtomicUnit({ planRunStore, signalStore })`, and `CeoPlanExecutionScheduler` routes
every multi-write span (including `claimAttempt`) through it as `SchedulerDeps.runAtomicUnit`. See
the `claimAttempt` bullet above for the regression test proving this closes the gap.

## Testing performed this session

- `packages/protocol/src/ceo-execution.test.ts` — 48 tests covering every schema, bound, and
  actor/field-leak rejection.
- `migrations.ceo-execution.test.ts` — 7 raw-SQL tests proving the two partial unique indexes.
- Shared contract-test suites (`ceo-plan-run-store.contract.ts`, 20 cases;
  `execution-signal-store.contract.ts`, 17 cases) run against both in-memory and SQLite backends —
  74 tests total, both backends passing identically.
- `ceo-plan-step-readiness.test.ts` — 10 tests, including explicit operation-count assertions.
- `ceo-plan-execution-scheduler.test.ts` — 21 tests against a real `TaskStore`/`TaskOrchestrator`/
  `AgentRegistry` (never a mocked orchestrator), including a genuine two-worker concurrent-claim
  race producing exactly one attempt, and the two `emergencyStop` tests added this session. This
  covers manual-vs-autonomous mode, concurrency/adapter-capacity limits, dependency ordering,
  failure/pause/resume/cancel/emergency-stop, and idempotent re-processing — it does not attempt
  the kickoff's full enumerated 29-scenario list one-for-one, and does not include the ≥10×
  duplicate-signal or ≥10× concurrent-claim repeated-run requirement from "Final verification."
- `ceo-plan-execution-recovery.test.ts` — 5 tests covering unclean-restart pause/abandon/dedup,
  clean-restart continuation, a missing-plan-version fail-closed path, and idempotent repeat
  calls.
- `mock-agent-composition-root.test.ts` — 8 tests, including two end-to-end composition-root
  integration tests: one proving the real task-mutation bridge drives an autonomous run to
  completion with no test code calling `onChildTaskMutated` directly, and one proving the bridge
  stays inert before `activateAutonomousScheduling()` is called.
- Full workspace `pnpm -r run typecheck` and `pnpm -r run test` — clean (server: 83 files / 1132
  passed / 1 skipped; all seven other workspace packages passing; one stale pre-existing test bug
  in `ceo-execution.test.ts` — an obsolete `"pausing"` status the schema was deliberately never
  given — fixed as part of this verification pass).
- `pnpm run verify:process-recovery` — all 4 process-level tests passed against the real server
  binary, real SQLite, and real crash/kill scenarios (interrupted-run restart, hard-crash restart,
  frozen-owner takeover, concurrent-instance rejection) — confirming this phase's `server.ts`
  changes do not regress Phase 13's durable-restart guarantees.

### Phase 15.6 addendum — explicit abandoned-step recovery

- `ceo-plan-execution-abandoned-retry.test.ts` (new) — 15 scheduler-unit tests against a real
  `TaskStore`/`TaskOrchestrator`/`AgentRegistry` and a `"cancellable"` Mock Agent scenario:
  Resume-alone-starts-nothing, Retry-before-Resume rejected, Resume-then-Retry creates attempt 2
  with a new task-run ID, cumulative event sequencing, duplicate/concurrent Retry produce exactly
  one recovery, assignment-drift/cancelled/completed/wrong-failure-code/cross-run rejections, no
  raw-error leakage, and exactly-once event/Board-audit.
- `composition/ceo-plan-execution-durable-restart.test.ts` — one new integration test on a
  genuinely fresh, second `CeoPlanExecutionComposition` instance that never configured the run
  itself, proving the `/resume`-route dependency-index rebuild is what makes cross-process recovery
  possible at all (fails without it).
- `routes/ceo-plan-runs.test.ts` — one new REST-level test proving `POST
.../steps/:stepId/retry` branches correctly on the latest attempt's status, through the real
  `reconcileTasks()` crash-classification path, over HTTP.
- All three files together (38 tests) run 10/10 consecutive times, clean.
- `apps/e2e/tests/ceo-plan-execution-unclean-restart.spec.ts` — extended with the Resume-then-Retry
  browser workflow through to the replacement attempt's genuine natural completion; run 5/5
  consecutive times. `apps/e2e/tests/ceo-plan-execution-clean-restart.spec.ts` re-run 3/3
  consecutive times to confirm no regression.
- See `docs/architecture/0015-security-review-matrix.md` scenario 23 for the full citation list
  tying each of the four required sub-points (unclean restart starts nothing automatically; Resume
  alone starts nothing; explicit Retry is required; explicit Retry creates exactly one replacement
  attempt) to a specific test.

## Known Phase-15 limitations (current)

Most of what an earlier revision of this section listed as "not built" now exists — REST API,
WebSocket publish-after-commit, the Hall Web execution section and its operator dialogs, Kanban
execution badges, dedicated retry/circuit-breaker/efficiency/durable-restart test suites, and a
dedicated WebSocket verification suite are all implemented and tested. What remains genuinely
open, as of this revision:

- **Cross-run adapter-capacity wakeup — fixed.** A step blocked with `readinessReason:
"waiting_for_capacity"` used to be re-evaluated only by a signal for its OWN run, so a
  DIFFERENT run's step blocked on the same shared adapter was never woken when some other run's
  task on that adapter freed a slot — a genuine starvation bug, discovered via
  `routes/ceo-plan-run-events.test.ts`'s two-run isolation test (whose first version deadlocked
  run B behind run A's completed capacity claim until the test was temporarily changed to give
  each run its own `adapterConcurrencyOverrides` slot; that test still uses dedicated slots
  because its purpose is stream isolation, not capacity contention). Closed by adding a bounded
  `adapterId -> runId -> stepIds` capacity-waiter index in `ceo-plan-execution-scheduler.ts`,
  populated only when `#tryAdvanceStep` actually parks a step for capacity and cleared on its next
  re-evaluation — a task reaching a terminal state now enqueues a targeted, per-step
  `adapter_availability_changed` signal (an existing protocol trigger reason that previously had no
  producer) to exactly the other runs/steps waiting on that adapter, and only those. No full
  run/step scan: the fix is a no-op when nobody is waiting. Regression-tested in
  `ceo-plan-execution-scheduler.test.ts` ("...is woken (not starved)...") — confirmed to fail
  without the fix and pass with it — and confirmed not to regress the §12 efficiency budget
  (`ceo-plan-execution-efficiency.test.ts`, test A).
- **Step-execution reconciliation after a run leaves "running" — fixed.**
  `onChildTaskMutated`'s guard used to require `run.status === "running"` before it would record a
  child task's terminal status into its step-execution row. But `emergencyStop()` (and a plain
  pause, and cancel-future-scheduling) all move the run off `"running"` synchronously, before the
  cancellation/completion they trigger actually resolves — so a step's terminal-status
  reconciliation arriving after any of those transitions was silently dropped forever, leaving the
  step-execution row stuck on `"running"` even after the underlying task had genuinely finished.
  Reproduced via a real browser-driven Playwright run (`ceo-plan-execution-intervention.spec.ts`'s
  emergency-stop test), not just a unit test — the unit harness never exercises the real
  notification bridge closely enough to hit this. Fixed: the guard now allow-lists `"running" |
"paused" | "awaiting_intervention"` (never `"configured"`, see the dedicated regression test for
  why); only the _consequential_ logic (auto-drain, retry scheduling, circuit-breaker trip,
  pause-for-intervention) stays gated on `run.status === "running"`, so a paused/stopped run is
  never silently resumed or advanced as a side effect of reconciling a step's own final status.
  This does not weaken the unclean-restart rule below — `awaiting_intervention` reconciliation
  still never enqueues a signal or auto-drains. Regression-tested in
  `ceo-plan-execution-scheduler.test.ts` (two tests: one proving the fix, one proving `"configured"`
  stays excluded) — both confirmed to fail against the pre-fix guard and pass against the fix.
- **Transient-failure misclassification through the real mutation-hook bridge — fixed, and see the
  new limitation below.** `TaskOrchestrator#handleEvent`'s `"run.failed"` case used to call
  `taskStore.updateStatus(taskId, "failed")` before `taskStore.setCompleted(taskId, ...,
failure)` — two independently-notifying calls under `wrapTaskStoreWithMutationHook`. The first
  notification fired with the task already `"failed"` (terminal, so the bridge forwarded it) but
  `.failure` still `undefined`, so `CeoPlanExecutionScheduler#handleChildTaskFailure` fell back to
  `{retryable: false}` and classified every genuinely transient failure as permanent — and because
  the step then landed on `"failed"` (one of `onChildTaskMutated`'s own idempotency-guard terminal
  statuses), the second, correctly-populated notification was silently discarded. Net effect:
  automatic transient retry was structurally non-functional for every real failure in the live
  system, invisible to the 23-test unit suite (which manually calls `onChildTaskMutated` once, well
  after both store calls have already settled, and never wires the real bridge). Fixed by
  reordering all three terminal cases in `task-orchestrator.ts` to call `setCompleted` before
  `updateStatus`, so the one notification the bridge actually forwards always carries complete
  data. Regression-tested in `mock-agent-composition-root.test.ts` (fails pre-fix, passes post-fix)
  via a new test-only `mockFailureRetryable` composition option.
- **Retry deadlock — fixed (Phase 15.2).** A correctly-classified transient failure used to reach a
  real forward-progress dead end: `#tryAdvanceStep` requires `taskRecord.task.status === "assigned"`
  before it will call `TaskOrchestrator.startTask()`, but a task that had genuinely run and reached
  `"failed"` never satisfied that, and nothing ever reset it back — a `retry_wait` step whose
  backoff had elapsed stayed wedged there forever, with no automatic or even effective manual path
  forward. Root cause captured precisely: three independent, stacked blockers — (1) the scheduler's
  own `taskRecord.task.status !== "assigned"` preflight guard; (2) `TaskStore.updateStatus()`'s
  transition table, which has no `failed -> assigned` edge at all (deliberately still doesn't —
  see below); (3) `EventStore`'s reserved-terminal-slot invariant, which rejects any event for a
  `taskId` once a terminal event is recorded, regardless of `runId`, so even a hypothetical direct
  status flip would immediately fail attempt 2's first `run.started`. Closed by a new governed-retry
  path: `TaskOrchestrator.prepareRetry(taskId)` atomically resets a genuinely `"failed"` task back
  to `"assigned"` (via the new `TaskStore.prepareRetryIfEligible()`, an `assignIfEligible()`-shaped
  revision/four-field-CAS commit) and reopens the task's event stream (`EventStore.
reopenForRetry()`, ABA-guarded by the terminal event's own sequence number) so a brand-new run can
  append starting exactly where attempt 1 left off — never resetting to sequence 0, never touching
  attempt 1's own history. `prepareRetry()` deliberately never re-verifies launch eligibility itself
  (that stays `startTask()`'s sole authority, run immediately after); `CeoPlanExecutionScheduler.
#prepareTaskRetryIfEligible()` verifies the 12 further plan/attempt/circuit/classification-level
  preconditions (task linked to the exact run/step, previous attempt genuinely terminal, safe
  failure classification permits retry, attempts below policy, circuit closed, run still running,
  never a restart-interrupted task, approved assignment still matches) before ever calling it, and
  cancels any other obsolete signal queued for that same step first. `failed -> assigned` is
  deliberately still ABSENT from `TaskStore`'s general transition table — `updateStatus()` must keep
  rejecting it unconditionally (a real, tested safety property); `prepareRetryIfEligible()` is the
  one narrow, independently-gated exception, never reachable from a generic route. Along the way,
  two further real, pre-existing gaps were found and fixed, both load-bearing for this fix: (a)
  neither `onChildTaskMutated`'s completed/cancelled branches nor `#handleChildTaskFailure` ever
  called `updateAttempt()` for a task that genuinely ran to a terminal outcome — every
  `CeoPlanStepAttempt` row stayed stuck at `"running"` forever, which also meant "previous attempt
  terminal" could never be verified; (b) `upsertStepExecution()` (both backends) did a full-record
  replace that silently wiped `activeAttemptId` on every subsequent call unless the caller re-passed
  it (almost none did) — now preserved via the same `COALESCE`/`?? existing` fallback pattern
  `startedAt`/`completedAt` already used. Verified end-to-end (real scheduler, real
  `TaskOrchestrator`, real fixture adapter, real mutation-hook bridge, not a direct classifier unit
  call) in `ceo-plan-execution-retries.test.ts` — a transient failure reaches a genuine attempt 2
  with a new run ID and preserved attempt-1 history, both when attempt 2 also fails and when it
  succeeds — and, separately, that a fresh `TaskOrchestrator` instance sharing only a durable SQLite
  backend (simulating a real restart) still computes the correct event-sequence offset
  (`task-orchestrator.test.ts`). **Not yet done:** the full 16-scenario TOCTOU-adjacent launch test
  matrix, the 25-scenario retry-liveness matrix, and the ×10 repeated-run verification the Phase
  15.2 directive specifies (see the Phase 15.3 deferred-work entry above). The
  `ceo-plan-execution-retry-circuit.spec.ts` browser flake this note originally referred to has since
  been root-caused and fixed in Phase 15.3 (the retry-due wake mechanism entry above) — the spec now
  proves a real, automatic attempt 2 in the browser with 5/5 consecutive passes.
- **Capability/execution-trust evidence not re-verified at launch time — fixed (Phase 15.2).**
  `TaskOrchestrator#startTask()` used to claim `runId` and check only raw adapter `availability`
  before invoking the adapter — never re-calling `evaluateCandidateEligibility()` against the task's
  persisted `requirements`, and never re-comparing `executionTrust` against the snapshot taken at
  assignment. If an adapter's declared capabilities or trust level degraded in the window between
  assignment and actual launch — plausible under Phase 15, since dependency-gated scheduling can
  leave a task genuinely `"assigned"` for a meaningful period — the step still launched. Fixed:
  `startTask()` is now structured exactly like the already-correct `assignTask()` — snapshot
  `expectedRevision` and a four-field ABA struct BEFORE any `await`, re-run `adapter.detect()`,
  re-run `evaluateCandidateEligibility()` against current requirements/capabilities/execution-trust,
  then commit the launch reservation in one atomic, no-`await`-gap call
  (`TaskStore.startIfEligible()`) that independently re-derives the launch invariant from the LIVE
  record and rejects on any revision/status/assignment/run-id drift. This is now the single
  authoritative launch boundary for every caller — manual `POST .../start` and the CEO autonomous
  scheduler both go through it, and no provider process starts before every check passes. Rejections
  surface as the same already-safe `AdapterUnavailableError` / `AdapterRequirementsMismatchError` /
  `TaskStateConflictError` the rest of the system already uses (never raw detection output, never a
  silent adapter substitution); the scheduler classifies a launch-time rejection as
  `requirements_changed` (never auto-retried) and cancels any other obsolete signal queued for that
  step. **Done (Phase 15.4):** the full 16-scenario injected-detection-barrier TOCTOU test suite the
  directive specifies, plus its ×10 repetition requirement — see the "Launch-time TOCTOU test matrix
  and store-contract tests" entry below for the concrete evidence.
- **`periodic_reconciliation` is not wired to any timer.** The trigger reason exists and the
  scheduler knows how to handle one if it ever arrives (treated as a plan-level "reconsider
  everything" signal), but nothing in composition ever actually fires it on an interval. This is
  the same underlying gap as the `retry_wait`-past-`nextEligibleAt` self-wake limitation noted
  below — both are instances of "nothing wakes a step that isn't blocked on ITS OWN run's own next
  signal" (the cross-run adapter-capacity instance of this same class is now fixed, above).
- **`retry_wait` past `nextEligibleAt` has no self-wake — fixed (Phase 15.3).** Root-caused via a
  temporary, env-gated trace (`HALL_RETRY_TRACE`, removed once diagnosis was complete) added to an
  ad hoc Playwright poll (`_diag-retry.spec.ts`, deleted once diagnosis was complete): a `retry_wait`
  step's backoff elapsing produced no event of any kind, so the scheduler — event-first by design,
  with no polling loop — never reconsidered it until some unrelated signal for that run happened to
  arrive. Closed with the smallest correct event-driven fix: both retry-scheduling branches
  (`#handleChildTaskFailure`, `#handleStartFailure`) now enqueue a durable, delayed `"retry_due"`
  signal (`delaySeconds: policy.retryBackoffSeconds`) at the moment a step enters `retry_wait`, and
  a single injectable one-shot wake timer (`SchedulerDeps.scheduleWake`/`cancelWake`, defaulting to
  real `setTimeout`/`clearTimeout`; a new `ExecutionSignalStorePort.nextPendingAvailableAt()` method
  on both backends locates the soonest-due pending signal across ALL runs) rearms itself — never one
  timer per task — on every signal insert, fires `#drain()` once, and cancels cleanly on
  `scheduler.stop()` (wired into `runControlledShutdown`) or on the store closing under it (the
  rearm-after-fire callback swallows a `DatabaseClosedError` from tests that close the SQLite store
  directly without calling `stop()` — `stop()` remains the correct way to cancel deliberately).
  `scheduler.start()` is called from `activateAutonomousScheduling()`, so no wake timer exists before
  restart recovery has finished. Regression-tested in `mock-agent-composition-root.test.ts` ("a
  retry_wait step reaches attempt 2 on its own once the backoff elapses, with no manual nudge of any
  kind") and proven live in the browser in `ceo-plan-execution-retry-circuit.spec.ts` (below) — 5/5
  consecutive passes, zero Pause/Resume or manual retry action taken by the test at any point.
  Alongside this, a second, narrower staleness gap was found and hardened defensively but never
  deterministically reproduced in isolation: `#handleChildTaskFailure`'s atomic block used to
  finalize the attempt row via `stepExecution.activeAttemptId`, a snapshot `onChildTaskMutated` took
  at its own entry, before the atomic block actually runs; it now re-reads `activeAttemptId` fresh
  from the store immediately before using it (same pattern applied to the `completed`/`cancelled`
  branches). Treat this as a structural fix for a plausible race, not a confirmed-and-verified one —
  the 5/5 browser passes are evidence for the wake-mechanism fix, not for this one.
- **UI refresh race — fixed (Phase 15.3).** `ceo-plan-execution-section.tsx`'s `refresh()` issued
  three sequential awaited fetches per call with no guard against an older in-flight `refresh()`
  call's response landing after a newer one — a slow response to a stale `planId`/version could
  overwrite state a newer, faster call had already set. Fixed with a monotonic generation counter
  (`refreshGenerationRef`) captured at call entry and checked after every `await`; a stale call's
  response is discarded rather than applied. Verified with a negative control: removing the guard in
  the new test ("discards a stale refresh response that resolves after a newer one already landed")
  makes it fail; restoring the guard makes it pass.
- **Circuit breaker cannot trip above threshold 1 from a single step's own automatic retries — fixed
  (Phase 15.4).** Root cause exactly as previously diagnosed: `#tryAdvanceStep` called
  `planRunStore.recordCircuitProgress(run.id)` immediately after every successful launch, zeroing
  `consecutiveFailures` before that attempt even ran, so a single step's own repeated automatic
  retries could never accumulate more than 1 consecutive failure at evaluation time. **A successful
  launch is activity, not durable progress.** Fixed by deleting that call site entirely; the ONE
  place a failure streak legitimately resets is `onChildTaskMutated`'s `"completed"` branch, where
  the step's child task has actually, durably finished — never on attempt creation, signal creation,
  `retry_due` becoming available, scheduler claim, task launch, a task-run-ID change by itself, a
  timestamp, a Board message, a WebSocket refresh, or an operator opening a dialog. Final semantics:
  - **On terminal failure:** `consecutiveFailures` always +1. `consecutiveSameCodeFailures` +1 if the
    new failure's CLASSIFICATION (`transient`/`permanent`/`security`/... — never the adapter's raw,
    per-provider `failure.code` string, which is unbounded and not "safe") matches the previous
    failure's classification, else resets to 1. `noProgressAttempts` +1 if the new progress
    fingerprint (`computeProgressFingerprint`) is identical to the immediately preceding failure's,
    else resets to 0.
  - **On meaningful progress** (a step reaching `"completed"`): all three counters reset to 0.
  - **On attempt launch, retry-due becoming available, dependency/capacity waiting, or manual pause:**
    no counter is touched at all — verified explicitly in the Phase 15.4 unit matrix (below).
  - **On operator Resume:** `resetCircuit()` is the one explicit, governed reset operation — already
    existed pre-Phase-15.4, called only from `resumeRun()` (an explicit operator action), never from
    any automatic scheduler path. This satisfies "no silent reset on Resume" without requiring a new
    mechanism.
  - **`consecutive_same_code_failures` trip reason unreachable — fixed (Phase 15.5).**
    `evaluateCircuitBreaker` used to check `consecutive_failures` before
    `consecutive_same_code_failures`, and by construction `consecutiveSameCodeFailures <=
consecutiveFailures` always holds (both reset together on progress; same-code only ever matches
    or falls behind). Under the shared `maxConsecutiveFailures` threshold, this ordering meant a trip
    whose failures all shared one classification always reported `reason: "consecutive_failures"` —
    `"consecutive_same_code_failures"` could never structurally be returned, making it a dead branch
    even though the counter itself was tracked and exposed correctly. This is a genuine, previously
    undiscovered bug, not a documentation gap: the field was live in the public policy/evaluation
    contract but its own trip reason was unreachable. Fixed by checking
    `consecutiveSameCodeFailures` first — no schema or policy-threshold change needed; both trip
    reasons are now reachable under the existing single-threshold shape. Regression-tested in
    `ceo-plan-execution-circuit-breaker.test.ts` (priority-order test reworked, plus a new dedicated
    same-code-reachability test) and `ceo-plan-execution-circuit-breaker-semantics.test.ts` (test 4
    now asserts the correct trip reason) — 18/18 and 39/39 respectively, 216/216 across all
    `ceo-execution` test files.
  - **Known nuance — valid documented limitation, re-confirmed (Phase 15.5).** The no-progress
    fingerprint baseline (`#progressFingerprints`) is an in-memory `Map` on the scheduler instance,
    not itself persisted — circuit STATE and COUNTERS survive a durable restart (proven below), but
    the very first post-restart failure always computes `isNoProgress: false` (no previous
    fingerprint to compare against), same as the very first failure of a fresh run. This is an
    **advisory** signal only: it resets one soft heuristic (`noProgressAttempts`), never the durably
    persisted `consecutiveFailures`/`consecutiveSameCodeFailures` counters or trip state, so a
    genuinely stuck loop of identical failures across a restart still trips the circuit via
    `consecutive_failures` (or `consecutive_same_code_failures`, now reachable per the fix above) —
    it just cannot ALSO trip via `no_progress_retries` on the very first post-restart attempt. Not
    fixed this session, and not a checkpoint blocker: the in-memory reset narrows one advisory
    detector, it does not weaken any enforced/durable threshold.

  **Unit/integration evidence (Phase 15.4):** `ceo-plan-execution-circuit-breaker-semantics.test.ts`,
  18 scenarios matching the session directive's numbered list 1:1 (threshold 2 launch-doesn't-reset,
  threshold 3, failure/success/failure, same-code, different-codes-via-classification, no-progress,
  attempt-launch/retry-wait/dependency-wait/capacity-wait/manual-pause non-mutation, duplicate
  terminal notification, duplicate `retry_due` signal, single circuit-open event, single Board
  summary, open-circuit blocks further claims, security failure never auto-resets, durable-restart
  survival) — 18/18 passing across 10 consecutive runs.

  **Browser evidence (Phase 15.4):** `ceo-plan-execution-retry-circuit.spec.ts`'s second test —
  `maxConsecutiveFailures: 2`, the `"CEO Execution Fixture (transient failure)"` adapter (always
  fails, `retryable: true`, same safe code every attempt — never the old threshold-of-1 workaround).
  Attempt 1 fails automatically; attempt 2 launches automatically after backoff with a genuinely new
  task-run ID (attempt 1: `cad21067-ffa4-492a-b64b-ade5f23d72d0`, attempt 2:
  `71e866e4-7127-4960-82b9-6b6324fd324a`); attempt 2 fails; the circuit opens at exactly 2, the run
  moves to `awaiting_intervention`, exactly one `ceo.execution.circuit_opened` event and one bounded
  Board alert are recorded, and no third attempt ever appears within a bounded observation window (a
  full further backoff period). No Pause/Resume, no manual retry, no synthetic clicks. 5/5
  consecutive passes on the final build.

  **Operational note surfaced by this fix:** the E2E fixture server runs `node dist/fixture-server.js`
  (a compiled artifact, not source), and Playwright's `reuseExistingServer` can mask a stale build —
  an earlier verification pass in this session initially appeared to reproduce the OLD bug in the
  browser even after the source fix landed, purely because `apps/server`'s `dist/` predated the edit.
  `pnpm build` (or at least `pnpm --filter @hall-of-wisdom/hall-core run build`) must run before any
  E2E verification that depends on a just-changed `apps/server` source file.

- **Attempt rows never closed out except via the start-failure path — fixed (Phase 15.2), stale
  documentation corrected (Phase 15.5).** This bullet previously described the underlying
  `CeoPlanStepAttempt` row staying `status: "running"` forever once a task finished any other way
  (normal completion, a circuit trip, a retry) — but that is the same bug already fixed as
  sub-finding (a) of the "Retry deadlock" entry above (`onChildTaskMutated`'s completed/cancelled
  branches and `#handleChildTaskFailure` now all call `updateAttempt()`). This bullet had simply
  never been removed after that fix landed. Re-verified this session by grepping
  `ceo-plan-execution-scheduler.ts` for `updateAttempt(`: it is called on launch (`"running"`), on
  the `"completed"` branch, on the `"cancelled"` branch, and on the failure path (`"failed"`) — no
  remaining path leaves an attempt row stuck. `listAttempts` is a reliable "is this attempt still
  active" signal.
- **Resolved (Phase 15.6) — explicit operator recovery now relaunches a genuinely-abandoned
  `awaiting_intervention` step after an unclean restart.** Phase 15.5 found that neither Resume nor
  manual "Retry step" relaunched such a step, and named a single root cause
  (`#prepareTaskRetryIfEligible` gating exclusively on `step.status === "retry_wait"`). That
  diagnosis was correct but incomplete: there were **two independent, compounding causes**, both of
  which had to be fixed for in-place recovery to work at all:
  1. `CeoPlanExecutionScheduler.#prepareTaskRetryIfEligible` — the only path that called
     `TaskOrchestrator.prepareRetry()` to reset a task back to `"assigned"` and reopen its event
     stream — gated exclusively on `step.status === "retry_wait"`; a step abandoned by
     unclean-restart recovery is `awaiting_intervention`, a status that path never handled.
  2. **A resumed run after an unclean-restart pause had no dependency index in a freshly-restarted
     scheduler process.** `registerDependencyIndex` was only ever called from the plan-run
     configure route and from clean-restart recovery; a resume after a genuine process restart with
     no intervening clean-restart recovery pass had no index to schedule against, so even a
     hypothetical fix to cause (1) alone would still silently fail on a real cross-process restart
     — exactly the scenario this whole feature exists for.
     The fix, in two parts:
  - `CeoPlanExecutionScheduler.retryAbandonedStep(runId, planStepId)` — a new, narrow,
    explicit-operator-only method (never called by the automatic scheduler, never called by
    `resumeRun()`) that verifies the step's latest attempt is genuinely `"abandoned"` (never
    `"failed"` — that remains `#prepareTaskRetryIfEligible`'s job, unchanged), the task carries
    `HALL_RESTART_INTERRUPTED_RUN`, a committed terminal event exists, the approved assignment is
    still present, and the run's `maxAttemptsPerStep` budget is not already exhausted (**the
    abandoned attempt itself counts toward that budget** — a deliberate bounded-recovery decision,
    not an oversight; a run configured at the protocol minimum of 1 has no in-place recovery path
    and must be cancelled and restarted). On success it first records or reuses a durable
    abandoned-retry intent keyed to that exact abandoned attempt. That intent, not a Board message
    and not inferred task assignment state, is the authoritative proof that a human operator
    requested continuation. It then appends one `ceo.execution.retry_requested` event attributed to
    `"human:local-operator"` (never the scheduler's own actor), posts one dedup-gated Board summary,
    prepares the task if needed, persists/coalesces a scheduler signal, and hands off to the
    ordinary claim-then-launch tail — re-running `startTask()`'s full eligibility chain (adapter
    detection, capability/execution-trust evidence, workspace validation, revision/assignment CAS)
    and creating at most one replacement attempt with at most one new task-run ID.
  - The `/resume` REST route (`routes/ceo-plan-runs.ts`) now rebuilds the scheduler's in-memory
    dependency index from the approved plan version immediately after `resumeRun()` succeeds,
    closing cause (2) — the exact gap a genuinely fresh cross-process scheduler instance would
    otherwise hit.
    Manual "Retry step" (`POST .../steps/:stepId/retry`) branches on the step's latest attempt status:
    `"abandoned"` routes through `retryAbandonedStep()`; anything else routes through the unchanged,
    ordinary `#prepareTaskRetryIfEligible`/`enqueueSignal` path. Proven at three layers — scheduler
    unit tests (`ceo-plan-execution-abandoned-retry.test.ts`, including crash-boundary and
    adapter-count coverage), REST tests (`routes/ceo-plan-runs.test.ts`), and a browser-level
    Playwright spec (`ceo-plan-execution-unclean-restart.spec.ts`); see
    `docs/architecture/0015-security-review-matrix.md` scenario 23 for the broader citation list.
- **Clean/unclean restart browser coverage — done (Phase 15.5), extended (Phase 15.6).** Two
  dedicated Playwright specs exist: `apps/e2e/tests/ceo-plan-execution-clean-restart.spec.ts`
  (graceful shutdown, restart with identical config, reconnect without a page reload,
  byte-identical state with no duplication, automatic continuation of the next step, exactly-once
  terminal event) and `apps/e2e/tests/ceo-plan-execution-unclean-restart.spec.ts` (force-kill,
  restart, Phase 13 interrupted-run recovery, `HALL_RESTART_INTERRUPTED_RUN`,
  `awaiting_intervention` pause, exactly-once recovery event/Board summary never duplicated on a
  second unattended restart, Resume-alone-starts-nothing, and — as of Phase 15.6 — explicit
  Retry-step recovery through to genuine natural completion of the replacement attempt, with a new
  task-run ID and a preserved abandoned-attempt history row). Unclean-restart passes 5/5
  consecutive runs, clean-restart passes 3/3. Three real,
  previously-latent bugs were found and fixed while building this coverage, all load-bearing for the
  fixture composition's fidelity to production, none of which change scheduler/orchestrator
  behavior itself:
  - `apps/e2e/src/fixture-server.ts` never called `scheduler.start()`, so the durable retry-due wake
    timer (Phase 15.3) was inert in this composition — a `retry_wait` step parked before a restart
    would never resume on its own in the E2E fixture, even though production always arms it. Fixed
    by calling it after composition, matching `server.ts`.
  - `createCeoExecutionTransientThenSuccessAdapter`'s "have I already failed once" tracking used an
    in-memory `Set`, which reset on a fixture-server process restart — any future restart-spanning
    retry-success scenario would have silently broken. Fixed by persisting the marker to a file
    keyed by `taskId`.
  - Communication Boards are explicitly ephemeral/in-memory (ADR: "Local-only, in-memory — boards
    and messages are cleared when Hall Core restarts"), so a Board-message count is not a valid way
    to prove "not duplicated across a restart" once a SECOND restart is involved — the first
    restart's message does not survive to be counted against. The unclean-restart spec's dedup check
    was corrected to use the durable execution-event log (`ceo.execution.recovery_paused` /
    `ceo.execution.paused` counts via REST) as the authoritative source, with the Board-message
    assertion relaxed to `<= 1` (best-effort, not authoritative). This was a genuine architectural
    discovery made while writing the spec, not a known fact going in.
- **Launch-time TOCTOU test matrix and store-contract tests — done (Phase 15.4).** All 16 named
  launch-time TOCTOU scenarios (normal-eligible baseline; adapter unavailable; capability/trust
  degradation; task requirements/status/adapter/agent drift while `detect()` is pending; the ABA
  test — revision-gated, proven to reject even when status/runId/adapterId/agentId all return to
  their original values; a competing run ID appearing; an invalid working directory; manual-start
  and autonomous-scheduler-start both routing through the identical `startIfEligible` guard; trusted-
  local rejected for isolated-only requirements; simulated execution rejected when forbidden; a
  frozen/stale durable owner rejected by the ownership fence, never merely `TaskStateConflictError`)
  are covered in `task-orchestrator-launch-toctou.test.ts` and
  `task-orchestrator-launch-toctou-entrypoints.test.ts`, using a purpose-built barrier adapter
  (`detect()` parks until released, with per-call configurable availability/capabilities/execution-
  trust) modeled on `test-support.ts`'s existing `createGatedAdapter` pattern. Every rejected
  scenario asserts: `startTask()`/`execute()` was never called, no `run.started` event was ever
  recorded, no successful launch, no adapter substitution, and a bounded safe error with no
  revision/lease/owner-token/epoch/path leakage. 16/16 passing across 10 consecutive runs.

  The `TaskStore.startIfEligible` / `TaskStore.prepareRetryIfEligible` / `EventStore.reopenForRetry`
  shared behavioral contracts are extended in `task-store-contract.ts` and `event-store-contract.ts`
  (the same pattern every other storage port in this codebase already uses — one shared `describe`
  function, wired against both the in-memory and SQLite backends by the existing `*.contract.test.ts`
  files, so both backends are proven behaviorally identical with no duplicated test code): exact-
  snapshot success, stale-revision/status/runId/adapterId/agentId rejection, active-run rejection,
  non-eligible-status rejection, revision +1 on success and +0 on rejection, exactly-one-of-two-
  competing-calls-wins, no partial state on a rejected call, and (for `reopenForRetry`) history
  preservation, cumulative never-reset sequencing, and strictly-increasing attempt-2 sequence numbers.
  156/156 passing across 10 consecutive runs, both backends. "Durable restart preserves reopened
  state" is intentionally not exercised at this shared-contract level (the contract functions cannot
  hold one physical SQLite connection across two store instances) — that guarantee is covered
  separately by `ceo-plan-execution-durable-restart.test.ts` and the `process-tests/` suite.

- **Full security-review checklist** (~35 named scenarios) — see this phase's final report for the
  scenario-by-scenario matrix; most are protected structurally (by schema, by store-level fencing,
  by the port-interface boundary) rather than by a scenario-specific test written for this pass.
- Also out of scope for the phase as a whole, per the original kickoff (not session-specific
  gaps): automatic replanning, dynamic step creation, step skipping, adapter reassignment after
  approval, model-backed CEO reasoning, cost/token budget enforcement, provider billing
  integration, agent-to-agent negotiation, multi-node/distributed scheduling, cloud sandbox
  scheduling, agent org hierarchy, recurring routines/cron, GitHub/Azure DevOps integration,
  automatic merge/commit/push, outcome-quality verification, artifact approval.
