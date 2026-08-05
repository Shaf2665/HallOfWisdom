# Hall of Wisdom

Hall of Wisdom is a local, cross-platform Agent OS for coordinating coding agents against a user's own projects while keeping provider credentials on the user's machine.

## Installation / Quick Start

Requirements:

- Node.js `>=24.11.0 <25`
- pnpm `10.33.0`
- Git

```powershell
git clone <repository URL>
cd HallOfWisdom
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Start Hall Core in normal ephemeral development mode:

```powershell
pnpm --filter @hall-of-wisdom/hall-core run dev -- `
  --workspace-root "D:\HallOfWisdom" `
  --port 4310 `
  --mock-scenario success `
  --web-origin "http://127.0.0.1:3000"
```

Start Hall Web:

```powershell
pnpm --filter @hall-of-wisdom/web run dev
```

Open `http://127.0.0.1:3000`.

Durable SQLite mode:

```powershell
pnpm --filter @hall-of-wisdom/hall-core run dev -- `
  --workspace-root "D:\HallOfWisdom" `
  --data-dir "D:\HallOfWisdomData" `
  --port 4310 `
  --mock-scenario success `
  --web-origin "http://127.0.0.1:3000"
```

Phase 16 isolated Codex mode, under development on this branch, additionally requires an explicit Hall-owned worktree root:

```powershell
pnpm --filter @hall-of-wisdom/hall-core run dev -- `
  --workspace-root "D:\HallOfWisdom" `
  --data-dir "D:\HallOfWisdomData" `
  --agent-worktree-root "D:\HallOfWisdomAgentWorktrees" `
  --port 4310 `
  --mock-scenario success `
  --web-origin "http://127.0.0.1:3000"
```

Trusted-local Codex mode is dangerous and optional. It bypasses Codex's own sandbox and approval enforcement, and should not be used as the default:

```powershell
pnpm --filter @hall-of-wisdom/hall-core run dev -- `
  --workspace-root "D:\HallOfWisdom" `
  --port 4310 `
  --mock-scenario success `
  --web-origin "http://127.0.0.1:3000" `
  --enable-codex-trusted-local
```

## Current Development Phase

Current Development Phase: **Phase 16.4 — Strict Isolated Codex Compatibility**

Last Completed and Merged Phase: **Phase 16.3 — Provider-Neutral Isolated Execution Orchestration and Terminal Artifact Integration**

Phase 16.4 is under development on `phase-16-4-codex-strict-isolated-compatibility` and is pending review and merge. It does not run a real model-backed Codex task; that remains deferred to Phase 16.6.

## Current Project Status

Implemented through Phase 16.3:

- TypeScript pnpm monorepo
- provider-neutral protocol and adapter SDK
- Mock Agent
- Claude Code adapter
- Codex adapter
- Hall Runner
- Hall Core
- Hall Web
- task console
- Kanban board
- communication boards
- capability and trust-based routing
- multi-agent comparison
- optional SQLite durability
- restart recovery
- CEO planning, approval, and delegation
- autonomous CEO plan execution and retry handling
- Hall-owned isolated Git worktrees
- immutable bounded execution artifacts
- Phase 16.3 isolated orchestration
- run-specific retry and cancellation fencing

Phase 16.4 adds strict isolated Codex compatibility behind durable Hall-owned worktree configuration and a zero-model sandbox compatibility probe. It does not add UI, routes, public protocol fields, automatic worktree cleanup, restart reconciliation for Phase 16 worktrees, or real Codex smoke testing.

## Features

Hall Core is a localhost-only Fastify HTTP and WebSocket server. It can create tasks, assign adapters, stream normalized events, store durable state when SQLite mode is enabled, run deterministic Mock Agent tasks, route by capability and trust, compare agents in isolated comparison worktrees, and drive approved CEO plan execution. Hall Web is a local Next.js dashboard for task, board, communication, system, comparison, and CEO workflows.

Real provider adapters use the operator's locally installed CLIs and local subscription authentication. Hall does not collect provider credentials, API keys, auth files, or raw provider output.

## Architecture

Key architecture documents:

