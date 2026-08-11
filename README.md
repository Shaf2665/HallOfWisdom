# Hall of Wisdom

Hall of Wisdom is a local, cross-platform Agent OS for coordinating coding agents against your own
projects. The current alpha supports **Claude Code**, **Codex**, and **Hermes Router** through one
task, routing, event, and recovery workflow.

Claude Code and Codex use their locally installed CLIs and their own local authentication. Hermes
uses a local Hermes Coding Runtime connected to a Hermes Router endpoint. Hall does not provide
upstream OpenRouter or model-provider credentials to the router; Hermes uses a separate proxy/client
key saved locally by Hall or supplied through an advanced environment override.

The normal path on Windows, Linux, and macOS is: clone, install, start, configure a provider, and run
a task. Contributor commands and architecture details are under [For Developers](#for-developers).

## Getting Started

### 1. Requirements

- [Node.js](https://nodejs.org/) `>=22.13.0 <23 || >=24.11.0 <25` (Node 22 or 24 LTS)
- [pnpm](https://pnpm.io/installation) `>=10.0.0 <11` (`packageManager` pins 10.33.0 for deterministic installs)
- [Git](https://git-scm.com/downloads) — recent enough to support
  `git worktree list --porcelain -z` (confirmed against Git 2.54)
- Windows 10/11 with PowerShell, or Linux/macOS with Bash
- At least one coding provider you intend to use:
  - Claude Code CLI
  - Codex CLI
  - a local Hermes Coding Runtime and reachable Hermes Router endpoint

### 2. Clone the repository

```text
git clone https://github.com/Shaf2665/HallOfWisdom.git
cd HallOfWisdom
```

### 3. Install

Windows (PowerShell):

```powershell
.\install.ps1
```

Linux/macOS (Bash):

```bash
./install.sh
```

The installer checks prerequisites, installs dependencies, builds Hall, and saves your local
configuration. It asks for:

- the directory containing projects Hall may work with;
- a durable data directory;
- a Hall-owned agent-worktree directory;
- an optional comparison-worktree directory.

The Windows installer also offers the existing Codex trusted-local opt-in. The Bash installer keeps
that setting disabled on a first install and preserves it when reconfiguring an existing setup.

Keep the durable data and agent-worktree directories configured if you intend to use Hermes. They
allow Hall to persist run state and keep Hermes away from the original project checkout. Run the
installer again to verify or change the saved configuration. See
[`docs/architecture/0017-persistent-hall-configuration.md`](docs/architecture/0017-persistent-hall-configuration.md).

### 4. Start Hall

Windows (PowerShell):

```powershell
.\start.ps1
```

Linux/macOS (Bash):

```bash
./start.sh
```

The launcher loads the saved configuration, starts Hall Core and Hall Web, waits for both services,
and opens Hall in your browser. See
[`docs/architecture/0019-one-command-hall-launcher.md`](docs/architecture/0019-one-command-hall-launcher.md).

### 5. Configure a provider

Open **Providers** from the navigation bar. The page shows exactly:

- Claude Code
- Codex
- Hermes Router

Each card is driven by Hall Core detection and shows **Connected** or **Not connected** with
provider-specific guidance. Click **Recheck** after changing a provider's setup.

#### Claude Code and Codex

- **Claude Code** is the recommended default. **Connect** shows `claude auth login`; run it in your
  own terminal.
- **Codex** uses `codex login` in the same way.
- Codex trusted-local execution is a separate, explicit installer opt-in. It is not OS-sandboxed and
  runs with the Hall Core process user's filesystem permissions.

Hall does not collect or store either CLI's password, subscription token, auth files, or login
session.

#### Hermes Router

Hermes is **Connected** only when both conditions are true:

1. the local Hermes runtime and configured router pass detection; and
2. Hall is running with durable SQLite state and its Hall-owned agent-worktree infrastructure.

Otherwise Hermes remains **Not connected** and the card displays the server-provided reason. Hermes
cannot run from Hall's ephemeral mode or directly against the source checkout.

Open **Settings → Hermes Router**, click **Set up Hermes**, and enter the runtime folder, router base
URL, and Hermes proxy/client key. Python is optional under **Advanced**. Hall saves non-secret values
in its normal local configuration and keeps the client key in a separate user-local secret file;
the UI never displays a saved key. Never enter an upstream OpenRouter or provider key.

Existing `HALL_HERMES_ROUTER_ROOT`, `HERMES_ROUTER_BASE_URL`, `HERMES_ROUTER_API_KEY`, and
`HALL_HERMES_PYTHON` values remain supported as advanced overrides. They take precedence over saved
settings when Hall Core starts with them.

### 6. Create and run your first task

1. Open **Task Console**.
2. Select the project, enter a title and optional description, and choose a connected agent.
3. Create the task.
4. Open **Kanban Board** and find the task in **Assigned**.
5. Click **Start task** and confirm.
6. Watch normalized events and results in the task details.

Coding-agent execution uses Hall-owned isolated worktrees where supported and configured. Hermes
always receives a Hall-created worktree, never the original project checkout. Hall records the
terminal result and execution artifact, then cleans up the worktree through its shared lifecycle.

### 7. Stop Hall

Return to the terminal running the launcher and press **Ctrl+C**. Hall Core and Hall Web shut down
cleanly.

### 8. Troubleshooting

- **A prerequisite is missing** — install or upgrade the named tool, then rerun your platform's
  installer.
- **A port is already in use** — stop the process using the configured port. Defaults are 4310 for
  Hall Core and 3000 for Hall Web.
- **A build is missing** — rerun your platform's installer.
- **Claude Code or Codex is Not connected** — run the card's CLI login command, then click
  **Recheck**.
- **Hermes is Not connected** — read the card's server-provided guidance. Confirm the runtime root,
  router endpoint, proxy key, durable data directory, and agent-worktree directory in **Settings →
  Hermes Router**, then click **Recheck**.
- **You want to reconfigure Hall** — rerun your platform's installer and choose **Reconfigure
  Hall**.

## Current Features

- **Task Console** — create, assign, start, and monitor tasks.
- **Kanban boards** — manage task state through the delivery workflow.
- **Communication boards** — keep structured project and task discussions.
- **Provider detection and onboarding** — server-driven status, setup guidance, and Recheck.
- **Claude Code** — local CLI execution with normalized Hall events.
- **Codex** — local CLI execution with explicit trust profiles.
- **Hermes Router** — local runtime detection, transport, events, cancellation, and isolated runs.
- **Capability/trust routing** — assign only adapters that satisfy task and execution policy.
- **Isolated agent worktrees** — Hall-owned Git worktrees for supported coding-agent runs.
- **Execution artifacts** — immutable run evidence and repository-change summaries.
- **Durable SQLite state and recovery** — persisted tasks, events, plans, artifacts, and cleanup state.
- **Agent comparison** — run candidates in isolated comparison worktrees.
- **CEO planning and autonomous execution** — approve, delegate, schedule, and recover multi-step
  plans.
- **Restart-safe cleanup and recovery** — reconcile interrupted runs and conservatively resume
  worktree cleanup.
- **One-command cross-platform onboarding** — PowerShell on Windows and Bash on Linux/macOS.

## For Developers

### Manual setup

```powershell
git clone https://github.com/Shaf2665/HallOfWisdom.git
cd HallOfWisdom
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Start Hall Web in one terminal:

```powershell
pnpm --filter @hall-of-wisdom/web run dev
```

For normal durable development, start Hall Core in another terminal:

```powershell
pnpm --filter @hall-of-wisdom/hall-core run dev -- `
  --workspace-root "D:\Projects" `
  --data-dir "D:\HallOfWisdomData" `
  --agent-worktree-root "D:\HallOfWisdomAgentWorktrees" `
  --port 4310 `
  --web-origin "http://127.0.0.1:3000"
```

Real Hermes routing requires all of the following:

- durable SQLite mode through `--data-dir`;
- a Hall-owned `--agent-worktree-root`; and
- Hermes setup saved from Settings (or the advanced environment overrides documented above).

Hermes deliberately remains unavailable in ephemeral mode. Once an agent-worktree root has been
used with a data directory, later startup against that data directory must supply the same root.

Ephemeral mode remains useful for UI and Mock Agent development:

```powershell
pnpm --filter @hall-of-wisdom/hall-core run dev -- `
  --workspace-root "D:\Projects" `
  --port 4310 `
  --mock-scenario success `
  --web-origin "http://127.0.0.1:3000"
```

Open `http://127.0.0.1:3000`.

Trusted-local Codex mode is optional and bypasses Codex sandbox and approval enforcement. Enable it
only when intended with `--enable-codex-trusted-local`. An already-built Hall Core can be started
with `node apps/server/dist/server.js`; without flags it loads the configuration saved by the
platform installer.

### Hermes architecture

```text
Hall task
  -> Hall isolated worktree
  -> local Hermes Coding Runtime
  -> Hermes Router
  -> configured model/provider
```

Hall owns task orchestration, normalized lifecycle state, artifacts, and worktree creation/cleanup.
The local Hermes runtime owns coding tools. Hermes Router owns model/provider routing; it does not
execute Hall filesystem or command tools.

### Architecture

Key documents:

- [`AGENTS.md`](AGENTS.md)
- [`docs/architecture/0001-initial-architecture.md`](docs/architecture/0001-initial-architecture.md)
- [`docs/architecture/0008-claude-code-adapter.md`](docs/architecture/0008-claude-code-adapter.md)
- [`docs/architecture/0009-codex-adapter.md`](docs/architecture/0009-codex-adapter.md)
- [`docs/architecture/0011-agent-capabilities-trust-and-routing.md`](docs/architecture/0011-agent-capabilities-trust-and-routing.md)
- [`docs/architecture/0013-durable-persistence-and-recovery.md`](docs/architecture/0013-durable-persistence-and-recovery.md)
- [`docs/architecture/0015-autonomous-plan-execution-and-scheduling.md`](docs/architecture/0015-autonomous-plan-execution-and-scheduling.md)
- [`docs/architecture/0017-persistent-hall-configuration.md`](docs/architecture/0017-persistent-hall-configuration.md)
- [`docs/architecture/0018-provider-connection-onboarding.md`](docs/architecture/0018-provider-connection-onboarding.md)
- [`docs/architecture/0019-one-command-hall-launcher.md`](docs/architecture/0019-one-command-hall-launcher.md)

### Packages

| Package                                 | Purpose                                                         |
| --------------------------------------- | --------------------------------------------------------------- |
| `@hall-of-wisdom/protocol`              | Provider-neutral wire and validation contracts.                 |
| `@hall-of-wisdom/agent-adapter-sdk`     | Adapter interfaces, detection, events, and terminal guards.     |
| `@hall-of-wisdom/mock-agent`            | Deterministic adapter for tests and development.                |
| `@hall-of-wisdom/claude-code-adapter`   | Local Claude Code CLI execution and normalized events.          |
| `@hall-of-wisdom/codex-adapter`         | Local Codex CLI execution with strict and trusted-local modes.  |
| `@hall-of-wisdom/hermes-router-adapter` | Hermes detection, transport, event lifecycle, and Hall adapter. |
| `@hall-of-wisdom/hall-config`           | Persisted, schema-validated Hall configuration.                 |
| `@hall-of-wisdom/hall-runner`           | Local task runner and adapter registry.                         |
| `@hall-of-wisdom/hall-core`             | HTTP/WebSocket server, orchestration, stores, and recovery.     |
| `@hall-of-wisdom/web`                   | Next.js local dashboard.                                        |
| `@hall-of-wisdom/e2e`                   | Playwright E2E fixtures outside ordinary `pnpm test`.           |

### Development and validation

```powershell
pnpm typecheck
pnpm lint
pnpm format
pnpm test
pnpm build
pnpm verify:process-recovery
pnpm verify:package-entry
```

### Security limitations

Hall binds to `127.0.0.1` and remains alpha software without a production authentication layer.
Durable SQLite state is optional generally, but mandatory for Hermes routing.

Hall-owned worktrees isolate coding changes from the source checkout; they are not an OS sandbox.
Cleanup is deliberately conservative: Git remains the primary removal mechanism, and ambiguous,
redirected, or non-empty residual paths are retained and reported rather than recursively deleted.
Restart reconciliation resumes interrupted artifact and worktree cleanup using the same checks.

Strict OS-sandboxed Codex compatibility remains deferred. Trusted-local Codex is an explicit opt-in
that bypasses Codex's sandbox and approval enforcement. Hall prevents unsafe persistence categories
such as raw stdout/stderr, environment maps, arbitrary provider payloads, and upstream provider
auth files. The Hermes proxy/client key is the narrow exception: it is stored separately in Hall's
user-local configuration directory and never returned by the API or displayed in Settings. Hall
does not claim generic secret detection.

## Current Project Status

Hall of Wisdom is a working local alpha. Root launchers provide the same install, persisted-config,
start, and clean-shutdown flow through PowerShell on Windows and Bash on Linux/macOS.

Hermes Router integration is complete for the current alpha scope, including runtime/router
detection, validated execution and event handling, cancellation, Hall-owned isolated-worktree
routing, artifacts/recovery integration, and Providers onboarding. Hermes becomes assignable only
when its runtime is healthy and Hall's durable isolation prerequisites are active.

The project is not production-hardened. Future work may include stronger authentication, richer
policy controls, public artifact workflows, merge flows, and deployment integrations; no additional
development phase is implied by this status summary.
