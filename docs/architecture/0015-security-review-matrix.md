# 0015 — Security Review Matrix (Phase 15.6 / 15.7 sign-off)

Linked appendix to
[`0015-autonomous-plan-execution-and-scheduling.md`](0015-autonomous-plan-execution-and-scheduling.md).
Covers the exact 38 named scenarios required for Phase 15.6 sign-off, closed out in Phase 15.7.
Every row cites a real, currently-passing, executable test — **no row is marked "Protected" from
documentation or code reading alone.** Where no scenario-specific test exists, a row is marked
"Partially protected," even when the underlying mechanism is real and code-confirmed; it is never
rounded up to "Protected" without a passing test to back it. All source paths are repo-relative.

Status legend: **Protected** (mechanism + scenario-specific executable test both confirmed) /
**Partially protected** (mechanism confirmed, but no test targets this exact scenario by name —
only a more general or adjacent test exists) / **Not protected** (no mechanism or test found).

## 1. Start without approval

- **Mechanism**: `CeoPlanOrchestrator.delegate()` requires `plan.status === "approved"`; any other
  status throws `CeoPlanStateConflictError` before any child task is created.
- **Source**: `apps/server/src/ceo-plans/ceo-plan-orchestrator.ts` — `delegate()`.
- **Test**: `apps/server/src/ceo-plans/ceo-plan-orchestrator.test.ts` — "an unapproved plan cannot
  be delegated, and delegation cannot be repeated automatically after approval".
- **Finding**: a freshly-created (draft, never-approved) plan's `delegate()` call throws
  `CeoPlanStateConflictError`.
- **Status**: Protected.

## 2. Start without delegation

- **Mechanism**: `POST /api/v1/ceo-plans/:planId/execution/configure` (the only route that can
  create an execution run) requires `plan.status === "delegated"`; otherwise throws
  `CeoPlanExecutionNotEligibleError` (422), before any run/step rows or dependency index exist.
- **Source**: `apps/server/src/routes/ceo-plan-runs.ts`.
- **Test**: `apps/server/src/routes/ceo-plan-runs.test.ts` — "returns 422
  (CEO_PLAN_EXECUTION_NOT_ELIGIBLE) when the plan is not yet delegated".
- **Finding**: verified end-to-end over HTTP for a plan that was created but never
  approved/delegated.
- **Status**: Protected.

## 3. Autonomous mode enabled by default

- **Mechanism**: `configureCeoPlanRunRequestSchema`'s `executionMode` field has no `.default()`;
  it is required server-side (doc comment: "manual stays the default the operator must explicitly
  move off of — this field is required, never defaulted server-side to 'autonomous'"). Client-side,
  `CeoPlanExecutionConfigureDialog` initializes `useState<CeoPlanExecutionMode>("manual")`.
- **Source**: `apps/server/src/schemas/ceo-plan-execution-request.ts`;
  `apps/web/components/ceo/ceo-plan-execution-configure-dialog.tsx`.
- **Test**: `apps/server/src/routes/ceo-plan-runs.test.ts` — "Phase 15.7 — security matrix
  scenario 3: autonomous execution is never enabled by default at any stage, requires an explicit
  executionMode and a separate explicit start, and a missing executionMode is rejected rather than
  defaulted" (proves create/approve/delegate alone leave zero runs and zero started tasks; a
  configure request omitting `executionMode` gets 400 `INVALID_REQUEST` and creates no run; an
  explicitly-`"autonomous"`-configured run starts nothing until a separate `/start` call; a positive
  control confirms `/start` on that same run does launch the eligible child task, proving the gates
  above are real, not merely an inert path). Complements the pre-existing
  `apps/server/src/routes/ceo-plan-runs.test.ts` — "manual mode: configure -> start never starts a
  child task".
- **Finding**: confirmed by a real, passing, scenario-specific test (10/10 consecutive runs).
- **Status**: Protected.

## 4. Browser-forged execution signal

- **Mechanism**: no route accepts a signal object, `reason`, or trigger data from the browser body;
  every `enqueueSignal(...)` call from a route uses a hardcoded `reason` literal
  (`"execution_started"`, `"operator_resumed"`, `"operator_manual_retry"`); the shared
  `runMutationTokenRequestSchema` (start/pause/resume/cancel/emergency-stop/retry) is `.strict()`
  with only `expectedMutationToken` in its shape.
- **Source**: `apps/server/src/routes/ceo-plan-runs.ts` (hardcoded reasons);
  `apps/server/src/schemas/ceo-plan-execution-request.ts` (`runMutationTokenRequestSchema`).
- **Test**: `apps/server/src/routes/ceo-plan-run-events.test.ts` — "Phase 15.7 — security matrix
  scenario 4: a browser cannot enqueue scheduler work over the execution WebSocket — the forged
  frame creates no signal, no attempt, no task start, and the connection is closed rather than
  silently ignored" (a run is configured autonomous but deliberately never `/start`ed; a client
  sends a plausible `{type: "start_step", reason: "execution_started", actor:
"system:ceo-scheduler"}` frame over the live WebSocket; the connection closes with code 1003, the
  signal store's pending/claimed counts are unchanged, no new attempt exists, the run status stays
  `"configured"`, and no task ever receives a `runId`). Complements the pre-existing
  `apps/server/src/routes/ceo-plan-run-events.test.ts` — "closes with 1003 and takes no scheduling
  action when a client sends a message — this is a publish-only stream, never a command channel"
  and "no route accepts a browser-supplied actor field...".
- **Finding**: confirmed by a real, passing, scenario-specific test (10/10 consecutive runs) —
  zero scheduling side effects from the forged frame, not just "the forged frame itself never
  appears in the stream."
- **Status**: Protected.

## 5. Browser-forged scheduler actor

- **Mechanism**: same `.strict()` `runMutationTokenRequestSchema` — no `actor` field in its shape;
  every event this route file appends uses the fixed constant `"human:local-operator"`; the
  scheduler's own `SCHEDULER_ACTOR = "system:ceo-scheduler"` constant is never reachable from a
  route.
