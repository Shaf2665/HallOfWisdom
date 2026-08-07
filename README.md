# Hall of Wisdom

Hall of Wisdom is a local, cross-platform Agent OS for coordinating coding agents against a user's own projects while keeping provider credentials on the user's machine.

## Installation / Quick Start

Requirements:

- Node.js `>=24.11.0 <25`
- pnpm `10.33.0`
- Git — a version recent enough to support `git worktree list --porcelain -z` (confirmed against Git
  2.54); Phase 16 isolated worktree execution fails closed with a bounded Git-failure code on a Git
  too old to support it, never a silent permissive fallback

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

Phase 16 isolated Codex mode additionally requires an explicit Hall-owned worktree root:

```powershell
pnpm --filter @hall-of-wisdom/hall-core run dev -- `
  --workspace-root "D:\HallOfWisdom" `
  --data-dir "D:\HallOfWisdomData" `
  --agent-worktree-root "D:\HallOfWisdomAgentWorktrees" `
  --port 4310 `
  --mock-scenario success `
  --web-origin "http://127.0.0.1:3000"
```

Once `--agent-worktree-root` has been used with a given `--data-dir`, every later startup against that same data directory must keep supplying the exact same root — a different root, or omitting the flag entirely, fails startup closed (see "Security Limitations" below).

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

Current Development Phase: **Phase 16.6 — Codex Trusted-Local Production Readiness and Git LFS Worktree Compatibility** (implemented on a branch, pending review and merge)

Last Completed and Merged Phase: **Phase 16.5 — Restart-Safe Worktree Reconciliation and Cleanup**

Phase 16.5 is merged. Phase 16.6 replaces the previously planned strict Codex sandbox-attestation work with a narrower, practical correction: **Claude Code** is verified working end to end and remains the recommended default provider for non-technical users. **Codex trusted-local** — the supported, practical way to run Codex today — is now verified working through Hall-owned worktrees, including on machines where Git for Windows registers a standard Git LFS checkout filter (`filter.lfs.*`) at system scope, which previously caused every Codex worktree to fail closed with `GIT_CHECKOUT_FILTER_UNSUPPORTED` before Codex was ever invoked. Hall now recognizes exactly the standard Git LFS profile (narrow, value-checked, never by filter name alone) and never automatically downloads or materializes LFS objects while preparing an agent worktree (`GIT_LFS_SKIP_SMUDGE=1`, scoped to the one checkout invocation). **Strict, OS-sandboxed Codex isolation remains deferred as optional future hardening and stays fail-closed** — this phase makes no strict-mode support claim, and trusted-local's explicit startup opt-in is unchanged: only `--enable-codex-trusted-local` at Hall Core process start can enable it, never a browser request, task input, or project file. The Hall-owned worktree Codex trusted-local uses is a primary-checkout safety mechanism (so a task can never mutate the repository the operator is actually working in) — it is not an operating-system sandbox, and trusted-local still runs with the Hall Core process user's own filesystem permissions once Codex starts.

## Current Project Status

Implemented through Phase 16.5:

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
- Phase 16.4 strict isolated Codex compatibility infrastructure (still fail-closed; strict Codex isolation is now deferred as optional future hardening, not a near-term goal)
- Phase 16.5 restart-safe worktree reconciliation and cleanup, including post-merge hardening of the configuration fingerprint and Git registration parsing (below)
- Phase 16.6 Codex trusted-local production readiness: narrow, value-checked recognition of the standard Git LFS checkout-filter profile, skip-smudge scoped to the one checkout invocation, and a verified real Codex trusted-local task through a Hall-owned worktree

Phase 16.5 makes isolated worktree lifecycle management restart-safe. After an isolated run reaches an authoritative terminal outcome (completed, failed, or cancelled), Hall Core persists (or idempotently confirms) the immutable execution artifact first and only then requests worktree cleanup — cleanup failure is fail-soft: it never changes the task's outcome, never touches the artifact, never blocks a governed retry, and leaves the worktree recoverable on the next restart. On every durable startup, after task/event reconciliation, Hall Core also reconciles every persisted agent worktree: an interrupted `creating` worktree is marked with a stable code and safely cleaned; `creation_failed`/`cleanup_pending` worktrees resume cleanup; `cleanup_failed` worktrees get one retry per boot; a `ready` worktree whose run already reached a terminal event gets its execution artifact reconstructed (only from exact durable evidence — immutable adapter/agent identity captured at worktree creation, never a newer retry's mutable assignment) and is then cleaned; a worktree lacking that immutable identity (a legacy row) is retained and reported blocked, never guessed at; a `cleaned` worktree whose path or Git registration unexpectedly reappears is reported, never deleted, pruned, or transitioned backward; and unrecognized directories or Git registrations under the owned root are counted as orphans and left untouched. Cleanup only ever removes an exact, safety-validated `wt_<id>` worktree through `git worktree remove --force` — never a recursive filesystem delete, never `git clean`/`git worktree prune`, never an unknown directory or registration.

