# 0001 — Initial Architecture

Status: Draft (Phase 2.1). This document will be revised as later phases add real packages.

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

## Current state (end of Phase 2.1)

```
hall-of-wisdom/
  packages/
    protocol/                 @hall-of-wisdom/protocol - shared communication contract (see below)
  docs/architecture/0001-initial-architecture.md
  AGENTS.md
  CLAUDE.md
  README.md
  package.json, pnpm-workspace.yaml, tsconfig.base.json, tsconfig.json, eslint.config.js,
  .prettierrc.json, .editorconfig, .gitattributes, .gitignore
```

The temporary `src/example/` module from Phase 1 has been removed now that a real package exists.
No `apps/`, `runners/`, or `integrations/` directories exist yet, and `packages/` contains only
`protocol` — the remaining packages listed in "Planned module structure" above are created only
when the phase that needs them arrives.

## The Hall protocol (`@hall-of-wisdom/protocol`, Phase 2)

`packages/protocol` defines the wire contract every other part of the system (Hall Core, Hall
Runner, the web app, and all coding-agent adapters) uses to talk about agents, tasks, runs, and
events. It is deliberately the first package built, and deliberately has zero dependencies on any
other Hall package, any specific agent, or any specific provider:

- **Why a normalized protocol at all.** Without one, every consumer of agent output (the web UI,
  the task board, the CEO Agent) would need to understand every adapter's native format. A single
  shared contract means Hall Core is written once against one vocabulary, and adding a tenth coding
  agent later requires only a new adapter, not changes throughout the rest of the system.
- **Why adapters must not leak provider-specific events.** If a Claude-specific or Codex-specific
  event type ever reached Hall Core directly, Hall Core would have to special-case it, and the
  "provider-neutral core" constraint above would already be broken on day one. Each adapter is
  responsible for translating its agent's native output into the nine `NormalizedAgentEvent`
  variants defined here before anything leaves the adapter boundary.
- **Why ISO 8601 timestamp strings, not `Date` objects.** A `Date` is a JavaScript-runtime concept:
  it does not serialize predictably through `JSON.stringify`/`JSON.parse`, has no meaning in a
  browser-vs-Node vs. future-non-JS-adapter context, and silently reinterprets time zones. A fixed
  ISO 8601 string is unambiguous across every process boundary the protocol crosses.
- **Why every event carries a required, non-negative `sequence` number.** Events travel from an
  adapter subprocess through Hall Runner to Hall Core and out over a (future) WebSocket connection
  to the browser. Network connections drop and reconnect; wall-clock timestamps can collide or
  arrive out of order. A monotonically increasing sequence number, scoped per run, is what lets a
  consumer detect gaps, discard duplicates after a reconnect, and reconstruct the correct event
  order — none of which a timestamp alone can guarantee.
- **Why runtime validation, not just TypeScript types.** Types are erased at compile time and
  provide no protection against malformed data crossing an actual process or network boundary (a
  buggy adapter, a corrupted message, a future hostile client). Every protocol object is backed by
  a [Zod](https://zod.dev) schema that is the single source of truth; TypeScript types are inferred
  from the schema (`z.infer`) rather than hand-maintained, so the type and the validator cannot
  drift apart. Object schemas are `.strict()` so unexpected fields are rejected rather than
  silently accepted at the trust boundary, which also closes off prototype-pollution-style attacks
  via unexpected keys (see the package's `security.test.ts`).
- **What runtime validation does _not_ do: secret redaction.** `structuredFailureSchema`'s
  `details` field is bounded in shape and size (flat primitives, capped key count, capped string
  length) so it cannot be used to smuggle unbounded or deeply nested data. It has no way to know
  whether one of those bounded strings happens to contain a token, password, or raw environment
  variable value — that is a question of _meaning_, not shape, and no schema can answer it. Secret
  redaction is a separate responsibility: real adapters and Hall Runner must run captured process
  output through a dedicated redaction layer _before_ constructing a `StructuredFailure` or any
  other protocol object. That redaction layer does not exist yet and is not part of this package.

The package has no Node-specific or browser-specific dependencies (only `zod`, which runs
identically in both) so it can be imported from Hall Core (Node), the web app (browser), and Hall
Runner (Node) without modification.

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

## Normalized agent events (implemented, Phase 2, extended Phase 2.1)

All coding-agent adapters emit a shared, agent-agnostic event vocabulary so Hall Core never needs
to know about Claude- or Codex-specific formats. Defined in `@hall-of-wisdom/protocol`:

`run.started`, `message.delta`, `tool.started`, `tool.completed`, `file.changed`,
`approval.required`, `run.completed`, `run.failed`, `run.cancelled`.

Every event shares an envelope (`protocolVersion`, `eventId`, `runId`, `taskId`, `agentId`,
`timestamp`, `sequence`, `type`) plus an event-specific `payload`. Ordering, deduplication, and
persistence of these events is a Hall Core concern for a later phase — the protocol package only
guarantees that `sequence` is present and non-negative; it does not itself buffer, reorder, or
deduplicate events.

`run.completed`, `run.failed`, and `run.cancelled` are **terminal events** — once one of them has
been emitted for a run, no further events should follow for that run. The protocol package defines
their shapes only; it does not enforce "exactly one terminal event per run" or "no events after
termination". That lifecycle rule is the responsibility of the agent adapter SDK (Phase 3+, which
produces the events) and Hall Core (Phase 5+, which consumes and persists them).

## Open questions for later phases

- Exact shape of the agent adapter contract that produces these normalized events (Phase 3 minimal
  version, expanded later).
- How task/branch/worktree naming (`agent/<agent>/<task-id>`) is enforced and validated.
- Where permission decisions (`allowed` / `requires-approval` / `denied`) are evaluated — Hall
  Core vs. Hall Runner.
- Where event ordering, deduplication (by `sequence`), and persistence are implemented — likely
  Hall Core (Phase 5+), once a server exists to own that state.
