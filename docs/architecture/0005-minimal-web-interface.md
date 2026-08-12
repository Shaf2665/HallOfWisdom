# 0005 — Minimal Web Interface

Status: Draft (Phase 6; `TaskRecord`'s optional run fields noted below were extended in Phase 7,
see `0006-kanban-board.md`; Communication Boards added in Phase 8, see
`0007-communication-boards.md`).

## Context

Phase 6 adds `@hall-of-wisdom/web` (`apps/web`): a Next.js 16 App Router dashboard — the first
visible Hall of Wisdom user interface. It talks directly to Hall Core's REST + WebSocket API
(`docs/architecture/0004-hall-core-server.md`) from the browser, with no server-side proxy of its
own. It is a prototype, same as every package before it: no authentication, no persistence beyond
what Hall Core itself already holds in memory. Phase 7 (`0006-kanban-board.md`) added a second page,
the Kanban Board (`/board`), on top of the same API client and schemas this document describes —
this page (the Task Console, `/`) is unchanged in its own responsibilities below, except that
`TaskRecord.runId`/`.adapterId`/`.agentId` are now `undefined` for a planning task selected here
(the Task Console can display any task `GET /api/v1/tasks` returns, including ones with no run
yet), and `TaskDetail`/`TaskListItem` render those fields conditionally rather than assuming they
exist.

## Web application responsibilities

1. Show whether Hall Core is reachable (`ServerStatus`).
2. List the coding-agent adapters Hall Core actually has registered (`TaskCreateForm`'s adapter
   selector, backed by `GET /api/v1/adapters`) — never assumes `hall.mock-agent` is the only one.
3. Create a task (`TaskCreateForm` → `POST /api/v1/tasks`).
4. List existing tasks (`TaskList` → `GET /api/v1/tasks`).
5. Show one task's full detail (`TaskDetail`).
6. Stream that task's normalized events live over WebSocket (`useTaskEvents` →
   `GET /api/v1/tasks/:taskId/events`), with safe reconnection.
7. Allow cancelling an active task (`TaskDetail`'s Cancel button → `POST /api/v1/tasks/:taskId/cancel`).
8. Clearly distinguish completed/failed/cancelled outcomes.

## Next.js App Router boundary

Every interactive piece is a Client Component (`"use client"` — `app/page.tsx`,
`components/server-status.tsx`, `components/task-create-form.tsx`, `components/task-detail.tsx`,
`hooks/use-task-events.ts`). `app/layout.tsx` and `components/application-shell.tsx` are plain
Server Components (no interactivity, no client-only APIs) — there's nothing to gain from making
them client components, and keeping them server-rendered is the smaller, more standard choice.
There is deliberately no `app/api/` directory anywhere in this package.

## Why no custom Next.js server

The whole point of this architecture is that the browser talks to Hall Core **directly**, cross-origin,
authenticated by nothing more than "which origin is allowed" (see "Exact-origin CORS policy" and
"WebSocket Origin validation" in `0004-hall-core-server.md`). A custom server, a Next.js Server
Action, or an `app/api/` route proxy would each reintroduce a server-side hop this design doesn't
need — Hall Core already is the API; adding another one in front of it would just be indirection
with no corresponding benefit at this phase, and was explicitly out of scope for Phase 6.

## Why apps/web has its own tsconfig, not the shared one

Every other package in this monorepo extends the shared `tsconfig.base.json`: `module`/`moduleResolution:
"NodeNext"`, `verbatimModuleSyntax: true`, `.js`-suffixed relative imports. Next.js requires
`moduleResolution: "bundler"`, `jsx: "react-jsx"`, and no forced `.js` import suffixes — genuinely
incompatible settings, not a style preference. `apps/web/tsconfig.json` is therefore a standalone
config (matching what `next build` itself generates and expects) that still turns on the same
strict-mode flags the rest of the repo uses (`strict`, `noUncheckedIndexedAccess`,
`noImplicitOverride`, `exactOptionalPropertyTypes`, `noFallthroughCasesInSwitch`,
`noImplicitReturns`) — strict everywhere, shared base file only where the tooling actually agrees.
The root ESLint flat config (`eslint.config.js`) similarly adds a block scoped to
`apps/web/**/*.{ts,tsx}` only, layering React/JSX/`react-hooks`/`jsx-a11y`/`@next/next` rules on top
of (not instead of) the same `projectService`-based type-aware linting every other package gets,
rather than importing `eslint-config-next`'s own config wholesale (which ships its own competing
parser assignment).