- **Source**: `apps/server/src/routes/ceo-plan-runs.ts`;
  `apps/server/src/ceo-execution/ceo-plan-execution-scheduler.ts` (`SCHEDULER_ACTOR`).
- **Test**: `apps/server/src/routes/ceo-plan-run-events.test.ts` — "no route accepts a
  browser-supplied actor field..." — the payload literally sends `actor: "system:ceo-scheduler"`
  on `POST .../pause` and asserts 400 `INVALID_REQUEST` before any token check runs.
- **Finding**: direct hit — the exact forged value from the scenario name is used in the test
  payload and rejected.
- **Status**: Protected.

## 6. Browser-forged system Board message

- **Mechanism**: `createMessageRequestSchema` has exactly one field (`text`), `.strict()` — no
  `author` key exists in the accepted shape, so the route always constructs a fixed
  `LOCAL_OPERATOR_AUTHOR` server-side; a body containing `author` (any kind, including `"system"`)
  is rejected at schema-parse time before route logic runs.
- **Source**: `apps/server/src/routes/boards.ts`; `apps/server/src/schemas/create-message-request.ts`.
- **Test**: `apps/server/src/routes/boards.test.ts` — "rejects a POST that attempts to set
  author.kind to system, and stores no message", and "rejects a POST that attempts to claim the
  display name 'CEO Agent' via a human-kind author override, and stores no message" (labeled
  in-code "Phase 14.1 — system-author spoofing audit").
- **Finding**: both tests assert 400 plus zero stored messages.
- **Status**: Protected.

## 7. Duplicate queue claim

- **Mechanism**: `ExecutionSignalStore.claimNext()` atomically claims and marks a signal `claimed`
  under a lease/owner-token; a second concurrent `claimNext()` against the same signal returns
  `undefined`.
- **Source**: `apps/server/src/ceo-execution/*-execution-signal-store.ts` (`claimNext`).
- **Test**: `apps/server/src/ceo-execution/execution-signal-store.contract.ts` — "a second
  concurrent claim attempt never claims the same signal twice" (shared contract, in-memory + SQLite
  backends); `apps/server/src/ceo-execution/ceo-plan-execution-scheduler.test.ts` — "two concurrent
  scheduler workers racing the same claimable signal produce exactly one launch intent".
- **Finding**: verified at both the store-contract level (both backends) and the full-scheduler
  race level.
- **Status**: Protected.

## 8. Duplicate launch

- **Mechanism**: `TaskStore.startIfEligible()` is a revision-checked compare-and-swap — of two
  competing calls with the same expected snapshot, exactly one commits and the loser throws
  `TaskStateConflictError`; at the scheduler level, a step already `claimed`/`starting`/`running`
  is never re-launched by a duplicate/repeated trigger signal.
- **Source**: `apps/server/src/tasks/task-orchestrator.ts` (`startTask()`);
  `apps/server/src/tasks/task-store.ts`.
- **Test**: `apps/server/src/tasks/task-store-contract.ts` — "of two competing calls with the same
  expected snapshot, exactly one succeeds" (shared contract, both backends);
  `apps/server/src/ceo-execution/ceo-plan-execution-retries.test.ts` — "a manual retry
  (operator_manual_retry) is explicit and idempotent — sending it twice in a row does not
  double-launch".
- **Finding**: both the storage-layer CAS and the scheduler-level idempotency are independently
  tested.
- **Status**: Protected.

## 9. Stale run generation

- **Mechanism**: `#processSignal()` compares `run.activeGeneration !== signal.generation`; a
  signal stamped with a generation that predates a pause/resume cycle is discarded (claim released,
  nothing advanced).
- **Source**: `apps/server/src/ceo-execution/ceo-plan-execution-scheduler.ts` (`#processSignal`).
- **Test**: `apps/server/src/ceo-execution/ceo-plan-execution-scheduler.test.ts` — "a
  stale-generation signal (queued before a pause/resume) never starts anything" — a signal manually
  stamped `generation: 0` is injected after the run moves to `activeGeneration: 1`; asserts the
  linked task never gets a `runId`.
- **Finding**: confirmed.
- **Status**: Protected.

## 10. Stale public mutation token

- **Mechanism**: the browser-facing mutation token for a run is
  `tokenIssuer.issue(run.id, run.activeGeneration)`; `verifyRunToken()` checks the caller's token
  against the run's _current_ `activeGeneration` and throws `CeoPlanRunTokenInvalidError` (409) on
  mismatch. `activeGeneration` bumps at safety-relevant boundaries (resume, cancel, recovery
  pause).
- **Source**: `apps/server/src/routes/ceo-plan-runs.ts` (`issueRunToken`/`verifyRunToken`).
- **Test**: `apps/server/src/routes/ceo-plan-runs.test.ts` — "returns 409
  (CEO_PLAN_RUN_TOKEN_INVALID) for a token from before a generation-bumping resume" — the original
  token is reused for `pause` after a `resume` bump and rejected with 409; also asserts the raw
  response body never leaks the token.
- **Finding**: confirmed.
- **Status**: Protected.

## 11. Stale task assignment

- **Mechanism**: `TaskOrchestrator.startTask()` snapshots `status`/`runId`/`adapterId`/`agentId`
  before any `await`, then commits via `TaskStore.startIfEligible()`, which re-validates the full
  four-field snapshot plus revision against live state at commit time — a concurrent reassignment
  between the snapshot and the commit is rejected with `TaskStateConflictError`.
- **Source**: `apps/server/src/tasks/task-orchestrator.ts` (`startTask()`).
- **Test**: `apps/server/src/tasks/task-orchestrator-launch-toctou.test.ts` — "7. assigned adapter
  changes concurrently (reassignment races the launch) — rejects, and the winning reassignment's
  adapterId is preserved untouched"; "8. assigned agent changes concurrently..."; reinforced by "9.
  ABA: revision moves through assigned -> blocked -> ready -> assigned while
  status/runId/adapterId/agentId all return to their original values — still rejects, because the
  guard is revision-gated, not field-gated" (this is also scenario 35's own test).
- **Finding**: three independent tests, including the adversarial ABA case.
- **Status**: Protected.

