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

**Phase 2.1 — Protocol Cancellation and Packaging Hardening.** The workspace tooling from Phase 1
(strict TypeScript, ESLint, Prettier, Vitest) is joined by the first real package,
`@hall-of-wisdom/protocol`: the provider-neutral message contract shared by Hall Core, Hall
Runner, the web app, and every coding-agent adapter. No application code (web app, server, runner,
adapters) has been built yet.

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

`typecheck`, `test`, and `build` run recursively across every workspace package (currently just
`packages/protocol`); `lint` and `format` run once across the whole repository.

To verify the _built_ protocol package resolves and behaves correctly through its public entry
point (as an external consumer would use it, not via `src`), after `pnpm build`:

```powershell
pnpm --filter @hall-of-wisdom/protocol run verify:package-entry
```

## Packages

| Package                                         | Purpose                                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@hall-of-wisdom/protocol`](packages/protocol) | Provider-neutral wire contract: agent identity, capabilities, tasks, agent runs, and normalized agent events, with Zod-backed runtime validation. |

## Repository Layout (current)

```
hall-of-wisdom/
  packages/
    protocol/          @hall-of-wisdom/protocol - shared communication contract
  docs/architecture/   architecture decision records
  AGENTS.md            rules for coding agents working in this repo
  CLAUDE.md             rules for Claude Code specifically
  README.md            this file
```

Future phases will add `apps/` (web, server), more `packages/` (database, agent-adapter-sdk,
source-control, work-management), and `runners/` (hall-runner and its adapters) as each becomes
necessary. See the architecture document for the full planned layout.