## Local URL configuration

`lib/hall-core-url.ts`'s `parseHallCoreUrl()` parses and validates `NEXT_PUBLIC_HALL_CORE_URL`
(default `http://127.0.0.1:4310`, see `.env.local.example`): only `http`/`https`, no embedded
username/password, no fragment, no query string, no path (Hall Core's base URL is an origin, not an
endpoint — paths are appended per-call), trailing slash normalized away. `ws`/`wss` is derived from
the validated `http`/`https` origin, never constructed separately (so the two can never silently
drift apart). Hall Core itself only ever binds to `127.0.0.1` (`0004-hall-core-server.md`,
"Local-only binding") and this is never exposed directly — but a non-loopback
`NEXT_PUBLIC_HALL_CORE_URL` is a supported, real configuration: it is how a public HTTPS origin (a
Cloudflare Tunnel hostname mapping back to `127.0.0.1:4310`) is configured for remote access, see
`docs/remote-access.md`. The function does not hard-reject a non-loopback host, only genuinely
unsafe or malformed values.

## Exact-origin CORS policy (client side)

Hall Core enforces the actual allowlist server-side (`0004-hall-core-server.md`); the web app's
obligation is simply to run on an origin that allowlist expects. `package.json`'s `dev`/`start`
scripts both pass `--hostname 127.0.0.1 --port 3000` explicitly — never `0.0.0.0`; a public origin
served through a Cloudflare Tunnel maps back to that same local Next.js process, it is never bound
directly to a non-loopback address (`docs/remote-access.md`).

## WebSocket Origin validation (client side)

Nothing extra is required on the client: browsers already send a real, unforgeable `Origin` header
on every WebSocket handshake, which is exactly what Hall Core's server-side check relies on
(`0004-hall-core-server.md`, "WebSocket Origin validation"). The web app never needs to construct
or claim an origin itself.

## Safe adapter discovery

`TaskCreateForm` calls `GET /api/v1/adapters` on mount and renders whatever comes back — including
disabling (not hiding) any adapter whose `availability` isn't `"available"`, and refusing to submit
if no adapter is available at all. It never hardcodes `hall.mock-agent` as a fallback.

## API client validation

`lib/api-client.ts` is the only place in this app that calls `fetch()`. Every successful response
is validated at runtime against a Zod schema (`lib/api-schemas.ts`) before a caller ever sees it —
matching TypeScript types is necessary but never sufficient; the schemas are `.strict()`, so an
unexpected extra field (e.g. a stray `executablePath` that should never have left the server) fails
validation rather than silently passing through. Error responses are validated the same way. A
non-JSON body, a malformed-JSON body, a network failure, and a client-side timeout each produce a
distinct, typed `ApiClientError` with a bounded, safe `message` — never a raw `Response` object,
never a raw fetch exception, never a response body printed to the console. `POST` requests
(`createTask`, `cancelTask`) are never automatically retried by this client; a user-initiated retry
(re-submitting the form, or Hall Core's own idempotent-cancel semantics) is the only path to a
repeated request.

## WebSocket replay and reconnect

`hooks/use-task-events.ts` mirrors, client-side, the exact duplicate/conflict/gap policy Hall
Core's own `EventStore.append()` enforces server-side (`lib/task-events.ts`'s
`parseAndClassifyIncomingEvent`) — Hall Core already guarantees these invariants, but this client
does not trust that blindly, the same defense-in-depth reasoning Hall Core itself applies one layer
down. On reconnect, the WebSocket URL includes `afterSequence=<last accepted contiguous sequence>`
(omitted entirely on the very first connection, when nothing has been received yet).

