# Hall of Wisdom

Hall of Wisdom is a local, cross-platform Agent OS for coordinating coding agents against a user's own projects while keeping provider credentials on the user's machine.

## Installation / Quick Start

Requirements:

- Node.js `>=24.11.0 <25`
- pnpm `10.33.0`
- Git

```powershell
git clone https://github.com/Shaf2665/HallOfWisdom.git
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

Current Development Phase: **Phase 16.5 — Restart-Safe Worktree Reconciliation and Cleanup**

Last Completed and Merged Phase: **Phase 16.4 — Strict Isolated Codex Compatibility Infrastructure**

Phase 16.5 is under development on `phase-16-5-restart-safe-worktree-reconciliation` and is pending review and merge. It does not implement Phase 16.6 and does not run a real model-backed Codex task.

## Current Project Status

Implemented through Phase 16.4:

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
- Phase 16.4 strict isolated Codex compatibility infrastructure (still fail-closed pending Phase 16.6)

Phase 16.5 makes isolated worktree lifecycle management restart-safe. After an isolated run reaches an authoritative terminal outcome (completed, failed, or cancelled), Hall Core persists (or idempotently confirms) the immutable execution artifact first and only then requests worktree cleanup — cleanup failure is fail-soft: it never changes the task's outcome, never touches the artifact, never blocks a governed retry, and leaves the worktree recoverable on the next restart. On every durable startup, after task/event reconciliation, Hall Core also reconciles every persisted agent worktree: an interrupted `creating` worktree is marked with a stable code and safely cleaned; `creation_failed`/`cleanup_pending` worktrees resume cleanup; `cleanup_failed` worktrees get one retry per boot; a `ready` worktree whose run already reached a terminal event gets its execution artifact reconstructed (only from exact durable evidence — immutable adapter/agent identity captured at worktree creation, never a newer retry's mutable assignment) and is then cleaned; a worktree lacking that immutable identity (a legacy row) is retained and reported blocked, never guessed at; a `cleaned` worktree whose path unexpectedly reappears is reported, never deleted or transitioned backward; and unrecognized directories under the owned root are counted as orphans and left untouched. Cleanup only ever removes an exact, safety-validated `wt_<id>` worktree through `git worktree remove --force` — never a recursive filesystem delete, never an unknown directory. Phase 16.6 (explicitly authorized real Codex smoke verification and exact sandbox-equivalence proof) remains deferred and out of scope here.

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
  -> worktree cleanup request (fail-soft)

Restart:
  task/event reconciliation
    -> agent-worktree reconciliation (missing-artifact recovery, interrupted-worktree
       classification, safe cleanup resumption)
    -> comparison reconciliation
    -> bounded recovery summary
    -> server starts
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
pnpm --filter @hall-of-wisdom/hall-core run test -- src/agent-worktrees src/agent-execution src/execution-artifacts src/recovery src/tasks src/composition
```

## Security Limitations

Hall binds locally to `127.0.0.1` and is still a prototype. It has no production authentication layer. SQLite durability is optional. Phase 16 worktrees are now cleaned up automatically — after artifact persistence at runtime, and via restart reconciliation for anything a crash interrupted — but cleanup is deliberately conservative: it only ever removes an exact, safety-validated worktree through `git worktree remove --force`, never a recursive filesystem delete, and it retains (rather than deletes) any worktree whose identity, artifact match, or on-disk safety cannot be proven. Strict Codex remains unsupported until Hall can prove exact equivalence for the real `codex exec --sandbox workspace-write` policy in Phase 16.6; the zero-model helper probe alone is necessary evidence but not sufficient.

Trusted-local Codex mode is separate and explicitly opt-in. It bypasses Codex's sandbox and approval enforcement and runs with the Hall Core process user's filesystem permissions. Do not confuse it with strict isolated mode.

Hall does not claim generic secret detection. It prevents unsafe storage categories such as raw stdout, raw stderr, raw command lines, environment maps, arbitrary provider payloads, and provider authentication files.

## Phase Roadmap

Completed major phases include the monorepo foundation, adapter SDK, Mock Agent, Hall Runner, Hall Core, Hall Web, Claude Code and Codex adapters, routing, comparison worktrees, durable SQLite recovery, CEO planning, autonomous CEO plan execution, Hall-owned agent worktrees, bounded execution artifacts, isolated orchestration, and strict isolated Codex compatibility infrastructure.

Current:

- Phase 16.5 — Restart-Safe Worktree Reconciliation and Cleanup

Upcoming:

- Phase 16.6 — explicitly authorized real Codex smoke verification and exact sandbox-equivalence proof

Deferred future work includes additional coding-agent adapters, production authentication, richer policy controls, public artifact routes/UI, merge workflows, and deployment integrations.
