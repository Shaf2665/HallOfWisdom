# 0014 — CEO Agent Planning, Approval-Gated Delegation and Plan Tracking

Status: Phase 14 is complete; Phase 14.1 (plan revision, atomic delegation, and browser workflow
hardening) closes seven contract gaps identified in review — see the `(Phase 14.1)`-marked
sections and paragraphs throughout. Builds on
[`0006-kanban-board.md`](0006-kanban-board.md) (task lifecycle, assignment-and-start separation),
[`0007-communication-boards.md`](0007-communication-boards.md) (board audit messages),
[`0011-agent-capabilities-trust-and-routing.md`](0011-agent-capabilities-trust-and-routing.md)
(capability/trust vocabulary, `evaluateCandidateEligibility`, routing candidates), and
[`0013-durable-persistence-and-recovery.md`](0013-durable-persistence-and-recovery.md) (the
storage-port pattern, reentrant `withTransaction`, restart recovery). Read those first.

## Why this phase exists

Every prior phase requires an operator to write each child task's title, description, and
adapter choice by hand. Phase 14 adds a "CEO Agent" that turns one parent task into a reviewable,
multi-step plan — but only ever a plan. Generating a plan creates nothing. Approving a plan
authorizes nothing to run. Only an explicit, separate "delegate" action creates child tasks, and
even then every child task is created unstarted — starting one remains the same explicit operator
action every other task in this codebase has always required.

## What this phase deliberately does not do

Restated here because it shaped every design decision below, not just the UI copy:

- No autonomous plan generation — a plan is only ever created in response to an explicit
  `POST /api/v1/tasks/:taskId/ceo-plans` call (in the UI, the "Ask CEO to plan" dialog's own
  button click).
- No autonomous approval — approval is always a distinct operator action, gated by an unchecked
  confirmation checkbox in the UI, and bound to the exact plan version and content hash it was
  shown for (see "Content-hash approval binding" below).
- No autonomous delegation, and no autonomous execution ever, under any circumstance — approving a
  plan starts nothing; delegating a plan creates child tasks but starts none of them; there is no
  bulk "Start all" control anywhere in this phase's UI.
- No LLM, no model call, no network call of any kind inside plan generation. The only planner
  wired into production (`deterministic-ceo-planner.ts`) is a deterministic, rule-and-template
  generator that never invents a file name, shell command, repository fact, or acceptance
  criterion more specific than what the parent task's own description already states.
- No automatic replanning and no cascading cancellation — if one delegated child task fails, its
  siblings are left exactly as they are; the plan's own tracked status becomes `failed`, but
  nothing is torn down or retried automatically.
- No in-place plan mutation, ever — `createVersion` (whether called via Phase 14.1's web editor or
  directly) always produces a new, immutable version and never rewrites an existing one. See "Plan
  editing and adapter override (Phase 14.1)" below.
- No new task status — plan/step progress is derived read-only from each child task's own
  authoritative `TaskStatus`, never a second, independently mutable execution state.

## Protocol schema — `packages/protocol/src/ceo-plan.ts`

Environment-agnostic (no Node built-ins, no `crypto`) so Hall Web can import it exactly like every
other protocol schema. `CeoPlanStatus` is
`draft → awaiting_approval → approved → rejected → delegated → completed | failed | cancelled`
(`rejected` and `cancelled` are also reachable directly from earlier states). Every object schema
is `.strict()`.

