# Hall of Wisdom

Hall of Wisdom is a local, cross-platform Agent OS for coordinating coding agents (Claude Code,
Codex, and others) against your own projects — while keeping your provider credentials on your own
machine. Hall never collects passwords, API keys, or subscription auth files; each agent runs
through your own already-authenticated local CLI.

This README's **Getting Started** section is the normal path for a Windows user: clone, install,
start, connect a provider, run a task. Everything past that — manual CLI flags, architecture docs,
package internals, security details — is for contributors and is clearly marked **For Developers**
below.

## Getting Started

### 1. Requirements

- [Node.js](https://nodejs.org/) `>=24.11.0 <25`
- [pnpm](https://pnpm.io/installation) `10.33.0`
- [Git](https://git-scm.com/downloads) — recent enough to support `git worktree list --porcelain -z`
  (confirmed against Git 2.54)
- Windows 10/11 (the installer and launcher below are PowerShell scripts)

### 2. Clone the repository

```powershell
git clone https://github.com/Shaf2665/HallOfWisdom.git
cd HallOfWisdom
```

### 3. Install

```powershell
.\install.ps1
```

This checks your prerequisites, asks where you keep your projects (and, if you want, a data
directory and an agent-worktree directory), asks whether to enable Codex trusted-local mode
(default **No** — this is where that opt-in actually happens; see step 5 below for what it means),
installs dependencies, builds Hall, and saves your answers so you never have to type them again. Run
it again any time — it detects an existing configuration and offers to keep it (and re-verify the
install) or reconfigure it. See
[`docs/architecture/0017-persistent-hall-configuration.md`](docs/architecture/0017-persistent-hall-configuration.md).

### 4. Start Hall

```powershell
.\start.ps1
```

This loads the configuration `install.ps1` saved, starts Hall Core and Hall Web, waits until both
are ready, and opens Hall in your browser automatically. See
[`docs/architecture/0019-one-command-hall-launcher.md`](docs/architecture/0019-one-command-hall-launcher.md).

### 5. Connect a provider

Open the **Providers** page from the navigation bar. It shows Claude Code and Codex, each as
**Connected** or **Not connected**, with plain-language guidance and a **Connect** button that
shows the provider's own official sign-in command — Hall never touches your password, API key, or
login session:

- **Claude Code** is the recommended default provider. Connect shows `claude auth login`; run that
  command yourself in your own terminal.
- **Codex** connects via `codex login`, shown and run the same way. **Codex trusted-local mode is
  explicit opt-in and is not OS-sandboxed** — it bypasses Codex's own sandbox and approval
  enforcement and runs with your own filesystem permissions. Only enable it (during `install.ps1`,
  step 3 above) if you understand and accept that; it is never turned on automatically just because
  Codex is authenticated.

After running the command in your terminal, click **Recheck** on the Providers page to confirm the
connection. See
[`docs/architecture/0018-provider-connection-onboarding.md`](docs/architecture/0018-provider-connection-onboarding.md).

### 6. Create and run your first task

From the **Task Console**, fill in **Create Task** — Project, Title, and **Agent** (pick a connected
provider, or **Mock Agent** for a dry run that needs nothing connected; unavailable agents are
greyed out) — and submit. The task is created already assigned to that agent, and its live event
stream appears in the detail panel on the right of the Task Console. Go to the **Kanban Board**,
find the card in the **Assigned** column, and click **Start task** (it asks you to confirm) to begin
the run.

### 7. Stop Hall

Go back to the terminal where you ran `.\start.ps1` and press **Ctrl+C**. Both Hall Core and Hall
Web are stopped cleanly — no processes are left running in the background.

### 8. Troubleshooting

- **`.\install.ps1` says a prerequisite is missing** — install (or upgrade) the tool it names from
  the links in step 1, then run `.\install.ps1` again.
- **`.\start.ps1` says a port is already in use** — something else is already listening on your
  configured Hall Core/Hall Web port. Close it. (`install.ps1` doesn't currently prompt for a custom
  port — the default ports are 4310 for Hall Core and 3000 for Hall Web.)
- **`.\start.ps1` says a build is missing** — run `.\install.ps1` again; it rebuilds Hall.
- **A provider shows "Not connected" after you ran its login command** — click **Recheck** on the
  Providers page; if it's still not connected, re-run the command shown and check your terminal for
  errors from the provider's own CLI.
- **You want to start over** — run `.\install.ps1` again and choose "Reconfigure Hall."

## For Developers

Everything below this point is for contributors working on Hall itself, or for anyone who needs to
start Hall Core/Hall Web manually with specific flags instead of through `install.ps1`/`start.ps1`.

### Manual setup and manual startup

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

Once `--agent-worktree-root` has been used with a given `--data-dir`, every later startup against
that same data directory must keep supplying the exact same root — a different root, or omitting
the flag entirely, fails startup closed (see "Security Limitations" below).

Trusted-local Codex mode is dangerous and optional. It bypasses Codex's own sandbox and approval
enforcement, and should not be used as the default:

```powershell
pnpm --filter @hall-of-wisdom/hall-core run dev -- `
  --workspace-root "D:\HallOfWisdom" `
  --port 4310 `
  --mock-scenario success `
  --web-origin "http://127.0.0.1:3000" `
  --enable-codex-trusted-local
```

For an already-built Hall Core binary:

```powershell
pnpm --filter @hall-of-wisdom/hall-core run build
node apps/server/dist/server.js `
  --workspace-root "D:\HallOfWisdom" `
  --port 4310 `
  --mock-scenario success
```

`node apps/server/dist/server.js` with **no flags at all** also works if you've already run
`.\install.ps1` — it loads your saved configuration the same way `.\start.ps1` does.

### Features

Hall Core is a localhost-only Fastify HTTP and WebSocket server. It can create tasks, assign
adapters, stream normalized events, store durable state when SQLite mode is enabled, run
deterministic Mock Agent tasks, route by capability and trust, compare agents in isolated comparison
worktrees, and drive approved CEO plan execution. Hall Web is a local Next.js dashboard for task,
board, communication, providers, system, comparison, and CEO workflows.

Real provider adapters use the operator's locally installed CLIs and local subscription
authentication. Hall does not collect provider credentials, API keys, auth files, or raw provider
output.

### Architecture

Key architecture documents:

- [`AGENTS.md`](AGENTS.md)
- [`docs/architecture/0001-initial-architecture.md`](docs/architecture/0001-initial-architecture.md)
- [`docs/architecture/0008-claude-code-adapter.md`](docs/architecture/0008-claude-code-adapter.md)
- [`docs/architecture/0009-codex-adapter.md`](docs/architecture/0009-codex-adapter.md)
- [`docs/architecture/0010-paperclip-compatible-codex-mode.md`](docs/architecture/0010-paperclip-compatible-codex-mode.md)
- [`docs/architecture/0013-durable-persistence-and-recovery.md`](docs/architecture/0013-durable-persistence-and-recovery.md)
- [`docs/architecture/0015-autonomous-plan-execution-and-scheduling.md`](docs/architecture/0015-autonomous-plan-execution-and-scheduling.md)
- [`docs/architecture/0016-codex-worktree-execution.md`](docs/architecture/0016-codex-worktree-execution.md)
- [`docs/architecture/0017-persistent-hall-configuration.md`](docs/architecture/0017-persistent-hall-configuration.md)
- [`docs/architecture/0018-provider-connection-onboarding.md`](docs/architecture/0018-provider-connection-onboarding.md)
- [`docs/architecture/0019-one-command-hall-launcher.md`](docs/architecture/0019-one-command-hall-launcher.md)

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

### Packages

| Package                               | Purpose                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| `@hall-of-wisdom/protocol`            | Provider-neutral wire and validation contracts.                                |
| `@hall-of-wisdom/agent-adapter-sdk`   | Adapter interface, task input, detection, events, and terminal guards.         |
| `@hall-of-wisdom/mock-agent`          | Deterministic local adapter for tests and development.                         |
| `@hall-of-wisdom/claude-code-adapter` | Local Claude Code CLI adapter.                                                 |
| `@hall-of-wisdom/codex-adapter`       | Local Codex CLI adapter with strict and trusted-local profiles.                |
| `@hall-of-wisdom/hall-config`         | Persisted, schema-validated Hall configuration (Phase 17.1).                   |
| `@hall-of-wisdom/hall-runner`         | Local task runner and adapter registry.                                        |
| `@hall-of-wisdom/hall-core`           | Local Fastify server, stores, orchestration, recovery, and Phase 16 internals. |
| `@hall-of-wisdom/web`                 | Next.js browser dashboard.                                                     |
| `@hall-of-wisdom/e2e`                 | Playwright E2E fixtures, not included in ordinary `pnpm test`.                 |

### Development and Validation

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

PowerShell installer/launcher test suites (both `pwsh` and Windows PowerShell 5.1 are expected to
pass identically):

```powershell
pwsh -NoProfile -File scripts/install/tests/run-tests.ps1
pwsh -NoProfile -File scripts/launch/tests/run-tests.ps1
powershell -NoProfile -File scripts/install/tests/run-tests.ps1
powershell -NoProfile -File scripts/launch/tests/run-tests.ps1
```

### Security Limitations

Hall binds locally to `127.0.0.1` and is still a prototype. It has no production authentication
layer. SQLite durability is optional. Phase 16 worktrees are cleaned up automatically — after
artifact persistence at runtime, and via restart reconciliation for anything a crash interrupted —
but cleanup is deliberately conservative: Git remains the primary removal mechanism whenever it
still has a registration to act on (`git worktree remove --force`, never a recursive filesystem
delete); only once Git no longer registers a path at all may Hall remove what remains of it itself,
and only an exact, freshly-revalidated, provably empty top-level directory — never a recursive
delete, never `fs.rm`, never `git worktree prune`/`git clean`. A non-empty residual directory, a
symlink/junction, or any path whose identity cannot be proven fresh is retained, not deleted, and
cleanup fails closed with a bounded code; restart reconciliation converges a `cleanup_failed` record
left in exactly this state to `cleaned` using the identical checks. A `--data-dir` durably remembers
the `--agent-worktree-root` it was first started with, the same way it already remembers
`--workspace-root`; reusing that data directory against a different (or omitted) worktree root fails
startup closed rather than silently reconciling — or failing to reconcile — the wrong set of
worktrees. Git worktree registration inspection uses one strict, NUL-delimited parser everywhere a
registration list is read, so malformed, incomplete, or unexpectedly structured Git output is never
silently treated as "no registrations."

**Strict, OS-sandboxed Codex isolation remains deferred as optional future hardening and stays
fail-closed.** Exact equivalence for the real `codex exec --sandbox workspace-write` policy against
Hall's zero-model helper probe was never proven, and strict mode is not a near-term goal — it is not
required for normal application functionality. Trusted-local Codex mode is separate and explicitly
opt-in: it bypasses Codex's sandbox and approval enforcement and runs with the Hall Core process
user's filesystem permissions. Do not confuse trusted-local with strict isolated mode. Codex worktree
preparation recognizes exactly the standard Git LFS checkout-filter profile (by key and value, never
by name alone) and disables automatic LFS smudge/download for agent worktrees; every other checkout
filter is still rejected, and Hall never installs, configures, or invokes Git LFS itself.

Hall does not claim generic secret detection. It prevents unsafe storage categories such as raw
stdout, raw stderr, raw command lines, environment maps, arbitrary provider payloads, and provider
authentication files.

### Phase Roadmap

Completed major phases include the monorepo foundation, adapter SDK, Mock Agent, Hall Runner, Hall
Core, Hall Web, Claude Code and Codex adapters, routing, comparison worktrees, durable SQLite
recovery, CEO planning, autonomous CEO plan execution, Hall-owned agent worktrees, bounded execution
artifacts, isolated orchestration, strict isolated Codex compatibility infrastructure, restart-safe
worktree reconciliation and cleanup (Phase 16.5), Codex trusted-local production readiness with Git
LFS worktree compatibility (Phase 16.6), and Phase 17's onboarding milestone (below). The Phase 16
milestone is complete.

**Phase 17 — Windows Onboarding (complete):**

- **17.1 — Persistent Hall Configuration & Interactive Installer.** `.\install.ps1` and
  `@hall-of-wisdom/hall-config` (see
  [`0017-persistent-hall-configuration.md`](docs/architecture/0017-persistent-hall-configuration.md)).
- **17.2 — Provider Connection & Authentication UX.** The Providers page, guide-only Connect (see
  [`0018-provider-connection-onboarding.md`](docs/architecture/0018-provider-connection-onboarding.md)).
- **17.3 — One-Command Hall Launcher.** `.\start.ps1` (see
  [`0019-one-command-hall-launcher.md`](docs/architecture/0019-one-command-hall-launcher.md)).
- **17.4 — User Documentation & Phase 17 Release Verification.** This README, plus an end-to-end
  release verification of install → persisted config → launcher → browser-accessible Hall →
  Providers page → clean shutdown, run against disposable configuration. The installer and launcher
  unit test suites (`scripts/install/tests/`, `scripts/launch/tests/`) pass on both `pwsh` and
  Windows PowerShell 5.1, as they already did before this phase; the new chained release-verification
  smoke test itself runs under `pwsh` only.

Last Completed and Merged Phase:

- Phase 17.4 — User Documentation & Phase 17 Release Verification (closes the Phase 17 milestone)

Deferred future work includes strict, OS-sandboxed Codex isolation (optional future hardening,
fail-closed and unclaimed unless a future phase proves exact policy equivalence — not required for
normal application functionality), additional coding-agent adapters, production authentication,
richer policy controls, public artifact routes/UI, merge workflows, and deployment integrations.
