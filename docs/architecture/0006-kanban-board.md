# 0006 — Kanban Board

Status: Draft (Phase 7; assignment concurrency hardened in Phase 7.1).

## Context

Phase 7 adds a visual Kanban board (`/board` in `@hall-of-wisdom/web`) alongside the existing Task
Console (`/`, Phase 6). It introduces the first tasks that exist _before_ an agent is chosen or
started — planning tasks — and the manual, agent-assignment, and start operations needed to move
one from an idea to a running execution, while Hall Core remains the sole authority over every
status change.

## Kanban responsibilities

1. Create a planning task in Backlog without starting an agent (`BacklogTaskForm` →
   `POST /api/v1/tasks` with `executionMode: "deferred"`).
2. Move a planning task through the permitted manual workflow columns
   (`POST /api/v1/tasks/:taskId/transition`).
3. Assign an available adapter to a `ready` task (`POST /api/v1/tasks/:taskId/assign`) — this alone
   never starts execution.
4. Start an assigned task (`POST /api/v1/tasks/:taskId/start`) — the one explicit action that ever
   begins agent execution.
5. Reflect execution-owned status changes (`running`, terminal outcomes) exactly as the Task
   Console already does, via polling rather than a dedicated board WebSocket (see "Polling
   strategy" below).
6. Cancel a task appropriately for whichever state it's in (see "Cancellation: two operations,
   one decision").
7. Display completed/failed/cancelled tasks distinctly from active ones.
8. Support the same operations by mouse/touch drag and by explicit keyboard-accessible controls,
   with drag never doing anything the equivalent explicit control couldn't also do.

## Column and status mapping

| Column         | `TaskStatus`           | Kind      |
| -------------- | ---------------------- | --------- |
| Backlog        | `backlog`              | planning  |
| Ready          | `ready`                | planning  |
| Assigned       | `assigned`             | planning* |
| In Progress    | `running`              | execution |
| Agent Review   | `reviewing`            | future    |
| Human Approval | `waiting_for_approval` | future    |
| Blocked        | `blocked`              | planning  |
| Completed      | `completed`            | terminal  |
| Failed         | `failed`               | terminal  |
| Cancelled      | `cancelled`            | terminal  |

\* `assigned` is planning-controlled only until a run has been claimed (`runId` set by `/start`) —
see "The assigned-but-launching window" below.

This table exists in exactly one place client-side, `lib/kanban.ts`'s `COLUMN_DEFINITIONS`, built
from an exhaustive `switch` over the full `TaskStatus` union (`columnKindForStatus`) — adding a new
protocol status without updating this file is a TypeScript compile error, not a silent
miscategorization.

## Planning-controlled, execution-controlled, terminal, and future states

- **Planning-controlled** (`backlog`, `ready`, `assigned` before start, `blocked`): only ever
  change status through an explicit client request — a manual transition, an assignment, or a
  start. Cards here are draggable and expose the full non-drag action menu.
- **Execution-controlled** (`running`, and the `assigned`-with-a-claimed-run window): status
  changes are driven only by the adapter's own normalized events (`run.started`) or Hall Core's own
  infrastructure-failure workflow — never by a client request. Cards here cannot be dragged and
  expose only a cancel action (or nothing, while launching).
- **Terminal** (`completed`, `failed`, `cancelled`): no further transition is ever valid. Cards are
  view-only.
- **Future** (`reviewing`, `waiting_for_approval`): reachable in the protocol's `TaskStatus` enum
  and rendered as real columns, but nothing in this server ever transitions a task into them yet —
  see "Why Agent Review and Human Approval are visible but not automated" below.

## The assigned-but-launching window

`POST /start` claims a `runId` synchronously (see `TaskStore.setRunId()`'s atomic
compare-and-set) but the task's `status` field does not change to `running` until the adapter's own
`run.started` event actually arrives — the same rule Phase 5/6 already established for immediate
tasks. During that window a task is `status: "assigned"` _and_ has a `runId`. This is a real,
client-visible state, not a rounding error: with a nonzero `--mock-step-delay-ms` it is visible on
the board for the whole delay. Both the server (`TaskOrchestrator.transitionTask`'s
"actively executing" check) and the client (`isCardLocked` in `lib/kanban.ts`) treat
`assigned && runId !== undefined` as execution-controlled — no Start button (no double-start), no
Move menu, just a "Starting…" indicator — distinctly from `assigned && runId === undefined`, which
is fully planning-controlled.

## Deferred versus immediate task creation

`POST /api/v1/tasks` takes an optional `executionMode: "immediate" | "deferred"`, defaulting to
`"immediate"` when the field is omitted entirely — every Phase 6 caller, which never sends the
field, is completely unaffected. The two branches are validated by a
`z.discriminatedUnion` (`schemas/create-task-request.ts`), reached via a `z.preprocess` step that
injects the default only when `executionMode` is missing:

- **Immediate**: identical to Phase 6 — `adapterId` required, `202 Accepted`, task begins
  `assigned` and is started immediately.
- **Deferred**: `adapterId` is not merely optional but absent from the schema's shape — `.strict()`
  rejects one outright if sent, since an adapter on a task with no execution yet is meaningless.
  `201 Created`, `status: "backlog"`, no `runId`, no `eventsPath`, no `AgentRun`, no active-run
  tracking, no WebSocket subscription created (there is nothing to stream yet).

## Task snapshot compatibility

`TaskRecord.runId` / `.adapterId` / `.agentId` are `string | undefined`, both server-side
(`tasks/task-record.ts`) and in the web client's Zod schema (`lib/api-schemas.ts`). A planning task
is a real `TaskRecord` from the moment it's created — never padded with empty strings as a
substitute for "not yet known." Every place that reads these fields (the Task Console's
`TaskDetail`, the Kanban card, `useTaskEvents`'s connection gate) checks for `undefined` explicitly
rather than assuming a run exists.

## Assignment and Start separation

Two endpoints, two purposes, deliberately never merged:

- **`POST /assign`**: validates the adapter exists and reports `"available"` (a stricter, new check
  Phase 6's immediate-creation path never performed), validates and canonicalizes an optional
  working directory, and transitions `ready -> assigned` (or updates the assignment in place if
  already `assigned` and not yet started — reassignment before start). Creates no run, no
  `AgentTaskInput`, no WebSocket subscription.
- **`POST /start`**: the _only_ endpoint that ever begins execution. Requires `status: "assigned"`
  and no `runId` yet, claims the run atomically, and only then builds the real `AgentTaskInput` and
  hands it to Hall Runner.

The canonical, validated _absolute_ working directory is never part of `TaskRecord` (which is
serialized directly as an HTTP response body) — it lives only in a private
`TaskOrchestrator`-internal sidecar map (`#pendingWorkingDirectories`, keyed by `taskId`), populated
by deferred-creation or `/assign` and consumed (and cleared) by `/start`. The browser never sees an
absolute path.

## Assignment concurrency policy (Phase 7.1)

`assignTask()` reads task state, then `await`s `adapter.detect()` — an arbitrary amount of other
code (another request's handler) can run during that `await`, so the state read before it can be
stale by the time it resolves. Phase 7 originally left this as an accepted, unfixed limitation;
Phase 7.1 closes it with a deterministic atomic commit, because a stale write here could silently
assign a different adapter than the one a racing `/start` already began executing with, or resurrect
an assignment on a task that had meanwhile been blocked or cancelled.

**The fix — `TaskStore.assignIfEligible()`**: after `adapter.detect()` resolves, `assignTask()` calls
one new, purely synchronous `TaskStore` method (no `await` inside it, and none between it and the
`detect()` call that precedes it) that re-reads the task's _live_ record and re-validates the exact
four-field snapshot the caller originally observed — `status`, `runId`, `adapterId`, `agentId` — all
in the same event-loop turn as the write. JavaScript's single-threaded execution guarantees nothing
else can run in that gap, so whatever this method observes is still true at the moment it commits.
Comparing all four fields (not just `status`) closes both races found:

- **Ready → Assigned race**: two concurrent first-assignments of the same Ready task. Both capture
  `expected.status: "ready"`; the loser's live status has already become `"assigned"` by the time its
  commit runs, so the snapshot no longer matches and it is rejected.
- **Concurrent-reassignment race**: two concurrent adapter changes on an already-`assigned`,
  not-yet-started task. Both capture the same `expected.adapterId`/`agentId`; the loser's live
  `adapterId`/`agentId` have already changed by the time its commit runs (the winner updated them),
  so it is rejected even though `status` alone would still have matched.

**Policy**: a Ready task may be assigned exactly once; if two assignment requests race, exactly one
succeeds and the other receives `409 TASK_STATE_CONFLICT` (the same code `assignTask()`'s existing
fast-fail pre-check already used for an obviously-ineligible task — reused rather than introducing a
new `TASK_ASSIGNMENT_CONFLICT` code, since both conditions mean exactly the same thing to a client:
"this task was not in a state this request could act on"). Reassignment of an already-assigned,
not-yet-started task remains permitted, but is now subject to the identical atomic re-check — never
last-write-wins. A losing request never stores its adapter identity, never touches the cached working
directory (`#pendingWorkingDirectories` is only written after `assignIfEligible()` succeeds), and
never leaves a partially-applied or mixed assignment.

This closes the race without an external lock, a client-supplied lock token, or a new dependency — it
is a plain optimistic-concurrency compare-and-set over four fields already held in memory, exploiting
the fact that Node never preempts synchronous code. See `apps/server/src/tasks/task-store.ts`'s
`assignIfEligible()` doc comment for the full field-by-field reasoning, and
`apps/server/src/routes/kanban-workflow.test.ts`'s "agent assignment" describe block for the
deterministic tests (a gated fake adapter holds `detect()` open so a test can force two requests to
overlap on demand, rather than relying on incidental Promise-microtask ordering).

## Why drag cannot start agent execution automatically

Dragging a card onto the Assigned column from Ready opens the assignment dialog rather than
assigning directly — assignment needs real, possibly-slow validation (adapter availability, working
directory) a drop gesture can't meaningfully carry. Dragging onto In Progress is rejected outright:
`lib/kanban.ts`'s `isValidDragTarget` never lists `running` as a legal target from any column,
regardless of what `manualDestinationsFor` would otherwise allow. Starting an agent is always an
explicit `Start task` action with its own confirmation step (`KanbanCard`'s inline
idle → confirming → busy state machine, mirroring the Task Console's own cancel-confirmation
pattern from Phase 6) — a drag can select a _destination column_, never _commit code execution_.

Dropping onto a terminal column (including Cancelled) is likewise always rejected by
`isValidDragTarget`, even though `cancelled` legitimately appears in `manualDestinationsFor` for
every planning status — cancelling is a deliberate, confirmed action (the dedicated Cancel
control), never something an accidental drag onto the wrong column should trigger.

## No optimistic state

On drop, the card stays in its origin column; the board sends exactly one transition/assignment/
start/cancel request, shows the card as pending (disabled, no second drag or menu action possible),
and only moves the card once Hall Core's own response (or the next poll) reflects the new state. A
failed operation leaves the card exactly where it was, with a bounded, safe error message and a
board-level announcement — never a UI that disagrees with what Hall Core actually holds.

## Accessible non-drag controls

Every draggable card also exposes an "Actions" disclosure (`components/kanban/move-menu.tsx`) built
from native `<button>` elements — deliberately without `role="menu"`/`role="menuitem"` (that ARIA
pattern requires arrow-key/Home/End roving-tabindex navigation this disclosure doesn't implement;
using the role without it would announce a false affordance to screen-reader users, a Phase 7
accessibility-review finding fixed in Phase 7.1). Items are plain, ordinary Tab-stop buttons, with
`aria-expanded`/`aria-controls` on the trigger, Escape-to-close, and a click-outside handler —
listing exactly the same permitted destinations
`availableActionsFor` computes for that card's current state (backlog: Move to Ready/Move to
Blocked/Cancel task; ready: + Assign agent; assigned: Start task/Return to Ready/Move to
Blocked/Cancel task; running: Cancel active task only; terminal: nothing). These controls are
present unconditionally, not only as a fallback when JavaScript-based dragging is unavailable —
mouse, touch, and keyboard users all reach the same actions through the same menu.

Focus management: a card's own local confirmation UI stays focused normally, but a _successful_
move/assignment/start moves the task's column, which unmounts the old `<li>` (a different parent
`<ul>`) once the board's next fetch lands — React does not preserve component identity across a
parent change even with a stable `key`. The board tracks which `taskId` was just acted on
(`lastActedOnTaskId`) and passes that down; the newly mounted card (or, on failure, the same
surviving instance) claims focus on its own Actions button once rendered. See the doc comments on
`KanbanCard`'s `shouldFocusOnMount` prop for the full reasoning.

## dnd-kit boundary

`@dnd-kit/core` provides `DndContext`, `useDraggable`/`useDroppable`, `DragOverlay`, and
pointer/keyboard sensors — everything this phase needs for column-to-column status drags.
`@dnd-kit/sortable` is deliberately **not** installed: Phase 7 has no within-column reordering to
support (see below), so the sortable-list machinery would add a dependency with nothing to do.
`@dnd-kit/utilities` is installed only for its `CSS.Translate.toString()` helper, the standard,
tiny companion for turning a drag transform into an inline style — avoiding a hand-rolled transform
string. dnd-kit's own `accessibility.announcements` option drives the drag-start/over/end/cancel
screen-reader announcements; a _separate_, single `aria-live="polite"` region at the board level
announces the _result_ of every operation (move, assign, start, cancel), including ones reached
through the non-drag controls dnd-kit knows nothing about. Using dnd-kit does not by itself make
this board accessible — see "Accessibility review disclosure" in the Phase 7 report for what was
and wasn't independently verified.

## No persisted custom card ordering

Within each column, cards render in the server's own list order (`GET /api/v1/tasks`'s response
order, preserved by `groupTasksByColumn`) — there is no drag-to-reorder-within-a-column feature,
and no ordering field is ever sent back to Hall Core. A drag only ever changes which column a task
belongs to.

## Polling strategy

`hooks/use-kanban-tasks.ts` polls `GET /api/v1/tasks` every 3 seconds while at least one task is
`assigned` or `running`, and every 15 seconds otherwise; polling pauses entirely while
`document.visibilityState === "hidden"` and refreshes immediately on `visibilitychange` back to
visible or on `window`'s `focus` event. Every fetch is generation-guarded exactly like Phase 6's
WebSocket hook (`use-task-events.ts`): a superseded response can never overwrite a newer one, and a
failed refresh only ever surfaces a bounded warning — it never clears already-loaded cards. There is
deliberately no per-task WebSocket opened by the board; the existing per-task live event stream
remains reachable through the Task Console (`/`), unchanged from Phase 6 — see "Board data
synchronization" below for why that split was chosen over duplicating it.

## Board data synchronization (server-authoritative)

Hall Core is the only source of truth the board ever renders from. The board never opens a
WebSocket of its own — the Kanban spec's phrase "continue using the existing per-task WebSocket for
the currently selected or actively viewed task" is interpreted here as: a user who wants the live,
event-by-event timeline for one specific task already has it, unchanged, on the Task Console; the
board itself reflects progress purely through polling `GET /api/v1/tasks`, refreshed after every
mutation and on visibility/focus regain. This keeps the "no new global WebSocket API" and "no one
WebSocket per task" restrictions unambiguously satisfied without needing a second, board-specific
live-streaming surface.

## In-memory limitations

Nothing about deferred tasks changes Hall Core's storage model: `TaskStore` remains a bounded
in-memory map (`docs/architecture/0004-hall-core-server.md`, "In-memory storage limitations"). A
Hall Core restart discards backlog/ready/assigned planning tasks exactly as it discards running or
completed ones — there is no persistence in this phase, and the Kanban board does not imply
otherwise.

## Why Agent Review and Human Approval are visible but not automated

These columns exist because `TaskStatus` already reserves `reviewing` and `waiting_for_approval`
for the eventual CEO-Agent-driven review/approval workflow described in
`docs/architecture/0001-initial-architecture.md`. Showing them now — empty, with a small "Not
automated yet — a later phase" note — lets the board's shape match the eventual full workflow
without pretending review-agent execution or human-approval logic exists yet. No code path in this
server or this phase ever transitions a task into either status.

## Why Communication Boards remain deferred to Phase 8

Nothing in this phase — planning tasks, manual transitions, assignment, starting execution — needs
inter-agent or agent-to-human messaging. Communication Boards are a materially separate feature
(message threads, notification delivery, presence) that deserves its own phase rather than being
folded into "tasks can now be planned before they run."

## Cancellation: two operations, one decision

The existing active-run endpoint (`POST /tasks/:taskId/cancel`, Phase 5/6) is unchanged and remains
the only way to cancel a task that already has a run — it does not mark the task `cancelled` until
the adapter's own `run.cancelled` event arrives. For a task with no run yet (backlog, ready,
blocked, or assigned-not-started), cancellation goes through the manual transition endpoint instead
(`targetStatus: "cancelled"`), which completes synchronously and emits no event at all — there is no
run to cancel. Both the Task Console's `TaskDetail` and the Kanban card make this choice the same
way: `record.runId === undefined` routes to `/transition`; otherwise to `/cancel`.