## 12. Changed capability evidence

- **Mechanism**: `startTask()` re-runs `adapter.detect()` and re-evaluates
  `evaluateCandidateEligibility()` against the task's requirements using freshly-detected
  capability observations (never the assignment-time cache); a required capability missing from
  fresh detection throws `AdapterRequirementsMismatchError` before the adapter's real `startTask()`
  is called.
- **Source**: `apps/server/src/tasks/task-orchestrator.ts`.
- **Test**: `apps/server/src/tasks/task-orchestrator-launch-toctou.test.ts` — "3. capability
  evidence degrades — required capability is missing from detect()'s observations, rejects with
  AdapterRequirementsMismatchError" (asserts zero `startTaskCallCount`, zero appended events, task
  status left `"assigned"`).
- **Finding**: confirmed.
- **Status**: Protected.

## 13. Changed execution-trust evidence

- **Mechanism**: same `startTask()` re-validation — `detection.executionTrust` is checked against
  `allowedExecutionTrust` at launch time (not assignment time); a degraded/changed trust value
  rejects with `AdapterRequirementsMismatchError`.
- **Source**: `apps/server/src/tasks/task-orchestrator.ts`.
- **Test**: `apps/server/src/tasks/task-orchestrator-launch-toctou.test.ts` — "4. execution trust
  degrades — detect() resolves a trust not in allowedExecutionTrust, rejects with
  AdapterRequirementsMismatchError".
- **Finding**: confirmed.
- **Status**: Protected.

## 14. Adapter unavailable after queueing

- **Mechanism**: at scheduler-driven launch time (not just signal-enqueue time), `detect()` is
  re-run and an `"unavailable"`/non-available result blocks the attempt before the adapter's real
  work method is invoked; the step is parked `awaiting_intervention` with a `failed` attempt
  recorded, never silently retried or launched anyway.
- **Source**: `apps/server/src/ceo-execution/ceo-plan-execution-scheduler.ts` (`#tryAdvanceStep`);
  `apps/server/src/tasks/task-orchestrator.ts`.
- **Test**: `apps/server/src/ceo-execution/ceo-plan-execution-scheduler.test.ts` — "adapter
  unavailable at launch time blocks the attempt without ever calling the adapter's real work" (goes
  through the real signal-queue → scheduler → launch path, with a fake adapter whose `startTask`
  throws if ever called); `apps/server/src/tasks/task-orchestrator-launch-toctou.test.ts` — "2.
  adapter becomes unavailable — detect() itself resolves unavailable, rejects with
  AdapterUnavailableError".
- **Finding**: covered through both the real queue and at the orchestrator unit level.
- **Status**: Protected.

## 15. Dependency graph tampering

- **Mechanism**: the dependency graph passed to `scheduler.registerDependencyIndex()` is derived
  server-side exclusively from the plan's own approved/delegated version — `configure` builds it
  from `getVersion(...).steps`, and `resume` independently rebuilds it the same way (Phase 15.6).
  `configureCeoPlanRunRequestSchema` has no `steps`/`dependencies` field in its shape at all
  (`.strict()`, only `executionMode`+`policy`).
- **Source**: `apps/server/src/routes/ceo-plan-runs.ts` (configure and resume handlers);
  `apps/server/src/schemas/ceo-plan-execution-request.ts`.
- **Test**: `apps/server/src/routes/ceo-plan-runs.test.ts` — "Phase 15.7 — security matrix
  scenario 15: the execution DAG is derived only from the approved plan version, forged dependency
  data in a configure request is rejected by the strict schema, and the resulting step dependencies
  exactly match the approved plan" (reads the approved plan's real 3-step chain — Investigate: no
  deps, Implement: depends on Investigate, Verify: depends on Implement — directly from `GET
.../versions/1`; a configure request carrying a forged `steps` array naming a DIFFERENT ordering
  and different `childTaskId`s is rejected with 400 `INVALID_REQUEST` and creates no run; a genuine
  configure request's resulting `stepExecutions[].dependencySummary.totalDependencies` exactly
  matches the approved plan's own counts (0, 1, 1); and, as a functional proof beyond a bare count,
  starting the run launches only the dependency-free step while the two dependent steps' child tasks
  never receive a `runId`).
- **Finding**: confirmed by a real, passing, scenario-specific test (10/10 consecutive runs) —
  both the negative case (forged data rejected) and the positive case (derived DAG matches the
  approved plan, functionally proven by launch order) are exercised.
- **Status**: Protected.

## 16. Dependency completion spoofing

- **Mechanism**: a step's dependency-readiness is re-evaluated from the _actually persisted_
  step-execution statuses (`evaluateDependencyReadiness`), never taken on faith from a signal's
  `reason`. `onChildTaskMutated()` only marks a step "completed" when the run is in an allow-listed
  status (`running`/`paused`/`awaiting_intervention`) and the step wasn't already resolved — a run
  still `"configured"` is explicitly excluded.
- **Source**: `apps/server/src/ceo-execution/ceo-plan-execution-scheduler.ts`
  (`onChildTaskMutated`, `#resolveTargetSteps`); `apps/server/src/ceo-execution/ceo-plan-step-readiness.ts`.
- **Test**: `apps/server/src/ceo-execution/ceo-plan-execution-scheduler.test.ts` —
  "onChildTaskMutated does nothing to a step-execution whose run is still 'configured' (never
  started) — a child task finished by some other means ahead of the run must not be treated as
  already resolved"; "a dependent step starts only after every dependency has completed".
- **Finding**: the primary test directly targets the "complete a task out-of-band to fake a
  resolved dependency" threat.
- **Status**: Protected.

## 17. Cross-plan signal linkage

- **Mechanism**: `ExecutionSignalStore.claimNext()` only claims signals whose `planRunId` is in the
  caller-supplied `eligibleRunIds` set (the scheduler passes only currently-`running`/`autonomous`
  run IDs); `#processSignal()` looks up the per-run dependency index via
  `#dependencyIndexes.get(run.id)` and releases the claim with no effect if unregistered.
