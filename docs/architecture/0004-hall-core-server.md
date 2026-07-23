# 0004 — Hall Core Server

Status: Draft (Phase 5, hardened in Phase 5.1; extended in Phase 6 and Phase 7; assignment
concurrency hardened in Phase 7.1 and 7.2; extended in Phase 8 with Communication Boards — see
`0007-communication-boards.md`).

## Context

Phase 5 introduces `@hall-of-wisdom/hall-core` (`apps/server`): a local Fastify HTTP + WebSocket
server that creates and runs tasks, in-memory, through Hall Runner's public API. It is a
prototype: a single local process, no authentication, no persistence, no browser UI — but the
task/event model and API shape it establishes are what Hall Core will keep building on.

Phase 5.1 ("Event Capacity and WebSocket Backpressure Hardening") corrected two gaps a
post-implementation review found in Phase 5: reaching `maxEventsPerTask` left a task stuck rather
than reaching a terminal state, and a slow WebSocket client had its frames silently skipped rather
than being disconnected. See "Event-capacity terminal handling" and "WebSocket backpressure
policy" below for the corrected design.

## Hall Core's responsibilities

1. Expose a health endpoint.
2. Accept task-creation requests and start them asynchronously (never blocking the HTTP request
   on the agent finishing).
3. List and retrieve tasks.
4. Accept cancellation requests for active tasks.
5. Stream a task's normalized events over WebSocket, with replay for late/reconnecting clients.
6. Store tasks and events in memory, within configured bounds.
7. Shut down cleanly, cancelling active runs first.

## Temporary in-process Hall Runner connection

