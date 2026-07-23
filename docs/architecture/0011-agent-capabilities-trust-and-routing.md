# 0011 — Agent Capability Catalog, Trust Comparison and Safe Routing

Status: Phase 11, hardened by Phase 11.1 (requirement-safe manual assignment, the pnpm CLI-forwarding
fix, and genuine Playwright E2E verification — see "Requirement-safe manual assignment", "CLI
argument forwarding", and "Real verification performed this phase" below). Builds on
[`0004-hall-core-server.md`](0004-hall-core-server.md) (adapter registry, `GET /api/v1/adapters`),
[`0006-kanban-board.md`](0006-kanban-board.md) (task lifecycle, assignment),
[`0009-codex-adapter.md`](0009-codex-adapter.md) and
[`0010-paperclip-compatible-codex-mode.md`](0010-paperclip-compatible-codex-mode.md) (the first
adapter whose safety story genuinely depends on a runtime execution-trust mode). Read those first.

## Why this phase exists

Before this phase, Hall could only say whether an adapter was `available` — a single boolean-ish
status covering everything from "not installed" to "logged out" to "ready to run." It could not say
_what a task actually needs_ versus _what an adapter can currently, verifiably do on this machine_,
and it had no way to compare adapters' execution-trust posture: a sandboxed Claude Code run is not
the same risk as a trusted-local Codex run that deliberately bypasses its own sandbox
([`0010`](0010-paperclip-compatible-codex-mode.md)). An operator assigning Codex had no structured
signal that they were granting Hall-Core-user filesystem permissions — only prose in a diagnostic
string.

Phase 11 adds a provider-neutral capability/trust vocabulary, teaches each adapter to report it
honestly, and adds a deterministic (non-AI) routing policy that can recommend — but never
automatically execute — a suitable adapter for a task's stated requirements. This is read-only
analysis plus one explicit, mutating "assign" action; starting a run remains a separate, always
manual step, unchanged from every prior phase.

## Eight dichotomies this phase distinguishes

Phase 11's whole design exists to keep these eight distinctions structurally visible, not just
documented in prose:

1. **Installed vs. executable** — an adapter can be installed and still never reach `available`
   (Codex strict mode: installed, authenticated, but the sandbox blocks writes — see
   [`0010`](0010-paperclip-compatible-codex-mode.md)).
2. **Authenticated vs. safe to execute** — Codex trusted-local mode requires ChatGPT auth _and_ four
   independent environment preconditions (loopback binding, configured workspace root, no
   billing-changing env var, explicit operator opt-in flag) before it is safe, not merely logged in.
3. **Declared vs. verified capabilities** — `declaredCapabilities` (static, descriptor-level, "what
   this adapter was designed to support") is a separate field from `capabilityObservations`
   (runtime, `detect()`-level, "what Hall has actually confirmed right now").
4. **Simulated vs. real execution** — Mock Agent's `executionTrust` is always `"simulated"` and it
   never declares `project.edit`; it is structurally unable to be presented as equivalent to real
   editing.
5. **Isolated vs. trusted-local execution** — `executionTrust` distinguishes `"isolated"` (Claude
   Code's `--safe-mode` profile) from `"trusted_local"` (Codex's sandbox-bypassing mode); trusted-
   local is never softened to read "isolated" or "sandboxed" anywhere, including in routing UI.
6. **Available vs. assignable** — `assignable` is task-independent
   (`assignable === (availability === "available")`); whether an available adapter is _right for a
   given task_ is a separate question the routing policy answers per task.
7. **Capability match vs. security posture** — the routing eligibility gate checks both
   independently: an adapter can meet every required capability and still be excluded for its
   `executionTrust` not being in the task's allow-list, or vice versa.
8. **Recommendation vs. explicit operator assignment** — `POST .../routing-analysis` only ever
   recommends; only the operator's explicit `POST .../route-and-assign` click assigns, and even that
   never starts a run.

## Provider-neutral capability vocabulary

New module: `packages/protocol/src/capability.ts`. Deliberately separate from the existing
9-boolean `AgentCapabilities` (streaming, toolEvents, mcp, ...) in `agent-capabilities.ts`, which
describes integration _mechanics_ an adapter implements. The new vocabulary describes what a task
actually needs an agent to be able to _do_, and is never a provider name:

- **`CapabilityId`** (8 values): `project.read`, `project.edit`, `command.execute`, `git.inspect`,
  `structured.events`, `cancellation`, `session.resume`, `network.access`.
- **`CapabilityStatus`** (5 values): `verified` (backed by evidence), `declared` (adapter claims it,
  not independently confirmed on this machine), `unverified` (neither confirmed nor denied),
  `restricted` (Hall has a _diagnosed_ reason it currently doesn't work — e.g. the Windows sandbox
  account's write restriction), `unsupported` (the adapter never claims it at all).
- **`ExecutionTrust`** (4 values): `simulated`, `isolated`, `trusted_local`, `unavailable`.
  Server-derived only — never accepted from browser input anywhere in this feature.
  `simulated`/`isolated`/`trusted_local` are not a single total order; see "Ranking" below for the
  one place an explicit order is defined, and only for tie-breaking.
- **`CapabilityEvidenceCategory`** (6 values): `deterministic_test`, `isolated_smoke_test`,
  `browser_smoke_test`, `environment_probe`, `declared_only`, `unavailable` — what kind of evidence
  actually backs a given observation.
- **`CapabilityObservation`** (`.strict()`): `{ capability, status, safeSummary (≤300 chars),
evidence }`. `safeSummary` is a short, hand-authored sentence — never raw process output, a
  prompt, an executable path, or account data, matching the existing `diagnosticMessage` discipline
  from [`0010`](0010-paperclip-compatible-codex-mode.md).
- **`TaskRequirements`** (`.strict()`): `{ requiredCapabilities: CapabilityId[] (max 8, deduped),
allowedExecutionTrust: ExecutionTrust[] (min 1, max 4, deduped) }`. `allowedExecutionTrust` is an
  explicit allow-list, not a `maximumExecutionTrust` threshold — trust levels aren't a strict total
  order, so only an explicit list is unambiguous.

`HallTask` (`protocol/src/task.ts`) gained an optional `requirements` field. Existing tasks built
without it remain valid — this is additive, backward-compatible.

## Declared vs. observed — the SDK contract

- **`AgentAdapterDescriptor`** (`agent-adapter-sdk/src/descriptor.ts`) gained a **required**
  `declaredCapabilities: CapabilityId[]` field — static, "what this adapter was designed to
  support." Required (not optional) because every real descriptor must declare this honestly.
- **`AgentDetectionResult`** (`agent-adapter-sdk/src/detection.ts`) gained **optional** fields:
  `executionTrust`, `capabilityObservations` (max 8), `limitations` (≤300 chars each, max 6).
  Optional so pre-existing test fakes that don't set them keep compiling; the three real adapters
  always populate them meaningfully as an enforced business rule, not a schema requirement.

## What each adapter actually reports

Capability evidence is hand-authored per adapter/branch, gated by the _current_ environment check —
never unconditionally "verified." This reflects the "CURRENT VERIFIED ADAPTER STATE" ground truth
from the kickoff and each adapter's own prior real-verification sections
([`0008`](0008-claude-code-adapter.md), [`0009`](0009-codex-adapter.md),
[`0010`](0010-paperclip-compatible-codex-mode.md)).

| Adapter                                         | `declaredCapabilities`                                                                                | Available: `executionTrust`  | Available: verified                                                                                                                                                  | Unavailable/unsupported: `executionTrust`                                                                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mock Agent                                      | `structured.events`, `cancellation` — **never `project.edit`**                                        | `simulated` (always)         | `structured.events`, `cancellation` (`deterministic_test`)                                                                                                           | n/a — always simulated                                                                                                                                         |
| Claude Code                                     | `project.read`, `project.edit`, `command.execute`, `git.inspect`, `structured.events`, `cancellation` | `isolated`                   | `project.read`, `project.edit` (`isolated_smoke_test`); `structured.events`, `cancellation` (`deterministic_test`); `command.execute`, `git.inspect` `declared` only | `unavailable`                                                                                                                                                  |
| Codex (strict mode)                             | same as Claude Code                                                                                   | never available in this mode | —                                                                                                                                                                    | `unavailable`; `project.read`/`project.edit`/`command.execute`/`git.inspect` reported **`restricted`** (`environment_probe`) — a diagnosed reason, not silence |
| Codex (trusted-local, all preconditions passed) | same as Claude Code                                                                                   | `trusted_local`              | `project.read`, `project.edit` (`browser_smoke_test`); `structured.events`, `cancellation` (`deterministic_test`); `command.execute`, `git.inspect` `declared` only  | —                                                                                                                                                              |
| Codex (trusted-local, any precondition failed)  | same                                                                                                  | —                            | —                                                                                                                                                                    | `unavailable`; capabilities `restricted` (same reasoning as strict mode)                                                                                       |

Every adapter's `session.resume` and `network.access` are `unsupported` — no adapter currently
offers either through this vocabulary. Mock Agent's `limitations` always states execution is
simulated only; Codex trusted-local's `limitations` reuses `TRUSTED_LOCAL_AVAILABLE_MESSAGE`
verbatim (never re-worded to sound safer).

`restricted` vs. plain `unverified`/no-observation exists specifically to express _diagnosed_
unavailability: Codex strict mode doesn't merely lack evidence for `project.edit` — Hall has already
proven, in [`0009`](0009-codex-adapter.md)/[`0010`](0010-paperclip-compatible-codex-mode.md), that
the Windows sandbox account blocks the write. `structured.events`/`cancellation` stay `verified`
even when file editing is restricted, because those are adapter-level facts proven by the
deterministic test suite, independent of the current machine's sandbox state.

## Deterministic routing policy

New, pure module: `apps/server/src/routing/routing-policy.ts`, `evaluateRouting(requirements,
candidates)`. No I/O, no randomness, no provider reputation/cost/token comparison — same input
always produces the same output.

**Eligibility gate** (a candidate must pass all three to be considered at all):

1. `availability === "available"` (this is also what makes it `assignable`).
2. Every entry in `requiredCapabilities` has status `"verified"` for that candidate. `"declared"`,
   `"unverified"`, `"unsupported"`, and no-observation-at-all are all treated as "missing" for
   routing purposes (though shown separately, for descriptive purposes, in the `/agents` catalog).
   `"restricted"` is tracked and reported separately (`restrictedCapabilities`) so the UI can say
   _why_ — but it excludes the candidate exactly the same as "missing" does.
3. `executionTrust` is a member of `allowedExecutionTrust`.

This single gate, with no adapter-specific special-casing, naturally produces every rule the kickoff
specified: Mock Agent is excluded from any task that doesn't allow `simulated`; trusted-local Codex
is excluded from any task whose allow-list is `isolated`-only; a restricted-capability Codex is
excluded from any task requiring `project.edit`.

**Ranking** (eligible candidates only, in order):

1. **Trust-safety rank**: `isolated` (0) < `trusted_local` (1) < `simulated` (2) — Hall's own
   judgment that a real, sandboxed run is safer than either a sandbox-bypassing run or a simulated
   one, used only to order candidates a task's own `allowedExecutionTrust` already permits.
2. **Integration-level rank**: `native` < `structured_cli` < `ide_bridge` < `interactive_cli` <
   `restricted` < `unsupported`.
3. **Cancellation-verified-first** — a candidate whose `cancellation` observation is `verified` sorts
   ahead of one where it isn't.
4. **`adapterId` lexicographic tie-break** — the only place ranking ever reads `adapterId`, and only
   as a final, documented tie-break, never a hidden provider preference.

The result includes **every** candidate, even excluded ones (`rank: undefined` for those), plus
`recommendedAdapterId` (the top eligible candidate, or `undefined` if none qualify) and a bounded,
templated `safeReason`/`explanation` per candidate — always a hand-built sentence referencing only
the candidate's own fields, never raw provider output.

## Routes and orchestration

Two new routes, both delegating to `TaskOrchestrator`:

- **`POST /api/v1/tasks/:taskId/routing-analysis`** — strictly read-only. Accepts an optional body
  `{ requirements? }`; if omitted, falls back to the task's persisted `task.requirements`. Throws
  `TaskRequirementsNotSetError` (400) if neither exists. Runs a fresh `detect()` across every
  registered adapter in parallel (`detectRoutingCandidates`, mirroring `routes/adapters.ts`'s
  `detectSafely` pattern), evaluates the policy, and returns the full candidate list plus
  recommendation. **Never touches `TaskStore`'s mutating methods, never emits an event.**
- **`POST /api/v1/tasks/:taskId/route-and-assign`** — the one explicit, mutating action. Mirrors
  `assignTask()`'s exact structure: snapshot `expectedRevision` before any `await`, fast-fail on a
  task that isn't `ready` or a not-yet-started `assigned` task (409 `TaskStateConflictError`),
  resolve `requirements` the same way as analysis, run a **fresh** `detect()` + `evaluateRouting`
  (never reuses a stale prior analysis), throw `NoRoutingCandidateError` (409) if nothing qualifies,
  otherwise commit atomically via `TaskStore.assignIfEligible()` — now also persisting `requirements`
  and a `executionTrust` snapshot onto the task record at the same atomic commit. **Never calls
  `setRunId`, never starts a run.** A losing/conflicting concurrent call gets 409, exactly like
  manual assignment.

`TaskStore.assignIfEligible()`'s assignment parameter gained two optional fields —
`requirements?`, `assignedExecutionTrust?` — applied only when the caller supplies them, so manual
`POST .../assign` (which never supplies them) is byte-identical to its pre-Phase-11 behavior. No new
revision mechanism was introduced; both new routes reuse the same private `#revisions` map and
`#bumpRevision` call site that already made `assignTask()`/`startTask()` race-safe.

`TaskRecord` gained `assignedExecutionTrust?: ExecutionTrust` — a **snapshot** taken at assignment
time from the same `detect()` call the assigning request already made, not a live-recomputed value.
It cannot silently drift if the adapter's trust configuration changes later while the task sits
`assigned`.

## Concurrency

`route-and-assign` and manual `/assign` (Phase 11.1) both reuse `assignIfEligible`'s existing
optimistic-concurrency mechanism — no new revision or lock system was added. Concurrency scenarios
are covered by dedicated tests in `apps/server/src/routes/routing.test.ts` and
`apps/server/src/routes/manual-assign-requirements.test.ts`, using a shared gating technique
(`kanban-workflow.test.ts` established the pattern):

1. **Two concurrent `route-and-assign` calls** (or two concurrent manual `/assign` calls) for the
   same task — exactly one wins, the other gets 409 `TASK_STATE_CONFLICT`. Deterministic: both
   requests are held at the same shared gate and released simultaneously, so neither can commit
   before the other's revision snapshot is taken.
2. **`route-and-assign` racing a manual `/assign`** — **not** a strict "exactly one wins, the other
   gets 409" guarantee, and this phase does not attempt to make it one. `assignTask()`'s
   reassignment-before-start behavior (Phase 7.1, unchanged here) intentionally allows a second
   `/assign`-family call to succeed against a task that is already `assigned` with no `runId` yet —
   so if manual `/assign` is the request that observes the _post-commit_ state (rather than a stale
   snapshot), it legitimately reassigns rather than being rejected; both requests can validly return
   `200`. What **is** guaranteed: no request ever commits against a stale snapshot (`assignIfEligible`'s
   revision + four-field check still rejects that unconditionally, in either direction — 409
   `TASK_STATE_CONFLICT`), the final record is never a torn mix of one request's `adapterId` with
   another's `agentId`/`assignedExecutionTrust`, and — as of Phase 11.1 — **a fresh (non-stale)
   reassignment must still satisfy the task's current requirements**, so the final state is also
   never left inconsistent with `task.requirements` (see "Requirement-safe manual assignment"
   below). Achieving strict mutual exclusion between routing and manual assignment would still
   require changing Phase 7.1's reassignment semantics, which remains out of scope — flagged as an
   open design question, not resolved here.
3. **A lifecycle change during `detect()`** (task moved to `blocked`, cancelled, or its `requirements`
   changed by a competing `route-and-assign`, all while a request's own `detect()` call is still
   pending) — the stale request is rejected with 409 `TASK_STATE_CONFLICT` rather than committing an
   assignment against a task state it never actually observed; this is the same ABA-safety guarantee
   `assignTask()`'s own doc comment already describes. This is distinct from — and must never be
   confused with — 409 `ADAPTER_REQUIREMENTS_MISMATCH` (below), which rejects an accurately-read,
   non-stale snapshot because the chosen adapter itself does not satisfy the requirements observed at
   that snapshot.

## Requirement-safe manual assignment (Phase 11.1)

Manual `POST .../assign` previously never consulted `task.requirements` at all — an operator could
assign any available adapter regardless of what a task's `requirements` said, including silently
overriding a previously-routed, requirements-satisfying adapter with one that did not itself satisfy
those requirements. **This has been corrected**: `TaskOrchestrator.assignTask()` now runs the exact
same `evaluateCandidateEligibility()` check `routing-analysis`/`route-and-assign` already use (see
"Deterministic routing policy" above — there is no second, divergent compatibility algorithm)
against `preCheck.task.requirements`, immediately after the availability check and before ever
reaching `assignIfEligible`. `task.requirements` is now an **assignment invariant**, not merely a
routing input:

- **A task with no `requirements`** is completely unaffected — the check is skipped entirely,
  preserving byte-identical pre-11.1 behavior for every task that has never gone through routing.
- **A task with `requirements`** must have its selected adapter satisfy them — `available`,
  `assignable` (these two are already implied by the existing availability check), every required
  capability `verified` (not `declared`/`unverified`/`unsupported`/absent, and not `restricted`),
  and the adapter's `executionTrust` present in `allowedExecutionTrust`. An incompatible selection
  is rejected with `AdapterRequirementsMismatchError` — 409, code `ADAPTER_REQUIREMENTS_MISMATCH`,
  the fixed safe message `"The selected adapter does not satisfy this task's requirements."` — before
  any store mutation, so a rejected attempt is a pure no-op: no status change, no revision bump, no
  event.
- **Reassignment-before-start remains fully supported** — an `assigned`, not-yet-started task can
  still be reassigned, but the new adapter must satisfy the task's _current_ requirements just like a
  first assignment does. To assign an adapter whose trust or capabilities fall outside a task's
  stated requirements, the operator must first change those requirements (via a fresh "Find suitable
  agent" → route-and-assign, which persists new requirements onto the task) — there is no way to
  bypass the check for an existing task's `requirements` from the manual-assign path.
- **Browser input still cannot claim capabilities or trust**: the manual-assign request body accepts
  only `adapterId`/`workingDirectory` (`assignTaskRequestSchema`, `.strict()`); a request that tries
  to smuggle `capabilityObservations`/`executionTrust`/`requirements` fields is rejected outright by
  the existing schema, before ever reaching the eligibility check.
- **`TaskOrchestrator`'s generic code contains no provider-specific branch** — the eligibility check
  reads only `adapterId`/`descriptor`/`detection` fields already flowing through the generic
  `AgentAdapter` interface; a source-level test asserts no literal `hall.mock-agent`/`hall.codex`/
  `hall.claude-code` string appears in `task-orchestrator.ts`.

## `/agents` catalog and the "Find suitable agent" dialog

- **`GET /api/v1/adapters`** (`routes/adapters.ts`) now also returns `declaredCapabilities`,
  `assignable`, `executionTrust`, `capabilityObservations`, `limitations`, `detectedAt` per adapter.
  `detectSafely()` defaults `executionTrust` to `"unavailable"` and the observation/limitation arrays
  to `[]` if an adapter's `detect()` omits them or throws — never partially-populated, never leaked
  raw output.
- **`/agents` page** (`apps/web/app/agents/page.tsx` + `components/agents/agents-catalog.tsx`, new):
  an allowlist-rendered table/card view of every registered adapter. Execution trust is always shown
  with its exact value — `trusted_local` is never softened to `isolated`. Never renders
  `executablePath`, account info, environment variables, cost, or token data, none of which the
  server ever sends for this route, but the component is written to allowlist fields rather than
  merely omit ones it doesn't currently receive.
- **"Find suitable agent" dialog** (`components/kanban/routing-dialog.tsx`, new): available from a
  Ready task's Kanban card. On mount, and whenever the chosen requirement profile changes, it calls
  `routing-analysis` only — a read-only fetch. Five default requirement profiles
  (`lib/requirement-profiles.ts`) plus a "Custom" option are offered as a picker; none of the five
  presets requests `network.access`. "Route and assign" is disabled until a recommendation exists,
  and is the **only** control that ever calls `route-and-assign`. Closing the dialog (button or
  Escape) never assigns anything.
- **Task Details** (`components/task-detail.tsx`): shows `task.requirements` (required capabilities,
  allowed execution trust) when set, and `record.assignedExecutionTrust` when the task has been
  assigned — plain additive rendering, no new fetch.

**Scoping note**: this phase does **not** modify `TaskCreateForm` or the deferred-task-creation flow.
Requirement profiles live only in the "Find suitable agent" dialog. `route-and-assign` persists
whatever requirements it actually routed against onto the task at commit time, so Task Details can
show them afterward even for a task that started with none — this is how a task acquires
requirements without a creation-form change. Extending profiles to task creation itself is a natural,
separate follow-up, not attempted here.

## Security review

- **No spoofing vector**: `capabilityObservations`, `executionTrust`, and `assignable` are computed
  exclusively server-side, inside each adapter's own `detect()` or the routing route handler. The
  only client-supplied input anywhere in this feature is the optional `requirements` override body,
  which only ever feeds the deterministic policy function — it cannot directly set `assignable`,
  `executionTrust`, or force a candidate's inclusion.
- **No silent downgrade / no hidden provider preference**: `evaluateRouting` never mutates its
  `requirements` input and never widens `allowedExecutionTrust` or drops a `requiredCapabilities`
  entry to make a candidate fit. The ranking tie-break order is fixed and documented, and never reads
  `adapterId`/`provider` except as the explicit, final tie-break.
- **No automatic execution**: `routing-analysis` never calls any `TaskStore` mutating method or emits
  an event; `route-and-assign` never calls `setRunId` and never creates a run — both are covered by
  dedicated tests asserting zero event/run creation.
- **Leakage**: `safeReason`/`explanation`/`limitations`/`safeSummary` strings are all hand-authored,
  bounded, templated constants — never raw process output — matching the existing
  `diagnosticMessage`/`limitationNotice` discipline from [`0010`](0010-paperclip-compatible-codex-mode.md).
  The internal task revision counter is never exposed by any new response shape.
- **No subscription usage**: every Phase 11/11.1 test (adapter reporting, routing policy, routes,
  web, E2E) uses fake/fixture adapters — the real `ClaudeCodeAdapter`/`CodexAdapter` classes are
  never wired to a real spawner in any Phase 11/11.1 test, and the Playwright E2E suite's own fixture
  adapters (`apps/e2e/src/fixture-adapters.ts`) always reject `startTask()`.
- **Manual assignment can no longer bypass requirements**: see "Requirement-safe manual assignment"
  above — this was reviewed and fixed this phase, not merely documented as a known gap.

## CLI argument forwarding (Phase 11.1)

`pnpm --filter @hall-of-wisdom/hall-core run dev -- --workspace-root ...` — the documented Hall Core
startup command used throughout this README and every prior phase's manual-verification steps —
previously failed with `Unexpected argument '--workspace-root'`. The pinned pnpm version (10.33.0)
forwards the literal `--` script-separator token itself into the script's own `argv`, and Node's
`parseArgs` treats a bare `--` as "end of options: everything after this is positional" (the POSIX
convention), so every real flag after it was rejected as an unrecognized positional.

Fixed in `apps/server/src/config/server-cli-args.ts`'s new `stripLeadingScriptSeparator()`, applied
to `argv` before it ever reaches `parseArgs`: strips exactly one leading, standalone `--` — and only
if it is the very first token — leaving everything else untouched. A `--` occurring anywhere other
than index 0, a value that happens to contain two hyphens, and a second/extra leading `--` (now
correctly still rejected, not silently absorbed) are all unaffected. Direct `node dist/server.js
--workspace-root ...` invocation (no leading `--` at all) was already, and remains, a no-op through
this function. Verified both via unit tests (`server-cli-args.test.ts`) and a live process: the
documented `pnpm ... run dev -- --workspace-root ...` command now starts Hall Core successfully, its
health endpoint responds, and it shuts down cleanly leaving the port free.

`runners/hall-runner/src/cli-args.ts` uses the identical `parseArgs`/`allowPositionals: false`
pattern and, by inspection, almost certainly has the same latent bug — **not fixed here**, out of
this phase's scope (Hall Core's CLI only); flagged for a future phase.

## Deterministic tests

Spread across the modules they exercise, per this repository's per-module convention:

- `packages/protocol/src/capability.test.ts` (17 tests) — every enum, `.strict()` rejection,
  dedup/bounds refinements.
- `packages/protocol/src/task.test.ts` (+5 tests) — `requirements` absent-is-valid, valid-accepted,
  unknown-capability-rejected, empty/duplicate-trust-rejected, unexpected-field-rejected.
- `packages/agent-adapter-sdk/src/descriptor.test.ts` / `detection.test.ts` (+8/+9 tests) — the new
  required/optional fields.
- Each adapter's `descriptor.test.ts`/`detection.test.ts` — the exact `declaredCapabilities`/
  `executionTrust`/`capabilityObservations`/`limitations` values per branch described in the table
  above.
- `apps/server/src/routing/routing-policy.test.ts` — every eligibility-exclusion reason individually,
  all three worked examples from the kickoff (isolated-only → Claude recommended, Codex/Mock
  excluded; trusted-local-allowed → Claude first, then Codex; simulation-only → Mock recommended),
  determinism (identical input twice ⇒ identical output), no-mutation-of-input, tie-break ordering,
  and an explicit "ranking never reads `adapterId`/`provider` except the documented final tie-break"
  test.
- `apps/server/src/routes/routing.test.ts` (16 tests) — read-only guarantee for analysis (no
  status/revision/event change), correct recommendation/exclusion per scenario, body-override
  behavior, 400 `TASK_REQUIREMENTS_NOT_SET`, 404 unknown task, no-leak assertions; assign-only
  guarantee for route-and-assign (no `runId`/`eventsPath`), persistence of `requirements` +
  `assignedExecutionTrust`, 409 `NO_ROUTING_CANDIDATE`, 400/409 edge cases, never-starts-execution
  assertion, and the three concurrency tests described above.
- `apps/web/components/agents/agents-catalog.test.tsx` (7 tests) — renders every adapter,
  never-softens-trusted-local, Mock shown as simulated, limitation visibility, never-leaks
  executablePath/`CODEX_HOME`, error state, explanatory caveats present.
- `apps/web/components/kanban/routing-dialog.test.tsx` (9 tests) — read-only on mount, close/Escape
  never assign, explicit route-and-assign works, disabled when no candidate, custom-profile
  validation, dialog accessibility, focus-restore, error state.
- `apps/server/src/config/server-cli-args.test.ts` (Phase 11.1, +18 tests) — `stripLeadingScriptSeparator`
  unit tests plus the full pnpm-forwarding scenario list (see "CLI argument forwarding" above),
  including the exact README-documented argv shape.
- `apps/server/src/composition/codex-composition-root.test.ts` (Phase 11.1) — rewritten to inject a
  deterministic fake `ProcessSpawner` (`alwaysFailingSpawner`) instead of spawning a real `codex`
  process; a real-detection smoke check is retained but `it.skip`'d by default (opt-in only). Root
  cause of a load-induced timeout flake this phase found in a full-workspace `pnpm test` run.
- `apps/server/src/routes/manual-assign-requirements.test.ts` (Phase 11.1, 23 tests) — the full
  requirement-safe manual assignment matrix: no-requirements unaffected, compatible/incompatible
  (first and reassignment), every capability-status combination (missing/unverified/restricted),
  unavailable-adapter precedence, stale-snapshot rejection via a real revision-bumping competing
  `route-and-assign` (not a raw store poke), lifecycle-change-during-detection (blocked/cancelled),
  concurrent-manual-assign, browser-input smuggling rejection, revision privacy, and the
  no-provider-branch source check.
- `apps/web/components/kanban/assign-dialog.test.tsx` (Phase 11.1, +7 tests) — requirement display,
  incompatible-adapter disabling with a safe reason, eligible-first auto-selection, trusted-local
  warning preserved, and the 409 `ADAPTER_REQUIREMENTS_MISMATCH` keep-dialog-open/preserve-selection
  path.

## Real verification performed this phase

**Phase 11**: browser verification used fake/mock-only composition; states requiring live
authentication were not reproduced live and were documented as covered by the deterministic suites
instead.

**Phase 11.1**: genuine, headless-browser E2E verification was added and actually run — a new
`apps/e2e` package (`@playwright/test`, a new devDependency; see the phase report for the
justification) drives a real Chromium browser against the real Hall Web dev server and a real,
listening Hall Core process (`apps/e2e/src/fixture-server.ts`), _not_ the Chrome extension this
repository's prior phases relied on. That fixture server is built entirely from
`@hall-of-wisdom/hall-core`'s own public package entry (`createHallCoreApp`, `TaskOrchestrator`,
`TaskStore`, ...) plus this new package's own deterministic fixture adapters
(`apps/e2e/src/fixture-adapters.ts`) reporting exactly the required state — Mock `simulated`, Claude
Code `isolated` with verified implementation capabilities, Codex `trusted_local` with verified
implementation capabilities and its limitation notice — never a real Claude Code or Codex process
(every fixture's `startTask()` rejects unconditionally). It is a wholly separate script: `server.ts`,
`server-cli-args.ts`, and every production composition root are untouched by it, and it is reachable
through no CLI flag on the real binary. 8 Playwright specs, covering the Agents catalog (execution
trust, trusted-local warning, no sensitive data, mobile viewport), the full routing workflow
(recommend/exclude/close-without-assigning/explicit-route-and-assign/no-run), requirement-safe manual
assignment (disabled-with-reason UI, compatible reassignment), the trusted-local-allowed ranking, and
keyboard-only operation plus console cleanliness, all pass — confirmed stable across repeated runs.
Ports 3000/4310 are free and no `codex.exe`/`claude.exe` process is ever started as a result of this
suite.

## Remaining limitations

- Capability evidence is hand-authored per adapter/branch, not re-derived live on every `detect()`
  call — a live poll cannot re-run a real file-edit smoke test without spending usage. "Verified"
  reflects already-documented real verification facts, gated by the current environment check, not a
  fresh proof on every call.
- Task-creation UI is unchanged; requirement profiles exist only inside the "Find suitable agent"
  dialog, not on the create-task form.
- The routing policy has no concept of cost, token usage, or model quality — by explicit design, per
  the kickoff's "do not add" list.
- Real, controlled multi-agent execution comparison (running the same task against multiple adapters
  and comparing real output) remains out of scope — proposed as a future phase, not implemented here.