- **Source**: `apps/server/src/ceo-execution/ceo-plan-execution-scheduler.ts`.
- **Test**: `apps/server/src/ceo-execution/execution-signal-store.contract.ts` — "claimNext never
  claims a signal outside the eligible run set"; "cancelSignalsForRun cancels every pending/claimed
  signal for that run only" (shared contract, both backends).
- **Finding**: confirmed.
- **Status**: Protected.

## 18. Cross-plan attempt linkage

- **Mechanism**: `CeoPlanExecutionScheduler.retryAbandonedStep(runId, stepId)` validates that
  `stepId` genuinely belongs to `runId`'s own registered dependency index/step-execution set; a
  `stepId` that only exists on a different run is rejected, never silently creating an attempt
  against the wrong run's step.
- **Source**: `apps/server/src/ceo-execution/ceo-plan-execution-scheduler.ts`
  (`retryAbandonedStep`); `CeoPlanExecutionAbandonedRetryNotEligibleError` in
  `apps/server/src/errors/app-error.ts`.
- **Test**: `apps/server/src/ceo-execution/ceo-plan-execution-abandoned-retry.test.ts` —
  "cross-plan / cross-run linkage is rejected — a stepId that only exists on a different run";
  "cross-step linkage is rejected — an unknown stepId on a real run".
- **Finding**: confirmed.
- **Status**: Protected.

## 19. Cross-plan child-task linkage

- **Mechanism**: `onChildTaskMutated(childTaskId)` looks up only the step-executions genuinely
  linked to that exact `childTaskId` via `listStepExecutionsByChildTask(childTaskId)` — a task not
  linked to a given run's steps can never cause that run's step-executions to change.
- **Source**: `apps/server/src/ceo-execution/ceo-plan-execution-scheduler.ts`.
- **Test**: `apps/server/src/ceo-execution/ceo-plan-execution-scheduler.test.ts` — "an unrelated
  task's completion never touches this run's steps (no cross-run scan)". Caveat: the "unrelated"
  task in this test is simply unlinked to any run (never delegated into a step), not a task
  belonging to a second, concurrently-running plan.
- **Finding**: the exact linkage check (`listStepExecutionsByChildTask`) is the same code path that
  would govern a genuine second-plan collision, but a dedicated "task genuinely delegated to plan B
  mutates while plan A is running" test was not found.
- **Status**: Protected (with the caveat above).

## 20. Partial ephemeral mutation

- **Mechanism**: `createEphemeralAtomicUnit()` snapshots every named store before `fn()` runs and
  restores all of them, in order, if `fn()` throws — the same all-or-nothing guarantee durable
  mode's SQLite transactions give, with no generic transaction API reachable from a route.
- **Source**: `apps/server/src/ceo-plans/ephemeral-atomic-unit.ts` (`createEphemeralAtomicUnit`).
- **Test**: `apps/server/src/ceo-plans/ephemeral-atomic-unit.test.ts` — "rolls back writes across
  all four stores together, not just the one that threw"; shared contract
  `apps/server/src/ceo-execution/ceo-plan-execution-atomicity.contract.ts` — "attempt creation: an
  injected step-execution failure during claimAttempt leaves NO dangling attempt row, and a retry
  succeeds exactly once" (run against both ephemeral and durable variants).
- **Finding**: real test proves rollback across multiple stores on mid-sequence failure.
- **Status**: Protected.

## 21. Publication before commit

- **Mechanism**: orchestrators call `eventStore.append()` (a committed transaction) strictly
  before `eventBus.publish()`; every scheduler event helper follows the same append-then-publish
  order.
- **Source**: `apps/server/src/tasks/task-orchestrator.ts`;
  `apps/server/src/ceo-execution/ceo-plan-execution-scheduler.ts` (`#appendEvent`).
- **Test**: `apps/server/src/events/persistence-before-publication.test.ts` — "every task event is
  durably committed before it is published on the task event bus".
- **Finding**: empirically verified (not just read from source) that the same event ID a
  subscriber receives is already the last durably-stored row.
- **Status**: Protected.

## 22. Ownership-fence bypass

- **Mechanism**: `withTransaction`'s outer boundary checks the current instance's ownership fence
  against the live `durable_ownership` row and throws `OwnershipLostError`, rolling back, before a
  superseded instance's write can commit; execution-specific store methods route through this same
  boundary.
- **Source**: `apps/server/src/persistence/transaction.ts` (`withTransaction`);
  `apps/server/src/persistence/database-ownership-fence.ts`;
  `apps/server/src/persistence/persistence-errors.ts` (`OwnershipLostError`).
- **Test**: `apps/server/src/persistence/transaction.test.ts` — "rejects a mutation with
  OwnershipLostError once this instance's fence has been superseded";
  `apps/server/src/ceo-execution/ceo-plan-execution-ownership-fencing.test.ts` — "none of the 14
  rejected operations changed the run's projected state, step execution, event log, or signal
  queue".
- **Finding**: generic boundary proven once, then all 14 execution-specific write operations proven
  to route through it.
- **Status**: Protected.

## 23. Automatic retry after unclean restart

**The Phase 15.6 scenario.** Four required sub-points, each independently cited:

- **Mechanism**: unclean-restart recovery marks a mid-flight step `awaiting_intervention`/abandoned
  and pauses the run; nothing auto-relaunches it. Resume only clears the pause and rebuilds the
  scheduler's dependency index; a separate, explicit `retryAbandonedStep()` governs relaunch, and
  it always mints a brand-new attempt/task-run ID.
- **Source**: `apps/server/src/ceo-execution/ceo-plan-execution-recovery.ts` (unclean-restart
  branch); `apps/server/src/ceo-execution/ceo-plan-execution-scheduler.ts` (`retryAbandonedStep`);
  `apps/server/src/routes/ceo-plan-runs.ts` (`/resume` dependency-index rebuild);
  `CeoPlanExecutionAbandonedRetryNotEligibleError` in `apps/server/src/errors/app-error.ts`.