**`CeoPlanStep`**: id, position, title, objective, bounded instructions, acceptance criteria
(≤20), dependencies (step ids, ≤20 — cycle-checked, self-reference-checked, and
unknown-id-checked by `validateSteps`'s `superRefine` on the version schema), optional
`requirements` (the same `TaskRequirements` shape routing already uses), optional
`recommendedAdapterId`/`selectedAdapterId`, a bounded `routingSummary`, and an optional
`delegatedTaskId` (populated only after delegation).

**Content-hash approval binding.** `ceoPlanVersionSchema` carries a `contentHash` — a hex-encoded
SHA-256 (`ceoPlanContentHashSchema`, always exactly 64 lowercase hex characters) computed by
`apps/server/src/ceo-plans/ceo-plan-content-hash.ts` over `canonicalCeoPlanContent()`'s output: a
recursively key-sorted JSON string of exactly the fields an operator actually reviewed
(objective, summary, assumptions, constraints, every step's content) — deliberately excluding
`createdAt`/`createdBy`, the hash itself, any internal revision, and `delegatedTaskId` (not
knowable until after approval). `decideApproval` requires the caller to submit the exact
`(planId, planVersion, contentHash)` triple the client read; a mismatch (a concurrent edit landed
first) throws `CeoPlanApprovalBindingError` — a 409 whose message deliberately says only that the
binding no longer holds, never which field changed, so the response can't be used to probe plan
internals the client doesn't already have. This is what makes "approving version 1" mean
_exactly_ that version's content, not "whatever the plan currently looks like."

## Public concurrency contract — opaque mutation tokens (Phase 14.1)

**`internalRevision` vs. the plan's own `revision` — never conflated, and neither is ever public.**
A `CeoPlanVersion` row has a private `internalRevision` the store uses for its own optimistic
concurrency on version mutation; the public `ceoPlanVersionSchema` never carries it (see the
schema's own header comment, "Do not expose internal revisions publicly"). The `CeoPlan` aggregate
itself has a private, plain `revision` counter (bumped on every successful mutation to the plan) —
Phase 14 briefly exposed this integer directly as `GetCeoPlanResponse.revision`, which review
flagged as an unnecessary internal-state leak (a client could infer mutation cadence, and nothing
prevented a forged/guessed integer from ever being distinguishable from a stale one). Phase 14.1
replaced it everywhere with an **opaque HMAC-signed mutation token**
(`ceo-plan-mutation-token.ts`): `base64url(HMAC-SHA256(secret, "<planId>:<revision>"))`, a
43-character, no-padding string (`MUTATION_TOKEN_PATTERN`, `^[A-Za-z0-9_-]{43}$`) that is never
decoded back into a revision — `CeoPlanOrchestrator` always already knows the plan's current
revision (it just read the plan) and only ever asks "does this client's token match it," via
`CeoPlanMutationTokenIssuer.verify`, a `timingSafeEqual` comparison. The signing secret is a fresh
`crypto.randomBytes(32)` per process, held only in memory — a restart invalidates every
previously-issued token, which is safe and self-healing (a stale token fails exactly like any
other stale token, 409 `CeoPlanMutationTokenInvalidError`, "re-fetch the plan and try again"; the
very next `GET` mints a fresh valid one). Every mutating route (`submit`/`approve`/`reject`/
`delegate`/`cancel`/`createVersion`) requires this token as `expectedMutationToken` in its request
body, validated by schema regex (malformed shape → 400) before ever reaching the orchestrator
(well-formed but stale/wrong → 409). `GET /api/v1/ceo-plans/:planId` is the only place a token is
issued, as `mutationToken` in the response body — the plan's internal `revision` integer itself
is never serialized into any response, checked by a dedicated test that scans every route's
response body for a literal `"revision"` or `"internalRevision"` key.

For every mutating orchestrator method that performs real `await`s before its store write
(`delegate`, `createVersion`), the token-verify step is placed immediately before the store call,
inside the same atomic-unit callback that already re-reads the plan's fresh state for its other
checks — never earlier — so the verified revision can never go stale between the check and the
write.

## Deterministic planner — `deterministic-ceo-planner.ts`, "never fabricate" discipline

`createDeterministicCeoPlanner()` is the only planner Phase 14 wires into production
(`ceo-plan-composition.ts`). Given a parent task, it produces a generic three-step
investigate/implement/verify plan built only from fields the task actually carries — title,
description, priority, requirements, and an optional bounded operator instruction
(`ceoPlanningInstructionsSchema`, ≤2000 characters). Every piece of task-specific text in the
output is either a direct (possibly truncated, via `truncateForBound`) copy of task-authored text
or one of a small number of fixed, generic template sentences that make no claim about repository
contents. If the parent task has no description at all, the planner returns
`{ kind: "blocked", reason: "..." }` rather than guessing — surfaced to the caller as
`CeoPlanningBlockedError` (422), never a generated-but-empty plan.

**A step with no `requirements` gets no adapter recommendation, ever.** `ceo-plan-routing.ts`'s
`recommendStepAdapter` returns `recommendedAdapterId: undefined` whenever the parent task's
`requirements` is `undefined` — it never falls back to guessing a "reasonable default" adapter.
This has a genuine, load-bearing UI consequence: `requirements` is only ever persisted through
routing/assignment in this codebase (the plain backlog-creation form has no requirements field),
which is why `lib/kanban.ts`'s `CEO_PLANS_ACTION` had to be added to the `assigned` status's
action list, not just `backlog`/`ready` — a task never routed still gets a valid three-step plan,
just one where every step shows "Agent: None selected — this step cannot be delegated yet," and
delegation of such a plan is correctly refused (see `CeoPlanDelegationBlockedError` below). A
`scripted-ceo-planner.ts` test double exists for orchestrator/store tests that need a
hand-controlled plan shape without exercising the deterministic template.

The planner interface (`ceo-planner-port.ts` / `ceo-planner-contract.ts`) is intentionally the
only seam a future model-backed planner would need to implement — nothing downstream (store,
orchestrator, routes, UI) knows or cares which concrete planner produced a draft.

## Store layer — `CeoPlanStorePort`, in-memory and SQLite behind one contract

`ceo-plan-store-port.ts` defines the full interface; `in-memory-ceo-plan-store.ts` and
`sqlite-ceo-plan-store.ts` both implement it and are both run against the same
`ceo-plan-store-contract.ts` behavioral suite — the same storage-port pattern
[0013](0013-durable-persistence-and-recovery.md) established for `TaskStore`/`ComparisonStore`.
`SqliteCeoPlanStore` persists plans, versions, approvals, delegation links, and events into the
schema `0013`'s migration set added for this feature, re-validating every JSON column through its
Zod schema on read, never trusting previously-written JSON.

**Every mutating store method is a CAS write**: read the live plan, validate `expectedRevision`
matches, write, bump `revision` exactly once. A stale revision throws
`CeoPlanStateConflictError` (409) — the same "the plan moved since you last read it" family a
wrong-status transition throws (e.g. approving a plan that isn't `awaiting_approval`), so a client
handles both with one re-fetch-and-retry path.

## Orchestrator — `CeoPlanOrchestrator`

`apps/server/src/ceo-plans/ceo-plan-orchestrator.ts` owns every state transition:

- **`createPlan(parentTaskId, planningInstructions)`** — reads the parent task, runs
  `detectRoutingCandidates` once (before any store write, so a slow/failing adapter's `detect()`
  can never leave a partially-created plan behind), hands both to the planner, and persists
  exactly what it returned. Creates a plan at version 1, status `draft`. Never creates a child
  task, never assigns an adapter.
- **`createVersion`** — Phase 14 accepted source status `draft` or `rejected` only. **(Phase 14.1)**
  extended this to `draft`/`rejected`/`awaiting_approval`/`approved` — see "Plan editing and
  adapter override" below; still rejects `delegated`/terminal statuses (`CeoPlanStateConflictError`,
  delegated plans remain immutable). `submit` still accepts source status `draft` only — this
  asymmetry is deliberate (a `rejected` — or now `awaiting_approval`/`approved` — plan's only
  server-side path forward is `createVersion`, never a direct re-submit) and is exactly what the
  web UI's `showSubmit` logic (see below) matches.
- **`decideApproval`** — `approve` or `reject`, bound to `(planVersion, contentHash)` as described
  above. Approving alone starts nothing.
- **`delegate(planId, expectedMutationToken)`** — the one and only method that creates child tasks.
  See below.
- **`cancel`** — allowed from `draft`/`awaiting_approval`/`approved`/`rejected`/`delegated`.
- **`getPlanWithProgress`** — pure, read-only; every route calls this, never a mutating method. See
  "Progress synchronization (Phase 14.1)" below (replaces Phase 14's `refreshProgress`, which both
  read and lazily mutated in the same call).

**Delegation is one atomic unit spanning four stores.** `delegate()` first revalidates, per step,
outside any transaction: the chosen adapter (`step.selectedAdapterId ?? step.recommendedAdapterId`
— if both are `undefined`, `CeoPlanDelegationBlockedError` with
`Step "<id>" has no selected or recommended adapter.`, a distinct, dedicated failure path from an
adapter that resolved but is no longer eligible/available), that it's still registered, and its
current eligibility (`evaluateCandidateEligibility`, the exact same function Phase 11 routing
uses — never a second, looser check). It also blocks on a cancelled parent task and on capacity.
Only once every step passes does it enter `#runAtomicUnit`, which re-validates the plan's status
and active-version content hash haven't moved since the pre-check (closing the race between
pre-check and commit), then creates every child task, records the delegation links, appends the
`ceo.plan.delegated` event, and posts one board audit message — all inside one physical
transaction in durable mode (`runAtomicUnit` is `(fn) => withTransaction(db, fn)`, and since
`0013`'s `withTransaction` is reentrant, `TaskStore`/`CeoPlanStore`/`BoardStore`/`MessageStore`'s
own individual `withTransaction` calls each become a nested `SAVEPOINT` rather than a second
top-level transaction). **(Phase 14.1)** In ephemeral (in-memory) mode, `runAtomicUnit` is now
`createEphemeralAtomicUnit({ taskStore, boardStore, messageStore, planStore })`
(`ephemeral-atomic-unit.ts`) — see "Ephemeral delegation atomicity" below; Phase 14's original
ephemeral mode was simply `(fn) => fn()`, relying only on pre-validation discipline with no real
rollback, which review identified as a genuine atomicity gap (a mid-delegation failure after the
first child task was created left that task behind). A repeated delegation request after success
creates no duplicate child tasks (`CeoPlanAlreadyDelegatedError`).

Every delegated child task is created with a real dependency on its sibling's real task id
(mirroring the plan step's own `dependencies`), `status: "assigned"`, a real `adapterId` and
`agentId`, but **no `runId`** — exactly the same "assigned, not started" state every other
task-creation path in this codebase already produces, so the pre-existing Kanban "Start task"
action is the only way any of them ever runs.

## Ephemeral delegation atomicity (Phase 14.1)

`ephemeral-atomic-unit.ts`'s `createEphemeralAtomicUnit` gives in-memory mode the same
all-or-nothing guarantee durable mode already had from `withTransaction` — not a real transaction
log, but a bounded, four-store snapshot/restore: every store's entire in-memory state
(`TaskStore`, `BoardStore`, `MessageStore`, `InMemoryCeoPlanStore`) is shallow-cloned via its own
`snapshot()` immediately before the delegation callback runs, and restored wholesale via
`restore()` if the callback throws. This is sufficient — not merely best-effort — because every
store in this codebase already replaces whole record objects on mutation rather than mutating
fields in place (each store's own `snapshot()` doc comment states this invariant explicitly).
`Snapshottable<S>` is a structural (duck-typed) interface, not a concrete-class check — deliberate,
so `task-mutation-hook.ts`'s wrapper (a plain object, not a `TaskStore` instance; see "Progress
synchronization" below) can still participate by pass-through delegating `snapshot()`/`restore()`
to the real store it wraps. A shared fault-injection contract suite
(`ceo-plan-delegation-atomicity.contract.ts`) runs identically against both the durable
(`withTransaction`) and ephemeral (`createEphemeralAtomicUnit`) coordinators, proving byte-identical
all-or-nothing behavior under injected mid-delegation failures at every child-task-creation point —
including that no plan event of any kind reaches a subscriber for a delegation attempt that fails
and rolls back.

## Plan progress derivation — `ceo-plan-progress.ts`

Deliberately not a new task status. `deriveCeoPlanProgress` computes each step's
`CeoPlanStepProgressStatus` (`waiting_for_dependencies | ready_to_start | running | completed |
failed | cancelled | blocked`) fresh, on every call, from its linked child task's own
authoritative `TaskStatus` plus its dependency steps' own derived statuses — never a second,
independently mutable execution field stored anywhere. A step whose dependency failed, was
cancelled, or is itself blocked is reported `blocked`, not silently left `waiting_for_dependencies`
forever.

**Plan completion policy** (`derivePlanTerminalOutcome`, documented in code as the kickoff
required): `completed` only once every child task has itself completed; `failed` as soon as _any_
child task reaches `failed`/`cancelled`/`blocked`, even while siblings are still running —
Phase 14 has no continuation policy, so a failed step is immediately fatal to the plan's own
tracked outcome, not silently waited out.

## Progress synchronization (Phase 14.1)

Phase 14's `refreshProgress` conflated a read with a write: every `GET` on a plan could itself
mutate the plan's status and append an event, which review flagged as a real "GET has side
effects" contract violation, and also meant `ceo.plan.progress_changed` was defined in the type
enum but never actually emitted anywhere. Phase 14.1 replaces it with two cleanly separated pieces:

- **`CeoPlanOrchestrator.getPlanWithProgress`** — pure, read-only, callable from any `GET` route.
  Never mutates plan status or appends an event, no matter how many times it's called.
- **`synchronizePlanProgress`** (`ceo-plan-progress-sync.ts`) — the mutating half, never called
  from a route. Derives progress fresh, computes a SHA-256 fingerprint over `[stepId, status]`
  pairs, and compares it against the plan's own stored `last_progress_fingerprint` (a Phase 14.1
  migration column). Unchanged → no-op (idempotent: a duplicate or out-of-order trigger never
  appends a second event for the same transition). Changed → appends exactly one event
  (`ceo.plan.progress_changed`, or `ceo.plan.completed`/`ceo.plan.failed` if
  `derivePlanTerminalOutcome` now returns a terminal outcome) inside the same atomic unit as the
  fingerprint update, then publishes strictly after commit — the same discipline `delegate()`
  already followed.

**What triggers a sync.** `task-mutation-hook.ts`'s `wrapTaskStoreWithMutationHook` wraps the
`TaskStorePort` at the composition root (before it's handed to _both_ `TaskOrchestrator` and the
CEO plan composition), so every status-changing task-store method also notifies a listener after
the real mutation succeeds — regardless of which orchestrator performed the mutation, since a
plan's child task can change status via a route `TaskOrchestrator` owns entirely, with no
`CeoPlanOrchestrator` involvement at all. The listener resolves to
`CeoPlanOrchestrator.onChildTaskMutated`, which looks up the owning plan
(`findPlanIdByChildTaskId`) and calls `synchronizePlanProgress`. Listener exceptions are caught and
swallowed — a missed sync is recoverable; the real task mutation must never fail because of it.
`recordEventMeta` (event-count/sequence bookkeeping, not a status change) deliberately does **not**
trigger a sync — it can never change the derived fingerprint, so notifying on it would be pure
overhead on the hottest possible path (every normalized event on every delegated child task).
**`reconcileAllPlanProgress`** (`ceo-plan-progress-reconciliation.ts`) is the idempotent backstop:
run once at startup, right after restart recovery, it re-synchronizes every `delegated` plan —
self-healing any hook notification genuinely missed (e.g. a crash between the child task's
mutation and the hook's callback completing).

## Events and WebSocket — `ceo-plan-events.ts`, `GET /api/v1/ceo-plans/:planId/events/live`

`CeoPlanEventType` covers `created / version_created / submitted / approved / rejected / cancelled
/ delegated / progress_changed / completed / failed`. Every mutation append-only records an event
via the same `planStore.appendEvent` call inside the same atomic unit as the mutation itself, and
`CeoPlanEventBus` only publishes to subscribers strictly after that commit (a dedicated test,
"publishes each plan event to subscribers strictly after the underlying mutation commits", proves
the ordering). The WebSocket route mirrors `routes/task-events.ts`/`routes/board-messages.ts`
exactly: exact-Origin validation, live subscription registered before replay (so the two paths can
never double-deliver), the same close-code vocabulary (4400/4403/4404/4503/1003), and every
outgoing frame re-validated through `ceoPlanEventSchema` immediately before `send()`.

**(Phase 14.1) `ceo.plan.progress_changed` is now genuinely emitted**, in real time, whenever a
delegated plan's linked child task changes status — see "Progress synchronization" above. A
browser with a CEO plan detail page open receives it over the existing WebSocket subscription and
re-fetches (`ceo-plan-detail.tsx`'s `useCeoPlanEvents` triggers a refetch on any new event,
unfiltered by type — no additional wiring was needed on the web side, since this behavior already
existed for the `completed`/`failed` case Phase 14 shipped).

## REST API — `apps/server/src/routes/ceo-plans.ts`

`POST /api/v1/tasks/:taskId/ceo-plans` (create, 201 — the only route that ever generates a draft),
`GET /api/v1/ceo-plans` (list all), `GET /api/v1/ceo-plans/:planId` (detail — pure read via
`getPlanWithProgress`; response is `{ plan, progress, links, mutationToken }` — **(Phase 14.1)** was
`revision` until Task 1's opaque-token migration, see above), `GET .../versions`, `GET
.../versions/:version`, `GET .../approvals`, `GET .../events`, `POST .../versions` (create a new
version, 201 — Phase 14.1 also allows this from `awaiting_approval`/`approved`, not just
`draft`/`rejected`), `POST .../submit`, `POST .../approve`, `POST .../reject`, `POST .../delegate`
(202 — the only route that ever creates child tasks), `POST .../cancel`. Every mutating route
requires `expectedMutationToken` in its body (`mutationTokenRequestSchema`, or embedded in
`decideCeoPlanApprovalRequestSchema` / `createCeoPlanVersionRequestSchema`, all `.strict()`; a
malformed token 400s at the schema boundary, a well-formed-but-stale one 409s inside the
orchestrator). Candidate events stream over `GET /api/v1/ceo-plans/:planId/events/live` (WebSocket,
see above).

## Composition wiring — `ceo-plan-composition.ts`

Never builds its own `TaskStore`/`BoardStore`/`MessageStore` — always reuses the exact instances
`createCoreStoresComposition` already built, which is what lets delegation's atomic unit span all
four stores (see above). Picks `SqliteCeoPlanStore` vs. `InMemoryCeoPlanStore` based on whether a
`HallDatabase` was supplied, exactly mirroring `0013`'s durable/ephemeral branch elsewhere. Wired
into production (`server.ts` via `createMockAgentServerComposition`) and into the E2E fixture
server (`apps/e2e/src/fixture-server.ts`) identically — no scripted planner in either place, only
the deterministic one.

## Plan editing and adapter override (Phase 14.1)

Phase 14 shipped `createVersion` (store/orchestrator/protocol) with no browser surface to reach
it — a `rejected` plan's only forward path in the web app was cancellation. Phase 14.1 closes this
with two new components, always reachable from `ceo-plan-detail.tsx`'s "Edit plan…" button whenever
`plan.status` is `draft`/`rejected`/`awaiting_approval`/`approved` (never `delegated` or a
terminal status):

- **`ceo-plan-edit-form.tsx`** — pre-fills every field from the plan's current active version and
  saves exclusively via **"Save as new version"** (`createCeoPlanVersion`); there is no in-place
  "Save" anywhere in this form, matching the orchestrator's own "always a new, immutable version"
  discipline. Every submitted step is built as an explicit object literal, never a spread of the
  loaded `CeoPlanVersion.steps` entry — `CeoPlanStep` carries `routingSummary` (always present) and
  `recommendedAdapterId`/`delegatedTaskId`, none of which the server's `.strict()`
  `editedCeoPlanStepRequestSchema` accepts; a spread would 400 on submit despite typechecking
  cleanly, since a spread suppresses TypeScript's excess-property check. Step reordering and
  removal use accessible "Move up"/"Move down"/"Remove step" buttons (no drag-and-drop, matching
  `0006`'s existing accessible-non-drag convention); array index at save time is always the
  submitted `position` (reorder never touches a separate `position` field), and removing a step
  strips its id from every other step's `dependencies` before submission, so the server's
  dependency-graph validation (`validateSteps`) never sees a dangling reference. A step or
  assumption/constraint/acceptance-criterion added via the form's own "Add …" buttons starts blank;
  the form disables "Save as new version" and shows an inline message until every required field is
  non-blank, rather than letting a blank field reach the server as a generic 400.
- **`ceo-step-adapter-selector.tsx`** — one instance embedded per step row in the edit form.
  Read-only with respect to eligibility: it calls the same
  `POST /api/v1/tasks/:taskId/routing-analysis` the "Find suitable agent" dialog already uses
  (`getRoutingAnalysis`), scoped to that one step's own (possibly locally-edited, not-yet-saved)
  `requirements` — never the parent task's stored requirements — and renders eligible candidates
  selectable, ineligible ones disabled with their bounded reason, plus the existing trusted-local
  warning. It never decides whether an override is allowed to persist; `CeoPlanOrchestrator.
createVersion`'s server-side validation (`CeoPlanStepAdapterInvalidError`, 422 — added in Task 2:
  an unregistered or newly-ineligible `selectedAdapterId` is rejected at save time, not just at
  delegation time) is the real trust boundary this selector is only a display of.

This also closes Phase 14's "creating a genuinely delegatable plan requires routing/assigning the
parent task first" limitation: an operator can now set a step's `requirements` and pick an adapter
directly in the edit form, without ever routing the parent task through the Kanban board.

## Hall Web — `/ceo`, task integration, dialogs

`apps/web/app/ceo/page.tsx` (list, optionally filtered by `?parentTaskId=`) and
`apps/web/app/ceo/[planId]/page.tsx` (detail) mirror the `/comparisons` pages' own convention.
`components/ceo/` holds `create-ceo-plan-dialog.tsx`, `ceo-plan-detail.tsx`,
`ceo-approve-dialog.tsx` / `ceo-reject-dialog.tsx` / `ceo-delegate-dialog.tsx` (each gated by an
unchecked-by-default confirmation checkbox), `ceo-plans-list.tsx`, `ceo-plan-status-badge.tsx`, and
**(Phase 14.1)** `ceo-plan-edit-form.tsx` / `ceo-step-adapter-selector.tsx` (see above).
`hooks/use-ceo-plan-events.ts` subscribes to the WebSocket route above with the same
reconnect/backoff schedule every sibling hook uses, and refetches the plan on _any_ new event
(unfiltered by type) — which is also what makes the real-time `progress_changed` event (see above)
reach an open detail page with no additional wiring.

A Kanban card's "Actions" menu exposes a "CEO plans" action on `backlog`, `ready`, and `assigned`
status tasks (`lib/kanban.ts`'s `CEO_PLANS_ACTION`) — routing to `/ceo?parentTaskId=<id>`. The
`assigned` inclusion remains useful (a task with real `requirements` from prior routing still gets
step-level recommendations pre-filled) but is no longer strictly required to reach a delegatable
plan, since the edit form's adapter selector (above) can set `requirements` and an override
per-step regardless of the parent task's own routing history.

**`CeoPlanDetail`'s `showSubmit` is `plan.status === "draft"` only** — not `"draft" ||
"rejected"` — matching `submit()`'s own server-side status guard. **(Phase 14.1)** A
`rejected`/`awaiting_approval`/`approved` plan's forward path back to `draft` is now the edit form
above (`createVersion`), never a direct re-submit; `showSubmit` naturally becomes `true` once the
new version lands and the page refetches — no new boolean was needed.

## Durable restart coverage

`apps/server/src/composition/ceo-plan-durable-restart.test.ts` drives a real `createServerComposition`
across a genuine `HallDatabase` close/reopen (the same pattern `0013`'s own `durable-restart.test.ts`
uses): a delegated plan's version, content hash, approval, delegation links, and event history
survive an unclean restart byte-identical, and `getPlanWithProgress` does not wrongly auto-advance
status while children are still incomplete (it cannot — it's pure); a second scenario runs every
delegated child task to real completion via a real Mock Agent adapter before crashing, with the
task-mutation hook's `onChildTaskMutated` callback deliberately stubbed to a no-op for the duration
of the completion loop — faithfully simulating "the hook fired but its notification never actually
ran the sync" (as if the process died mid-notification), since real hook wiring otherwise makes
that race undeterministically reproducible through the normal code path. It then confirms the
startup **reconciliation pass** (`reconcileAllPlanProgress`, not a subsequent `GET`) is what
performs the actual `delegated → completed` transition on restart, and that a second reconciliation
pass is idempotent; a third scenario confirms an unsubmitted draft plan survives unchanged.

## Playwright E2E coverage — `apps/e2e/tests/ceo-plans.spec.ts`

Two tests exercise the full spine against the shared fixture Hall Core: create → route/assign (to
give the parent task real `requirements`, since the plain backlog form has none) → open CEO plans
→ create a draft → submit → approve (confirming approval alone starts nothing, by navigating away
and back) → delegate (confirming exactly three unstarted, correctly-linked child tasks, each still
exposing its own manual "Start task" action, and no bulk "Start all" control anywhere); and a
reject flow confirming the rejection is recorded with its reason and that no direct re-submit
button appears afterward.

**Deliberately not covered here** (disclosed, not silently skipped): starting a delegated child
task and observing live progress in-browser — blocked by the pre-existing, repo-wide Phase 11
fixture constraint that `src/fixture-adapters.ts`'s `startTask()` rejects unconditionally for every
adapter except the comparison-specific one; the underlying progress-sync behavior this would
exercise is instead covered with a real executable Mock Agent by the durable-restart test above.
**(Phase 14.1)** `ceo-plans-durable-restart.spec.ts` adds dedicated browser coverage for the edit
form/adapter selector flow and a genuine mid-session Hall Core restart — landed; see the addendum
immediately below for what it covers. `ceo-plans-focused.spec.ts` (keyboard-only interaction,
duplicate delegation, mobile/desktop rendering) is still planned, not yet landed.

## Playwright E2E coverage (Phase 14.1 addendum)

Mirrors `durable-restart.spec.ts`'s dedicated-real-binary pattern (own ports, own `--data-dir`,
`requireDurableRestartBuildArtifacts()`-style guard) rather than the shared fixture pair the
original spec above uses:

- **`ceo-plans-durable-restart.spec.ts`** (landed) — a single long-running scenario covering:
  creating a second plan version through the edit form, with the per-step adapter selector
  rendering and its "Recommended" candidate visibly selected and clicked (the plan's own routing
  profile makes Mock Agent the only `simulated`-trust adapter, so this exercises the selector's
  rendering and click interaction, not a persisted override — see that spec's own file-level doc
  comment for why a genuine cross-restart adapter override isn't reachable through the real
  production binary in this scenario); approving only version 2; delegation creating exactly one
  assigned, unstarted child per step with dependency readiness reflected in the UI; Hall Core
  stopping gracefully mid-session (checked via `/system`'s "Hall Core: Offline"/"Online" text, the
  same proven signal `durable-restart.spec.ts` uses) and restarting against the same `--data-dir`;
  both versions' bookkeeping surviving intact — the Activity log still showing both the
  version-1-creation and version-2-creation events, and the approval history still correctly
  attributing the approval to version 2 specifically (the detail page only ever renders the plan's
  current active version, so this is what "both versions survive" means through genuine browser UI,
  not a dedicated read-a-past-version view, which does not exist); one or more
  `progress_changed`-driven Activity log updates as the one dependency-free child runs to completion
  — delegation's own reconciliation pass and the assigned→running edge each already produce a real,
  correct event before completion, so the count is not fixed, but it settles once the run completes
  and a page reload never moves it further (the fingerprint guard's actual promise — see Task 6);
  and confirming no path, content hash, internal revision, mutation-token internals, or database
  metadata is ever visible in the rendered DOM. Also fixed in the shared
  `durable-restart-harness.ts` while building this spec: `spawnDurableHallCore`'s `--web-origin` was
  hardcoded to `durable-restart.spec.ts`'s own web port, silently breaking CORS for any caller using
  a different one — it now takes an optional `webPort`.
- **`ceo-plans-focused.spec.ts`** (planned) — five smaller, targeted tests intended to cover: (A)
  reject → edit → resubmit → approve, the full round trip through the new editor; (B) keyboard-only
  interaction (Escape closes every CEO dialog without mutating anything, focus returns correctly,
  every confirmation checkbox starts unchecked); (C) duplicate delegation (firing the delegate
  action twice in quick succession produces exactly one set of child tasks, one
  `ceo.plan.delegated` event, one audit message, verified across five consecutive runs); (D) mobile
  390×844 (no horizontal scroll, the edit form and adapter selector remain reachable, trusted-local
  warning text isn't clipped); (E) desktop 1440×900 (zero console errors, zero hydration warnings,
  zero CORS failures across the full create→edit→submit→approve→delegate flow).

Both specs use (or, for the still-planned one, will use) the registered Mock Agent adapter
exclusively — no real Claude Code or Codex invocation, matching every other test in this codebase.

## Known Phase-14 limitations

Stated explicitly rather than left for a reader to discover by omission. Three of Phase 14's four
original limitations were resolved by Phase 14.1 and have moved into the main body above (marked
`(Phase 14.1)`): real `ceo.plan.progress_changed` emission ("Progress synchronization"), a
plan-editing UI ("Plan editing and adapter override"), and the routing-first requirement for a
delegatable plan (same section). A fourth — `ceo-plans.spec.ts` failing in a full-suite E2E run —
was root-caused and fixed in Phase 14.2 (see "MoveMenu viewport-aware positioning (Phase 14.2)"
below); it is no longer an accepted limitation. What remains:

1. **No automatic replanning or cascading cancellation** if a delegated child task fails — see
   "Plan progress derivation" above. Out of scope for Phase 14.1 by explicit instruction, not an
   oversight.
2. **No child-task execution/progress observation in-browser via E2E for the original spec's flow**
   (`ceo-plans.spec.ts` itself) — the durable-restart integration test covers the underlying sync
   mechanism with a real adapter (see "Durable restart coverage"), and `ceo-plans-durable-restart.spec.ts`
   (Phase 14.1, landed) now covers it in-browser too, through its own edit/delegate/restart flow
   rather than the original spec's; this does not replace a true live multi-agent execution demo,
   which remains out of scope.

## MoveMenu viewport-aware positioning (Phase 14.2)

**Root cause, isolated in two parts.** A full `pnpm --filter @hall-of-wisdom/e2e run e2e` run
reproducibly failed one `ceo-plans.spec.ts` test with a "CEO plans ... outside of the viewport"
click timeout. Investigation (live geometry captured at the point of failure — trigger and popover
`getBoundingClientRect()`, `window.innerWidth/innerHeight`, `scrollX/scrollY`) found this was **not**
a test-isolation or fixture-state-leakage bug — no test in the suite asserts an ordering-dependent
count or an un-scoped locator, and every card/message/dialog locator across the CEO-plan specs is
already scoped to its own unique task title or dialog container. It was a genuine product defect in
`MoveMenu` (`apps/web/components/kanban/move-menu.tsx`): the popover always rendered below the
trigger with no flip-up fallback, and — the more surprising half — its own accessibility behavior
made things worse. Auto-focusing the first menu item for keyboard users, via a plain `.focus()`
call, made the browser try to scroll a `position: fixed` element into view; that does nothing useful
for a viewport-relative element, but on a long accumulated board it could scroll the _page_ by
thousands of pixels, leaving the popover's already-computed position stale relative to the trigger's
new location and landing it past the viewport bottom.

**Fix.** `move-menu-position.ts` is a new, pure, unit-tested function (`computeMenuPosition`) that
flips the popover above the trigger when there isn't room below, and clamps both axes to stay within
the viewport with an 8px margin — dependency-injected trigger/menu/viewport rects, no DOM access, so
its flip/shift/clamp geometry is tested deterministically (`move-menu-position.test.ts`, 10 cases,
including the exact failing geometry captured live during investigation). `move-menu.tsx` measures
the trigger and the popover's own rendered size in a single pre-paint `useLayoutEffect` pass (the
popover mounts once at an off-screen, `visibility: hidden` placeholder position so there's no visible
flash at the wrong spot), and — the second half of the fix — passes `{ preventScroll: true }` to the
auto-focus call, so opening the menu never triggers an unwanted page scroll in the first place.
Position now _recomputes_ (not closes) on scroll/resize while the menu is open, tracking the trigger
instead of abandoning the disclosure — a deliberate change from the original "close on any
scroll/resize" behavior. `move-menu.test.tsx` (13 cases) covers the resulting behavior end to end:
below/above placement, edge clamping, resize/scroll recalculation, Escape-closes-and-restores-focus,
outside-click-closes, a disabled trigger, exactly-one-of-two-menus-open, and portal/trigger
association via `aria-controls`.

A dedicated Playwright regression, `move-menu-accumulation.spec.ts`, creates its own batch of
backlog cards (so it reproduces reliably in isolation, not only after a long full-suite run),
scrolls the target card into view the way a real user would, and opens `MoveMenu` through a real
pointer click and, separately, real keyboard input (`Tab`-equivalent `.focus()` + `Enter`) — no
DOM-dispatch bypass, no `force: true`. It asserts the popover's own bounding box stays fully inside
the viewport at both 390×844 and 1440×900. `ceo-plans-focused.spec.ts`'s own interaction helper was
simplified in the same pass: an earlier draft's bounded-retry-plus-DOM-dispatch-fallback workaround
(needed only because the popover could genuinely go unreachable before this fix) was removed
entirely — every interaction in that file is now a plain `locator.click()`, and the whole file runs
roughly 40% faster with the retry/fallback machinery gone.

One related, but explicitly _unrelated-to-`MoveMenu`_, finding surfaced while building the
accumulation regression: `/board`'s own multi-column layout (`KanbanBoard`'s `overflow-x-auto`
columns row, ten fixed-width `w-72 shrink-0` columns) can widen past `document.documentElement`'s
own client width once enough cards accumulate at a narrow viewport — confirmed via a diagnostic that
walks every element for the widest `right` edge at the point of overflow: it is always a Kanban
column `<section>`, never `MoveMenu`'s own popover. At the time this was a known, undiagnosed
board-layout characteristic, so `move-menu-accumulation.spec.ts` scoped its own horizontal-overflow
assertions away from `/board` (onto the single-column `/ceo` screen and the popover's own bounding
box) with a doc comment explaining why. **Phase 14.3 root-caused and fixed this** (see "Kanban
mobile overflow containment (Phase 14.3)" below): the columns row was missing its own
`position: relative` containing block, letting an `sr-only` absolutely-positioned label's
un-scrolled static offset leak into the document's own scrollable-overflow region. With that fixed,
`move-menu-accumulation.spec.ts` now asserts no horizontal overflow on `/board` directly too, as
live regression coverage for the Phase 14.3 fix.

**Verification.** `pnpm --filter @hall-of-wisdom/e2e run e2e` passed with zero failures across three
consecutive complete runs. `ceo-plans.spec.ts` (5 consecutive runs), `ceo-plans-focused.spec.ts` (3
consecutive full-file runs), `move-menu-accumulation.spec.ts` (5 consecutive runs), the keyboard-only
test (3 consecutive standalone runs), and the duplicate-delegation test (5 consecutive standalone
runs, plus 3 more via the full-file runs — 33 delegate-race rounds total) all passed with zero
flakiness. No test in the suite uses a DOM-dispatched click, `force: true`, or direct React handler
invocation to reach `MoveMenu`.

## Security review performed this phase

- **No autonomous execution at any stage** — verified structurally, not just by convention:
  `createPlan` and `decideApproval` never call `taskStore.setRunId`/anything adapter-related;
  `delegate` creates every child task via the exact same "assigned, no `runId`" path Kanban
  assignment already uses, and posts no bulk-start capability. A dedicated orchestrator test
  ("posts a bounded board audit message and a plan event on creation" plus the approval-flow
  tests) asserts zero child tasks exist after creation, submission, and approval alone.
- **Approval cannot be replayed against a changed plan** — `CeoPlanApprovalBindingError`, bound to
  `(planVersion, contentHash)`; a dedicated test ("an approval submitted for a version that is no
  longer active is rejected") proves editing invalidates a pending approval.
- **Delegation re-validates everything at the moment of delegation, never trusts approval-time
  state** — adapter registration, eligibility (`evaluateCandidateEligibility`, the same function
  Phase 11 routing uses, never a looser duplicate), parent-task cancellation, and capacity are all
  re-checked inside `delegate()` itself, immediately before the atomic write. A step with no
  adapter at all (`recommendedAdapterId`/`selectedAdapterId` both `undefined`) is a distinct,
  explicitly tested failure path from an ineligible adapter, both blocking the entire delegation
  with zero child tasks created.
- **No client-controlled plan content bypasses the planner.** `createPlan`'s request body accepts
  only an optional bounded `planningInstructions` string (`.strict()`); every step's title,
  objective, instructions, and acceptance criteria are always planner-generated, never supplied
  directly by a client at creation time.
- **Every mutating route requires an explicit optimistic-concurrency token**
  (`expectedMutationToken` — **(Phase 14.1)** opaque and HMAC-signed, never the plan's raw internal
  revision integer, see "Public concurrency contract" above — plus the content-hash binding for
  approval decisions) — no route accepts a blind "just do it" mutation against whatever the plan's
  current state happens to be.
- **(Phase 14.1) A step's `selectedAdapterId` override is validated server-side at save time, not
  only at delegation time** — `createVersion` rejects (422, `CeoPlanStepAdapterInvalidError`) an
  unregistered adapter or one that no longer satisfies the step's own `requirements`, so the web
  adapter selector (above) can be purely a display of server-computed eligibility; a browser can
  never persist an override that could never actually delegate.
- **(Phase 14.1) System-author spoofing remains impossible by construction, re-verified.**
  `CreateMessageRequest`'s schema has no `author` field at all (`.strict()`, so a request body
  containing one fails validation rather than being silently stripped) — the protection is
  shape-absence, not a runtime denylist check. New tests confirm a POST attempting
  `author.kind: "system"`, or attempting to claim a system-looking display name via a `human`-kind
  override, both 400 and store nothing; the WebSocket route continues to close on any client-sent
  frame.
- **Bounded, safe event payloads** — `ceoPlanEventSchema`'s payload schema caps keys (≤25) and
  string values (≤1000 chars), matching `StructuredFailure.details`'s existing discipline; no
  event payload ever carries a stack trace, absolute path, or raw adapter output.
- **WebSocket route matches the existing task/board-event safety mechanisms exactly** — Origin
  validation, close-code vocabulary, subscriber limits, replay-then-live-subscribe ordering with
  no double-delivery window.
- **No real Claude Code or Codex invocation anywhere in this phase's own development** — every
  test, including the durable-restart child-task-completion scenario, used the registered Mock
  Agent adapter exclusively; no provider subscription usage was consumed.

## What's next

Phase 14 (CEO Agent planning, approval-gated delegation, and plan tracking) and Phase 14.1 (plan
revision, atomic delegation, and browser workflow hardening) are both complete. The natural next
phase — **not implemented here** — is Phase 15: Autonomous Plan Execution, Step Scheduling and
Operator Intervention. With this phase's real-time progress events, atomic ephemeral delegation,
and plan-editing UI now in place, Phase 15's remaining prerequisites are narrower: an operator
continuation/replanning policy for a failed step (see "Known Phase-14 limitations" above) and a
live in-browser multi-agent execution demonstration.