The durable configuration fingerprint that already scoped a `--data-dir` to its `--workspace-root`/`--comparison-root` now also scopes it to `--agent-worktree-root`: the first valid root supplied is recorded, a later startup with a different root (or no root at all, once one was recorded) fails closed, and a database with existing worktree rows but no recorded root first proves every one of those rows' reconstructed paths belongs to the newly supplied root before ever bootstrapping it — including when the root is omitted entirely: a database that already holds `agent_worktrees` rows but never got as far as recording a root now fails closed on an omitted root too, rather than silently composing no agent-worktree manager and leaving those rows permanently unreconciled. Every fingerprint write for one startup call (`workspaceRoot`/`comparisonRoot`/`agentWorktreeRoot` together) happens inside a single outer transaction, so a failure partway through can never leave one key durably recorded while another silently isn't. Restart reconciliation also inspects Git's own worktree registrations (through the same bounded Git runner, never a second ad hoc invocation, and through one strict parser shared by every registration-checking call site) alongside the filesystem, so a registration Git still remembers but Hall has no record of — or a `cleaned` worktree's registration reappearing — is detected and reported exactly like its filesystem counterpart, never silently missed. That parser reads Git's NUL-delimited `git worktree list --porcelain -z` output rather than the plain newline-oriented form, and fails closed (a bounded `GIT_WORKTREE_LIST_MALFORMED` code) on any output that does not exactly match Git's own byte structure — including an `exitCode: 0` response that looks superficially like success — rather than ever silently returning an empty or partial registration list. A dedicated real-process test (`pnpm verify:process-recovery`) proves the core recovery flow end to end through the actual built binary: a real completed task, a real Git worktree with no execution artifact yet, a real restart that recovers the artifact and safely removes the worktree, a second real restart that changes nothing further, and confirmation that neither the primary checkout nor an unrelated orphan directory was ever touched. A second real-process test proves the legacy-root-omission rejection itself: a database seeded with a real `agent_worktrees` row but no recorded root refuses to start when the root is omitted (no health response, no boot record, the row untouched) and remains recoverable once the exact proven root is supplied on a later boot. Strict isolated Codex execution remains fail-closed and is now deferred as optional future hardening, separate from Phase 16.6's Codex trusted-local production-readiness work (below).

Phase 16.6 replaces the previously planned strict Codex sandbox-attestation phase with a narrower, practical correction to Codex trusted-local's use of Hall-owned worktrees. `AgentWorktreeManager` previously rejected any configured Git checkout filter (`filter.<name>.clean`/`.smudge`/`.process`) purely by key-name suffix, regardless of which filter it was — including the entirely standard Git LFS profile Git for Windows registers at system scope by default (`filter.lfs.clean`/`.smudge`/`.process`/`.required`), which made every Codex worktree fail closed with `GIT_CHECKOUT_FILTER_UNSUPPORTED` before Codex was ever invoked on any machine with Git LFS installed. Hall now inspects both the filter's key _and_ its value (`git config --null --get-regexp`, a machine-safe NUL-delimited format) and recognizes exactly one thing: the standard Git LFS profile, matched against Git LFS's own documented output as a small fixed allowlist of exact command strings — never a pattern, glob, or "looks like LFS" heuristic. Every other filter — any other name, any modified or ambiguous LFS command, a duplicated or conflicting key, an unrecognized `filter.lfs.*` subkey, or malformed/truncated configuration output — is still rejected exactly as before. When the recognized profile is present, Hall never lets Git LFS automatically download or materialize LFS objects while preparing an agent worktree: `GIT_LFS_SKIP_SMUDGE=1` is applied narrowly to the single checkout invocation that needs it (a small, closed-shape environment-override extension to `GitCommandRunner`, not a general environment-passthrough mechanism), so an LFS-tracked file in a Hall-owned worktree remains a pointer, never a downloaded object, while every ordinary file checks out normally. This is a filesystem-scoping and content-classification fix, not a change to Codex trusted-local's own security posture: trusted-local still bypasses Codex's sandbox and approval enforcement exactly as documented, its explicit `--enable-codex-trusted-local` startup opt-in is unchanged, and strict, OS-sandboxed Codex isolation remains deferred, fail-closed, and unclaimed. A real, end-to-end Codex trusted-local task — through the real adapter, a real Hall-owned worktree, and the operator's real ChatGPT-authenticated Codex CLI — was verified against a disposable fixture repository outside this repository as part of this phase; see `docs/architecture/0016-codex-worktree-execution.md` for the mechanism and `docs/architecture/0009-codex-adapter.md`/`0010-paperclip-compatible-codex-mode.md` for how it composes with the adapter's existing strict/trusted-local profiles.

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