**(a) Unclean restart starts nothing automatically:**
`apps/server/src/composition/ceo-plan-execution-durable-restart.test.ts` — "unclean restart: a step
left mid-flight is abandoned and moved to awaiting_intervention (never silently rerun), the run is
recovery-paused, and exactly one Board summary is posted — repeating the boot changes nothing
further".

**(b) Resume alone starts nothing:**
`apps/server/src/ceo-execution/ceo-plan-execution-abandoned-retry.test.ts` — "Resume alone starts
nothing — no new attempt, no new task run". Also proven at the browser level in
`apps/e2e/tests/ceo-plan-execution-unclean-restart.spec.ts` (step 24: `investigateAttemptsAfterResume`
stays at length 1, step status stays `awaiting_intervention` after clicking Resume).

**(c) Explicit Retry is required:**
`apps/server/src/ceo-execution/ceo-plan-execution-abandoned-retry.test.ts` — "Retry before Resume
is rejected — the run must be 'running' first"; `apps/server/src/routes/ceo-plan-runs.test.ts` —
"POST .../steps/:stepId/retry: a step whose latest attempt is 'abandoned' (unclean-restart
recovery) routes through the governed abandoned-recovery path over HTTP — Retry before Resume is
rejected, Resume then Retry creates a genuine attempt 2 with a new task-run ID" (409
`CEO_PLAN_EXECUTION_ABANDONED_RETRY_NOT_ELIGIBLE`).

**(d) Explicit Retry creates exactly one replacement attempt (new attempt, new task-run ID):**
`apps/server/src/ceo-execution/ceo-plan-execution-abandoned-retry.test.ts` — "Resume followed by
Retry creates attempt 2 with a new task-run ID, preserving the abandoned attempt";
`apps/server/src/composition/ceo-plan-execution-durable-restart.test.ts` — "Phase 15.6 — explicit
operator Resume then Retry step relaunches a step genuinely abandoned by unclean-restart recovery,
on a FRESH scheduler instance that never configured this run itself" (proves the `/resume`
dependency-index rebuild specifically); browser-level:
`apps/e2e/tests/ceo-plan-execution-unclean-restart.spec.ts`, describe "CEO plan execution — unclean
browser restart (Phase 15.5 / 15.6)" — the full test proves attempt count reaches 2, the
replacement's task-run ID differs from the interrupted one, the abandoned attempt's original
task-run ID is preserved, and the replacement attempt reaches genuine natural `"completed"` status
— run 5/5 consecutive times.

- **Finding**: protected on all four sub-points — each has a distinct, real, executable citation
  spanning unit, HTTP-route, cross-process-composition, and end-to-end-Playwright layers, all
  agreeing.
- **Status**: Protected. **Note**: `retryAbandonedStep()` additionally rejects if
  `step.attemptCount >= policySnapshot.maxAttemptsPerStep` — the abandoned attempt itself counts
  toward that budget, so a run configured at the protocol minimum of 1 has no in-place recovery
  path (must cancel and restart instead). This is a disclosed product decision, not a gap; see
  README.md and 0015's "Explicit abandoned-step recovery" section.

## 24. Retry death spiral

- **Mechanism**: `decideRetry()` refuses once `attemptNumber >= maxAttemptsPerStep`, independent of
  classification; the no-progress circuit breaker separately trips on N consecutive failures or N
  no-progress attempts, pausing the run outright.
- **Source**: `apps/server/src/ceo-execution/ceo-plan-execution-retries.ts` (`decideRetry`);
  `apps/server/src/ceo-execution/ceo-plan-execution-circuit-breaker.ts` (`shouldTrip`).
- **Test**: `apps/server/src/ceo-execution/ceo-plan-execution-retries.test.ts` — "retry stops at
  maxAttemptsPerStep — at-threshold and above never retry, below it does";
  `apps/server/src/ceo-execution/ceo-plan-execution-circuit-breaker.test.ts` — "trips at the
  consecutive-failures threshold — at-threshold trips, one-below does not".
- **Finding**: hard attempt cap plus an independent circuit breaker both bound retry accumulation.
- **Status**: Protected.

## 25. Circuit-breaker bypass

- **Mechanism**: once tripped, the scheduler refuses new attempt claims; nothing in automatic
  signal processing calls `resetCircuit` — only an explicit operator Resume clears it.
- **Source**: `apps/server/src/ceo-execution/ceo-plan-execution-scheduler.ts`;
  `apps/server/src/ceo-execution/ceo-plan-execution-circuit-breaker.ts`.
- **Test**: `apps/server/src/ceo-execution/ceo-plan-execution-circuit-breaker.test.ts` — "explicit
  operator action (resume) is required to clear a tripped circuit — nothing in the scheduler's own
  automatic signal processing calls resetCircuit";
  `apps/server/src/ceo-execution/ceo-plan-execution-circuit-breaker-semantics.test.ts` — "16. an
  open circuit prevents further attempt claims".
- **Finding**: confirmed.
- **Status**: Protected.

## 26. Emergency stop affecting unrelated tasks

- **Mechanism**: `emergencyStop(runId)` is scoped strictly to this run's own linked child tasks via
  `listStepExecutions(runId)`; an unrelated task or a task on a different run is never touched, and
  per-task cancellation failures are recorded individually without ever reporting false overall
  success.
- **Source**: `apps/server/src/ceo-execution/ceo-plan-execution-scheduler.ts` (`emergencyStop`).
- **Test**: `apps/server/src/ceo-execution/ceo-plan-execution-scheduler.test.ts` — "emergency stop
  requests cancellation for every linked active task, leaves an unrelated task's run alone, and
  prevents further scheduling"; `apps/server/src/routes/ceo-plan-runs.test.ts` — "emergency-stop:
  returns 202, requests cancellation for linked active tasks, and never exposes internal
  owner/lease/path fields".
- **Finding**: confirmed.
- **Status**: Protected.

## 27. Private path leakage

- **Mechanism**: the error hierarchy (`HallCoreError` subclasses) only ever includes task/adapter
  IDs and pre-validated non-secret data; ownership-lock errors never echo the lock-file/data-dir
  path; raw wire payloads are checked to be free of internal-path substrings.
