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

**Phase 4 — Hall Runner Prototype.** Four packages now exist: `@hall-of-wisdom/protocol` (the wire
contract), `@hall-of-wisdom/agent-adapter-sdk` (the adapter contract), `@hall-of-wisdom/mock-agent`
(the first concrete adapter), and `@hall-of-wisdom/hall-runner` — a local CLI that registers an
adapter, validates the workspace, runs one task, and streams normalized events as JSON Lines to the
terminal. No server, web app, networking, Git integration, or real coding-agent integration exists
yet.

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
```

## Packages

| Package                                                           | Purpose                                                                                                                                                                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@hall-of-wisdom/protocol`](packages/protocol)                   | Provider-neutral wire contract: agent identity, capabilities, tasks, agent runs, and normalized agent events, with Zod-backed runtime validation.                                                    |
| [`@hall-of-wisdom/agent-adapter-sdk`](packages/agent-adapter-sdk) | The contract every coding-agent adapter implements: descriptors, detection results, task input, an event-sequencing factory, and a terminal-event guard. Depends only on `protocol`.                 |
| [`@hall-of-wisdom/mock-agent`](adapters/mock-agent)               | Deterministic, local-only, network-free `AgentAdapter` implementation used to develop and test Hall Runner/Hall Core without consuming real agent subscription usage.                                |
| [`@hall-of-wisdom/hall-runner`](runners/hall-runner)              | Local process/CLI: registers adapters via `AgentRegistry`, validates the workspace and working directory, runs one task through the generic `AgentAdapter` interface, and streams JSON Lines events. |

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

## Repository Layout (current)

```
hall-of-wisdom/
  packages/
    protocol/            @hall-of-wisdom/protocol - shared communication contract
    agent-adapter-sdk/   @hall-of-wisdom/agent-adapter-sdk - adapter contract
  adapters/
    mock-agent/            @hall-of-wisdom/mock-agent - deterministic, network-free adapter
  runners/
    hall-runner/            @hall-of-wisdom/hall-runner - local task runner CLI
  docs/architecture/      architecture decision records
  AGENTS.md               rules for coding agents working in this repo
  CLAUDE.md                rules for Claude Code specifically
  README.md               this file
```

Future phases will add `apps/` (web, server), more `packages/` (database, source-control,
work-management), and more `adapters/` (Claude Code, Codex, ...) as each becomes necessary. See the
architecture documents for the full planned layout and the Phase 3/4 boundary decisions.
