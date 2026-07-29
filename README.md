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

**Phase 11.1 — Requirement-Safe Manual Assignment, CLI Argument Forwarding and Browser
Verification**, hardening Phase 11 (**Agent Capability Catalog, Trust Comparison and Safe
Routing**). Hall Core reports a provider-neutral capability vocabulary (`project.read`,
`project.edit`, `command.execute`, `git.inspect`, `structured.events`, `cancellation`,
`session.resume`, `network.access`) and an execution-trust classification (`simulated` / `isolated`
/ `trusted_local` / `unavailable`) for every registered adapter, distinguishing what an adapter was
designed to support (`declaredCapabilities`) from what Hall has actually, currently verified on this
machine (`capabilityObservations`). A deterministic (non-AI) routing policy can recommend a suitable
adapter for a task's stated capability and trust requirements — read-only analysis plus one explicit
"route and assign" action. **Manual assignment (`POST .../assign`) now enforces the same
requirements**: an adapter that does not satisfy a task's current capability/trust requirements is
rejected (`409 ADAPTER_REQUIREMENTS_MISMATCH`), whether it's a first assignment or a
reassignment-before-start; a task with no requirements is completely unaffected. Starting a run
remains a separate, always-manual step, unchanged from every prior phase. See the new `/agents`
page, the Kanban board's "Find suitable agent" and "Assign agent" dialogs, and
[`docs/architecture/0011-agent-capabilities-trust-and-routing.md`](docs/architecture/0011-agent-capabilities-trust-and-routing.md)
for the full design — including the pnpm `--` CLI-argument-forwarding fix (the documented
`pnpm ... run dev -- --flag` startup commands below are now verified working) and the new
Playwright-based E2E verification suite (`apps/e2e`, no Chrome-extension dependency).

**Phase 12 — Controlled Multi-Agent Execution Comparison**, hardened by **Phase 12.1 — Task-Scoped
Source Repository Resolution**. An operator can give the same task to two different adapters and
compare their results side by side, in separate, reproducible Git worktrees created at the identical
base commit — no shared writable workspace, no automatic parallel execution (starting a candidate is
explicit and sequential, one at a time), no AI judge, no automatic winner, no merge/commit/push.
Optional at startup (`--comparison-root`, off by default); when enabled, `/comparisons` lists and
drives comparisons (create, prepare, start each candidate, view changed files and a bounded diff,
cancel, an optional non-binding preference note, and clean up), and a new "Compare agents" Kanban
action opens the create dialog for a Ready task. A comparison's source repository is always resolved
from its source task's own stored working directory — `--workspace-root` is a trusted security
boundary, not itself the repository; it need not be a Git repository and may be dirty, so an
operator's real, uncommitted development work sitting alongside a task's own clean repository never
blocks a comparison. See
[`docs/architecture/0012-controlled-agent-comparison.md`](docs/architecture/0012-controlled-agent-comparison.md)
for the full design, including a real cleanup/finalization race and the source-repository-resolution
defect, both found and fixed during this feature's own development. **A single, explicitly authorized
real comparison has been run** — one genuine Claude Code (isolated) invocation and one genuine Codex
(trusted-local) invocation, zero retries, both completed successfully with independent, correct
results and no automatic winner; see that document's "Real Claude Code + Codex comparison" section.
No further real-provider execution is needed or authorized for this feature.

**Phase 13 — Durable State Persistence and Restart Recovery** (with follow-ups **13.1** and
**13.2**). Every Hall Core store still defaults to in-memory, exactly as before; an operator can now
opt in to a SQLite-backed durable mode (`--data-dir`, off by default) so tasks, events, boards,
messages, and comparisons survive a restart. The in-memory and SQLite backends for every store
implement the same port interface and are exercised by the same contract tests. A restart-recovery
pass runs on every durable boot, reconciling any run an unclean shutdown left non-terminal into
exactly one synthetic "interrupted" failure — never an automatic resume or retry against a real
provider — and classifies every comparison candidate's worktree health without ever auto-deleting
anything. A new `/system` page and `GET /api/v1/system/storage` route report storage mode, schema
version, and a bounded recovery summary. **13.1** added exclusive single-instance ownership of a
`--data-dir` (a filesystem lock — see "A `--data-dir` is exclusively owned..." below), a mandatory
`pnpm verify:process-recovery` real-process test suite, and a genuine browser-driven durable-restart
Playwright spec. **13.2** added a second, database-level ownership fence — closing the one gap
13.1's filesystem lock alone could not (a _frozen_, not crashed, former owner resuming and writing
after a legitimate takeover) — plus a second Playwright spec proving a full multi-agent comparison
can be genuinely restarted and continued, both candidates started via real UI clicks. See
[`docs/architecture/0013-durable-persistence-and-recovery.md`](docs/architecture/0013-durable-persistence-and-recovery.md)
for the full design.