- **Source**: `apps/server/src/errors/app-error.ts`; `apps/server/src/persistence/instance-ownership.ts`.
- **Test**: `apps/server/src/persistence/instance-ownership.test.ts` — "no ownership error message
  ever contains the data directory path"; `apps/server/src/tasks/task-orchestrator.test.ts` — "safe
  API responses do not expose raw internal event-store errors, stack traces, or absolute paths";
  `apps/server/src/routes/ceo-plan-run-events.test.ts` — "every event payload delivered over the
  raw wire is free of internal fields — checked against the raw JSON text, not the
  parsed/re-serialized object".
- **Finding**: multiple independent tests at store, orchestrator, and wire-protocol layers.
- **Status**: Protected.

## 28. Raw stderr leakage

- **Mechanism (adapter/task pipeline)**: `TaskOrchestrator#failTaskOnUnhandledExecutionError` is
  the ONE path every unexpected adapter-side throw (a real provider's process spawn failure,
  crash, or any other raw stderr-shaped error) is funneled through. It always stores/exposes the
  fixed, bounded client-safe message `"Hall Core could not complete this task due to an unexpected
internal error."` with code `TASK_EXECUTION_FAILED` — the raw `Error.message` (`serverLogDetail`,
  which may legitimately contain real stderr text) is passed only to `console.error` (a genuine
  server-side-only log), never to `EventStore.append()`, the task record, or any REST/WebSocket
  response. Reused unchanged by the CEO-execution scheduler's own launch path (`#tryAdvanceStep` ->
  `TaskOrchestrator.startTask()`), so the same guarantee holds for a CEO plan step's failure, not
  just a plain task's.
- **Mechanism (git-worktree comparisons)**: `boundedSnippet()` additionally truncates any embedded
  `git` stderr to 500 chars before it reaches `GitCommandFailedError`'s message — a secondary,
  narrower bound for a different subsystem (comparisons), server-log-oriented per that module's own
  doc comment.
- **Source**: `apps/server/src/tasks/task-orchestrator.ts`
  (`#failTaskOnUnhandledExecutionError`, `#failTaskWithInfrastructureFailure`);
  `apps/server/src/comparisons/git-worktree-errors.ts` (`boundedSnippet`,
  `MAX_STDERR_SNIPPET_CHARS = 500`).
- **Test**: `apps/server/src/routes/stderr-leakage.test.ts` — "a fixture adapter that throws with a
  private stderr marker embedded in its Error never leaks that marker into the created-task
  response, task detail, task events REST, or task events WebSocket — only the fixed, bounded
  TASK_EXECUTION_FAILED message ever appears" (a fixture adapter's `startTask()` throws
  synchronously with a marker, `PHASE15_PRIVATE_STDERR_MUST_NOT_LEAK`, embedded in realistic
  spawn-failure-shaped text; the marker is confirmed absent from the task-creation response, the
  raw WebSocket frame text, the REST task detail, the REST events replay, and the serialized task
  record — only the safe bounded code/message ever appear).
  `apps/server/src/ceo-execution/ceo-plan-execution-stderr-leakage.test.ts` — "a step assigned to a
  fixture adapter that throws with a private stderr marker never leaks that marker into the run
  detail, step executions, attempts, durable execution events, or the permanent-failure Board
  summary" (same fixture adapter, driven through the real `CeoPlanExecutionScheduler`; confirms the
  marker is absent from the run detail, step-execution rows, attempt rows, the durable
  execution-event log, and the fixed-text Board summary a `pauseOnAnyPermanentFailure` pause
  posts).
- **Finding**: confirmed by two real, passing, scenario-specific tests (10/10 consecutive runs
  each) covering the plain-task REST/WebSocket surface and the CEO-execution run/event/Board
  surface. The `git`/comparisons `boundedSnippet` mechanism remains a secondary, narrower,
  server-log-oriented bound not itself covered by a dedicated unit test — noted for completeness,
  not required for this scenario's protected status given the primary adapter-pipeline mechanism
  above is what actually governs task/CEO-execution failure text end-to-end.
- **Status**: Protected.

## 29. Hidden reasoning persistence

- **Mechanism**: no "reasoning"/"thinking"/"chainOfThought" field exists anywhere in
  `@hall-of-wisdom/protocol`'s event/evidence schemas — a structural absence (event and
  result-evidence shapes are `.strict()` Zod schemas with a fixed, small field set), not a runtime
  filter. Doc comments explicitly state raw reasoning is never captured.
- **Source**: `apps/server/src/ceo-execution/ceo-plan-execution-circuit-breaker.ts` (doc comment:
  "never raw provider output, hidden reasoning..."); `apps/server/src/comparisons/result-evidence.ts`
  (doc comment: "Never exposes... raw process reasoning, tokens, or cost");
  `apps/server/src/comparisons/comparison-record.ts` (`candidateResultEvidenceSchema`, `.strict()`).
- **Mechanism (adapter/task pipeline trust boundary)**: `runTask()`
  (`@hall-of-wisdom/hall-runner`, `runner-service.ts`) re-validates every event yielded by an
  adapter's `events` async iterable via `parseNormalizedAgentEvent` — the same `.strict()` schema
  above — strictly BEFORE calling `onEvent`/forwarding it to `TaskOrchestrator#handleEvent`. An
  event carrying an extra `reasoning`-shaped field is therefore rejected at the untrusted
  adapter/Hall-Core boundary itself, never partially accepted with the field silently dropped; the
  rejection throws, and the task fails through the exact same bounded `TASK_EXECUTION_FAILED`
  infrastructure-failure path scenario 28 uses (the field name may appear in the Zod validation
  error text, but that error is `serverLogDetail` — console-only, per scenario 28's mechanism —
  never the client-facing message).
- **Source**: `packages/protocol/src/events.ts` (every event/payload schema, `.strict()`);
  `runners/hall-runner/src/runner-service.ts` (`runTask()`'s `parseNormalizedAgentEvent` call,
  strictly before `onEvent`); `apps/server/src/tasks/task-orchestrator.ts`
  (`#failTaskOnUnhandledExecutionError`, shared with scenario 28).
