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

**Phase 1 — Project Foundation.** Only the workspace tooling exists so far: strict TypeScript,
ESLint, Prettier, and Vitest. No application code (web app, server, runner, adapters) has been
built yet.

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
```

Bash (Linux / macOS):

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm format
pnpm test
```

## Repository Layout (current)

```
hall-of-wisdom/
  src/example/        sample module demonstrating the toolchain (temporary, Phase 1 only)
  docs/architecture/   architecture decision records
  AGENTS.md            rules for coding agents working in this repo
  CLAUDE.md            rules for Claude Code specifically
  README.md            this file
```

Future phases will add `apps/` (web, server), `packages/` (protocol, database,
agent-adapter-sdk, source-control, work-management), and `runners/` (hall-runner and its
adapters) as each becomes necessary. See the architecture document for the full planned layout.
