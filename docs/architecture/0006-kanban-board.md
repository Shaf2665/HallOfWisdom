# 0006 — Kanban Board

Status: Draft (Phase 7; assignment concurrency hardened in Phase 7.1; ABA gap closed with an internal
task revision in Phase 7.2).

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

## Closing the ABA gap: internal task revision (Phase 7.2)

The Phase 7.1 four-field compare (`status`/`runId`/`adapterId`/`agentId`) closes every _direct_
stale-write race, but not an **ABA** sequence: a task can go `ready -> blocked -> ready` (two real,
legitimate transitions) while an assignment request's `detect()` call is still pending, and all four
fields end up reading exactly what the request originally observed — `status: "ready"`, no run, no
adapter — even though the task's real history moved twice in between. A same-shape snapshot compare
structurally cannot tell "nothing happened" apart from "this happened and then un-happened"; only
something that strictly increases on every mutation, and never repeats, can.

**The fix — an internal monotonic revision.** `TaskStore` now keeps a private `taskId -> revision`
map, entirely separate from `TaskRecord`:

- A new task's revision starts at `0` when `add()` creates it (not counted as a "mutation").
- Every subsequent successful mutation of that task's record — `updateStatus`, `recordEventMeta`,
  `setStarted`, `setCompleted`, `setCancellationRequested`, `assignIfEligible`, `clearAssignment`,
  `setRunId`, `clearRunId` — increments it by exactly `1`, always as the last step, always after
  whatever validity check that method performs (a rejected mutation, e.g. an invalid transition,
  never increments revision, since nothing actually happened).
- It is never decremented, never reused, and deliberately **not** derived from `updatedAt` or any
  timestamp: two mutations can legitimately land in the same millisecond (`updateStatus("running")`
  and `setStarted(...)` are both called back-to-back from the same `run.started` handler in
  `TaskOrchestrator#handleEvent`), and a wall-clock value cannot promise two such mutations produce
  two distinguishable tokens the way a counter does.
- It is exposed only through `TaskStore.getRevision(taskId)` — never added to `TaskRecord`, never
  touched by any route handler, never present in any HTTP response body, and never read from request
  input. Keeping it out of `TaskRecord` entirely (rather than adding a field and trusting every route
  to strip it before responding) is what makes "revision cannot reach the browser" true by
  construction, not by discipline that could later be forgotten by a new endpoint.

**Revision-aware commit.** `TaskOrchestrator.assignTask()` now captures `taskStore.getRevision(taskId)`
in the same synchronous block as its existing snapshot read, before `await adapter.detect()`.
`TaskStore.assignIfEligible()`'s signature grew an `expectedRevision` parameter, checked first and
treated as the _primary_ concurrency token; the four-field snapshot is kept as secondary defense in
depth (redundant with revision for every case tested here, but cheap to keep, and a disagreement
between the two would itself indicate a bug worth surfacing loudly rather than silently). Any mismatch
— revision or snapshot — still throws the same `409 TASK_STATE_CONFLICT` used since Phase 7.1; no new
error code, no change to the client-visible contract.

