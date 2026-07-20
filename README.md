# Hall of Wisdom

Hall of Wisdom is a cross-platform Agent OS and coding-agent orchestrator. It lets a user
coordinate multiple coding agents (Claude Code, OpenAI Codex, OpenCode, Google Antigravity,
Cursor, GitHub Copilot CLI, Cline, Goose, Junie, and future agents) on the same project without
the agents interfering with each other, while keeping each agent's own subscription credentials
local to the user's machine.

This repository is being built incrementally, one small phase at a time. See
[`docs/architecture/0001-initial-architecture.md`](docs/architecture/0001-initial-architecture.md)
for the current architecture and [`AGENTS.md`](AGENTS.md) / [`CLAUDE.md`](CLAUDE.md) for the
rules coding agents working in this repository must follow.

## Status

**Phase 9.1 — Claude Configuration Isolation and Authentication Output Hygiene.** Seven packages
now exist: `@hall-of-wisdom/protocol` (the wire contract), `@hall-of-wisdom/agent-adapter-sdk` (the
adapter contract), `@hall-of-wisdom/mock-agent` (the first, deterministic adapter),
`@hall-of-wisdom/claude-code-adapter` (Phase 9 — a real `AgentAdapter` that spawns the operator's
own locally-installed, subscription-authenticated Claude Code CLI, hardened in Phase 9.1 with
`--safe-mode`, no discretionary `--setting-sources`, and stricter authentication-output handling —
see [`docs/architecture/0008-claude-code-adapter.md`](docs/architecture/0008-claude-code-adapter.md)),
`@hall-of-wisdom/hall-runner` (a local CLI that runs one task and streams normalized events as JSON
Lines), `@hall-of-wisdom/hall-core` (a local Fastify HTTP + WebSocket server that creates and runs
tasks in memory, calling Hall Runner's public API in-process, with an exact-origin
CORS/WebSocket-Origin allowlist for the web app below, plus a General board and per-task discussion
boards for local human communication), and `@hall-of-wisdom/web` — a Next.js browser dashboard with
three pages: the Task Console (`/`, Phase 6, immediate task execution), the Kanban Board (`/board`,
Phase 7, planning tasks — Backlog → Ready → Assigned → In Progress → a terminal outcome — with
drag-and-drop and full keyboard-accessible equivalents), and Communication Boards (`/boards`, Phase
8, a General board plus one discussion board per task, with live WebSocket message delivery). No
authentication, persistence, agent-to-agent or agent-to-human messaging, Git integration, human
approval workflow, or Codex/other-provider integration exists yet.

## Requirements

- Node.js `>=24.11.0 <25`
- pnpm `10.33.0`
- Git

## Getting Started

PowerShell (Windows):

```powershell
pnpm install
pnpm typecheck
pnpm lint
pnpm format
pnpm test
pnpm build
```

