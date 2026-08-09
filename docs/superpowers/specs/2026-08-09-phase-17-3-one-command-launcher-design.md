# Phase 17.3 — One-Command Hall Launcher — Design

Status: Approved for implementation planning.
Date: 2026-08-09
Starting commit: `43da3a185c9f53a560e02c498f4493fef65fa1c2` (origin/main, working tree clean)

## 1. Problem

A user who has completed `.\install.ps1` still has to know that Hall Core is
`apps/server/dist/server.js`, that Hall Web is `next start` on a hardcoded port, that the two must
be started in the right order with matching origins, and that stopping them cleanly on Windows is
not as simple as Ctrl+C. Phase 17.3 adds `.\start.ps1`: load the persisted config, start both
processes on their configured ports, wait until ready, open the browser, and keep both managed
together until the user stops the launcher.

## 2. What already exists (reused as-is, never duplicated)

- **`@hall-of-wisdom/hall-config`'s `tryLoadConfig()`** is already called unconditionally by
  `apps/server/src/server.ts` on every startup. Confirmed by reading `server.ts` and
  `resolve-server-config.ts`: **Hall Core can be started with `node apps/server/dist/server.js` and
  zero CLI flags** — `workspaceRoot`/`port`/`dataDir`/`agentWorktreeRoot`/`comparisonRoot`/
  `codexTrustedLocal` all resolve from the persisted config automatically, and `webOrigin` is
  *derived* from the resolved `hallWebPort` (`http://127.0.0.1:<hallWebPort>`), never a stored
  flat value — so the launcher never needs to compute or pass a `--web-origin` itself. This is the
  single biggest simplification available: the launcher's entire responsibility toward Hall Core's
  own configuration is "confirm a valid persisted config exists," never "pass its fields through."
- **The Windows stdin graceful-shutdown protocol**
  (`apps/server/src/process/signal-shutdown.ts`) already exists specifically because "Windows
  cannot deliver a real SIGINT/SIGTERM from a parent Node process to a child Node process" — the
  doc comment there documents this was empirically re-confirmed, including `SIGBREAK` and plain
  `taskkill` without `/F`. The mechanism: when Hall Core's stdin is a *pipe* (not a TTY), writing
  the literal line `SHUTDOWN\n` to it triggers the exact same graceful-shutdown path a real
  SIGINT/SIGTERM would. This is reused verbatim — the launcher spawns Hall Core with a redirected
  (piped) stdin specifically so this mechanism activates, and sends that command on shutdown.
- **`apps/e2e/src/durable-restart-harness.ts`** is the closest existing precedent for spawning both
  processes together from a script: `spawnDurableHallCore` (stdio `["pipe","inherit","inherit"]`,
  `child.stdin.write("SHUTDOWN\n")` to stop), `spawnDurableHallWeb` (spawns the `next` binary
  directly — not through a `pnpm run` script — with `["start"|"dev", "--hostname", "127.0.0.1",
  "--port", String(port)]` and `NEXT_PUBLIC_HALL_CORE_URL` as a process env var), and
  `waitForHallCoreHealth`/`waitForHallWebReady` (polling `/api/v1/health` and the app's own root,
  respectively). Phase 17.3 reuses the same endpoints and the same "spawn the `next` binary
  directly with explicit `--hostname`/`--port`" approach, translated into PowerShell.
- **`packages/hall-config/src/run-cli.ts`'s `status` command** already resolves its own config path
  via `resolveHallConfigFilePath()` when `--path` is omitted — the exact same function
  `server.ts`'s `tryLoadConfig()` uses with no argument. `scripts/install/HallConfigCli.ps1`'s
  `Invoke-HallConfigCli` currently always appends `--path <ConfigPath>`, forcing every caller to
  precompute the path — which is why `install.ps1` has its own `Get-HallInstallerConfigPath`
  (justified there *only* because it must run before any build exists, so the keep/reconfigure
  menu can appear first). `start.ps1` has no such ordering constraint (it assumes `install.ps1` has
  already run) and must not duplicate that path logic.