**What this deliberately is not**: `updatedAt` is not the token (timestamps can collide and are
observable/predictable in a way a private counter isn't); there is no external locking package, no
database-style row lock, and no client-supplied version — the browser has no way to read, submit, or
influence a revision number, since it never appears in any response this server sends. This remains a
plain, in-process optimistic-concurrency compare-and-set, extended from four compared fields to five
(revision plus the original four), still exploiting the same single-threaded, no-`await`-in-between
guarantee Phase 7.1 established.

See `apps/server/src/tasks/task-store.ts` (the `#revisions` field and `getRevision()`/`#bumpRevision()`
doc comments) and `apps/server/src/routes/kanban-workflow.test.ts`'s two "ABA sequence" tests — one
for a Ready round trip, one for a same-adapter reassignment round trip — both constructed to fail
against a revision-less, four-field-only implementation and pass with revision checking.

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

### Real-browser bugs found in Phase 7.2, invisible to component tests

Phase 7.2's mandated genuine Playwright verification (not jsdom) found and fixed four real defects
that every prior automated test — including the accessibility-focused ones — had missed, because
each depends on actual browser layout, paint, or hit-testing that jsdom never performs:

1. **`lastActedOnTaskId` was set before the refetch that makes it meaningful.** `handleMove`/
   `handleStart`/`handleCancel`/`handleAssigned` called `refresh()` (fire-and-forget) and
   `setLastActedOnTaskId(taskId)` together in the same `finally` block. Because `refresh()` is
   asynchronous, the flag change was observed first by the _still-mounted, soon-to-be-unmounted_
   card instance in its _old_ column (a plain prop update, not a mount), which claimed focus and
   immediately cleared the flag via `onFocusHandled()` — before the real column change had even
   landed. The genuinely new instance in the new column then mounted with the flag already `false`
   and never claimed focus at all, dropping it to `<body>`. **Fix**: `useKanbanTasks`'s `refresh()`
   now returns a `Promise<void>` that resolves once `tasks` has actually been updated, and every
   caller `await`s it before setting `lastActedOnTaskId` — so the flag is only ever set once the DOM
   already reflects the new column, and only the correct (new, or on-failure surviving) instance can
   observe it.
2. **Entering a confirmation state (`confirming-start`/`confirming-cancel`) unmounts the button that
   was focused, with nothing claiming the new one.** Clicking "Start task" or the "Cancel task" menu
   item swaps that control out for a "Confirm"/"Cancel" pair in the same render; the just-clicked
   element is gone from the DOM by the time it commits, and focus fell to `<body>`. **Fix**: a
   `confirmButtonRef` + effect in `KanbanCard` claims focus on the "Confirm" button the moment either
   confirmation state is entered.
3. **`AssignDialog`'s focus-restore-on-close target could already be gone.** `Dialog` captures
   `document.activeElement` on mount to restore it later, but the "Assign agent" _menu item_ that
   opened the dialog is itself removed from the DOM in the same commit that mounts the dialog
   (`MoveMenu` closes its popover), so the captured reference was frequently already detached —
   restoring focus to it on close/Escape was then a silent no-op, dropping focus to `<body>`. **Fix**:
   `KanbanCard`'s `handleAction` now explicitly refocuses the stable, always-rendered "Actions"
   trigger button _synchronously, before_ calling `onOpenAssign` — so `Dialog` always captures a real,
   still-attached element to restore focus to.
4. **`MoveMenu`'s open popover could be clipped and pointer-unreachable.** Each Kanban column's card
   list (`KanbanColumn`'s `<ul>`) is `overflow-y-auto` so long columns scroll. `MoveMenu` originally
   rendered its popover as a plain `position: absolute` child of the trigger; CSS's overflow-clipping
   rule applies to absolutely-positioned descendants of a `overflow-y-auto` (as well as `overflow-x-auto`)
   ancestor exactly the same as normal-flow ones. Whenever a card sat near the bottom of a scrolled
   column, the popover's own action buttons rendered in a region the `<ul>` clipped — confirmed live via
   `document.elementFromPoint()` landing on the column's `<section>` instead of the button, meaning a
   real mouse/touch user genuinely could not click "Cancel task"/"Move to Ready"/etc. in that
   position, while keyboard Tab still reached the (invisible) button — exactly why this escaped every
   prior review. **Fix**: `MoveMenu` now renders its open popover through a `react-dom` portal into
   `document.body`, `position: fixed`, positioned from the trigger's own `getBoundingClientRect()` —
   fully escaping the column's clipping box — and closes on any scroll or resize while open rather
   than tracking a moving target.

Only (1) was genuinely unreachable from `@testing-library/react` + jsdom: it depends on the _relative
timing_ of a real async fetch racing a real cross-component-identity remount (the stale instance
observing the flag before the new instance mounts), a real-event-loop race that jsdom's synchronous test
harness doesn't reproduce the same way a browser does. (2), (3), and (4) turned out to be reachable
after all — each is a deterministic consequence of a single render/commit, not a timing race — and each
now has a direct jsdom regression test added after the fact: `kanban-card.test.tsx`'s "moves focus to
the Confirm button when entering the start/cancel-confirmation state" tests cover (2), "refocuses the
stable Actions trigger before opening the assign dialog" covers (3), and "renders the open Move menu
popover through a portal into document.body" covers (4)'s DOM placement (with a companion test described
below guarding the keyboard-reachability regression the portal fix itself introduced). The original
claim that all four were only reachable via genuine browser testing was an overstatement for (2)–(4):
genuine Playwright verification is still what actually _found_ all four (component tests had reported
this area as covered before Phase 7.2's browser pass), but jsdom tests were achievable in hindsight and
are what now guard against silent regression. Only (1) remains a case where real-browser verification is
the only practical way to both find and guard the bug.

**A fifth bug, introduced by the fix for (4) and found only by re-doing the live keyboard pass after
making that fix:** portaling `MoveMenu`'s popover to `document.body` moved it out of DOM order relative
to its trigger button. Sequential Tab navigation follows DOM order, not visual position, so once the
popover was portaled, Tab from "Actions" no longer landed inside the menu — it fell through to whatever
came next in `document.body` order (typically the next card), leaving the menu keyboard-unreachable even
though every earlier keyboard verification pass (done before the portal fix existed) had found the
pre-portal, DOM-adjacent version fully Tab-reachable. **Fix**: `MoveMenu` now moves focus to its first
action button in a passive effect the moment it opens. This is a direct, sequencing-only consequence of
render order, not a timing race, so it too has a jsdom regression test ("moves focus to the first menu
item when the portaled Move menu opens").

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