This reconnect behavior only applies **within the lifetime of one running Hall Core process** — it
replays from that process's still-intact `EventStore`. It has no bearing on a Hall Core _restart_: a
new process starts with empty `TaskStore`/`EventStore` (`0004-hall-core-server.md`, "In-memory
storage limitations"), so a client still watching a task from the old process cannot resume it.
What that actually looks like client-side: the dropped TCP connection first surfaces as an abnormal
close (`1006`, since the old process is simply gone, not gracefully closing anything) and the hook
retries on its normal bounded backoff — "Reconnecting…", and "disconnected" with a manual
`reconnect()` option if the restart takes long enough to exhaust the retry budget. Only once the
_new_ process is up and a reconnect attempt actually completes against it does the task's real,
permanent fate resolve: the new process has never heard of that task ID, so it closes with `4404`
and the hook settles into a permanent `"error"` state — no further automatic retry, and no stale
data is ever presented as if it were still live. See "Close-code handling" below, and `README.md`'s
"WebSocket reconnect vs. Hall Core restart" section for the exact manual test that exercises this
distinction.

## At-least-once event handling and client deduplication

Matching Hall Core's own documented guarantee (`0004-hall-core-server.md`, "WebSocket delivery
guarantee"): delivery is **at-least-once** across a reconnect, not exactly-once. A replay can, in
rare interleavings, redeliver the most recently live-received event. `parseAndClassifyIncomingEvent`
treats a same-sequence-same-`eventId` message as an idempotent duplicate (silently ignored, not an
error) — this client is built to expect and correctly absorb that, not to assume it can never
happen.

## Close-code handling

`use-task-events.ts` interprets every one of Hall Core's documented WebSocket close codes
explicitly:

| Code          | Meaning                                    | Client behavior                                                                                                                                 |
| ------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `1000`        | Normal close                               | If a terminal event was already accepted: mark the stream `"completed"`, no reconnect. Otherwise: treat as unexpected, reconnect (bounded).     |
| `4400`        | Invalid request (e.g. bad `afterSequence`) | `"error"`, no automatic retry.                                                                                                                  |
| `4404`        | Unknown task                               | `"error"`, no automatic retry — the task genuinely doesn't exist.                                                                               |
| `4503`        | Subscriber limit reached                   | Reconnect with bounded backoff.                                                                                                                 |
| `4504`        | Client too slow                            | Reconnect using `afterSequence=<last accepted sequence>` — the skipped event is still in `EventStore` and gets replayed.                        |
| `1003`        | Unsupported client data                    | `"error"`, no automatic retry (this client never sends anything, so this would indicate a real bug or interference, not a transient condition). |
| `4403`        | Origin not allowed                         | `"error"`, no automatic retry — a browser origin mismatch will not resolve itself by retrying.                                                  |
| `1006`        | Abnormal closure                           | Treated as reconnectable — the browser's generic "something went wrong with the connection" code.                                               |
| anything else | Unrecognized                               | Reconnectable by default — the safer assumption for a code this client doesn't specifically know to be permanent.                               |

Reconnection uses a fixed, deterministic backoff schedule — `250ms, 500ms, 1000ms, 2000ms, 4000ms`
— with **no jitter**: jitter was deliberately omitted so the entire reconnect/backoff test suite
could run under fake timers fully deterministically, rather than adding timing noise a test would
then have to tolerate. After five attempts, the hook stops and exposes a manual `reconnect()`
action instead of retrying forever.

The retry budget resets only when a reconnect actually delivers an accepted event — never merely
on the WebSocket `open` event. Hall Core's own checks (subscriber limit, slow-client) run after the
handshake completes, so `open` can fire immediately before a retryable close; resetting on `open`
alone would let a server stuck rejecting every connection reconnect forever at the fastest backoff
step instead of ever exhausting the cap. Resetting on real, delivered progress means a long-running
task that keeps making progress between outages is not penalized for having recovered before,
while a server that never lets the connection do anything useful — or a task that stays idle across
repeated blips with no new events in between — still counts toward, and can still hit, the
manual-reconnect cap as designed.

## Connection cleanup

Every WebSocket connection this hook opens is tracked through exactly one `AbortController`-free,
generation-counter-guarded lifecycle: a monotonically increasing "generation" number is captured by
each socket's handlers at creation time, and any handler whose captured generation no longer matches
the hook's current generation is a no-op — this is what makes it safe for a late message/close event
from an already-superseded socket (because the user switched tasks, or the hook itself opened a
newer connection) to arrive without corrupting state. On every reconnect, task switch, and unmount,
the previous socket's `onopen`/`onmessage`/`onclose`/`onerror` handlers are explicitly nulled before
(or as part of) closing it — regardless of whether the close was self-initiated or came from the
server first — so no handler reference and no listener can accumulate across the component's
lifetime. Pending reconnect timers are always cleared on unmount and on every new connection attempt.

## Accessibility expectations

One `<h1>` per page (`Hall of Wisdom`, in `ApplicationShell`); every form field in
`TaskCreateForm` has a real, programmatically associated `<label>`; task list items are real
`<button>` elements (keyboard-operable for free, no synthetic `div`-with-`onClick`); connection and
health status use `aria-live="polite"` regions; status is never communicated by color alone (every
badge and status line carries text, e.g. "Completed", "Reconnecting…", not just a colored dot);
`globals.css` defines one consistent `:focus-visible` style and respects
`prefers-reduced-motion`; field-level validation errors are wired to their inputs via
`aria-invalid`/`aria-describedby`. Native HTML controls (`<select>`, `<input>`, `<button>`,
`<textarea>`) are used throughout rather than custom-built equivalents.

## Responsive behavior

The dashboard's grid (`app/page.tsx`) collapses from a two-column desktop layout
(`lg:grid-cols-[320px_1fr]`) to a single stacked column below the `lg` breakpoint — server status,
task form, task list, and task detail/event timeline stack top-to-bottom on a narrow viewport. The
raw-JSON debug view inside `TaskEventTimeline` scrolls its own content horizontally
(`overflow-x-auto`) rather than ever forcing the page itself to scroll sideways.

## Why Kanban is deferred to Phase 7

This phase's task list is a flat, chronological list — no columns, no drag-and-drop, no workflow
states beyond what Hall Core's own `TaskStatus` already models. A Kanban board is a materially
larger feature (multi-column layout, drag interactions, its own accessibility requirements for
non-pointer users) that deserves its own phase rather than being folded into "the first UI exists at
all."

## Communication Boards (Phase 8)

A third page, `/boards`, was added in Phase 8 on top of the same API client, schema-validation, and
WebSocket-reconnect discipline this document describes — reusing `lib/api-client.ts`'s validated-
response pattern and `hooks/use-task-events.ts`'s reconnect/backoff/generation-guard structure for
its own `useBoardMessages` hook, but as a deliberately separate hook operating on
`CommunicationMessage`, never on `NormalizedAgentEvent` (the two domains — agent execution events
and human discussion — are kept structurally distinct end to end, protocol package through UI). See
`0007-communication-boards.md` for the full design: board list, message history, composer, scroll
behavior, and accessibility.

## CEO plan execution UI (Phase 15, Phase 15.1)

`/ceo/[planId]`'s **Autonomous execution** section (`components/ceo/ceo-plan-execution-section.tsx`)
reuses the same reconnect-with-resume WebSocket discipline described above via its own dedicated
hook, `hooks/use-ceo-plan-run-events.ts`, on the execution-run event stream (never mixed with the
task-events or CEO-plan-definition streams). Four operator-action dialogs
(`ceo-plan-execution-{configure,start}-dialog.tsx`, plus a single shared
`ceo-plan-execution-confirm-dialog.tsx` parameterized for Pause/Cancel/Emergency-stop) each carry
their own exact, non-interchangeable confirmation copy — see `0015-...md` for why Pause, Cancel, and
Emergency-stop must never share ambiguous text even though they share one dialog component. A
Kanban card's own derived execution-state badge (`hooks/use-ceo-plan-run-badges.ts`) is described in
`0006-kanban-board.md`.

**A real bug found and fixed in Phase 15.1, worth calling out for future readers**: this section's
render/refresh gate was originally `planStatus !== "delegated"` (using the parent `CeoPlan`'s own
aggregate status) — but Phase 14's plan-progress reconciliation moves that status off `"delegated"`
the moment every delegated child task reaches a terminal status, which can happen while a Phase 15
execution run is still legitimately `running`/`paused`/`awaiting_intervention` (e.g. one step
permanently failed under `pauseOnAnyPermanentFailure: false` while sibling steps continue) — making
the entire section, including Pause/Cancel/Emergency-stop/Retry, silently disappear at exactly the
moment an operator would need it. The gate is now `links.length === 0` (was this plan ever
delegated, a fact that never changes once true) instead.

## Why authentication is still deferred

Unchanged from `0004-hall-core-server.md`: nothing in this system is reachable from outside
`127.0.0.1`. Phase 6 adds a second local-only process (the web app) talking to the first
(Hall Core) across two loopback ports, protected by an exact-origin allowlist — not by any identity
or credential system, because none of this is exposed to a network an untrusted party could reach.

## Why Hall Core remains local-only

Restated because Phase 6 is the first phase where "local-only" is actually visible to an end user
rather than just an internal implementation detail: the browser dashboard only ever talks to
`127.0.0.1:4310`, and Hall Core only ever accepts connections that arrive already on that same
loopback interface. There is no code path in this phase that binds either process to a non-loopback
address.