Hall binds locally to `127.0.0.1` and is still a prototype. It has no production authentication layer. SQLite durability is optional. Phase 16 worktrees are now cleaned up automatically — after artifact persistence at runtime, and via restart reconciliation for anything a crash interrupted — but cleanup is deliberately conservative: it only ever removes an exact, safety-validated worktree through `git worktree remove --force`, never a recursive filesystem delete, and it retains (rather than deletes) any worktree whose identity, artifact match, or on-disk safety cannot be proven. A `--data-dir` durably remembers the `--agent-worktree-root` it was first started with, the same way it already remembers `--workspace-root`; reusing that data directory against a different (or omitted) worktree root fails startup closed rather than silently reconciling — or failing to reconcile — the wrong set of worktrees, and this now also covers a database that already holds worktree rows but never got as far as recording a root at all — including the case where no fingerprint field of any kind, not even `--workspace-root`, was ever recorded. Git worktree registration inspection uses one strict, NUL-delimited parser everywhere a registration list is read, validating a record's complete documented attribute set (not only its path) and rejecting genuinely empty exit-zero output the same way, so malformed, incomplete, or unexpectedly structured Git output is never silently treated as "no registrations." Strict Codex remains unsupported and unclaimed; exact equivalence for the real `codex exec --sandbox workspace-write` policy against the zero-model helper probe was never proven, and that work is now deferred as optional future hardening rather than near-term scope — the zero-model helper probe alone was, and remains, necessary evidence but not sufficient. Codex worktree preparation now recognizes exactly the standard Git LFS checkout-filter profile (by key and value, never by name alone) and disables automatic LFS smudge/download for agent worktrees (`GIT_LFS_SKIP_SMUDGE=1`, scoped to the one checkout invocation); every other checkout filter is still rejected, and Hall never installs, configures, or invokes Git LFS itself.

Trusted-local Codex mode is separate and explicitly opt-in. It bypasses Codex's sandbox and approval enforcement and runs with the Hall Core process user's filesystem permissions. Do not confuse it with strict isolated mode.

Hall does not claim generic secret detection. It prevents unsafe storage categories such as raw stdout, raw stderr, raw command lines, environment maps, arbitrary provider payloads, and provider authentication files.

## Phase Roadmap

Completed major phases include the monorepo foundation, adapter SDK, Mock Agent, Hall Runner, Hall Core, Hall Web, Claude Code and Codex adapters, routing, comparison worktrees, durable SQLite recovery, CEO planning, autonomous CEO plan execution, Hall-owned agent worktrees, bounded execution artifacts, isolated orchestration, strict isolated Codex compatibility infrastructure, restart-safe worktree reconciliation and cleanup (Phase 16.5, including its post-merge hardening), and Codex trusted-local production readiness with Git LFS worktree compatibility (Phase 16.6).

Last Completed and Merged Phase:

- Phase 16.5 — Restart-Safe Worktree Reconciliation and Cleanup

Current (implemented on a branch, pending review and merge):

- Phase 16.6 — Codex Trusted-Local Production Readiness and Git LFS Worktree Compatibility

Deferred future work includes strict, OS-sandboxed Codex isolation (optional future hardening, fail-closed and unclaimed until a future phase proves exact policy equivalence), additional coding-agent adapters, production authentication, richer policy controls, public artifact routes/UI, merge workflows, and deployment integrations.