Eight packages now exist:
`@hall-of-wisdom/protocol` (the wire contract), `@hall-of-wisdom/agent-adapter-sdk`
(the adapter contract), `@hall-of-wisdom/mock-agent` (the first, deterministic adapter),
`@hall-of-wisdom/claude-code-adapter` (Phase 9 — a real `AgentAdapter` that spawns the operator's own
locally-installed, subscription-authenticated Claude Code CLI, hardened in Phase 9.1 with
`--safe-mode`, no discretionary `--setting-sources`, and stricter authentication-output handling —
see [`docs/architecture/0008-claude-code-adapter.md`](docs/architecture/0008-claude-code-adapter.md)),
`@hall-of-wisdom/codex-adapter` (Phase 10 — a real `AgentAdapter` that spawns the operator's own
locally-installed, ChatGPT-authenticated Codex CLI; message and command-execution event mapping are
verified live over stdout only (Phase 10.1 removed stderr from the JSONL parsing path entirely)).
**By default, `detect()` still never reports Codex as available** — it reports `unsupported` with a
fixed diagnostic, since Phase 10.1's free, live Windows-sandbox diagnosis found the local sandbox
helper's dedicated restricted account is denied write access to the operator's own directories.
Phase 10.2 adds an explicitly opt-in **trusted-local mode** (`--enable-codex-trusted-local` at Hall
Core startup, default off) that reproduces Paperclip's own working Codex execution path — Codex's
internal sandbox/approval enforcement is bypassed, not fixed, and this is never the default — see
[`docs/architecture/0009-codex-adapter.md`](docs/architecture/0009-codex-adapter.md) and
[`docs/architecture/0010-paperclip-compatible-codex-mode.md`](docs/architecture/0010-paperclip-compatible-codex-mode.md).
Phase 10.3 hardened `detect()` against a transient cold-start flake observed during real
verification: the `--version` probe now gets exactly one bounded retry on a spawn failure or
timeout (never on any other failure kind), and concurrent `detect()` callers coalesce into a single
in-flight detection rather than each starting an independent spawn sequence — see
[`docs/architecture/0009-codex-adapter.md`](docs/architecture/0009-codex-adapter.md), "Phase 10.3 —
Bounded detection retry and in-flight coalescing",
`@hall-of-wisdom/hall-runner` (a local CLI that runs one task and streams normalized events as JSON
Lines), `@hall-of-wisdom/hall-core` (a local Fastify HTTP + WebSocket server that creates and runs
tasks in memory, calling Hall Runner's public API in-process, with an exact-origin
CORS/WebSocket-Origin allowlist for the web app below, plus a General board and per-task discussion
boards for local human communication), and `@hall-of-wisdom/web` — a Next.js browser dashboard with
three pages: the Task Console (`/`, Phase 6, immediate task execution), the Kanban Board (`/board`,
Phase 7, planning tasks — Backlog → Ready → Assigned → In Progress → a terminal outcome — with
drag-and-drop and full keyboard-accessible equivalents), and Communication Boards (`/boards`, Phase
8, a General board plus one discussion board per task, with live WebSocket message delivery), plus
a fourth `/system` page (Phase 13) reporting storage mode and restart-recovery status. No
authentication, agent-to-agent or agent-to-human messaging, Git integration, or human approval
workflow exists yet; state persistence across a restart is optional (`--data-dir`, off by default —
see "Enabling durable state persistence (Phase 13)" below) rather than always-on.

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
pnpm --filter @hall-of-wisdom/claude-code-adapter run verify:package-entry
pnpm --filter @hall-of-wisdom/codex-adapter run verify:package-entry
pnpm --filter @hall-of-wisdom/hall-runner run verify:package-entry
pnpm --filter @hall-of-wisdom/hall-core run verify:package-entry
```

## Packages

| Package                                                           | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@hall-of-wisdom/protocol`](packages/protocol)                   | Provider-neutral wire contract: agent identity, capabilities, tasks, agent runs, and normalized agent events, with Zod-backed runtime validation.                                                                                                                                                                                                                                                                                                                         |
| [`@hall-of-wisdom/agent-adapter-sdk`](packages/agent-adapter-sdk) | The contract every coding-agent adapter implements: descriptors, detection results, task input, an event-sequencing factory, and a terminal-event guard. Depends only on `protocol`.                                                                                                                                                                                                                                                                                      |
| [`@hall-of-wisdom/mock-agent`](adapters/mock-agent)               | Deterministic, local-only, network-free `AgentAdapter` implementation used to develop and test Hall Runner/Hall Core without consuming real agent subscription usage.                                                                                                                                                                                                                                                                                                     |
| [`@hall-of-wisdom/claude-code-adapter`](adapters/claude-code)     | Real `AgentAdapter` that spawns your locally-installed, subscription-authenticated Claude Code CLI as a child process — never an API key, never cloud billing. See [`docs/architecture/0008-claude-code-adapter.md`](docs/architecture/0008-claude-code-adapter.md).                                                                                                                                                                                                      |
| [`@hall-of-wisdom/codex-adapter`](adapters/codex)                 | Real `AgentAdapter` that spawns your locally-installed, ChatGPT-authenticated Codex CLI as a child process — never an API key, never an access token. File-editing capability is an unresolved, disclosed gap. See [`docs/architecture/0009-codex-adapter.md`](docs/architecture/0009-codex-adapter.md).                                                                                                                                                                  |
| [`@hall-of-wisdom/hall-runner`](runners/hall-runner)              | Local process/CLI: registers adapters via `AgentRegistry`, validates the workspace and working directory, runs one task through the generic `AgentAdapter` interface, and streams JSON Lines events.                                                                                                                                                                                                                                                                      |
| [`@hall-of-wisdom/hall-core`](apps/server)                        | Local Fastify HTTP + WebSocket server: creates and runs tasks (in memory by default, optionally SQLite-backed and restart-durable via `--data-dir`, Phase 13) through Hall Runner's public API, streams normalized events over WebSocket with replay, hosts a General board and per-task discussion boards for local human communication, optionally drives two-adapter Git-worktree-isolated comparisons (Phase 12, `--comparison-root`), and binds to `127.0.0.1` only. |
| [`@hall-of-wisdom/web`](apps/web)                                 | Next.js browser dashboard: the Task Console (`/`) for immediate execution, the Kanban Board (`/board`) for planning tasks, Communication Boards (`/boards`) for local discussion, and System (`/system`) for storage mode and restart-recovery status — talks to Hall Core directly (no proxy, no custom server); binds to `127.0.0.1` only.                                                                                                                              |
| [`@hall-of-wisdom/e2e`](apps/e2e)                                 | Phase 11.1 — Playwright end-to-end verification against a deterministic, fixture-adapter Hall Core (`src/fixture-server.ts`, built from Hall Core's own public package entry) and the real Hall Web dev server; never a real Claude Code/Codex process, never any subscription usage.                                                                                                                                                                                     |

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

## Running the Agents Catalog and Safe Routing

The Agents catalog (`/agents`) and the Kanban board's "Find suitable agent" dialog share the same
Hall Core process and the same two-terminal setup as Hall Web above — no extra flags, no extra
terminal, and no real Claude Code/Codex process is required (this walkthrough uses only Mock Agent,
which never spends any usage).

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

1. Open `http://127.0.0.1:3000/agents` — confirm every registered adapter is listed (at minimum
   Mock Agent, plus Claude Code/Codex if installed) with its `executionTrust` value shown exactly
   (never softened — Codex's trusted-local mode, if enabled, must read `trusted_local`, never
   `isolated`), and confirm the page never renders an executable path, account identifier,
   environment variable, cost, or token figure.
2. Go to `http://127.0.0.1:3000/board`, create a backlog task, and move it to Ready.
3. On the Ready card, open Actions → **"Find suitable agent"** — confirm the dialog runs a read-only
   analysis automatically (no confirmation needed to view it) and shows a candidate table with each
   adapter's execution trust, rank, and a plain-language reason.
4. Leave the default "Real editing, isolated execution" profile selected — confirm Mock Agent (which
   is always `simulated`) is **excluded** with a reason referencing execution trust, and Claude Code
   is recommended if installed and available.
5. Switch the profile to **"Simulation / dry run"** — confirm the analysis re-runs automatically and
   Mock Agent is now recommended.
6. Click **"Route and assign"** — confirm the card moves to Assigned, and confirm via the task's
   detail view that it shows `0` events and no run ID (assigning never starts a run).
7. Open the assigned task's detail view — confirm it shows the required capabilities and allowed
   execution trust that were actually used, plus the assigned execution trust snapshot.
8. Close the "Find suitable agent" dialog on a different task (Close button, then Escape) without
   ever clicking "Route and assign" — confirm no assignment happens either way.
9. **Keyboard-only verification**: `Tab` to a Ready card's Actions button, open it with `Enter`,
   `Tab` to "Find suitable agent" and open it with `Enter`, `Tab` through the profile picker and the
   candidate table to "Route and assign", and confirm the same flow works with no mouse involved and
   focus returns to a sensible control after closing.
10. **Requirement-safe manual assignment (Phase 11.1)**: on the now-Assigned task from step 6, open
    Actions → **"Return to Ready"** (an `assigned` task's own Actions menu never offers "Assign
    agent" directly — this is the real path back to it), then Actions → **"Assign agent"** — confirm
    the dialog shows the task's required capabilities and allowed execution trust, and that any
    adapter which doesn't satisfy them (e.g. Mock Agent, if `simulated` isn't in the allow list) is
    disabled with a visible, safe reason. Pick a compatible adapter and submit — confirm it succeeds
    with no run created. If you want to see the rejection path, use your browser's devtools to
    resubmit with an incompatible `adapterId` (or simply trust the automated test suite here) —
    confirm the dialog stays open, shows "The selected adapter does not satisfy this task's
    requirements.", and does not move the task.

See [`docs/architecture/0011-agent-capabilities-trust-and-routing.md`](docs/architecture/0011-agent-capabilities-trust-and-routing.md)
for the full design: the capability/trust vocabulary, the deterministic routing policy and its
tie-break order, the eight dichotomies this phase tracks, why routing never starts execution, and
requirement-safe manual assignment (Phase 11.1).

## Running the Playwright E2E Suite (Phase 11.1)

Genuine, headless-browser end-to-end verification of everything in the walkthrough above — no Chrome
extension required. `apps/e2e` is a separate package with its own `@playwright/test` devDependency;
it drives a real Chromium browser against the real Hall Web dev server and a separate, deterministic
fixture Hall Core (`apps/e2e/src/fixture-server.ts` — built entirely from `@hall-of-wisdom/hall-core`'s
own public package entry, never `server.ts` or any real composition path). Every fixture adapter's
`startTask()` rejects unconditionally — no real Claude Code/Codex process is ever started, and no
subscription usage is ever spent.

**One-time setup** (downloads a headless Chromium browser, ~200 MB):

```powershell
pnpm install
pnpm --filter @hall-of-wisdom/e2e run build
pnpm --filter @hall-of-wisdom/e2e run e2e:install
```

**Run the suite** (starts both servers itself, on the normal default ports 3000/4310, and tears them
down when finished):

```powershell
pnpm --filter @hall-of-wisdom/e2e run e2e
```

Covers: the Agents catalog (execution trust values, trusted-local warning, no sensitive data, a
390×844 mobile viewport with no horizontal overflow), the full routing workflow (recommend/exclude,
close-without-assigning, explicit route-and-assign, no run created), requirement-safe manual
assignment (incompatible adapters disabled with a safe reason, compatible reassignment), the
trusted-local-allowed ranking (isolated ranked ahead of trusted-local), keyboard-only operation, and
console cleanliness. After a run, confirm ports 3000/4310 are free again — Playwright's own teardown
does this automatically; if a run is interrupted, stop any lingering `node` process manually.

**Phase 13.1 — genuine durable browser restart** (`tests/durable-restart.spec.ts`, included in the
same `e2e` run above): spawns its own dedicated, real `dist/server.js` Hall Core binary and its own
dedicated real Hall Web dev server — on their own ports (4395/3095), entirely separate from the
shared fixture pair above — so it can stop and restart Hall Core mid-test while Hall Web and the
browser stay open, without touching the shared suite's process lifecycle at all. Requires
`pnpm --filter @hall-of-wisdom/hall-core run build` to have been run first (the same requirement
`pnpm verify:process-recovery` below has); `requireDurableRestartBuildArtifacts()` throws a clear,
actionable error rather than hanging or failing obscurely if it hasn't been. Drives the full
task/board/comparison lifecycle, a graceful restart, and verifies every piece of state survived —
see [`docs/architecture/0013-durable-persistence-and-recovery.md`](docs/architecture/0013-durable-persistence-and-recovery.md),
"Testing," item 5, for the exact workflow and two disclosed adaptations (Mock Agent is the only
adapter the real binary can safely, deterministically run to completion; Codex isn't even
selectable in the real "Compare agents" dialog).

**Phase 13.2 — genuine durable comparison restart, both candidates genuinely started**
(`tests/dual-fixture-durable-restart.spec.ts`, also included in the same `e2e` run above): closes
exactly the gap the spec above discloses, using `apps/e2e`'s own durable-capable fixture composition
(`fixture-server.ts`, two genuinely-completing comparison fixture adapters — never a production CLI
flag) instead of the real binary, so it can genuinely click "Start" on _both_ comparison candidates —
one before a durable restart, one after it — and confirm both complete with correctly isolated event
streams. Requires `pnpm --filter @hall-of-wisdom/e2e run build` to have been run first;
`requireDualFixtureDurableRestartBuildArtifacts()` throws the same kind of clear, actionable error if
it hasn't. See the same document, "Testing," item 6, for the full flow and a real Windows
short-path-vs-long-path bug found and fixed while building it.

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

## Running the Codex Adapter

The Codex adapter (`@hall-of-wisdom/codex-adapter`) spawns your own locally-installed,
ChatGPT-authenticated Codex CLI as a real child process — never an API key, never an access token.
See [`docs/architecture/0009-codex-adapter.md`](docs/architecture/0009-codex-adapter.md) for the
full design.

**By default (strict mode), Codex is never assignable through Hall Web.** `detect()` always reports
it as `unsupported` (never `available`), with the fixed diagnostic "Codex file-edit execution is not
verified in the current sandbox." — regardless of how your CLI/ChatGPT-auth state looks. This is
intentional, fail-closed capability accuracy, not a bug: Phase 10's real task executions never
successfully modified a file, and Phase 10.1's free (no-model) Windows-sandbox diagnosis found the
likely root cause — the local sandbox helper runs commands under a dedicated, low-privilege Windows
account (`CodexSandboxOffline`) that is explicitly denied write access to directories owned by your
own account. Steps 1–9 below (detection, build, test, typecheck, lint, adapter-listing) never spend
any usage and remain useful for verifying the adapter itself.

**Phase 10.2 adds an explicitly opt-in trusted-local mode** that makes Codex assignable — see
"Enabling trusted-local mode" below before continuing to steps 10+, which otherwise describe a flow
that is not reachable in strict mode.

**1. Check the installed CLI version (no usage spent):**

```powershell
codex --version
```

**2. Check authentication status safely (no usage spent).** This prints a short status line — if it
ever includes an account or workspace identifier, **do not paste that output anywhere it could be
shared** (a report, a commit, a chat log). Only its safe classification (installed /
ChatGPT-verified yes-or-no) belongs anywhere outside your own terminal:

```powershell
codex login status
```

**3. Signing in with ChatGPT (if step 2 shows you're not signed in):**

```powershell
codex login
```

Follow the interactive device/browser flow. **Do not** use `--with-api-key` or
`--with-access-token` — this adapter rejects both.

**4. Recognizing API-key authentication as unsupported.** If `codex login status` (or `codex doctor
--json`'s `auth.credentials.details["stored auth mode"]`, if you inspect it yourself) shows an
API-key or access-token login rather than ChatGPT, this adapter will report Codex as `unsupported`,
never `available` — this is intentional; sign out and sign back in with `codex login` (step 3) to
use your ChatGPT subscription instead.

**5. Build the adapter package:**

```powershell
pnpm --filter @hall-of-wisdom/codex-adapter run build
```

**6. Run the adapter's deterministic test suite** (no real Codex invocation — a fake process
supervisor drives every test):

```powershell
pnpm --filter @hall-of-wisdom/codex-adapter run test
```

**7. Typecheck and lint the adapter package:**

```powershell
pnpm --filter @hall-of-wisdom/codex-adapter run typecheck
pnpm --filter @hall-of-wisdom/codex-adapter run lint
```

**8. Start Hall Core with all three adapters registered** (Codex registers unconditionally — no
extra flag needed; it simply reports whatever `detect()` finds):

```powershell
pnpm --filter @hall-of-wisdom/hall-core run dev -- `
  --workspace-root "D:\HallOfWisdom" `
  --port 4310
```

**9. Confirm all three adapters are listed**, in a second terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:4310/api/v1/adapters | ConvertTo-Json -Depth 5
```

Expect `hall.mock-agent`, `hall.claude-code`, and `hall.codex` in the `adapters` array. Confirm the
response contains no `executablePath` or `CODEX_HOME` anywhere. **Codex's `availability` will be
`"unsupported"` regardless of your ChatGPT auth state** (see the Phase 10.1 note above) — this is
expected, not a sign that something is misconfigured.

## Enabling trusted-local mode (Phase 10.2)

Trusted-local mode makes Codex assignable by having it bypass its own internal sandbox and approval
enforcement (`--dangerously-bypass-approvals-and-sandbox`) instead of working around the Windows
sandbox restriction. **Read
[`docs/architecture/0010-paperclip-compatible-codex-mode.md`](docs/architecture/0010-paperclip-compatible-codex-mode.md)
in full before enabling this** — once running, Codex has your own OS-user filesystem permissions for
the whole task, not merely inside the task's working directory; this is never described as
"sandboxed" or "restricted" execution because it isn't.

Restart Hall Core (step 8 above) with the additional flag:

```powershell
pnpm --filter @hall-of-wisdom/hall-core run dev -- `
  --workspace-root "D:\HallOfWisdom" `
  --port 4310 `
  --mock-scenario success `
  --web-origin "http://127.0.0.1:3000" `
  --enable-codex-trusted-local
```

There is no browser-, task-, or REST-request-controlled way to enable this — it is read once, at
process startup, from this flag only, and defaults to off. With it set and your ChatGPT
authentication verified (steps 2–3 above), re-run step 9's `Invoke-RestMethod` call: Codex's
`availability` should now be `"available"`, with a `limitationNotice` field reading "Trusted-local
mode: Codex sandbox and approval protections are bypassed. Codex runs with the Hall Core user's
filesystem permissions." — this same text also appears in Hall Web's "Assign agent" dialog beneath
the agent dropdown once Codex is selected.

## Enabling multi-agent comparison (Phase 12)

The comparison feature is off by default. Enable it by also passing `--comparison-root`, pointing at
an already-existing directory that is **not** nested inside, and not an ancestor of, your
`--workspace-root` — Hall Core checks this at startup and refuses to start otherwise:

```powershell
New-Item -ItemType Directory -Force -Path "D:\HallOfWisdomComparisons" | Out-Null
pnpm --filter @hall-of-wisdom/hall-core run dev -- `
  --workspace-root "D:\HallOfWisdom" `
  --port 4310 `
  --mock-scenario success `
  --web-origin "http://127.0.0.1:3000" `
  --comparison-root "D:\HallOfWisdomComparisons"
```

With it set, Hall Web's nav bar gains a "Comparisons" link, and a Ready task's Kanban card gains a
"Compare agents" action. **The source task must have its own "Working directory" set, pointing at a
real, clean Git repository somewhere inside `--workspace-root`** — comparisons resolve their source
repository from the task's working directory, never from `--workspace-root` directly (Phase 12.1), so
a task with no working directory set is rejected at "Prepare" with a safe
`COMPARISON_SOURCE_WORKING_DIRECTORY_REQUIRED` reason. `--workspace-root` itself need not be a Git
repository and may be dirty. See
[`docs/architecture/0012-controlled-agent-comparison.md`](docs/architecture/0012-controlled-agent-comparison.md)
for the full design and its explicit restriction list (no auto-parallel execution, no AI judge, no
automatic winner, no merge/commit/push).

---

**The remaining steps walk through assigning and starting a real Codex task — only reachable with
trusted-local mode enabled above.** In strict mode (the default), Hall Web will not offer Codex as
an enabled option in the "Assign agent" dialog.

**10. Create an isolated fixture — never the Hall of Wisdom source tree, and it must be its own Git
repository** (Codex requires one; this adapter never auto-initializes it for you):

```powershell
New-Item -ItemType Directory -Force "D:\HallOfWisdom\.tmp\codex-adapter-smoke" | Out-Null
Set-Location "D:\HallOfWisdom\.tmp\codex-adapter-smoke"
git init
git config user.email "smoke-test@example.invalid"
git config user.name "Hall Smoke Test"
Set-Content "NOTES.md" "placeholder"
git add NOTES.md
git commit -m "initial fixture commit"
Set-Location "D:\HallOfWisdom"
```

**11. Assigning Codex**: with Hall Core (step 8) and Hall Web (`pnpm --filter @hall-of-wisdom/web
run dev`) both running, open `http://127.0.0.1:3000/board`, create a backlog task with **Working
directory** set to `.tmp/codex-adapter-smoke`, move it to Ready, and use **Assign agent** to assign
**Codex** — confirm the card moves to Assigned with `0` events (assigning never starts a run).

**12. Starting the real task**: click **Start task** and confirm. Watch the card move through
Assigned → In Progress → a terminal state while normalized events stream in over the task-events
WebSocket — expect `run.started`, one or more `message.delta`/`tool.started`/`tool.completed`
events, then `run.completed` (or `run.failed`). **A `run.completed` here does not by itself confirm
a file changed** — check the file directly (next step) before trusting that any edit happened.

**13. Watching normalized events and confirming (or not) a real change:**

```powershell
Get-Content "D:\HallOfWisdom\.tmp\codex-adapter-smoke\NOTES.md"
git -C "D:\HallOfWisdom\.tmp\codex-adapter-smoke" status --short
```

If the file is unchanged and `git status` is clean despite a `run.completed`, this is the known,
disclosed limitation — see `docs/architecture/0009-codex-adapter.md`, "Real smoke-test results".

**14. Cancelling a real run**: while a task assigned to Codex is In Progress, open its Actions menu
and choose **Cancel task** (or use the task-level cancel control in the Task Console) — confirm the
card reaches Cancelled and no `codex.exe`/native Codex process remains (see the process-check
command in step 16 below, run once with no Codex task active).

**15. Troubleshooting `unsupported`**: step 9 will always show Codex as `unsupported` in strict mode
(see the Phase 10.1 note above) — that alone is not a problem to fix. `GET /api/v1/adapters`
deliberately never exposes _why_ (its `diagnosticMessage` field is stripped for every non-available
result, to avoid ever forwarding raw provider output to a browser); the exact reason is only visible
by calling `CodexAdapter#detect()` directly (e.g. from a test or a short local script) and reading
its `diagnosticMessage`. The fixed possible values in strict mode are:
`"Codex file-edit execution is not verified in the current sandbox."` (expected, current-phase,
needs no action) and `"Installed Codex cannot guarantee the required isolated execution profile."`
(your installed CLI version is either too old or is missing a required `codex exec --help` flag —
update Codex and repeat steps 1 and 9). With `--enable-codex-trusted-local` set (see above), an
`unsupported` result can additionally mean the operator's environment has a billing-changing
variable set, Hall Core somehow isn't loopback-bound, or the trusted-local flag set specifically
isn't supported by your installed CLI — see
[`docs/architecture/0010-paperclip-compatible-codex-mode.md`](docs/architecture/0010-paperclip-compatible-codex-mode.md),
"Availability policy" for the exact messages.

**16. Explaining subscription usage**: every task you start through the Codex adapter (step 12)
spends real usage against your ChatGPT/Codex subscription, exactly as running `codex exec`
interactively would — Hall of Wisdom adds no separate billing source and no local caching that
would let you "replay" a run for free. Detection (steps 1–2, 9) never spends usage.

**17. Cleaning up the fixture** — delete it, and confirm no `codex.exe`/native Codex process
(beyond your own interactive session, if any) or lingering Hall Core/Hall Web `node.exe` process
remains:

```powershell
Remove-Item -Recurse -Force "D:\HallOfWisdom\.tmp\codex-adapter-smoke"
Get-Process codex -ErrorAction SilentlyContinue | Select-Object Id, ProcessName
```

## Enabling durable state persistence (Phase 13)

Every store defaults to in-memory, exactly as in every prior phase — a restart still loses
everything unless you opt in. Pass `--data-dir`, pointing at an already-existing-or-creatable
directory that is **not** nested inside, and not an ancestor of, either `--workspace-root` or
`--comparison-root`:

```powershell
New-Item -ItemType Directory -Force -Path "D:\HallOfWisdomData" | Out-Null
pnpm --filter @hall-of-wisdom/hall-core run dev -- `
  --workspace-root "D:\HallOfWisdom" `
  --port 4310 `
  --mock-scenario success `
  --web-origin "http://127.0.0.1:3000" `
  --data-dir "D:\HallOfWisdomData"
```

The `dev` script above rebuilds and runs `dist/server.js` in one step. To run the already-built
production binary directly instead — e.g. to reuse a build without recompiling, or to match exactly
what `apps/e2e`'s process-level tests spawn — build once, then invoke it with the same flags. Every
flag after the first line needs its own trailing backtick continuation (or put the whole command on
one line) — a flag placed on a new line with no continuation character is silently dropped by
PowerShell:

```powershell
pnpm --filter @hall-of-wisdom/hall-core run build
node apps/server/dist/server.js `
  --workspace-root "D:\HallOfWisdom" `
  --data-dir "D:\HallOfWisdomData" `
  --port 4310 `
  --mock-scenario success
```

With it set, Hall Core opens (creating on first use) a SQLite database under `--data-dir`, applies
its schema migrations, and every task, event, board, message, comparison, and comparison-candidate
worktree record survives a restart against the same directory. On every durable boot, Hall Core
runs a restart-recovery pass: any run left non-terminal by an unclean prior shutdown is marked
failed with a single synthetic "interrupted" event — it is never automatically resumed or retried
against a real provider. Hall Web's new `/system` page (and the underlying `GET
/api/v1/system/storage` route) reports the current storage mode, schema version, the previous
shutdown's cleanliness (`"first_start"` / `"clean"` / `"unclean"`), and a bounded restart-recovery
summary. See
[`docs/architecture/0013-durable-persistence-and-recovery.md`](docs/architecture/0013-durable-persistence-and-recovery.md)
for the full design, including what is and is not covered by automated tests.

**A `--data-dir` is exclusively owned by one running Hall Core process at a time (Phase 13.1).**
Starting a second instance against the same directory while the first is still running fails
closed within seconds, with exit code 2 and a generic diagnostic that never names the directory —
the first instance is completely unaffected. After a genuine crash (not a graceful stop), a new
instance against the same directory is briefly refused too, until the crashed owner's lock has
aged past a 20-second staleness window, at which point it's automatically, safely reclaimed — no
manual cleanup is ever required. See that same document, "Durable single-instance ownership," for
the full design.

**A former owner that merely freezes (rather than crashes) can never commit a write after being
displaced (Phase 13.2).** The filesystem lock above only governs who may _start_ — a database-level
ownership epoch, re-checked inside every durable transaction, is what stops an already-running
instance from resuming and mutating state after a legitimate takeover, closing the one gap the
filesystem lock's own design deliberately leaves open (it cannot distinguish "frozen" from
"crashed" — see its doc comment). No configuration is needed to get this; it applies automatically
whenever `--data-dir` is used. See
[`docs/architecture/0013-durable-persistence-and-recovery.md`](docs/architecture/0013-durable-persistence-and-recovery.md),
"Database ownership fencing (Phase 13.2)," for the full design and the real bugs found and fixed
while building it.

## Full workspace verification

```powershell
pnpm install
pnpm typecheck
pnpm lint
pnpm format
pnpm test
pnpm build
pnpm verify:process-recovery
```

`typecheck`/`test`/`build` run recursively across all nine packages (including `apps/web`'s own
`next build` for production output and `vitest run` for its component/hook/library test suite);
`lint`/`format` run once across the whole repository. `apps/e2e` has no `test` script (deliberately —
its Playwright suite spawns a real browser and two real servers, so it's never swept up by an
ordinary `pnpm test` run); run it separately as its own step, described in "Running the Playwright
E2E Suite" above.

`pnpm verify:process-recovery` (Phase 13.1) is a separate, required step `pnpm test` intentionally
does not include: it rebuilds `@hall-of-wisdom/hall-core` and then runs `apps/server/src/process-tests/**`
— tests that spawn the actual built `dist/server.js` binary as a real OS process to verify durable
single-instance ownership and crash/restart behavior the source-level test suite can't reach. Takes
roughly 65 seconds (three of its four tests each wait out a real 20-second ownership-staleness
window — Phase 13.2 added a fourth: a frozen, not crashed, former owner is proven unable to commit
after a real takeover). See
[`docs/architecture/0013-durable-persistence-and-recovery.md`](docs/architecture/0013-durable-persistence-and-recovery.md),
"Process-level verification," for what it proves and why it's a separate command.

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
    codex/                  @hall-of-wisdom/codex-adapter - real, ChatGPT-authenticated
                            Codex CLI adapter
  runners/
    hall-runner/            @hall-of-wisdom/hall-runner - local task runner CLI
  apps/
    server/                 @hall-of-wisdom/hall-core - HTTP + WebSocket server
    web/                    @hall-of-wisdom/web - Next.js browser dashboard
    e2e/                    @hall-of-wisdom/e2e - Playwright E2E verification (Phase 11.1)
  docs/architecture/      architecture decision records
  AGENTS.md               rules for coding agents working in this repo
  CLAUDE.md                rules for Claude Code specifically
  README.md               this file
```

Future phases will add more `packages/` (database, source-control, work-management) and more
`adapters/` (OpenCode, Antigravity, Cursor, ...) as each becomes necessary. See the architecture
documents for the full planned layout and the Phase 3/4/5/6/7/8/9/10 boundary decisions.