For this phase, Hall Core and Hall Runner execute in the same Node.js process: `TaskOrchestrator`
calls Hall Runner's exported `runTask()` directly, in-process, the same way Hall Runner's own CLI
(`cli.ts`) does — just with an `onEvent` callback instead of writing JSON Lines to stdout. An
[architecture-review subagent](#future-remote-runner-boundary) confirmed before this phase's
implementation began that `runTask`, `AgentRegistry`, and `validateWorkspace` — exactly as already
exported from `@hall-of-wisdom/hall-runner`'s `index.ts` — already support everything
`TaskOrchestrator` needs: dependency-injected registries, `AbortSignal`-based cancellation, and a
plain event-sink callback. **No changes were made to Hall Runner's public API in this phase.**

## Future remote-runner boundary

This in-process connection is deliberately temporary. A future phase may connect Hall Core to one
or more _remote_ Hall Runner processes (potentially on different machines, so a coding agent can
run somewhere other than where Hall Core itself runs) through a dedicated, secure worker protocol.
That protocol does not exist yet and is not implemented here — nothing in this phase should be
read as already supporting remote Hall Runner communication. `TaskOrchestrator`'s dependency on
`runTask()` as a plain async function (not, say, a direct reference to an `AgentRegistry` singleton)
is what will make that swap possible later without redesigning the orchestrator: a remote-runner
client can implement the same call shape (`registry`/`adapterId`/`taskInput`/`options`/`onEvent` in,
`RunTaskResult` out) as a network call instead of an in-process call.

## Fastify application factory

`createHallCoreApp(options)` (`app.ts`) builds and fully configures a Fastify instance but never
calls `.listen()` — only `server.ts` (the process boundary) does that. This is what makes the
factory directly testable via Fastify's `.inject()` (all HTTP-route tests in this phase use it) and
reusable by anything else that wants to embed Hall Core without necessarily binding a real port.
`@fastify/websocket` is registered (and awaited) before any WebSocket route is declared, as its own
documentation requires.

## Local-only binding

The server binds to `127.0.0.1` only (`LOCAL_ONLY_HOST` in `config/server-config.ts`) — there is no
CLI flag to change this in this phase, deliberately. Binding to `0.0.0.0` would expose Hall Core
(and, transitively, whatever coding agent it's driving) to the local network; nothing in this
phase's threat model calls for that, and adding it prematurely would be adding attack surface with
no corresponding requirement. This remains true as of Phase 6, which only adds a browser client on
a _different_ local port (`apps/web`, `127.0.0.1:3000`) — see "Exact-origin CORS policy" and
"WebSocket Origin validation" below for how Hall Core now allows exactly that one cross-origin
caller without loosening its own bind address.

## Exact-origin CORS policy

As of Phase 6, `@fastify/cors` is registered in `app.ts` before every route, with an **exact
allowlist of one origin** — `[webOrigin]`, where `webOrigin` defaults to `http://127.0.0.1:3000`
and can be overridden with `--web-origin` (parsed and normalized by `config/web-origin.ts`, the
same strict http(s)-only/no-credentials/no-fragment/no-path validation `parseWebOrigin()` also
applies to WebSocket `Origin` headers — see below). This is deliberately **not** `origin: true`,
**not** a function that reflects the request's `Origin` header back, and **not** `"*"`; `credentials`
is never enabled. Only `GET`, `POST`, and `OPTIONS` are allowed, with `Content-Type` as the only
allowed request header, and a 600-second preflight cache. A request with no `Origin` header at all
(PowerShell, `curl`, any non-browser tool) is unaffected by CORS entirely — CORS is a _browser_
enforcement mechanism; Hall Core still answers such requests normally, it just never grants a
disallowed browser origin permission to read the response (see `app.test.ts`'s CORS test suite,
which asserts on the presence/absence of `Access-Control-Allow-Origin` directly, not on whether the
server "rejects" a request — it doesn't, and can't, in the HTTP sense; only the header is withheld).

## WebSocket Origin validation

Normal browser CORS enforcement does not apply to the WebSocket upgrade handshake, so
`routes/task-events.ts` validates the `Origin` header itself, using the exact same
`parseWebOrigin()`-based exact-match logic as HTTP CORS (never a substring/prefix check — an origin
like `http://127.0.0.1:3000.evil.example` is not treated as a match for `http://127.0.0.1:3000`).
The check runs as the very first thing in `handleTaskEventsConnection`, before the task-existence
check and before any `EventBus` subscription is created — an unapproved origin never learns whether
a task exists and is never given a live subscription slot. Policy: a **missing** `Origin` header is
allowed (the normal shape of a non-browser WebSocket client); a **present, matching** origin is
allowed; a **present, non-matching, or malformed** origin is rejected with the custom close code
`4403` and a generic reason string (`"origin not allowed"`) that never echoes back the client's
origin or the configured allowlist — see "WebSocket close codes" for the full table.

## Safe adapter discovery

`GET /api/v1/adapters` (`routes/adapters.ts`) returns a provider-neutral, deterministically sorted
(by `adapterId`) list of every registered adapter, built from `AgentRegistry.listDescriptors()` plus
a `detect()` call per adapter. Each adapter's `detect()` is awaited independently and wrapped in its
own try/catch (`detectSafely()`): a throwing/rejecting `detect()` never fails the whole request — it
just reports that one adapter as `"unavailable"`, with the real exception logged server-side only
(`console.error`, bounded, never returned to the caller). The response DTO is a fixed allowlist of
fields (`adapterId`, `displayName`, `adapterVersion`, `agentId`, `agentDisplayName`, `provider?`,
`integrationLevel`, `supportedOperatingSystems`, `capabilities`, `availability`) — it never includes
`executablePath`, `diagnosticMessage`, any other raw `AgentDetectionResult` field, an environment
value, or the `AgentAdapter`/`AgentRegistry` instance itself. The web client is expected to render
whatever this endpoint actually returns rather than assuming `hall.mock-agent` is the only adapter.

## Provider-neutral adapter composition (Phase 9)

Registering a second, real adapter (Claude Code — see
[`0008-claude-code-adapter.md`](0008-claude-code-adapter.md)) alongside Mock Agent did not require
touching `TaskOrchestrator`, `TaskStore`, any generic route, or any Hall Web component — the same
provider-neutral guarantee `0002-agent-adapter-boundary.md` establishes for adapters generally holds
across two real registrations, not just one. `apps/server/src/composition/` now has two composition
roots, each the sole file in this package allowed to know about its specific adapter:
`mock-agent-composition-root.ts` (unchanged since Phase 5) and the new
`claude-code-composition-root.ts`, which registers the Claude Code adapter unconditionally — no
`--enable-claude-code` startup flag exists, since the safe default is "register it and let `detect()`
report whatever its real availability is," identical to how Mock Agent has always behaved.
`server-composition.ts` composes both roots onto one shared `AgentRegistry` without either knowing
the other exists. `GET /api/v1/adapters` (see "Safe adapter discovery" above) lists both without any
change to that route's own code, and an unavailable Claude Code adapter (CLI not installed, not
logged in, auth unverifiable) never prevents Mock Agent from remaining fully operational.

## Task orchestration

`TaskOrchestrator` (`tasks/task-orchestrator.ts`) is provider-neutral: it never references Mock
Agent or any concrete adapter type, resolving adapters purely through the injected `AgentRegistry`'s
`AgentAdapter` interface. `createTask()` validates the request (reusing the protocol package's own
`nonEmptyIdSchema`/`boundedNonBlankString`/`taskPrioritySchema` rather than duplicating `HallTask`'s
validation rules) and branches on `executionMode`:

- **Immediate** (default, Phase 5/6 behavior unchanged): resolves and validates the working
  directory, stores the task, and starts execution **without awaiting it** — the HTTP handler
  returns `202 Accepted` as soon as `createTask()` returns, while the run continues in the
  background.
- **Deferred** (Phase 7): stores a planning-only task (`status: "backlog"`, no adapter, no run) and
  returns `201 Created`. No execution starts. See `docs/architecture/0006-kanban-board.md`,
  "Deferred versus immediate task creation".

Each active run gets its own `AbortController`, tracked so `requestCancellation()` and `shutdown()`
can abort it, and cleaned up in a `finally` block once the run settles — the same tracking now
also covers a deferred task's run once `assignTask()`/`startTask()` (Phase 7) eventually begin one.

## Controlled status transitions

A task created immediately starts directly in `assigned` status (an adapter is already selected at
creation time); a task created deferred starts in `backlog` and only ever reaches `assigned` through
`POST /assign`. From `assigned`, status changes to `running` only in response to a real
`run.started` event, never because `POST /start` was merely called — `/start` claims a run and
begins execution, but the client-visible status stays `assigned` until the adapter's own event
arrives (see `docs/architecture/0006-kanban-board.md`, "The assigned-but-launching window"). From
`running`, `run.completed` → `completed`, `run.failed` → `failed`, `run.cancelled` → `cancelled` —
never because a cancellation was merely _requested_.

Phase 7 adds the planning-state edges `backlog <-> ready/blocked`, `ready <-> blocked`, and
`assigned -> ready/blocked` (manual, via `POST /transition`), plus `ready -> assigned` (via
`POST /assign`) — see `tasks/task-status-transitions.ts`'s two tables: `ALLOWED_TRANSITIONS` (the
full graph `TaskStore.updateStatus()` enforces, including transitions only ever reachable from
specific internal call sites) and the strictly smaller `MANUAL_TRANSITIONS` (what a client may
request directly through `POST /transition` — never `running`, `reviewing`,
`waiting_for_approval`, `completed`, or `failed` as a destination from anywhere). Both reject any
attempt to leave a terminal status (`completed`/`failed`/`cancelled`) — there is no "restart"
operation in this phase.

