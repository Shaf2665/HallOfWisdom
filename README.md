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

**Phase 3 — Agent Adapter SDK and Mock Agent.** Three packages now exist: `@hall-of-wisdom/protocol`
(the wire contract), `@hall-of-wisdom/agent-adapter-sdk` (the contract every coding-agent adapter
implements — descriptors, detection, task input, event sequencing, terminal-event guarantees), and
`@hall-of-wisdom/mock-agent` (the first concrete adapter: deterministic, local-only, no network or
process execution). No Hall Runner, server, web app, or real agent integration exists yet.

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
```

## Packages

| Package                                                           | Purpose                                                                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@hall-of-wisdom/protocol`](packages/protocol)                   | Provider-neutral wire contract: agent identity, capabilities, tasks, agent runs, and normalized agent events, with Zod-backed runtime validation.                                    |
| [`@hall-of-wisdom/agent-adapter-sdk`](packages/agent-adapter-sdk) | The contract every coding-agent adapter implements: descriptors, detection results, task input, an event-sequencing factory, and a terminal-event guard. Depends only on `protocol`. |
| [`@hall-of-wisdom/mock-agent`](adapters/mock-agent)               | Deterministic, local-only, network-free `AgentAdapter` implementation used to develop and test Hall Runner/Hall Core without consuming real agent subscription usage.                |

## Repository Layout (current)

```
hall-of-wisdom/
  packages/
    protocol/            @hall-of-wisdom/protocol - shared communication contract
    agent-adapter-sdk/   @hall-of-wisdom/agent-adapter-sdk - adapter contract
  adapters/
    mock-agent/            @hall-of-wisdom/mock-agent - deterministic, network-free adapter
  docs/architecture/      architecture decision records
  AGENTS.md               rules for coding agents working in this repo
  CLAUDE.md                rules for Claude Code specifically
  README.md               this file
```

Future phases will add `apps/` (web, server), more `packages/` (database, source-control,
work-management), `runners/` (hall-runner, which depends on adapters only through
`@hall-of-wisdom/agent-adapter-sdk`), and more `adapters/` (Claude Code, Codex, ...) as each
becomes necessary. See the architecture documents for the full planned layout and the Phase 3
adapter boundary decisions.
