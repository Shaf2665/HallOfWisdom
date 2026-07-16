# 0004 — Hall Core Server

Status: Draft (Phase 5, hardened in Phase 5.1).

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
no corresponding requirement.

## Task orchestration

`TaskOrchestrator` (`tasks/task-orchestrator.ts`) is provider-neutral: it never references Mock
Agent or any concrete adapter type, resolving adapters purely through the injected `AgentRegistry`'s
`AgentAdapter` interface. `createTask()` validates the request (reusing the protocol package's own
`nonEmptyIdSchema`/`boundedNonBlankString`/`taskPrioritySchema` rather than duplicating `HallTask`'s
validation rules), resolves and validates the working directory, stores the task, and starts
execution **without awaiting it** — the HTTP handler returns `202 Accepted` as soon as `createTask()`
returns, while the run continues in the background. Each active run gets its own `AbortController`,
tracked so `requestCancellation()` and `shutdown()` can abort it, and cleaned up in a `finally` block
once the run settles.

## Controlled status transitions

A task is created directly in `assigned` status (an adapter is already selected at creation time).
From there, status changes only in response to the adapter's own normalized events —
`run.started` → `running`, `run.completed` → `completed`, `run.failed` → `failed`,
`run.cancelled` → `cancelled` — never because a cancellation was merely _requested_.
`tasks/task-status-transitions.ts` encodes the full allowed-transition graph explicitly (including
the direct `assigned -> cancelled` edge for the immediate-abort case, where a cancellation lands
before `run.started` is ever emitted) and rejects anything else, including any attempt to leave a
terminal status (`completed`/`failed`/`cancelled`) — there is no "restart" operation in this phase.

## In-memory storage limitations

`TaskStore` and `EventStore` are both bounded (`config/server-config.ts`'s `DEFAULT_LIMITS`):
`maxTasks: 500`, `maxEventsPerTask: 2000`, `maxSubscribersPerTask: 20`, plus a request `bodyLimit`
and a WebSocket `maxPayload`. These are conservative prototype defaults, not tuned for any real
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
subscriber-limit rejection closes with `4503`. See "WebSocket backpressure policy" below for the
fourth custom close code, `4504`.

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

## Graceful shutdown

`process/signal-shutdown.ts` listens for both `SIGINT` and `SIGTERM` (deliberately a small,
separate implementation from Hall Runner's `installSignalCancellation` — that one cancels a single
CLI run and only listens for `SIGINT`; this one shuts down the whole server, cancelling every active
run, and process managers send `SIGTERM`, which a server needs to handle). The first signal
triggers `TaskOrchestrator.shutdown(timeoutMs)` (which aborts every active run's controller and
waits, bounded, for their promises to settle) followed by `app.close()`; a second signal forces an
immediate `process.exit()`. `process.exit()` appears in exactly one place in this whole package —
`server.ts`'s forced-shutdown path — mirroring Hall Runner's own discipline.

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

## Why the web interface is deferred

Phase 6. This phase's REST/WebSocket API is what a future web UI will call — building the UI before
the API it depends on is stable would mean building against a moving target.

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
an approach" discipline.