- [`AGENTS.md`](AGENTS.md)
- [`docs/architecture/0001-initial-architecture.md`](docs/architecture/0001-initial-architecture.md)
- [`docs/architecture/0008-claude-code-adapter.md`](docs/architecture/0008-claude-code-adapter.md)
- [`docs/architecture/0009-codex-adapter.md`](docs/architecture/0009-codex-adapter.md)
- [`docs/architecture/0010-paperclip-compatible-codex-mode.md`](docs/architecture/0010-paperclip-compatible-codex-mode.md)
- [`docs/architecture/0013-durable-persistence-and-recovery.md`](docs/architecture/0013-durable-persistence-and-recovery.md)
- [`docs/architecture/0015-autonomous-plan-execution-and-scheduling.md`](docs/architecture/0015-autonomous-plan-execution-and-scheduling.md)
- [`docs/architecture/0016-codex-worktree-execution.md`](docs/architecture/0016-codex-worktree-execution.md)

Phase 16 dependency direction:

```text
TaskOrchestrator
  -> IsolatedAgentExecutionCoordinator
  -> AgentWorktreeManager
  -> strict Codex adapter
  -> normalized events
  -> authoritative terminal task/event state
  -> immutable execution artifact
```

## Usage

Normal development uses Mock Agent by default. Create tasks in Hall Web, move them through the Kanban workflow, assign an adapter, and explicitly start a run. CEO plan execution can start delegated child tasks only after an operator configures and starts an autonomous execution run.

For an already-built Hall Core binary:

```powershell
pnpm --filter @hall-of-wisdom/hall-core run build
node apps/server/dist/server.js `
  --workspace-root "D:\HallOfWisdom" `
  --port 4310 `
  --mock-scenario success
```

## Packages

| Package                               | Purpose                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| `@hall-of-wisdom/protocol`            | Provider-neutral wire and validation contracts.                                |
| `@hall-of-wisdom/agent-adapter-sdk`   | Adapter interface, task input, detection, events, and terminal guards.         |
| `@hall-of-wisdom/mock-agent`          | Deterministic local adapter for tests and development.                         |
| `@hall-of-wisdom/claude-code-adapter` | Local Claude Code CLI adapter.                                                 |
| `@hall-of-wisdom/codex-adapter`       | Local Codex CLI adapter with strict and trusted-local profiles.                |
| `@hall-of-wisdom/hall-runner`         | Local task runner and adapter registry.                                        |
| `@hall-of-wisdom/hall-core`           | Local Fastify server, stores, orchestration, recovery, and Phase 16 internals. |
| `@hall-of-wisdom/web`                 | Next.js browser dashboard.                                                     |
| `@hall-of-wisdom/e2e`                 | Playwright E2E fixtures, not included in ordinary `pnpm test`.                 |

## Development and Validation

```powershell
pnpm typecheck
pnpm lint
pnpm format
pnpm test
pnpm build
pnpm verify:process-recovery
pnpm verify:package-entry
```

Useful focused commands:

```powershell
pnpm --filter @hall-of-wisdom/codex-adapter run test
pnpm --filter @hall-of-wisdom/hall-core run test -- src/agent-execution src/agent-worktrees src/tasks src/composition
```

## Security Limitations

Hall binds locally to `127.0.0.1` and is still a prototype. It has no production authentication layer. SQLite durability is optional. Phase 16 worktrees are retained after terminal execution; automatic cleanup and restart reconciliation are deferred to Phase 16.5. Strict Codex compatibility depends on the installed native Codex sandbox passing Hall's zero-model probe. If no safe native sandbox is available, strict Codex fails closed.

Trusted-local Codex mode is separate and explicitly opt-in. It bypasses Codex's sandbox and approval enforcement and runs with the Hall Core process user's filesystem permissions. Do not confuse it with strict isolated mode.

Hall does not claim generic secret detection. It prevents unsafe storage categories such as raw stdout, raw stderr, raw command lines, environment maps, arbitrary provider payloads, and provider authentication files.

## Phase Roadmap

Completed major phases include the monorepo foundation, adapter SDK, Mock Agent, Hall Runner, Hall Core, Hall Web, Claude Code and Codex adapters, routing, comparison worktrees, durable SQLite recovery, CEO planning, autonomous CEO plan execution, Hall-owned agent worktrees, bounded execution artifacts, and isolated orchestration.

Current:

- Phase 16.4 — Strict Isolated Codex Compatibility

Upcoming:

- Phase 16.5 — restart-safe cleanup and reconciliation for Phase 16 worktrees and missing artifacts
- Phase 16.6 — explicitly authorized real Codex smoke verification

Deferred future work includes additional coding-agent adapters, production authentication, richer policy controls, public artifact routes/UI, merge workflows, and deployment integrations.