Bash (Linux / macOS):

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm format
pnpm test
pnpm build
```

`typecheck`, `test`, and `build` run recursively (`pnpm -r`) across every workspace package, in
dependency order (pnpm's recursive commands are topologically sorted, so `protocol` always builds
before `agent-adapter-sdk`, which always builds before `mock-agent` — no chained/hard-coded build
order is needed); `lint` and `format` run once across the whole repository.

To verify a _built_ package resolves and behaves correctly through its public entry point (as an
external consumer would use it, not via `src`), after `pnpm build`:

```powershell
pnpm --filter @hall-of-wisdom/protocol run verify:package-entry
pnpm --filter @hall-of-wisdom/agent-adapter-sdk run verify:package-entry
pnpm --filter @hall-of-wisdom/mock-agent run verify:package-entry
pnpm --filter @hall-of-wisdom/hall-runner run verify:package-entry
pnpm --filter @hall-of-wisdom/hall-core run verify:package-entry
```

## Packages

| Package                                                           | Purpose                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@hall-of-wisdom/protocol`](packages/protocol)                   | Provider-neutral wire contract: agent identity, capabilities, tasks, agent runs, and normalized agent events, with Zod-backed runtime validation.                                                                                                                                  |
| [`@hall-of-wisdom/agent-adapter-sdk`](packages/agent-adapter-sdk) | The contract every coding-agent adapter implements: descriptors, detection results, task input, an event-sequencing factory, and a terminal-event guard. Depends only on `protocol`.                                                                                               |
| [`@hall-of-wisdom/mock-agent`](adapters/mock-agent)               | Deterministic, local-only, network-free `AgentAdapter` implementation used to develop and test Hall Runner/Hall Core without consuming real agent subscription usage.                                                                                                              |
| [`@hall-of-wisdom/claude-code-adapter`](adapters/claude-code)     | Real `AgentAdapter` that spawns your locally-installed, subscription-authenticated Claude Code CLI as a child process — never an API key, never cloud billing. See [`docs/architecture/0008-claude-code-adapter.md`](docs/architecture/0008-claude-code-adapter.md).               |
| [`@hall-of-wisdom/hall-runner`](runners/hall-runner)              | Local process/CLI: registers adapters via `AgentRegistry`, validates the workspace and working directory, runs one task through the generic `AgentAdapter` interface, and streams JSON Lines events.                                                                               |
| [`@hall-of-wisdom/hall-core`](apps/server)                        | Local Fastify HTTP + WebSocket server: creates and runs tasks in memory through Hall Runner's public API, streams normalized events over WebSocket with replay, hosts a General board and per-task discussion boards for local human communication, and binds to `127.0.0.1` only. |
| [`@hall-of-wisdom/web`](apps/web)                                 | Next.js browser dashboard: the Task Console (`/`) for immediate execution, the Kanban Board (`/board`) for planning tasks, and Communication Boards (`/boards`) for local discussion — talks to Hall Core directly (no proxy, no custom server); binds to `127.0.0.1` only.        |

## Running Hall Runner

Hall Runner is a CLI prototype. From `D:\HallOfWisdom` in PowerShell, after `pnpm install` and
`pnpm build`:

**Success scenario** (multiline):

```powershell
pnpm --filter @hall-of-wisdom/hall-runner run dev -- `
  --adapter hall.mock-agent `
  --workspace-root "D:\HallOfWisdom" `
  --working-directory "D:\HallOfWisdom" `
  --title "Hall Runner smoke test" `
  --scenario success
```

Single line:

```powershell
pnpm --filter @hall-of-wisdom/hall-runner run dev -- --adapter hall.mock-agent --workspace-root "D:\HallOfWisdom" --working-directory "D:\HallOfWisdom" --title "Hall Runner smoke test" --scenario success
```

**Failure scenario** (multiline):

```powershell
pnpm --filter @hall-of-wisdom/hall-runner run dev -- `
  --adapter hall.mock-agent `
  --workspace-root "D:\HallOfWisdom" `
  --working-directory "D:\HallOfWisdom" `
  --title "Hall Runner failure test" `
  --scenario failure
```

Single line:

```powershell
pnpm --filter @hall-of-wisdom/hall-runner run dev -- --adapter hall.mock-agent --workspace-root "D:\HallOfWisdom" --working-directory "D:\HallOfWisdom" --title "Hall Runner failure test" --scenario failure
```

**Cancellable scenario, verified manually in an interactive terminal** (this is the one scenario
that cannot be verified through automated tooling — see the note below):

```powershell
pnpm --filter @hall-of-wisdom/hall-runner run dev -- `
  --adapter hall.mock-agent `
  --workspace-root "D:\HallOfWisdom" `
  --working-directory "D:\HallOfWisdom" `
  --title "Hall Runner cancellation test" `
  --scenario cancellable `
  --step-delay-ms 500
```

Single line:

