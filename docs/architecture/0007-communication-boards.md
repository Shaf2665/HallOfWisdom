# 0007 — Communication Boards

Status: Draft (Phase 8).

## Context

Phase 8 adds Communication Boards: a local, real-time surface for **human-authored** discussion —
one General board, always present, plus at most one discussion board per task, created on demand.
This is explicitly not the channel any future CEO Agent, agent-to-agent messaging, agent mentions,
or review-agent workflow will use — see "Why this is not the agent-communication channel" below.

## Communication model

- **General board**: exactly one, seeded once during Hall Core composition with the stable ID
  `hall.general`. Available immediately on startup, even before any task exists.
- **Task discussion boards**: created on demand via `POST /tasks/:taskId/board`, at most one per
  task, for a task in any status (planning, active, or terminal). Creation is idempotent and never
  changes the task's status, claims a run, or emits a `NormalizedAgentEvent`.
- Both kinds are flat, ordered message streams — no threads, no replies, no reactions.

## Shared protocol contracts (`packages/protocol/src/communication.ts`)

`CommunicationBoard` is a `z.discriminatedUnion("kind", [...])` over `general` and `task` — the
same pattern `create-task-request.ts` already uses for immediate-vs-deferred creation — so "general
boards never carry a `taskId`, task boards always require one" is a compile-time and runtime
guarantee, not a convention a handler could forget to check. `CommunicationMessage` carries
`messageId`, `boardId`, a per-board `sequence` starting at `0`, a server-owned `author`
(`{ kind: "human", displayName: "Local Operator" }`), `text` (trimmed for the blank check, but line
breaks preserved, capped at `MAX_COMMUNICATION_MESSAGE_TEXT_LENGTH = 4000`, NUL characters
rejected), and `createdAt`. Every object schema is `.strict()` — an unexpected field, including a
JSON-injected `__proto__` key, fails validation rather than silently passing through (see
`packages/protocol/src/security.test.ts`'s prototype-pollution tests for these two schemas).
Message sequences are entirely independent of `NormalizedAgentEvent` sequences — a communication
message is never encoded as, or confused with, an agent event. See
`0001-initial-architecture.md`, "Human communication is a separate vocabulary from agent events",
for why that separation is structural rather than a naming convention.

## Server-owned author, enforced by shape absence

`CreateMessageRequest` (`apps/server/src/schemas/create-message-request.ts`) is
`z.object({ text: communicationMessageTextSchema }).strict()` — there is no `author` field in the
schema at all, so a client-supplied author is rejected before any handler code runs. This is the
same "cannot reach the browser/cannot be forged by construction, not by discipline" pattern Phase
7.2 used for the internal task-revision counter (`0006-kanban-board.md`): nothing needed to
remember to strip a client-supplied author, because there was never a field to strip.

**(Phase 14.1) Re-verified with a dedicated forged-author test suite** — see
[`0014-ceo-planning-approval-and-delegation.md`](0014-ceo-planning-approval-and-delegation.md),
"Security review performed this phase": a POST attempting `author.kind: "system"`, or attempting
to claim a system-looking display name via a `human`-kind override, both 400 and store nothing;
confirms the protection is shape-absence, not a runtime denylist.

## Hall Core stores

`BoardStore`, `MessageStore`, and `MessageBus` (`apps/server/src/boards/`) mirror the shape of
`TaskStore`, `EventStore`, and `EventBus` but are deliberately separate, non-generic classes — kept
apart so the human-discussion domain and the agent-execution-event domain never blur together, per
the same principle enforced in the protocol package.

- **`BoardStore.ensureTaskBoard(taskId)`** derives the board ID deterministically as
  `` `task:${taskId}` `` rather than generating a random one. "Does this task already have a board"
  is therefore a single map lookup at a known key, not an index that has to be kept in sync — this
  structurally eliminates the possibility of two boards for one task, atomically and without a
  lock, the same way Phase 7.2's revision-keyed compare-and-set eliminates its own race.
- **`MessageStore.append()`** reads `messages.length` as the next sequence number synchronously,
  with no `await` between that read and the `push()` that commits it. Under Node's single-threaded
  execution model, two genuinely concurrent `POST .../messages` requests handled within the same
  synchronous tick can never collide on a sequence number — the identical no-await-between-
  check-and-write discipline `EventStore.append()` and `TaskStore.assignIfEligible()` already rely
  on.
- **`MessageBus`** fans a board's live messages out to every subscribed WebSocket connection, up to
  `maxSubscribersPerBoard`, isolating each listener in its own try/catch exactly as `EventBus`
  does — one failing or slow subscriber never affects another.

None of these three stores hold module-level mutable state: each is constructed fresh per server
composition or test-harness call, verified by a dedicated test that seeds two independent
`BoardStore` instances and asserts mutating one never affects the other.

## Board and message capacity

`BoardStore`/`MessageStore` are bounded the same way `TaskStore`/`EventStore` are
(`config/server-config.ts`'s `DEFAULT_LIMITS`): `maxBoards: 500`, `maxMessagesPerBoard: 1000`,
`maxSubscribersPerBoard: 20`. The always-present General board is deliberately excluded from the
`maxBoards` count — it is a fixed, always-present part of every server instance, not
browser-created capacity, so counting it against the limit would silently make one fewer task board
creatable than the configured number actually promises. (This was a real bug found and fixed during
implementation: the original capacity check counted General against the limit; a dedicated test,
"the General board does not count against the board capacity," now guards it.) Reaching a capacity
limit rejects the new board or message outright with a stable error code
(`BOARD_CAPACITY_REACHED` / `MESSAGE_CAPACITY_REACHED`, both `429`) — it never silently discards or
evicts existing data.

`BOARD_STATE_CONFLICT` is defined as a stable error code but is not reachable through any code path
in this implementation: because a task board's ID is deterministically derived
(`task:${taskId}`) rather than raced into existence through a check-then-create sequence, there is
no window in which two concurrent `ensureTaskBoard` calls for the same task could observe
conflicting state to report — the deterministic key makes the conflict structurally impossible
rather than merely detected and rejected.

## REST API

See `0004-hall-core-server.md`, "Communication Boards endpoints (Phase 8)" for the full endpoint
table. In summary: `GET /boards`, `GET /boards/:boardId`, `POST /tasks/:taskId/board` (`201` new /
`200` existing), `GET /boards/:boardId/messages` (optional `afterSequence`),
`POST /boards/:boardId/messages` (server assigns `messageId`/`sequence`/`author`, stores before
publishing to the WebSocket bus, returns `201`). There is no `PATCH`, no `DELETE`, no reply
endpoint, no reaction endpoint, no attachment upload — see "Why editing, deletion, and richer
interactions remain deferred" below.

## WebSocket message stream

`GET /boards/:boardId/messages/live` (`apps/server/src/routes/board-messages.ts`) reuses, verbatim,
the exact-origin CORS/Origin-validation policy and the close-code semantics
(`4400`/`4403`/`4404`/`4503`/`4504`/`1000`/`1003`) `routes/task-events.ts` established in Phase 5/6 —
no code is given a new or conflicting meaning. Subscription happens before replay (the same
subscribe-before-read ordering `task-events.ts` uses), replay delivers everything after the
client's `afterSequence`, and live delivery continues from there with no gap. Every outgoing frame
is re-validated through `communicationMessageSchema.safeParse()` immediately before `send()` —
stricter defense-in-depth than `task-events.ts` applies, deliberately, because a communication
message originates from arbitrary human-typed HTTP input rather than a trusted adapter's own
normalized event stream.

The one structural difference from the task-events route: a board discussion has no terminal
state. `task-events.ts` self-closes a connection once a task reaches `run.completed`/`run.failed`/
`run.cancelled`; a board's live stream never self-closes — it stays open until the client
disconnects, the server shuts down, or a policy violation (unsupported client data, capacity,
origin) closes it.

## Replay and delivery guarantee

Stated with the same precision `0004-hall-core-server.md`'s "WebSocket delivery guarantee" section
uses for task events:

- `MessageStore` is authoritative — anything stored can always be retrieved via `list()`/replay.
- Sequences are contiguous per board; live delivery over one healthy connection is ordered.
- Delivery is **at-least-once across a reconnect, not exactly-once** — replay can, in rare
  interleavings, resend the most recent message a client already received live. Clients dedupe by
  `sequence` + `messageId`, both stable and safe to key on.
- A slow client is disconnected (`4504`), never left silently missing frames.
- Reconnect uses `afterSequence=<last contiguous sequence accepted>`.
- By default, replay only ever works within the same Hall Core process's lifetime — a restart
  clears `BoardStore`/`MessageStore` entirely (see "In-memory storage, restart, and data loss"
  below). With Phase 13's optional durable mode (`--data-dir`), boards and messages instead survive
  a restart, and replay works across the process boundary too — but there is still no cross-process
  claim beyond that: durability is opt-in, not a default guarantee this design makes.

## Shutdown

Communication Boards' WebSocket clients close cleanly and `MessageBus` subscribers are removed as
part of the same `app.close()` Hall Core's existing shutdown sequence already performs — no
separate shutdown path was added, and no change was made to the existing task-shutdown/cancellation
policy. See `0004-hall-core-server.md`, "Graceful shutdown".

## In-memory storage, restart, and data loss

`BoardStore` and `MessageStore` are plain in-memory maps by default, exactly like
`TaskStore`/`EventStore` (`0004-hall-core-server.md`, "In-memory storage limitations"). In this
default mode, a Hall Core restart re-seeds a fresh General board (a new `createdAt`, zero messages)
and discards every task discussion board and every message that existed in the old process — this
was verified live: a message posted to General, followed by a process restart, followed by `GET
/boards` and `GET /boards/hall.general/messages` against the new process, shows a freshly seeded
General board with `messageCount: 0` and an empty message list. Nothing about Communication Boards
implies otherwise on its own. Phase 13 added an opt-in exception: with `--data-dir` set, both
stores are SQLite-backed instead, the General board (and every message on it) survives a restart
verbatim, and `BoardStore.seedGeneralBoard` upserts idempotently rather than re-seeding — see
[`0013-durable-persistence-and-recovery.md`](0013-durable-persistence-and-recovery.md).

## The web page (`/boards`)

`CommunicationBoards` (`apps/web/components/communication/communication-boards.tsx`) renders a
responsive two-column layout on desktop (board list left, selected discussion right) that stacks to
board selector → board context → message history → composer on a narrow viewport, with no
page-level horizontal overflow at any width. `BoardList` shows General first, then task boards, with
title, optional project ID, message count, last-updated time, and selected state; board IDs appear
only inside a collapsed diagnostic section, never as the primary label. Selecting a board updates
the URL (`?boardId=<encoded>`) via `router.replace`, so a reload or a direct link to a specific
board's URL selects the same board.

`useBoardMessages(boardId)` (`apps/web/hooks/use-board-messages.ts`) is structurally modeled on
`useTaskEvents` — the same generation-counter guard against stale callbacks after `boardId`
changes, the same explicit handler-teardown-before-close discipline, the same fixed
`250/500/1000/2000/4000ms` backoff schedule — but is a deliberately separate hook operating on
`CommunicationMessage`, never `NormalizedAgentEvent`. One behavioral difference follows directly
from the board stream having no terminal state: `useTaskEvents` treats a "normal" `1000` closure as
completion when a terminal event was already seen; `useBoardMessages` treats every close code,
including `1000`, as reconnectable, since a discussion has no equivalent "already finished" signal
to distinguish a graceful shutdown from an outage.

`MessageComposer` is plain-text only: a labeled, multiline textarea with a visible character
counter (importing `MAX_COMMUNICATION_MESSAGE_TEXT_LENGTH` from the protocol package rather than
duplicating the limit), blank and NUL-character rejection, Enter for a newline, Ctrl+Enter/Cmd+Enter
to submit, disable-while-submitting, and text preserved (not cleared) on a failed submit. It
deliberately never inserts the message it just sent into any local list — the board's message
history, driven by `useBoardMessages`, is the single source of truth and already receives the exact
same message back over the already-open WebSocket moments after the `POST` resolves (or via replay
on the next reconnect, if the stream happened to be briefly down). This is a conscious design
choice, not an oversight: it keeps the composer from ever needing separate local-insert/dedupe logic
(the hook's own sequence-based dedup already covers the message once it arrives), at the cost of a
brief window — only during an active WebSocket reconnect — where a message the server has already
confirmed with a `201` is not yet visible to the sender who just sent it. The alternative (locally
inserting an "unsaved-but-sent" message, then reconciling it against the WebSocket delivery) is what
the original Phase 8 specification's composer wording anticipates; this implementation took the
simpler, single-source-of-truth path instead, since Communication Boards has no requirement that a
sender see their own message with zero perceptible delay.

`MessageList` renders plain text only — no `dangerouslySetInnerHTML`, no Markdown parsing, no
automatic link activation, `whitespace-pre-wrap` to preserve line breaks as literal text. The empty
state is the exact text "No messages yet. Start the discussion." Scroll behavior jumps to the
latest message on first load, auto-scrolls on new-message arrival only if the reader is already near
the bottom, and never force-scrolls someone reading older messages; it respects
`prefers-reduced-motion` (`scrollTo({ behavior: reducedMotion ? "auto" : "smooth" })`) and announces
only the newest message's author through a bounded `aria-live="polite"` region, never the full
history.

`BoardList`'s `messageCount`/`updatedAt` refresh on mount, on window focus, and via a manual
Refresh control — deliberately no aggressive polling while a board is open, matching the "no
aggressive polling" requirement. This is a known, accepted limitation: the count for a board you are
not currently viewing can go stale until the next focus/manual refresh; it is not a bug.

## Create-or-open task discussion

Both the Task Console (`TaskDetail`'s "Open discussion" button) and the Kanban card (its Actions
menu — see `0006-kanban-board.md`, "Open discussion action (Phase 8)") call the identical
`ensureTaskBoard(taskId)` → `router.push(/boards?boardId=<encoded>)` sequence. Both entry points
were verified live to converge on the same board for the same task, with repeated clicks from
either surface never increasing the board count past one for that task.

## Why this is not the agent-communication channel

Communication Boards originally carried only human-authored messages (`author.kind` was always
`"human"`, and the schema had no other variant). Nothing here is a channel any coding agent writes
to — no message can trigger work, mention an agent, or invoke an approval or review workflow.
Building a human discussion surface first, cleanly separated from the not-yet-built
agent-communication surface, is what kept Phase 8 from having to guess at that future design's
shape.

**Phase 14 added the anticipated second author kind, `"system"`.** The CEO Agent posts bounded,
server-constructed audit summaries (plan created, submitted, approved, rejected, delegated,
completed/failed) to a task's own board using `author: { kind: "system", displayName: "CEO Agent" }`
— never `"human"`, so these messages can never be mistaken for something an operator typed.
`"system"` is deliberately generic, not `"ceo_agent"`, so any future non-human, non-adapter-run
message source can reuse the same literal rather than the union growing one member per feature.
This remains purely an audit trail, not a two-way channel: nothing posted this way can be replied
to by the CEO Agent, and the browser still can never supply either author kind directly — see
"Server-owned author" below and
[`0014-ceo-planning-approval-and-delegation.md`](0014-ceo-planning-approval-and-delegation.md).

**Phase 15 reuses the exact same dedup-gated `"system"` audit path** for autonomous execution
milestones (execution paused for review after an unclean restart, circuit breaker tripped, run
completed) — `claimBoardAuditOnce(runId, dedupKey, now)` on the execution-run store is the same
"claim once, post only if you win the claim" idiom `CeoPlanOrchestrator` already uses, applied to a
different dedup-key namespace so a repeated recovery pass or a duplicate-coalesced signal can never
post the same summary twice. See
[`0015-autonomous-plan-execution-and-scheduling.md`](0015-autonomous-plan-execution-and-scheduling.md).

## Why editing, deletion, and richer interactions remain deferred

Editing and deletion would require deciding what "delete" means for a sequence-numbered,
replay-based stream (does a deleted message leave a gap? get replaced by a tombstone? break replay
contiguity for late joiners?) — a real design question this phase does not need answered to prove
the board/message model itself. Reactions, nested replies, and attachments each add their own
schema, storage, and UI surface for a flat local-discussion prototype that has no requirement for
any of them yet. Notifications and search indexing both presuppose data living longer than one Hall
Core process lifetime by default — Phase 13's opt-in durable mode makes that possible for board
data, but this phase itself never assumed it, and notifications/search indexing remain unbuilt
regardless of storage backend.

## Why authentication and persistence remained deferred at this phase

Unchanged from this phase's own original reasoning (`0004-hall-core-server.md`, "Why authentication
is deferred"): nothing in this system is reachable from outside `127.0.0.1`. Persistence itself is
no longer deferred as of Phase 13 (opt-in, `--data-dir`) — see
[`0013-durable-persistence-and-recovery.md`](0013-durable-persistence-and-recovery.md) — but adding
it was intentionally out of scope for this phase, to avoid coupling the communication-board model to
schema/migration concerns unrelated to proving it worked.