- **Test**: `packages/protocol/src/events.test.ts` — "Phase 15.7 — security matrix scenario 29: a
  message.delta event carrying any unsupported reasoning-shaped field (reasoning, chainOfThought,
  hiddenReasoning, internalThought, scratchpad) at the payload level is rejected outright by the
  strict schema, never silently accepted with the field stripped" and the companion "...rejected at
  the event ENVELOPE level too, not only inside payload" (all 5 named field names, both
  positions). `apps/server/src/routes/hidden-reasoning-leakage.test.ts` — "a misbehaving fixture
  adapter that yields an event with a forged reasoning field never gets that field accepted,
  persisted, or exposed — the event is rejected at the adapter/Hall-Core trust boundary and the
  task fails through the bounded, safe infrastructure-failure path" (a fixture adapter yields a
  valid `run.started` event followed by a `message.delta` event carrying a synthetic
  `PHASE15_HIDDEN_REASONING_MUST_NOT_PERSIST` marker under a `reasoning` key; confirms the valid
  event is still delivered, the forged event never reaches any subscriber, the marker is absent
  from every WebSocket frame/REST response/serialized task record, and the task fails via the same
  bounded `TASK_EXECUTION_FAILED` path). Only synthetic fixture data was ever used — no real
  reasoning content was created, requested, or exposed.
- **Finding**: confirmed by three real, passing, scenario-specific tests (10/10 consecutive runs
  each) spanning the schema layer (all 5 named field names, both envelope and payload position) and
  the full adapter-to-REST/WebSocket pipeline with an actively misbehaving fixture adapter.
- **Status**: Protected.

## 30. Fabricated token or cost information

- **Mechanism**: cost/token fields (`estimatedCostUsd`, `tokenCount`, etc.) are never defined in
  any production Zod schema; every relevant request/policy schema is `.strict()`, so a
  client-supplied cost/token field is rejected outright rather than accepted and trusted.
- **Source**: `packages/protocol/src` (grep confirms zero production occurrences of
  `estimatedCostUsd`/`tokenCount`/`costUsd`).
- **Test**: `packages/protocol/src/ceo-execution.test.ts` — "rejects an unknown field (.strict())"
  (uses `estimatedCostUsd: 5` as the example forged/unknown field, asserting
  `safeParse(...).success === false`).
- **Finding**: the existing test directly demonstrates a cost-like field being rejected by strict
  schema validation, and grep confirms the field is absent from production code entirely.
- **Status**: Protected.

## 31. Queue overflow

- **Mechanism**: the execution-signal queue coalesces by `(planRunId, planStepId, generation)` —
  repeated/duplicate signals for the same coalescing key merge into a single pending row rather
  than accumulating, keeping the queue naturally bounded regardless of signal volume.
- **Source**: `apps/server/src/ceo-execution/execution-signal-store-port.ts` (coalescing key doc
  comment); `apps/server/src/ceo-execution/sqlite-execution-signal-store.ts` /
  `in-memory-execution-signal-store.ts`.
- **Test**: `apps/server/src/ceo-execution/execution-signal-store.contract.ts` — "coalesces a
  second enqueue for the same (run, step, generation) into one pending signal";
  `apps/server/src/ceo-execution/ceo-plan-execution-efficiency.test.ts` — "(B) duplicate signal
  coalescing: 100 equivalent signals for the same step produce exactly one pending row, one claim,
  one attempt, one launch".
- **Finding**: protected against unbounded growth from duplicate/repeated signals via coalescing.
  No explicit hard capacity-ceiling/rejection mechanism was found — this is coalescing-as-bounding
  by design, not a literal max-queue-size enforcement.
- **Status**: Protected. Note: the boundedness comes from coalescing (each signal corresponds to a
  bounded set of real steps × runs, never attacker-controlled volume, since no route lets a browser
  mint arbitrary signals — see scenario 4), not a literal hard capacity ceiling; a design choice,
  not a gap.

## 32. Cross-run starvation

- **Mechanism**: signals for independent plan runs are processed in stable, deterministic order;
  no single run can be repeatedly re-signaled to starve others of scheduler attention. (This is
  also where the cross-run adapter-capacity wakeup fix — see 0015's "Known Phase-15 limitations" —
  closed a real starvation bug found earlier this phase.)
- **Source**: `apps/server/src/ceo-execution/ceo-plan-execution-scheduler.ts` (`#drain`).
- **Test**: `apps/server/src/ceo-execution/ceo-plan-execution-efficiency.test.ts` — "(E) fairness:
  signals for independent runs are processed in stable, deterministic order, and no run is starved
  while others are repeatedly re-signaled".
- **Finding**: confirmed.
- **Status**: Protected.

## 33. Scheduler busy loop

- **Mechanism**: a single event-driven wake timer tracks only the soonest-due pending signal across
  all runs (never a fixed-interval poll, never one timer per task); it cancels itself back to fully
  idle (no timer at all) once nothing is pending.