```powershell
pnpm --filter @hall-of-wisdom/hall-runner run dev -- --adapter hall.mock-agent --workspace-root "D:\HallOfWisdom" --working-directory "D:\HallOfWisdom" --title "Hall Runner cancellation test" --scenario cancellable --step-delay-ms 500
```

**To manually verify cancellation:**

1. Run the command above directly in a real PowerShell window (not through this automation, and
   not piped through another program — Ctrl+C needs an attached interactive console).
2. Wait until you see at least one JSON line printed (e.g. `run.started`).
3. Press **Ctrl+C once**.
4. Expect: one more JSON line with `"type":"run.cancelled"`, then the process exits.
5. Check the exit code: `echo $LASTEXITCODE` should print `130`.
6. Optionally, run it again and press Ctrl+C **twice in quick succession** to exercise the forced
   second-interrupt exit path instead of the graceful one.

This manual step exists because genuinely delivering a catchable Ctrl+C signal cannot be reliably
reproduced from scripted automation on Windows (see
[`docs/architecture/0003-hall-runner-boundary.md`](docs/architecture/0003-hall-runner-boundary.md)
for why) — the graceful-cancellation _logic_ itself is fully covered by the automated test suite
(which triggers the same code path via `process.emit("SIGINT", ...)`), but only a real keypress in
a real console proves the OS actually delivers the signal end to end.

Each run prints one JSON object per line to stdout (`run.started`, progress events, then exactly
one of `run.completed` / `run.failed` / `run.cancelled`) and exits with a matching code — `0`, `1`,
or `130` respectively; `2` for invalid input, `3` for an unexpected internal error. Diagnostics go
to stderr, never mixed into the JSON Lines stream. See
[`docs/architecture/0003-hall-runner-boundary.md`](docs/architecture/0003-hall-runner-boundary.md)
for the full exit-code policy and cancellation design.

## Running Hall Core

