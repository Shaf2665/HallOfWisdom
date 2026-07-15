# 0001 — Initial Architecture

Status: Draft (Phase 1). This document will be revised as later phases add real packages.

## Vision

Hall of Wisdom is a cross-platform Agent OS and coding-agent orchestrator. A user talks to a
single CEO Agent, which breaks a project request into tasks, assigns tasks to suitable coding
agents (Claude Code, OpenAI Codex, OpenCode, Google Antigravity, Cursor, GitHub Copilot CLI,
Cline, Goose, Junie, and future agents), monitors progress, requests peer review between agents,
runs tests, and asks the human for approval before anything ships.

Each coding agent runs **locally**, through the user's own already-authenticated installation.
Hall of Wisdom never collects, stores, or uploads a user's subscription credentials for any agent
or provider.

## Guiding constraints

- **Provider-neutral core.** Hall Core must not hard-code GitHub-specific or Azure DevOps-specific
  logic. Source-control and work-item integrations are adapters behind a shared interface.
- **Local-first credentials.** Agent authentication stays on the user's machine, inside the Hall
  Runner process. Hall Core and the web UI never see raw credentials.
- **Isolated parallel work.** Every task an agent works on gets its own Git branch and worktree, so
  multiple agents can work on the same repository simultaneously without touching the same files.
- **Small, reviewable phases.** The system is built incrementally; each phase produces a runnable,
  testable increment before the next one starts.

## Planned module structure

This is the target layout. Packages are created only when the phase that needs them arrives —
this repository does not contain empty placeholder packages ahead of time.

```
hall-of-wisdom/
  apps/
    web/                    Next.js + React + Tailwind web application (Phase 6+)
    server/                 Fastify-based Hall Core backend (Phase 5+)
  packages/
    protocol/               Hall protocol: agent identity, tasks, runs, normalized events (Phase 2)
    database/                Prisma schema and data access (Phase 9)
    agent-adapter-sdk/      Shared contract all coding-agent adapters implement (Phase 3+)
    source-control/         Provider-neutral Git/GitHub/Azure Repos interfaces (Phase 10, 18, 19)
    work-management/        Provider-neutral work-item interfaces (Boards, etc.)
  runners/
    hall-runner/            Local process: detects/starts/cancels agents, streams events (Phase 4+)
      adapters/
        mock-agent/          Deterministic, no-network adapter used to prove the pipeline (Phase 3)
        claude-code/          Claude Code detection + execution adapter (Phase 12, 14)
        codex/                 Codex detection + execution adapter (Phase 13, 15)
  integrations/
    github/                  GitHub App-based source-control integration (Phase 18)
    azure-devops/            Azure DevOps integration (Phase 19)
  docs/
    architecture/            Architecture decision records (this document and future ones)
    specifications/
  AGENTS.md                 Rules for any coding agent working in this repo
  CLAUDE.md                 Claude Code specific notes, points to AGENTS.md
  README.md
  pnpm-workspace.yaml
```

## Current state (end of Phase 1)

Only the workspace root exists:

```
hall-of-wisdom/
  src/example/               Sample module + test proving the toolchain works (temporary)
  docs/architecture/0001-initial-architecture.md
  AGENTS.md
  CLAUDE.md
  README.md
  package.json, pnpm-workspace.yaml, tsconfig*.json, eslint.config.js,
  .prettierrc.json, vitest.config.ts, .editorconfig, .gitattributes, .gitignore
```

No `apps/`, `packages/`, `runners/`, or `integrations/` directories exist yet — they will be
created starting with `packages/protocol` in Phase 2.

## Technology decisions (Phase 1)

| Concern                    | Choice                                                                         | Notes                                                                              |
| -------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Package manager / monorepo | pnpm workspaces                                                                | Pinned to `10.33.0` via `packageManager` field                                     |
| Language                   | TypeScript, strict mode                                                        | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, etc. enabled   |
| Module system              | ESM (`NodeNext`)                                                               | Matches modern Node.js and future Next.js/Fastify usage                            |
| Linting                    | ESLint flat config + `typescript-eslint` strict/stylistic type-checked configs |                                                                                    |
| Formatting                 | Prettier                                                                       | ESLint stylistic rules disabled via `eslint-config-prettier` to avoid conflicts    |
| Tests                      | Vitest                                                                         | Lightweight, native TypeScript/ESM support, fast, no extra transpile config needed |
| Runtime                    | Node.js `>=24.11.0 <25`                                                        | Current LTS at time of writing                                                     |

Not yet introduced (by design, per the phase plan): Next.js, Fastify, Prisma, WebSockets, Tauri,
Docker, Redis, PostgreSQL, Rust.

## Normalized agent events (planned, Phase 2+)

All coding-agent adapters will emit a shared, agent-agnostic event vocabulary so Hall Core never
needs to know about Claude- or Codex-specific formats:

`run.started`, `message.delta`, `tool.started`, `tool.completed`, `file.changed`,
`approval.required`, `run.completed`, `run.failed`.

## Open questions for later phases

- Exact shape of the agent adapter contract (Phase 3 minimal version, expanded later).
- How task/branch/worktree naming (`agent/<agent>/<task-id>`) is enforced and validated.
- Where permission decisions (`allowed` / `requires-approval` / `denied`) are evaluated — Hall
  Core vs. Hall Runner.