- **`NEXT_PUBLIC_HALL_CORE_URL`** is read from `process.env` at Next.js build time (`.env.local` —
  `apps/web/.env.local.example`, ADR 0005 — is only one *source* Next.js merges into that
  environment; a process env var set directly on the spawned build works identically, without
  writing any file). `install.ps1`'s `pnpm build` step does not set it, so today's build is only
  ever correct for the default Hall Core port (4310).
- **`scripts/install/tests/*.Tests.ps1` + `run-tests.ps1` + `TestHelpers.ps1`** establish this
  project's hand-rolled (non-Pester) PowerShell test convention: fake Node fixture scripts standing
  in for the real binaries, `Assert-True`/`Assert-False`/`Assert-Equal`/`Assert-Throws` helpers, one
  test file per module, collected by a tiny `run-tests.ps1` that globs `*.Tests.ps1`.
  `end-to-end-smoke-test.ps1` (deliberately **not** matching that glob) is the separate, explicitly-run,
  real-binary smoke test, and is the file that already runs part of `install.ps1` under both
  `pwsh` and Windows PowerShell 5.1 (`powershell.exe`) — the exact dual-host pattern Phase 17.3's
  lifecycle/Ctrl+C testing must follow.

## 3. Decisions from the approved design (binding on the plan)