Hall Core is an HTTP + WebSocket server prototype, bound to `127.0.0.1` only. Start it in one
PowerShell window, then issue requests from a **second** PowerShell window (the server occupies the
first one while it's running).

**Success-scenario server:**

```powershell
pnpm --filter @hall-of-wisdom/hall-core run dev -- --workspace-root "D:\HallOfWisdom" --port 4310 --mock-scenario success
```

**Failure-scenario server:**

```powershell
pnpm --filter @hall-of-wisdom/hall-core run dev -- --workspace-root "D:\HallOfWisdom" --port 4310 --mock-scenario failure
```

**Cancellable-scenario server** (use a nonzero `--mock-step-delay-ms` to leave a window to cancel):

```powershell
pnpm --filter @hall-of-wisdom/hall-core run dev -- --workspace-root "D:\HallOfWisdom" --port 4310 --mock-scenario cancellable --mock-step-delay-ms 500
```

With a server running, from a **second** PowerShell window:

**Health check:**

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:4310/api/v1/health" -Method Get
```

**Create a task** (adapterId must match the server's registered adapter, `hall.mock-agent`):

```powershell
$body = @{ projectId = "demo-project"; title = "Manual verification task"; adapterId = "hall.mock-agent" } | ConvertTo-Json
$created = Invoke-RestMethod -Uri "http://127.0.0.1:4310/api/v1/tasks" -Method Post -Body $body -ContentType "application/json"
$created
```

**List tasks:**

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:4310/api/v1/tasks" -Method Get
```

**Read one task** (using the `taskId` from the create response above):

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:4310/api/v1/tasks/$($created.task.taskId)" -Method Get
```

**Cancel a task** (only meaningful against the cancellable-scenario server, before it finishes):

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:4310/api/v1/tasks/$($created.task.taskId)/cancel" -Method Post
```

Stop the server with Ctrl+C in its own window (first `SIGINT` requests a graceful shutdown —
cancelling any active runs and waiting, bounded, for them to settle; a second `SIGINT` forces an
immediate exit). See
[`docs/architecture/0004-hall-core-server.md`](docs/architecture/0004-hall-core-server.md) for the
full API, status-transition, event-sequencing, and shutdown design.

A task can also fail for reasons that are Hall Core's fault rather than the agent's — most notably
running out of its configured per-task event budget (`maxEventsPerTask`). These surface exactly
like any other failed task (`status: "failed"`, a `failure` object), but with a distinct code
(`EVENT_CAPACITY_REACHED` and similar, rather than `MOCK_EXECUTION_FAILED`) so a caller can tell
"the agent's work failed" apart from "Hall Core couldn't keep up." A WebSocket client that falls too
far behind the live event stream is disconnected with close code `4504` rather than silently
missing frames — reconnect with `?afterSequence=<lastReceivedSequence>` to replay whatever was
missed; nothing already stored is ever discarded on a slow client's account. See
[`docs/architecture/0004-hall-core-server.md`](docs/architecture/0004-hall-core-server.md), "Event-capacity
terminal handling" and "WebSocket backpressure policy", for the full design.

## Running Hall Web

Hall Web is a Next.js browser dashboard that talks to Hall Core directly from the browser — start
Hall Core first (with `--web-origin` matching where the dashboard will run), then the dashboard, in
two separate PowerShell windows.

**Terminal 1 — Hall Core** (success scenario):

```powershell
pnpm --filter @hall-of-wisdom/hall-core run dev -- `
  --workspace-root "D:\HallOfWisdom" `
  --port 4310 `
  --mock-scenario success `
  --web-origin "http://127.0.0.1:3000"
```

Failure scenario:

```powershell
pnpm --filter @hall-of-wisdom/hall-core run dev -- `
  --workspace-root "D:\HallOfWisdom" `
  --port 4310 `
  --mock-scenario failure `
  --web-origin "http://127.0.0.1:3000"
```

Cancellable scenario (use a nonzero `--mock-step-delay-ms` to leave a window to cancel):

```powershell
pnpm --filter @hall-of-wisdom/hall-core run dev -- `
  --workspace-root "D:\HallOfWisdom" `
  --port 4310 `
  --mock-scenario cancellable `
  --mock-step-delay-ms 500 `
  --web-origin "http://127.0.0.1:3000"
```

**Terminal 2 — Hall Web:**

```powershell
pnpm --filter @hall-of-wisdom/web run dev
```

Then open **http://127.0.0.1:3000** in a browser. Hall Web reads its Hall Core URL from
`NEXT_PUBLIC_HALL_CORE_URL`, defaulting safely to `http://127.0.0.1:4310` when unset — copy
[`apps/web/.env.local.example`](apps/web/.env.local.example) to `apps/web/.env.local` (gitignored,
never committed) only if you need to point it somewhere else.

**Production build and start**, from a second window once both are stopped:

```powershell
pnpm --filter @hall-of-wisdom/web run build
pnpm --filter @hall-of-wisdom/web run start
```

`start`, like `dev`, binds to `127.0.0.1:3000` explicitly — never `0.0.0.0`.

Stop Hall Web with Ctrl+C in its own window; it exits immediately (no in-process cleanup to wait
for, unlike Hall Core). Stop Hall Core with Ctrl+C in its own window as described above.

See [`docs/architecture/0005-minimal-web-interface.md`](docs/architecture/0005-minimal-web-interface.md)
for the full design: the CORS/WebSocket-Origin contract this depends on, the WebSocket
reconnect/close-code policy, URL configuration, and accessibility expectations.

### Switching scenarios requires restarting Hall Core

`--mock-scenario` is **server startup configuration**, not a per-task or per-request option — Mock
Agent is configured once, when the adapter is constructed at server startup, and every task Hall
Core runs for the rest of that process's lifetime uses that same scenario. There is no task title,
project ID, or other field that changes which scenario runs; the generic REST task contract and the
browser's task-creation form never expose a scenario field. To test a different scenario, stop Hall
Core (Ctrl+C) and start it again with a different `--mock-scenario` value. Because `TaskStore` and
`EventStore` are in-memory only (see `docs/architecture/0004-hall-core-server.md`, "In-memory
storage limitations"), **restarting Hall Core for any reason — including only to change the
scenario — discards every task and event it was holding.** Refresh the browser tab after restarting
Hall Core so Hall Web re-fetches its task list from the new, empty process rather than continuing to
show tasks that no longer exist server-side.

### WebSocket reconnect vs. Hall Core restart — two different things

These are easy to conflate but behave very differently:

- **Same-process reconnect** (Hall Core keeps running; only the browser's connection drops —
  a network blip, a laptop sleeping, DevTools "Offline" toggled on then off): Hall Web's
  `useTaskEvents` hook reconnects automatically with `afterSequence=<last accepted sequence>`,
  Hall Core replays whatever was stored in the meantime from its still-intact `EventStore`, and the
  task resumes streaming with no gap and no duplicate timeline entries. This is the reconnect
  behavior `docs/architecture/0005-minimal-web-interface.md` ("WebSocket replay and reconnect",
  "Close-code handling") describes.
- **Hall Core restart** (the process itself is stopped and started again — a new process, an empty
  `TaskStore`/`EventStore`): there is nothing to resume. A client still watching a task from the old
  process sees its connection drop abnormally (close code `1006`, since the old process is simply
  gone) and reconnects on its normal bounded backoff — expect to briefly see "Reconnecting…", and
  possibly "disconnected" with a manual Reconnect option if the restart takes longer than the retry
  budget. Only once the _new_ process is back up and a reconnect attempt actually reaches it does the
  task's real fate resolve: the new process has never heard of that task ID, so it closes with `4404`
  and the hook settles permanently into "This task no longer exists." — no further automatic retry,
  and no stale data is ever shown as if it were still live. **Restarting Hall Core never resumes a
  task; it only ever discards it**, eventually surfaced safely. Cross-process resume would require
  persisting `TaskStore`/`EventStore` to disk, which is explicitly out of scope for this prototype
  (`docs/architecture/0004-hall-core-server.md`, "Why persistence is deferred").

**Valid manual reconnect test** (keeps Hall Core running the whole time):

1. Start Hall Core with the cancellable scenario and a long step delay so there's a window to test
   within:
   ```powershell
   pnpm --filter @hall-of-wisdom/hall-core run dev -- `
     --workspace-root "D:\HallOfWisdom" `
     --port 4310 `
     --mock-scenario cancellable `
     --mock-step-delay-ms 1000 `
     --web-origin "http://127.0.0.1:3000"
   ```
2. Start Hall Web (`pnpm --filter @hall-of-wisdom/web run dev`) and open `http://127.0.0.1:3000`.
3. Create a task and wait until at least one event appears in the timeline.
4. Open the browser's DevTools, and set Network conditions to **Offline** for a few seconds — do
   **not** stop Hall Core.
5. Restore Network to **Online**.
6. Confirm the connection status shows "Reconnecting…", then confirm it reconnects.
7. Confirm any events that happened while offline appear with no gap and no duplicate entries.
8. Confirm the task still eventually reaches its terminal state (complete it, or cancel it).

(If DevTools "Offline" also blocks all localhost traffic in your browser, that's expected and still
a valid test — the point is that Hall Core's process itself is never stopped.)

**Separate restart-behavior test** (confirms data loss is real and handled safely, not that anything
resumes):

1. With a task selected in Hall Web, stop Hall Core (Ctrl+C).
2. Start Hall Core again (any scenario).
3. Confirm the server status header returns to "Online".
4. The task's connection status will briefly show "Reconnecting…" (and possibly "disconnected" with
   a manual Reconnect button, if the restart took longer than the automatic retry window) — this is
   expected while the client is still trying against the process that's now gone.
5. **Do not** expect the previously selected task to still be there — confirm it does not resume.
6. Once a reconnect attempt reaches the new process, confirm Hall Web settles into reporting the old
   task as unavailable ("This task no longer exists.") rather than retrying indefinitely or showing
   stale data as if it were live.

## Running the Kanban Board

The Kanban Board (`/board`) shares the same Hall Core process and the same two-terminal setup as
Hall Web above — no extra flags, no extra terminal.

**Terminal 1 — Hall Core:**

```powershell
pnpm --filter @hall-of-wisdom/hall-core run dev -- `
  --workspace-root "D:\HallOfWisdom" `
  --port 4310 `
  --mock-scenario success `
  --web-origin "http://127.0.0.1:3000"
```

**Terminal 2 — Hall Web:**

```powershell
pnpm --filter @hall-of-wisdom/web run dev
```

**Walkthrough** (browser, `http://127.0.0.1:3000/board`):

1. Start Hall Core and Hall Web as above, then open `http://127.0.0.1:3000/board`.
2. Click **"Kanban Board"** in the top navigation (or go directly to `/board`) — confirm all 10
   columns render: Backlog, Ready, Assigned, In Progress, Agent Review, Human Approval, Blocked,
   Completed, Failed, Cancelled.
3. Click **"+ New backlog task"**, fill in Project and Title, and submit — confirm a new card
   appears in Backlog.
4. Drag the card from Backlog to Ready (or use its Actions menu → "Move to Ready").
5. On the Ready card, open Actions → **"Assign agent"** — in the dialog, select Mock Agent, leave
   the working directory blank, and click Assign — confirm the card moves to Assigned.
6. Click **"Start task"** on the Assigned card, confirm the "Start this task…" prompt, click
   Confirm.
7. Confirm the card briefly shows "Starting…" (no Start button, no Actions menu) until it reaches
   In Progress.
8. Wait for the card to reach Completed.
9. Create another backlog task, move it to Blocked (drag or Actions menu), then back to Ready.
10. Create a third backlog task and use its Actions menu → "Cancel task" — confirm it moves to
    Cancelled without ever creating a run.
11. Verify keyboard-only operation: `Tab` to a card's "Actions" button, press `Enter` to open the
    action list, `Tab` to the item you want (these are ordinary buttons, not an ARIA menu — there is
    no arrow-key navigation), press `Enter` to choose it — confirm the same moves work with no mouse
    involved, and that focus lands back on a sensible control afterward.

To exercise a failure or a cancellable-while-running scenario, stop Hall Core and restart it with
`--mock-scenario failure` or `--mock-scenario cancellable --mock-step-delay-ms 1000` (see "Switching
scenarios requires restarting Hall Core" above), then repeat the assign/start steps.

See [`docs/architecture/0006-kanban-board.md`](docs/architecture/0006-kanban-board.md) for the full
design: the column/status mapping, why drag can never start execution on its own, the accessible
non-drag controls, the dnd-kit boundary, and the polling strategy.

## Running Communication Boards

Communication Boards (`/boards`) share the same Hall Core process and the same two-terminal setup
as Hall Web above — no extra flags, no extra terminal. All in-memory data (boards and messages) is
cleared whenever Hall Core restarts — see step 9 below.

**Terminal 1 — Hall Core:**

```powershell
pnpm --filter @hall-of-wisdom/hall-core run dev -- `
  --workspace-root "D:\HallOfWisdom" `
  --port 4310 `
  --mock-scenario success `
  --web-origin "http://127.0.0.1:3000"
```

**Terminal 2 — Hall Web:**

```powershell
pnpm --filter @hall-of-wisdom/web run dev
```

**Walkthrough** (browser):

1. Start Hall Core and Hall Web as above.
2. Open `http://127.0.0.1:3000` and confirm Hall Web is reachable (server status shows "Online" in
   the top bar).
3. Click **"Communication Boards"** in the top navigation (or go directly to
   `http://127.0.0.1:3000/boards`) — confirm the **General** board is selected by default and its
   message history loads (empty at first: "No messages yet. Start the discussion.").
4. Type a message in the composer (e.g. "Hello from General") and click **Send** — confirm it
   appears in the message list with your author name ("Local Operator") and a timestamp, and that
   the composer clears on success.
5. Go to `http://127.0.0.1:3000/board`, create a backlog task (or use an existing one), open its
   Actions menu, and click **"Open discussion"** — confirm you're navigated to `/boards` with that
   task's discussion board selected (a fresh board, "No messages yet.").
6. Send a message in this task's discussion (e.g. "Notes for this task") — confirm it appears only
   in this board's history, not in General's (switch back to General to confirm the two boards'
   messages never cross).
7. Go back to `/board`, open the **same** task's Actions menu again, and click **"Open discussion"**
   a second time — confirm you land on the identical board (same message still there, board count in
   the board list unchanged) rather than a second board being created for the same task.
8. **Reconnect test** (keeps Hall Core running the whole time): with a board open and its status
   showing "Live", open DevTools and set Network conditions to **Offline** for a few seconds, then
   restore **Online** — confirm the status briefly shows "Reconnecting…" then "Live" again, and that
   no messages are duplicated or lost.
9. **Restart data-loss test**: stop Hall Core (Ctrl+C in Terminal 1), start it again with the same
   command, then click **Refresh** in the board list (or reload the page) — confirm only a fresh,
   empty General board remains (`0` messages) and the task discussion board from steps 5–7 is gone.
   This is expected: Communication Boards, like tasks and events, are in-memory only and do not
   survive a Hall Core restart.
10. **Keyboard-only verification**: `Tab` to a board in the board list and press `Enter`/`Space` to
    select it (confirm the selection is visible and announced); `Tab` into the message composer,
    type a message, and press **Ctrl+Enter** (or **Cmd+Enter** on macOS) to send without touching the
    mouse — confirm the message sends and focus remains sensible afterward.

See [`docs/architecture/0007-communication-boards.md`](docs/architecture/0007-communication-boards.md)
for the full design: the board/message model, capacity limits, the REST and WebSocket contracts,
the replay/at-least-once delivery guarantee, and why editing, deletion, agent messaging, and
persistence remain deferred.

## Running the Claude Code Adapter

The Claude Code adapter (`@hall-of-wisdom/claude-code-adapter`) spawns your own locally-installed,
subscription-authenticated Claude Code CLI as a real child process — never an API key, never a
cloud-billing source. See [`docs/architecture/0008-claude-code-adapter.md`](docs/architecture/0008-claude-code-adapter.md)
for the full design. Steps 1–2 below never spend any usage; steps 10–11 spend one real, billed
Claude Code invocation each — do not repeat them casually.

**1. Check the installed CLI version (no usage spent):**

```powershell
claude --version
```

**2. Check authentication status safely (no usage spent).** This prints your account email, org ID,
and org name — **do not paste this output anywhere it could be shared** (a report, a commit, a
chat log). Only its safe classification (installed / subscription-verified yes-or-no) belongs
anywhere outside your own terminal:

```powershell
claude auth status
```

**3. Build the adapter package:**

```powershell
pnpm --filter @hall-of-wisdom/claude-code-adapter run build
```

**4. Run the adapter's deterministic test suite** (no real Claude Code invocation — a fake process
supervisor drives every test):

```powershell
pnpm --filter @hall-of-wisdom/claude-code-adapter run test
```

**5. Typecheck and lint the adapter package:**

```powershell
pnpm --filter @hall-of-wisdom/claude-code-adapter run typecheck
pnpm --filter @hall-of-wisdom/claude-code-adapter run lint
```

**6. Verify the package resolves correctly through its public entry point** (does not spawn any
real task):

```powershell
pnpm --filter @hall-of-wisdom/claude-code-adapter run verify:package-entry
```

**7. Start Hall Core with both adapters registered** (Claude Code registers unconditionally — no
extra flag needed; it simply reports whatever `detect()` finds):

```powershell
pnpm --filter @hall-of-wisdom/hall-core run dev -- `
  --workspace-root "D:\HallOfWisdom" `
  --port 4310
```

**8. Confirm both adapters are listed**, in a second terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:4310/api/v1/adapters | ConvertTo-Json -Depth 5
```

Expect both `hall.mock-agent` and `hall.claude-code` in the `adapters` array. Confirm the response
contains no `executablePath` or `diagnosticMessage` field anywhere.

**9. Confirm Claude Code's reported availability matches your real auth state**: `"available"` only
if step 2 showed a verified Pro/Max/Team/Enterprise subscription login; `"logged_out"` if not logged
in; `"unavailable"` if the CLI isn't installed or couldn't be resolved to a native executable.

**10. Create an isolated fixture — never the Hall of Wisdom source tree** — and run one real,
isolated task through the actual adapter (spends one real Claude Code invocation):

```powershell
New-Item -ItemType Directory -Force "D:\HallOfWisdom\.tmp\claude-adapter-smoke" | Out-Null
Set-Content "D:\HallOfWisdom\.tmp\claude-adapter-smoke\greeting.txt" "hello"
```

Then, with Hall Core (step 7) and Hall Web (`pnpm --filter @hall-of-wisdom/web run dev`) both
running, open `http://127.0.0.1:3000/board`, create a backlog task with **Working directory** set to
`.tmp/claude-adapter-smoke` and a description asking for a small, verifiable edit to
`greeting.txt`, move it to Ready, use **Assign agent** to assign **Claude Code**, then click
**Start task** and confirm. Watch the card move through Assigned → In Progress → Completed while
normalized events stream in over the task-events WebSocket.

**11. Confirm the real edit actually happened:**

```powershell
Get-Content "D:\HallOfWisdom\.tmp\claude-adapter-smoke\greeting.txt"
```

**12. Clean up** — delete the fixture, and confirm no `claude.exe` process (beyond your own
interactive session, if any) or lingering Hall Core/Hall Web `node.exe` process remains:

```powershell
Remove-Item -Recurse -Force "D:\HallOfWisdom\.tmp\claude-adapter-smoke"
Get-Process claude -ErrorAction SilentlyContinue | Select-Object Id, ProcessName
```

**13. Confirm Communication Boards were unaffected** by the real task run: open
`http://127.0.0.1:3000/boards` and confirm the **General** board's message count is unchanged from
before step 10 — a Claude Code task never posts to a Communication Board.

## Full workspace verification

```powershell
pnpm install
pnpm typecheck
pnpm lint
pnpm format
pnpm test
pnpm build
```

`typecheck`/`test`/`build` run recursively across all seven packages (including `apps/web`'s own
`next build` for production output and `vitest run` for its component/hook/library test suite);
`lint`/`format` run once across the whole repository.

## Repository Layout (current)

```
hall-of-wisdom/
  packages/
    protocol/            @hall-of-wisdom/protocol - shared communication contract
    agent-adapter-sdk/   @hall-of-wisdom/agent-adapter-sdk - adapter contract
  adapters/
    mock-agent/            @hall-of-wisdom/mock-agent - deterministic, network-free adapter
    claude-code/            @hall-of-wisdom/claude-code-adapter - real, subscription-authenticated
                            Claude Code CLI adapter
  runners/
    hall-runner/            @hall-of-wisdom/hall-runner - local task runner CLI
  apps/
    server/                 @hall-of-wisdom/hall-core - HTTP + WebSocket server
    web/                    @hall-of-wisdom/web - Next.js browser dashboard
  docs/architecture/      architecture decision records
  AGENTS.md               rules for coding agents working in this repo
  CLAUDE.md                rules for Claude Code specifically
  README.md               this file
```

Future phases will add more `packages/` (database, source-control, work-management) and more
`adapters/` (Codex, ...) as each becomes necessary. See the architecture documents for the full
planned layout and the Phase 3/4/5/6/7/8/9 boundary decisions.