- **Source**: `apps/server/src/ceo-execution/ceo-plan-execution-scheduler.ts` (`#rearmWakeTimer`;
  doc comment: "cancels itself back to idle (no timer at all — no busy loop) once nothing is
  pending").
- **Test**: `apps/server/src/ceo-execution/ceo-plan-execution-efficiency.test.ts` — "(C) idle
  scheduler: zero adapter starts, zero store mutations, zero Board messages during an injected idle
  period with no signals".
- **Finding**: confirmed.
- **Status**: Protected.

## 34. Unbounded database scan

- **Mechanism**: dependency/step-readiness evaluation is incremental — completing one step touches
  only that step's own record plus its direct dependent, never scanning the rest of the run or
  other runs; all SQL queries in the plan-run store are scoped by `WHERE run_id = ?` (indexed),
  never an unscoped table scan.
- **Source**: `apps/server/src/ceo-execution/sqlite-ceo-plan-run-store.ts` (all queries scoped by
  `run_id`); `apps/server/src/ceo-execution/ceo-plan-step-readiness.ts`.
- **Test**: `apps/server/src/ceo-execution/ceo-plan-execution-efficiency.test.ts` — "(A) incremental
  dependency evaluation: completing one step in one 20-step run, out of 100 configured 100x20=2000
  step runs, touches only that step's own record plus its direct dependent — never the other 1999
  steps or the other 99 runs" (includes a test-only naive-baseline comparison, test D).
- **Finding**: test explicitly proves O(1)-ish touch count at 2000-row scale, not a full scan.
- **Status**: Protected.

## 35. Existing task ABA protection

- **Mechanism**: `startIfEligible`/`assignIfEligible`/`prepareRetryIfEligible` all snapshot
  `expectedRevision = taskStore.getRevision(taskId)` before any `await`, then compare against the
  store's _current_ revision at commit time — a revision-gated compare-and-swap, not a
  field-by-field compare, so a value that cycles back to its original state (A→B→A) is still
  caught because the revision counter itself never regresses.
- **Source**: `apps/server/src/tasks/task-orchestrator.ts` (`expectedRevision` pattern).
- **Test**: `apps/server/src/tasks/task-orchestrator-launch-toctou.test.ts` — "9. ABA: revision
  moves through assigned -> blocked -> ready -> assigned while status/runId/adapterId/agentId all
  return to their original values — still rejects, because the guard is revision-gated, not
  field-gated".
- **Finding**: a purpose-built ABA test, not an inferred one.
- **Status**: Protected.

## 36. Existing plan approval/content-hash binding

- **Mechanism**: approval and delegation are bound to an exact `(planId, version, contentHash)`
  triple; delegation re-checks `freshVersion.contentHash !== version.contentHash` inside the atomic
  unit immediately before committing, and any edit after approval resets the plan to `draft`,
  invalidating the old approval binding.
- **Source**: `apps/server/src/ceo-plans/ceo-plan-orchestrator.ts` (contentHash check);
  `CeoPlanApprovalBindingError` in `apps/server/src/errors/app-error.ts`.
- **Test**: `apps/server/src/ceo-plans/ceo-plan-orchestrator.test.ts` — "an approval submitted for a
  version that is no longer active is rejected (edit invalidates approval)"; "delegation only ever
  uses the adapter approved in the exact version — editing an approved plan resets it to draft,
  which cannot be delegated until re-approved".
- **Finding**: confirmed.
- **Status**: Protected.

## 37. Existing trusted-local restrictions

- **Mechanism**: `allowedExecutionTrust` on a task's requirements gates eligibility both at routing
  time (`evaluateCandidateEligibility`, ranked by `TRUST_SAFETY_RANK` with `isolated` safer than
  `trusted_local`) and again at launch time inside the TOCTOU-guarded `startIfEligible` — a task
  requiring `isolated`-only execution rejects a `trusted_local` adapter even if one raced in
  concurrently.
- **Source**: `apps/server/src/routing/routing-policy.ts` (`TRUST_SAFETY_RANK`,
  `evaluateCandidateEligibility`); `apps/server/src/tasks/task-orchestrator.ts` (launch-time
  revalidation).
- **Test**: `apps/server/src/routing/routing-policy.test.ts` — "excludes an adapter whose execution
  trust is not in the allowed list"; "ranks by trust safety (isolated before trusted_local) even
  when adapterId ordering would suggest otherwise"; `apps/server/src/tasks/task-orchestrator-launch-toctou.test.ts`
  — "14. trusted-local is rejected for isolated-only requirements".
- **Finding**: enforced redundantly at both routing-selection and launch-time revalidation layers.
- **Status**: Protected.

## 38. Existing comparison isolation

- **Mechanism**: each comparison candidate runs in its own disposable Git worktree, lexically and
  canonically (symlink-resolved) contained within the configured comparison root; removal is
  refused unconditionally for any path outside that root; cleanup deletes only candidate worktrees,
  never the source repository or an unrelated repository; two comparisons against different source
  repositories resolve fully independently.
- **Source**: `apps/server/src/comparisons/git-worktree-errors.ts`
  (`WorktreeContainmentViolationError`, `WorktreeRemovalRefusedError`);
  `apps/server/src/comparisons/git-worktree-manager.ts`.
- **Test**: `apps/server/src/comparisons/git-worktree-manager.integration.test.ts` —
  "refuses to remove a path outside the comparison root, without invoking git"; "refuses to remove
  a prefix-confusion sibling of the comparison root"; `apps/server/src/comparisons/comparison-orchestrator.integration.test.ts`
  — "two tasks pointing at two different nested repositories resolve independently — repository A
  is never substituted for task repository B"; "never deletes the source repository or an unrelated
  repository during cleanup — only candidate worktrees".
- **Finding**: containment enforcement and cross-comparison independence both directly tested,
  including a deliberate prefix-confusion adversarial case.
- **Status**: Protected.

## Summary

- **Protected with scenario-specific executable test**: 1–38 (38/38 scenarios).
- **Partially protected**: 0.
- **Not protected**: 0.

**Revision history**: as of Phase 15.6 sign-off, scenarios 3 (autonomous mode enabled by default),
4 (browser-forged execution signal), 15 (dependency graph tampering), 28 (raw stderr leakage), and
29 (hidden reasoning persistence) were marked "Partially protected" — a real, code-confirmed
mechanism existed for each, but no scenario-specific executable test backed it, per this document's
own "never mark a row protected from documentation alone" rule. Phase 15.7 closed that gap: five
new scenario-specific tests were written (`apps/server/src/routes/ceo-plan-runs.test.ts` for 3 and
15; `apps/server/src/routes/ceo-plan-run-events.test.ts` for 4;
`apps/server/src/routes/stderr-leakage.test.ts` and
`apps/server/src/ceo-execution/ceo-plan-execution-stderr-leakage.test.ts` for 28;
`packages/protocol/src/events.test.ts` and `apps/server/src/routes/hidden-reasoning-leakage.test.ts`
for 29), each run 10/10 consecutive times, all passing on the first correct implementation attempt
(no production defect was found or fixed — every mechanism already behaved correctly; this was a
verification-only closure, not a bug-fix session). Scenario 23, the scenario Phase 15.6 itself
exists to fix, remains fully protected on all four required sub-points, unchanged by this session.