1. **Hall Web is started with explicit `--hostname 127.0.0.1 --port <hallWebPort>`**, by invoking
   the `next` binary directly (mirroring `spawnDurableHallWeb`'s approach) — never through
   `apps/web`'s `package.json` `start` script, whose hardcoded `--port 3000` cannot be safely
   overridden by appending arguments.
2. **Build-freshness proof is a launcher-owned marker file inside `apps/web/.next`; no file is
   written under `apps/web` itself.** The launcher never touches `.env.local` — it passes
   `NEXT_PUBLIC_HALL_CORE_URL` directly in the *environment* of the spawned `pnpm --filter
   @hall-of-wisdom/web run build` process (and, for consistency, the spawned `next start` process
   too), which Next.js inlines into the client bundle exactly as it would from a `.env.local` file,
   with no file left in the working tree to go stale, get hand-edited, or need cleanup. The launcher
   writes `apps/web/.next/hall-launcher-build-marker.json` (`{ "hallCoreUrl": "http://127.0.0.1:<port>"
   }`) itself, immediately after a build it ran completes successfully — this is the sole source of
   truth for "what URL is actually baked into the current `.next` output," since nothing else
   records that fact anywhere. Before starting Hall Web, the launcher rebuilds (spawn the build with
   the env var set, then rewrite the marker) if and only if the marker is missing or its recorded
   URL differs from the persisted `hallCorePort`'s expected URL. **Accepted consequence:** the very
   first `.\start.ps1` run after `.\install.ps1` will always trigger exactly one rebuild to create
   the marker — even on the common default-port path, where the pre-existing `install.ps1`-built
   `.next` output was already correct — because an unmarked `.next` build carries no evidence of
   what it was built with. This is a one-time cost (the marker exists afterward) and strictly safer
   than trusting an unmarked build; not treated as a defect.
3. **`scripts/install/HallConfigCli.ps1` is minimally adapted, not duplicated.** `Invoke-HallConfigCli`'s
   `$ConfigPath` parameter changes from mandatory to optional; when omitted, `--path` is not
   appended to the `node dist/cli.js` invocation at all, letting `run-cli.ts`'s own
   `resolveHallConfigFilePath()` resolve it — the identical function `server.ts` itself uses. This
   guarantees `start.ps1` can never resolve a different config path than the Hall Core process it's
   about to launch. Purely additive: every existing call site (`install.ps1`, `Reconfigure.ps1`)
   continues to pass `-ConfigPath` explicitly and is unaffected. One new test case is added to the
   existing `HallConfigCli.Tests.ps1` covering the omitted-path fallback.
4. **Launcher tests live under `scripts/launch/tests/`**, with their own `run-tests.ps1` (identical
   shape to the install one). Fast, fixture-based tests exercise each module's functions directly.
   A separate `scripts/launch/tests/end-to-end-smoke-test.ps1` (not matching `*.Tests.ps1`, run
   explicitly, mirroring `install`'s own smoke test's role and its dual-host pattern) does a real
   build-artifact launch against an isolated, temp-directory persisted config, and verifies
   lifecycle/shutdown — including a **real** console signal delivered to the launcher child process.
   `GenerateConsoleCtrlEvent(CTRL_C_EVENT, pid)` cannot target an arbitrary process group on
   Windows — `CTRL_C_EVENT` only ever reaches the caller's own console group (group ID `0`). The
   correct, documented technique: spawn the `start.ps1` child under `CREATE_NEW_PROCESS_GROUP`
   (via a small `Add-Type` P/Invoke helper — `System.Diagnostics.Process` exposes no managed way to
   set Win32 creation flags), then call `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, childPid)` to
   target that specific group. `System.Console`'s `CancelKeyPress` event fires identically for
   `ConsoleSpecialKey.ControlC` *and* `ControlBreak` — so `Register-HallLauncherCtrlCHandler`'s
   single handler, exactly as designed for real interactive Ctrl+C, is what the test exercises;
   nothing product-side is Ctrl+Break-specific. Verified under both `pwsh` and `powershell.exe`,
   asserting no orphaned Hall Core/Hall Web process remains afterward on either host.

## 4. Architecture

`start.ps1` (thin driver at repo root, mirrors `install.ps1`'s shape and its
`HALL_START_PS1_UNDER_TEST` dot-source guard) dot-sources four new modules under `scripts/launch/`,
plus the existing `scripts/install/HallConfigCli.ps1`:

- **`scripts/launch/ConfigLoad.ps1`** — `Get-HallLauncherConfig -RepoRoot $RepoRoot`: calls
  `Invoke-HallConfigStatus -RepoRoot $RepoRoot` (no `-ConfigPath` — decision 3) and translates the
  result into either a normalized config object or a thrown, actionable error ("no persisted Hall
  configuration found — run `.\install.ps1` first" / "the persisted configuration is invalid: ...").
- **`scripts/launch/PortCheck.ps1`** — `Test-HallPortFree -Port <n> -ServiceName <label>`: a TCP
  connect probe; throws a clear "port `<n>` is already in use (needed for `<label>`)" error if
  occupied. Called for both `hallCorePort` and `hallWebPort` before spawning anything.
- **`scripts/launch/WebBuildEnv.ps1`** — build-freshness (decision 2): `Get-HallWebBuildMarkerPath`,
  `Get-HallWebBuildMarker` (reads/parses the marker, `$null` if absent/unreadable),
  `Invoke-HallWebBuildIfStale -RepoRoot $RepoRoot -HallCoreUrl <url>` (the orchestrating function:
  compares the marker; if missing or stale, spawns `pnpm --filter @hall-of-wisdom/web run build`
  with `NEXT_PUBLIC_HALL_CORE_URL=<url>` set in that process's environment only — no file written
  under `apps/web` — and, only once that build exits 0, writes the marker; throws a clear error if
  the build itself fails, and the marker is never written in that case — "missing/invalid build"
  failure mode).
- **`scripts/launch/ProcessManagement.ps1`** — the core piece:
  - `Start-HallCoreProcess -RepoRoot $RepoRoot` — spawns `node apps/server/dist/server.js` with
    **zero arguments** (decision: reuse `tryLoadConfig()`'s own resolution, §2) via
    `System.Diagnostics.Process` with `RedirectStandardInput = $true` (needed for the stdin
    shutdown command) and inherited stdout/stderr (so the user sees Hall Core's own log lines,
    matching the harness's `stdio: ["pipe","inherit","inherit"]`). Throws a clear "Hall Core build
    not found — run `.\install.ps1`" error if `dist/server.js` is missing (reusing
    `Get-HallServerDistPath` from `scripts/install/Verification.ps1` — no duplication).
  - `Start-HallWebProcess -RepoRoot $RepoRoot -Port <hallWebPort> -HallCoreUrl <url>` — spawns the
    `next` binary directly (decision 1) with `["start", "--hostname", "127.0.0.1", "--port",
    "<port>"]`, `cwd` = `apps/web`, `NEXT_PUBLIC_HALL_CORE_URL` set in its environment (matching
    decision 3's env-only approach — Next's production server does not re-read `NEXT_PUBLIC_*` at
    runtime since it's already inlined into the built client bundle, but setting it on `next start`
    too costs nothing, keeps every spawned Hall Web process's environment consistent regardless of
    phase, and matches the dev-mode harness precedent). Throws a clear error if the `next` binary or
    `.next` build output is missing.
  - `Wait-HallCoreHealthy -Port <n> -TimeoutSeconds <t>` / `Wait-HallWebReady -Port <n>
    -TimeoutSeconds <t>` — polling loops (250ms interval) against `/api/v1/health` and Hall Web's
    root `/`, respectively (same endpoints the e2e harness already polls), throwing a clear timeout
    error that names which service never became ready. Defaults: 30s for Hall Core, 60s for Hall
    Web (a cold `next start` is measurably slower than Fastify's own boot).
  - `Stop-HallLauncherProcess -Process <proc> -ServiceName <label>` — the shared shutdown routine:
    if the process exposes a redirected stdin (Hall Core), writes `SHUTDOWN\n` and flushes; waits up
    to a 5-second grace period (polling every 250ms) for exit; if still alive at that point (either
    it ignored the stdin command, or it's Hall Web which has no such protocol), falls back to
    `taskkill /PID <id> /T /F` — killing the full process tree, never just the top process, so a
    `next start` worker can never be left orphaned. Idempotent — safe to call on an already-exited
    process (checks `-HasExited` first).
  - `Register-HallLauncherCtrlCHandler -OnShutdown <scriptblock>` — wraps
    `Register-ObjectEvent -InputObject ([Console]) -EventName CancelKeyPress` (the established,
    working PowerShell 5.1-and-pwsh pattern for intercepting Ctrl+C without immediately terminating
    the host process), setting `$EventArgs.Cancel = $true` and invoking the shutdown scriptblock.

`start.ps1`'s top-level flow (`Invoke-HallLauncher`):

```
1. Get-HallLauncherConfig                          (fail: no/invalid config)
2. verify apps/server/dist/server.js exists         (fail: missing build)
3. Test-HallPortFree for hallCorePort and hallWebPort (fail: occupied port)
4. Invoke-HallWebBuildIfStale                        (fail: build error)
5. Start-HallCoreProcess; Wait-HallCoreHealthy       (fail: child startup failure -> nothing else running yet, just exit)
6. Start-HallWebProcess; Wait-HallWebReady           (fail: child startup failure -> Stop-HallLauncherProcess the Core child, THEN exit)
7. Start-Process "http://127.0.0.1:<hallWebPort>"    (open default browser)
8. Register-HallLauncherCtrlCHandler + a monitoring loop that also detects either child exiting
   unexpectedly (crash) and treats that identically to Ctrl+C: stop the other child, report which
   one failed, exit non-zero.
9. On Ctrl+C: Stop-HallLauncherProcess for both children (Web first, then Core - the reverse of
   startup order), exit 0.
```

## 5. Explicitly out of scope for this phase

No admin requirement, `Invoke-Expression`, Windows services, tray app, autostart/startup-folder
registration, or any UI beyond opening the default browser to Hall Web's URL. No changes to
`install.ps1`'s own flow beyond the minimal `HallConfigCli.ps1` adaptation (decision 3). No changes
to Hall Core's or Hall Web's own runtime behavior — `start.ps1` only ever spawns the existing
built artifacts with the argument/env shapes described above; no new server-side flags, routes, or
config fields. No Phase 17.4 (this phase does not attempt anything beyond "start it").

## 6. Tests

- **`scripts/launch/tests/*.Tests.ps1`** (fixture-based, fast, run via `scripts/launch/tests/run-tests.ps1`):
  - `PortCheck.Tests.ps1` — a real bound TCP listener makes `Test-HallPortFree` throw; an unbound
    port passes.
  - `WebBuildEnv.Tests.ps1` — marker absent → rebuild triggered (a fake build script, standing in
    for `pnpm run build`, asserts it actually received `NEXT_PUBLIC_HALL_CORE_URL` in its own
    process environment — not a file — before writing its sentinel, and confirms no `.env.local` is
    ever created); marker present with matching URL → no rebuild (fake build never invoked); marker
    present with a *different* URL (simulating a `hallCorePort` change since the last launch) →
    rebuild triggered; a failing fake build (non-zero exit) → clear thrown error, marker not
    written/not updated.
  - `ProcessManagement.Tests.ps1` — a fake Hall-Core-shaped Node fixture (opens a port, serves
    `/api/v1/health`, honors the `SHUTDOWN` stdin line) and a fake Hall-Web-shaped fixture (opens a
    port, serves `/`, ignores stdin — proving the `taskkill` fallback path is what actually stops
    it): `Wait-HallCoreHealthy`/`Wait-HallWebReady` succeed once the fixture is listening and time
    out with a clear message against a fixture that never opens its port; `Stop-HallLauncherProcess`
    cleanly stops both fixture flavors (graceful stdin path for the Core-shaped one, forced
    `taskkill` fallback for the Web-shaped one) with no lingering process afterward (checked via
    `Get-Process -Id <pid> -ErrorAction SilentlyContinue` returning nothing); a fixture that never
    exits even after `SHUTDOWN` (simulating a hang) is still reaped by the forced fallback within
    the test's bounded timeout.
  - `ConfigLoad.Tests.ps1` — a fake `hall-config` CLI (mirroring `HallConfigCli.Tests.ps1`'s
    pattern) returning `exists:false`/invalid/valid `status` responses, asserting
    `Get-HallLauncherConfig`'s three outcomes.
  - New test case appended to the existing `scripts/install/tests/HallConfigCli.Tests.ps1`: calling
    `Invoke-HallConfigStatus` **without** `-ConfigPath` omits `--path` from the invocation (asserted
    via the fake CLI echoing back what it received) and still round-trips correctly.
- **`scripts/launch/tests/end-to-end-smoke-test.ps1`** (real binaries, explicitly run, mirrors
  `install`'s smoke test's role): builds Hall Core + Hall Web for real once (or reuses an existing
  build), writes a real, isolated persisted config (its own `HALL_CONFIG_DIR` temp override, never
  the real user profile — same isolation `Invoke-HallVerifyOnly` already uses), runs the launcher's
  own functions to start both processes on non-default ports, confirms both become ready, then
  sends a **real console signal** (`CREATE_NEW_PROCESS_GROUP` + targeted `CTRL_BREAK_EVENT`,
  decision 4) and confirms clean, orphan-free shutdown — run once under `pwsh` and once under
  `powershell.exe` (Windows PowerShell 5.1), matching `install`'s own dual-host precedent exactly.
  Also covers a non-default-port launch end to end (satisfying "real persisted-config launch smoke"
  together with the isolated-config setup) and one failure-injection case for the "one child fails,
  clean up the other" requirement: port precheck happens before *any* process is spawned, so a
  pre-occupied port can never reach the "Core already healthy, Web then fails" path — instead, Hall
  Web is started pointed at the real, already-healthy Hall Core, then made to exit immediately with
  a non-zero code right after spawn (a wrapper around the real `next` invocation that forces this
  for the test, independent of port occupancy), simulating a genuine startup crash. The test asserts
  `Wait-HallWebReady` surfaces that failure and that the already-running, already-healthy Hall Core
  process is subsequently stopped (via the same `Stop-HallLauncherProcess` path, confirmed exited)
  rather than left running alone.

## 7. Documentation

A short ADR (`docs/architecture/0019-one-command-hall-launcher.md`) documenting the marker-file
build-freshness mechanism (decision 2, since it's the one piece of new, non-obvious state this
phase introduces) and the `HallConfigCli.ps1` config-path adaptation (decision 3) — proportionate to
scope, matching this project's existing per-phase ADR convention (0016, 0017, 0018).