## In-memory storage limitations

`TaskStore` and `EventStore` are both bounded (`config/server-config.ts`'s `DEFAULT_LIMITS`):
`maxTasks: 500`, `maxEventsPerTask: 2000`, `maxSubscribersPerTask: 20`, plus a request `bodyLimit`
and a WebSocket `maxPayload`. As of Phase 8, `BoardStore` and `MessageStore` are bounded the same
way: `maxBoards: 500` (the always-present General board does not count against this — see
`0007-communication-boards.md`, "Board and message capacity"), `maxMessagesPerBoard: 1000`,
`maxSubscribersPerBoard: 20`. These are conservative prototype defaults, not tuned for any real
workload — the point is that nothing here grows without bound.

Reaching `maxTasks` is HTTP-reachable: `TaskCapacityReachedError` is thrown synchronously from
`TaskStore.add()` inside the `POST /api/v1/tasks` handler, so the client gets a clear `429` before
any task is created. Reaching `maxEventsPerTask`, and every other `EventStore` invariant violation
(`EventCapacityReachedError`, `EventSequenceGapError`, `EventSequenceConflictError`,
`EventIdentityMismatchError`), is **not** HTTP-reachable the same way — `EventStore.append()` is
only ever called from `TaskOrchestrator`'s un-awaited background execution, after the triggering
`POST` has already returned `202` — but as of Phase 5.1 it is no longer left unresolved either: it
drives the deterministic capacity/invariant-failure workflow described in "Event-capacity terminal
handling" below, which stops the run and lands the task in `failed` with a stable, safe failure
code. Fastify's own body-limit error (`413`) and WebSocket `maxPayload` rejection remain the two
limits enforced before any task-specific state is touched at all. There is no persistence:
restarting the process discards all tasks and events, which is an explicit, accepted prototype
limitation (see "Why persistence is deferred" below) — the event-capacity handling in this section
makes a _running_ task terminate deterministically, it does not make Hall Core survive a restart.

## Event-capacity terminal handling

`EventStore` reserves its last slot per task for a terminal event: a **non-terminal** event is
rejected once `events.length` reaches `maxEventsPerTask - 1`, while a **terminal** event may still
take that final slot (`EventStore.append()` in `events/event-store.ts`; enforced by a single
formula, `capacityLimit = isTerminal ? maxEventsPerTask : maxEventsPerTask - 1`). The constructor
rejects any `maxEventsPerTask` below `MIN_EVENTS_PER_TASK` (`2`) — the smallest limit that can hold
a `run.started` + one terminal event lifecycle without starving a normal run of the one
non-terminal event (`run.started`) it needs before it can ever reach a terminal state.

When a non-terminal event is rejected for capacity (or any other `EventStore` invariant is
violated — a sequence gap, a sequence conflict, or an identity mismatch), `TaskOrchestrator`
(`#handleEventStoreFailure` in `tasks/task-orchestrator.ts`) runs a single deterministic workflow:

1. Abort the active run's `AbortController`, signalling the adapter to stop.
2. Build a Hall-Core-originated `run.failed` event (`events/synthetic-events.ts`), using the
   task's real `runId`/`taskId`/`agentId` and the next contiguous sequence number
   (`EventStore.nextSequence()`), validated through the same `parseRunFailedEvent` gate every
   adapter-produced event passes. Its `failure.code` is the triggering error's own stable code
   (`EVENT_CAPACITY_REACHED`, `EVENT_SEQUENCE_GAP`, `EVENT_SEQUENCE_CONFLICT`, or
   `EVENT_IDENTITY_MISMATCH`) and its `failure.message` is a client-safe string — never the raw
   exception text (see "Distinguishing adapter failures from Hall Core infrastructure failures").
3. Store that event (it lands in the reserved last slot) and publish it to WebSocket subscribers.
4. Drive the task to `failed` and record its completion timestamp — `assigned -> failed` and
   `running -> failed` are both valid transitions (`tasks/task-status-transitions.ts`).
5. Remove the task from active-run tracking once the (now-aborted) `runTask()` promise settles, the
   same `.finally()` cleanup every other run outcome already goes through.

The same workflow also runs if `runTask()` itself rejects for a reason `#handleEvent` never saw at
all (`#failTaskOnUnhandledExecutionError` — e.g. `adapter.detect()`/`startTask()` throwing), using
the code `TASK_EXECUTION_FAILED`, so a task can never be left stuck in `assigned`/`running` purely
because the only place that marks a task terminal is event-driven. Both entry points share one
rule: if the task has already reached a terminal status by the time they run (a real adapter
terminal event, or an earlier infrastructure failure for the same task), they no-op — **the first
terminal outcome wins**, and no later event, from any source, can replace it. `EventStore`'s own
terminal-guard (`EventAfterTerminalError`/gap/conflict on a slot that's already the reserved
terminal one) enforces this a second time, independent of `TaskOrchestrator`'s own state check.
Neither of these finalization methods is ever allowed to throw back into the adapter's
event-delivery path or into `runTask()`'s promise chain — an unexpected failure inside them is
logged server-side and the task is left in whatever partial state was reached, rather than
crashing execution or producing an unhandled rejection.

## Distinguishing adapter failures from Hall Core infrastructure failures

Both an adapter reporting its own failure and Hall Core deciding it cannot safely continue a task
surface identically at the API layer — a task in `failed` status with a `StructuredFailure` in its
record — but the `failure.code` always identifies the real source. `MOCK_EXECUTION_FAILED` (Mock
Agent's own simulated failure) means the _adapter_ failed; `EVENT_CAPACITY_REACHED`,
`EVENT_SEQUENCE_GAP`, `EVENT_SEQUENCE_CONFLICT`, `EVENT_IDENTITY_MISMATCH`, and
`TASK_EXECUTION_FAILED` all mean _Hall Core_ decided it could not safely persist or deliver the
run's lifecycle. A client that wants to distinguish "the agent's work failed" from "Hall Core
couldn't keep up with the agent" needs only to check which family the code belongs to. Hall Core
never lets a later infrastructure failure overwrite an earlier real agent result, or vice versa —
whichever terminal outcome is recorded first is final (see above).

## Event sequencing and duplicate policy

`EventStore.append()` (`events/event-store.ts`) treats its backing array's length as the "next
expected sequence slot": an event landing exactly there is stored; an event landing on an
already-occupied slot with the _same_ `eventId` is an idempotent duplicate (accepted as a no-op,
never re-published); an already-occupied slot with a _different_ `eventId` is a conflict (rejected);
anything past the next slot is a gap (rejected); and any _new_ event past the next slot once a
terminal event has already been recorded for that task is rejected outright (an exact duplicate
resend of an already-stored slot, including the terminal event itself, is still accepted as the
ordinary idempotent no-op described above, not specially rejected). Every one of these is defense in depth —
Mock Agent's own `TerminalEventGuard` (in `@hall-of-wisdom/agent-adapter-sdk`) already prevents a
well-behaved adapter from producing any of these cases — but `EventStore` does not trust that
guarantee blindly; it enforces the same invariants again at this boundary. As of Phase 5.1, none of
these rejections are dead ends: see "Event-capacity terminal handling" above for what
`TaskOrchestrator` does when one of them fires.

## WebSocket replay and live streaming

`routes/task-events.ts` registers the live subscriber (`eventBus.subscribe(...)`) _before_ reading
stored history (`eventStore.list(...)`), and every delivery — whether from replay or from a live
publish — is gated by one monotonically increasing `lastDelivered` sequence number local to that
connection: whichever path (replay or a concurrent live publish) reaches a given sequence number
first delivers it, and the other skips it. No `setTimeout` or arbitrary delay is used anywhere in
this logic; ordering is enforced structurally, not by timing. A client that sends _any_ application
data (this endpoint is output-only, and does not accept task-control commands) is closed with code
`1003`; an unknown task closes with `4404`; an invalid `afterSequence` closes with `4400`; a
subscriber-limit rejection closes with `4503`; an unapproved `Origin` closes with `4403` (checked
before any of the others — see "WebSocket Origin validation" above). See "WebSocket backpressure
policy" below for the fifth custom close code, `4504`.

The connection-handling logic (`handleTaskEventsConnection` in `routes/task-events.ts`) is factored
out from Fastify route registration behind a minimal `TaskEventsSocket` interface (`bufferedAmount`,
`send`, `close`, `on`) that `@fastify/websocket`'s real socket satisfies structurally with no
adapter needed — this is what lets `task-events.test.ts` drive the low-level backpressure logic
with a small, fully controllable fake socket instead of only real (much harder to force into a
specific `bufferedAmount` state) network connections.

## WebSocket backpressure policy

As of Phase 5.1, a client whose `bufferedAmount` exceeds the configured threshold
(`maxWebSocketMessageBytes * 16`, passed as `maxBufferedBytes`) is **closed immediately** with the
custom code `4504` (`CLOSE_CODE_CLIENT_TOO_SLOW`) and unsubscribed — the frame that would have been
sent is not sent, and `lastDelivered` is deliberately left unchanged so the event is not
considered delivered. This replaces Phase 5's original policy of silently skipping just that one
frame and leaving the connection open, which meant a chronically slow client could accumulate an
unbounded number of silent gaps with no way to know it had missed anything.

This affects only the one slow subscriber: `EventBus.publish()` already isolates each listener in
its own `try`/`catch`, so a socket being closed here never touches any other subscriber to the same
task, and it never touches the task itself — the underlying run keeps executing exactly as if that
client had never connected. `4504` sits in the 4000-4999 private-use range WebSocket close codes
reserve for application use (RFC 6455 §7.4.2), alongside this route's other three custom codes.

A client disconnected this way can reconnect with `afterSequence=<lastDelivered>` (the sequence
number of the last event it _did_ successfully receive) to resume exactly where it left off: the
skipped event, and everything after it, is still in `EventStore` — nothing is ever deleted from
that store because one subscriber fell behind — so replay on reconnect has no gap. The browser UI
planned for Phase 6 is expected to use this same `afterSequence`-based reconnect on any WebSocket
close it did not itself request.

## WebSocket delivery guarantee

Stated precisely, since "streams events over WebSocket" alone under-specifies the actual contract:

- `EventStore` is authoritative. Anything it has stored can always be retrieved via `list()`/replay,
  regardless of what any individual WebSocket connection did or didn't deliver.
- Live delivery over one healthy connection is ordered (`lastDelivered` only ever increases).
- Delivery is **at-least-once across a reconnect**, not exactly-once: replay-then-live can, in rare
  interleavings, redeliver the most recent event a client already received live just before
  disconnecting. Clients are expected to deduplicate by `eventId` or `sequence` — both are stable
  per event and safe to key on.
- A slow client is disconnected (see "WebSocket backpressure policy" above) rather than silently
  losing frames while appearing connected.
- Reconnecting with `afterSequence` retrieves everything stored after that point; nothing is lost.
- Hall Core does **not** promise exactly-once network delivery, and no part of this design should be
  read as claiming it does.

## Cancellation behavior

`POST /api/v1/tasks/:taskId/cancel`: unknown task → `404`; a task already in a terminal status →
`409`; otherwise → `202`, with the response's `alreadyRequested` field distinguishing "this is the
first cancellation request" from "cancellation was already pending" (both are `202` — cancellation
is idempotent). The task's status does **not** flip to `cancelled` at request time; it flips only
when the adapter's own `run.cancelled` event actually arrives, the same event-driven rule every
other status transition follows.

## Planning task endpoints (Phase 7)

Three endpoints exist only for planning tasks; none of them ever emits an event or touches
`EventStore`/`EventBus` — see `docs/architecture/0006-kanban-board.md` for the full design and
rationale, summarized here as a contract reference:

| Endpoint                         | Purpose                                                             | Success | Key failure codes                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /tasks/:taskId/transition` | Manual planning-column move (never to an execution/terminal status) | `200`   | `TASK_NOT_FOUND` (404), `TASK_STATE_CONFLICT` (409, terminal), `ACTIVE_TASK_TRANSITION_DENIED` (409, executing), `INVALID_TASK_TRANSITION` (409, not a permitted manual destination) |
| `POST /tasks/:taskId/assign`     | Assign (or, before start, reassign) an adapter to a `ready` task    | `200`   | `TASK_NOT_FOUND`, `ADAPTER_NOT_FOUND` (404), `ADAPTER_UNAVAILABLE` (409), `TASK_STATE_CONFLICT` (409), `WORKSPACE_VALIDATION_FAILED` (400)                                           |
| `POST /tasks/:taskId/start`      | Begin execution for an already-assigned task                        | `202`   | `TASK_NOT_FOUND`, `TASK_STATE_CONFLICT` (409, not assigned / already started / terminal), `ADAPTER_NOT_FOUND`, `ADAPTER_UNAVAILABLE`                                                 |

`INVALID_TASK_TRANSITION` (409) is distinct from the pre-existing `InvalidTaskTransitionError`
(`INTERNAL_ERROR`, 500): the latter guards `TaskStore.updateStatus()`'s own invariant and should be
unreachable from any correctly-gated caller; the former is what a client actually sees when it
requests a manual transition `MANUAL_TRANSITIONS` doesn't permit — a real, expected 409, not a bug
signal.

`/start`'s duplicate-start guard is a true atomic compare-and-set, not a best-effort check:
`TaskStore.setRunId()` operates on the live record and throws if a run was already claimed, and
`TaskOrchestrator.startTask()` performs every synchronous step (status check, existing-run check,
adapter resolution, claiming the run) with **no `await` in between** — only the availability
re-check (`adapter.detect()`) is asynchronous, and it runs strictly after the claim. Under Node's
single-threaded execution model this closes the race completely: two concurrent `POST /start`
requests for the same task can never both begin a run.

`/assign` (Phase 7.1) uses the identical pattern: `TaskOrchestrator.assignTask()` reads a snapshot,
`await`s `adapter.detect()`, then commits through one synchronous `TaskStore.assignIfEligible()` call
with no further `await` — re-validating the exact snapshot it read against the task's live state
before writing. Two concurrent `POST /assign` requests for the same task, or an assignment racing a
manual transition or cancellation, can never both succeed or leave mixed state; exactly one commits
and every other caller receives `409 TASK_STATE_CONFLICT`.

A same-shape snapshot compare alone cannot detect an ABA sequence (the task moves away from and back
to an outwardly identical state while a request is still `await`ing `adapter.detect()`), so Phase 7.2
added a private, monotonically-increasing per-task revision counter to `TaskStore` — never part of
`TaskRecord`, never serialized in any response, never readable from or influenced by client input —
that every successful mutating `TaskStore` method bumps exactly once. `assignIfEligible()` now checks
the caller's expected revision first, as the primary concurrency token, with the original four-field
snapshot kept as secondary defense in depth. See `docs/architecture/0006-kanban-board.md`, "Assignment
concurrency policy (Phase 7.1)" and "Closing the ABA gap: internal task revision (Phase 7.2)", for the
full design and the races each phase closes.

## Capability/trust routing endpoints (Phase 11)

Two further endpoints exist for provider-neutral capability/trust routing — see
`docs/architecture/0011-agent-capabilities-trust-and-routing.md` for the full design:
`POST /tasks/:taskId/routing-analysis` (strictly read-only; never touches `TaskStore`'s mutating
methods or emits an event) and `POST /tasks/:taskId/route-and-assign` (the one explicit, mutating
action — assigns only, using the same `assignIfEligible()`/revision-based concurrency mechanism
`/assign` above already uses; never starts a run).

## Communication Boards endpoints (Phase 8)

A REST + WebSocket surface for local, human-authored discussion — a General board plus one
optional discussion board per task — lives alongside the task/event API described above but is
architecturally independent of it (separate stores, separate schemas, separate WebSocket route,
no shared sequence space). See `0007-communication-boards.md` for the full design; summarized here
as a contract reference:

| Endpoint                             | Purpose                                              | Success       | Key failure codes                                                                  |
| ------------------------------------ | ---------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------- |
| `GET /boards`                        | List all boards, General first                       | `200`         | —                                                                                  |
| `GET /boards/:boardId`               | Retrieve one board                                   | `200`         | `BOARD_NOT_FOUND` (404)                                                            |
| `POST /tasks/:taskId/board`          | Create-or-fetch that task's one discussion board     | `201` / `200` | `TASK_NOT_FOUND` (404), `BOARD_CAPACITY_REACHED` (429)                             |
| `GET /boards/:boardId/messages`      | List messages, optionally after a sequence           | `200`         | `BOARD_NOT_FOUND` (404)                                                            |
| `POST /boards/:boardId/messages`     | Append a message (server assigns id/sequence/author) | `201`         | `BOARD_NOT_FOUND` (404), `INVALID_MESSAGE` (400), `MESSAGE_CAPACITY_REACHED` (429) |
| `GET /boards/:boardId/messages/live` | WebSocket: replay then live stream                   | `101`         | `4400`/`4403`/`4404`/`4503`/`4504`/`1003` (see below)                              |

Creating a task's discussion board never changes that task's `status`, never claims or touches a
`runId`, and never creates an `AgentRun` or a `NormalizedAgentEvent` — `BoardStore.ensureTaskBoard`
only ever reads a task's existence and title through `TaskStore`, and is idempotent by
construction: the board's ID is deterministically derived as `` `task:${taskId}` ``, so "does this
task already have a board" is one map lookup at a known key, never an index that could drift out of
sync (the same "correct by construction" reasoning behind Phase 7.2's task revision counter — see
`0006-kanban-board.md`).

The WebSocket route (`routes/board-messages.ts`) reuses the exact-origin validation, subscribe-
before-replay ordering, and close-code semantics (`4400`/`4403`/`4404`/`4503`/`4504`/`1003`)
established by `routes/task-events.ts` above, with one structural difference: a board discussion
has no terminal state, so this route never self-closes a healthy connection the way a task's event
stream closes on `run.completed`/`run.failed`/`run.cancelled` — it stays open until the client
disconnects, the server shuts down, or a policy violation closes it.

## Graceful shutdown

`process/signal-shutdown.ts` listens for both `SIGINT` and `SIGTERM` (deliberately a small,
separate implementation from Hall Runner's `installSignalCancellation` — that one cancels a single
CLI run and only listens for `SIGINT`; this one shuts down the whole server, cancelling every active
run, and process managers send `SIGTERM`, which a server needs to handle). The first signal
triggers `TaskOrchestrator.shutdown(timeoutMs)` (which aborts every active run's controller and
waits, bounded, for their promises to settle) followed by `app.close()`; a second signal forces an
immediate `process.exit()`. `process.exit()` appears in exactly one place in this whole package —
`server.ts`'s forced-shutdown path — mirroring Hall Runner's own discipline. As of Phase 8,
`app.close()` also tears down every open Communication Boards WebSocket connection and clears
`MessageBus`'s subscriber lists — the same `@fastify/websocket` connection lifecycle that already
closes task-event sockets on `app.close()` closes board-message sockets identically, since both
routes are registered on the same Fastify instance; no separate shutdown path was needed. See
`0007-communication-boards.md`, "Shutdown", for what was specifically verified here.

## stdout/stderr and logging policy

There is no JSON Lines protocol here (that's Hall Runner's CLI concern) — Hall Core is an HTTP/WS
server, so its "output" is HTTP responses and WebSocket frames, both already schema-shaped.
Operational logging goes through Fastify's built-in `pino` logger (structured JSON to stdout by
default), which can be disabled entirely (`logger: false`) for tests. Nothing in this package logs
raw environment variables, credentials, or unrestricted adapter output.

## Safe API error policy

Every error response is `{ error: { code, message, details? } }` — a stable, bounded shape,
constructed by a single centralized handler (`errors/error-handler.ts`) that recognizes the
package's own `HallCoreError` hierarchy and the protocol package's `ProtocolValidationError`
specifically, and otherwise logs the real error server-side (via Fastify's logger) while returning
only a generic `INTERNAL_ERROR` / `500` to the client. No response body ever contains a stack trace,
an absolute filesystem path, or an environment variable value.

## Workspace-root configuration

The server is given exactly one workspace root at startup (`--workspace-root`), canonicalized once
via Hall Runner's `validateWorkspace()` (passing the root as both `workspaceRoot` and
`workingDirectory` — a root is always trivially "contained" within itself, so this reuses the
existing function instead of adding a new one). Every subsequent task request supplies a
`workingDirectory` **relative** to that configured root (default `"."`); `TaskOrchestrator` rejects
an absolute value outright, resolves the relative value against the canonical root, and re-validates
the resolved result through `validateWorkspace()` again before it ever reaches an adapter — the same
canonical-path discipline Hall Runner's own CLI uses (see
`0003-hall-runner-boundary.md`, "What this does and does not guarantee", for the precise TOCTOU
scope this provides and does not provide).

## Why API requests cannot choose arbitrary workspace roots

If a task-creation request could supply its own absolute workspace root, the server's own
`--workspace-root` configuration would be meaningless — any client could point an adapter anywhere
on the filesystem the server process can read. Requiring a relative path against one
server-configured root keeps the server's authority bounded to whatever the operator explicitly
configured at startup, which is the same "reduce the API's authority" principle behind not letting
requests choose an adapter's Mock-specific scenario either (that's also a startup-time-only
configuration, in the development composition root).

## Why authentication is deferred

Nothing in this phase is reachable from outside `127.0.0.1`. A local-only prototype talking to a
local-only coding agent has no unauthenticated network boundary to protect yet; adding
authentication now would be complexity with no corresponding threat this phase actually faces.

## Why persistence is deferred

`TaskStore` and `EventStore` are deliberately plain in-memory `Map`s. Introducing Prisma/SQLite now
would couple this phase to schema and migration concerns unrelated to proving the task/event model
itself works. Phase 9 (per `0001-initial-architecture.md`'s phase plan) is where persistence enters.

## The web interface (Phases 6, 7, and 8)

Phase 6 built `apps/web`, the first browser client of the REST/WebSocket API this document
describes. See `docs/architecture/0005-minimal-web-interface.md` for the Task Console's own
architecture (Next.js App Router boundary, why no custom server/API routes, URL configuration,
close-code handling on the client side, accessibility),
`docs/architecture/0006-kanban-board.md` for the Kanban Board Phase 7 added on top of it (planning
tasks, the assign/start separation, drag-and-drop with accessible non-drag equivalents, polling),
and `docs/architecture/0007-communication-boards.md` for the Communication Boards page Phase 8
added (`/boards`: board list, message history, composer, live WebSocket updates). This document
(`0004`) remains the source of truth for Hall Core's own contract — the CORS, WebSocket-Origin,
"Planning task endpoints", and "Communication Boards endpoints" sections above are the parts of
that contract the web application specifically required Hall Core to grow.

## Permanent subagent and plugin usage rules

Unchanged from `0003-hall-runner-boundary.md` / `CLAUDE.md`'s "Subagent and Plugin Usage" section.
Phase 5 used a read-only architecture-review subagent (confirming no Hall Runner API changes were
needed — see above) and, after implementation, read-only security-review and documentation-review
subagents; both found real issues that were fixed (an absolute-path disclosure in a validation
error, and a silently-swallowed execution error) before the phase was reported complete. Phase 5.1
did not spawn any read-only investigatory subagents — the corrections were scoped to files already
fully read during Phase 5 and its review, so delegation would not have provided the "clear benefit"
`CLAUDE.md`'s resource-control section requires; the design itself was checked against a stronger
reviewer before implementation began, per this project's standing "call advisor before committing to
an approach" discipline. Phase 6 launched five read-only, parallel review subagents after
implementation (frontend-architecture, WebSocket-protocol, accessibility/UX, security, and
documentation). Three found real, fixed issues: the WebSocket-protocol review found the client
treating the `4403` (Origin not allowed) close code as retryable when it should never retry, and
found the reconnect retry budget never resetting after a successful reconnection (both fixed in
`hooks/use-task-events.ts`); the accessibility review found the task-creation form's Description
field validation error rendering no message and no `aria-invalid`/`aria-describedby` at all (fixed
in `components/task-create-form.tsx`, along with adding `role="alert"` to every field error so
assistive technology is actually notified on a failed submit). The security and frontend-architecture
reviews found no issues requiring a fix. See `docs/architecture/0005-minimal-web-interface.md` and
the Phase 6 report for full findings. Phase 8 (Communication Boards) was implemented directly by
the main session rather than delegated to subagents: every store, route, hook, and component
followed shapes and patterns already established in Phases 5–7.2 (`EventBus`/`EventStore`-style
stores, the `task-events.ts` WebSocket route's Origin/replay/close-code discipline, the
`use-task-events.ts` reconnect hook's backoff schedule), so re-deriving that context through a
fresh subagent would not have provided the "clear benefit" `CLAUDE.md`'s resource-control section
requires. The security and bug review checklist (25 items) was walked directly rather than through
a dedicated subagent, cross-referenced against the store/route/hook/component tests that already
targeted each item — see the Phase 8 report's "Security and Bug Review" section for the outcome.
