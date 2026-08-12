# ADR 0019: One-Command Hall Launcher

## Status

Accepted (Phase 17.3).

## Context

A user who completed `.\install.ps1` still had to know Hall Core is `apps/server/dist/server.js`,
that Hall Web is `next start` on a hardcoded port, that the two must start in a specific order with
matching origins, and that stopping them cleanly on Windows is not as simple as Ctrl+C.

## Decision

`.\start.ps1` loads the persisted Hall configuration (`@hall-of-wisdom/hall-config`, reused as-is),
starts Hall Core and Hall Web on their configured ports, waits for both to become ready, opens the
default browser, and keeps both processes managed together until stopped.

Hall Core is spawned with **zero CLI flags** — `apps/server/src/server.ts` already calls
`tryLoadConfig()` unconditionally on every startup, so the launcher's only responsibility toward
Hall Core's configuration is confirming a valid persisted config exists, never passing its fields
through.

Hall Core is stopped via the existing stdin `SHUTDOWN` protocol
(`apps/server/src/process/signal-shutdown.ts`), reused verbatim — Windows cannot deliver a real
SIGINT/SIGTERM from a parent Node process to a child Node process, and this codebase already solved
that once. Hall Web (and Hall Core as a forced fallback) is stopped via `taskkill /T /F`, which
kills the full process tree rather than just the top process, since `next start` can spawn its own
worker processes a plain `Stop-Process` would never reach.

**Hall Web build freshness.** `NEXT_PUBLIC_HALL_CORE_URL` is inlined into Hall Web's client bundle
at `next build` time — it is not a runtime flag. The launcher never writes `.env.local`; it passes
the value directly in the environment of the spawned build (and `next start`) process. Because
nothing else records what URL a given `.next` build was actually made with, the launcher writes its
own marker file, `apps/web/.next/hall-launcher-build-marker.json`, immediately after a build it ran
completes successfully, and treats a missing or mismatched marker as proof a rebuild is needed
before starting Hall Web. The very first `.\start.ps1` run after `.\install.ps1` always triggers one
rebuild for this reason, even on the common default-port path — an unmarked `.next` build carries no
evidence of what it was built with, so trusting it unmarked would be unsound.

`scripts/install/HallConfigCli.ps1`'s `-ConfigPath` parameter became optional (previously
mandatory) so `start.ps1` can call `Invoke-HallConfigStatus` with no explicit path, letting
`packages/hall-config`'s own `resolveHallConfigFilePath()` resolve it — the identical function
`server.ts`'s `tryLoadConfig()` uses. `install.ps1` continues to pass `-ConfigPath` explicitly
(required there because it must run before any build exists) and is unaffected.

**Known limitation, deliberately not fixed in this phase.** `Start-HallCoreProcess`/
`Start-HallWebProcess` spawn their children via plain `System.Diagnostics.Process`, which inherits
`start.ps1`'s own console process group rather than isolating into a new one. A raw
`CTRL_BREAK_EVENT` broadcast to that group (the only way to *target* a specific process group on
Windows — `CTRL_C_EVENT` can only ever reach the caller's own group) therefore reaches Hall
Core/Hall Web directly too, and since neither registers a `SIGBREAK` handler, Node's default
behavior terminates them immediately rather than through `start.ps1`'s own graceful stdin/`taskkill`
path. This was discovered by this phase's own dual-host smoke test (confirmed via Windows' exit code
`0xC000013A`, `STATUS_CONTROL_C_EXIT`). It does not affect real interactive use: a user's actual
Ctrl+C sends `CTRL_C_EVENT`/`SIGINT`, which `signal-shutdown.ts` already handles gracefully and
redundantly on Hall Core's own side even if broadcast directly, and `Stop-HallLauncherProcess`
already tolerates a process that exited moments before it runs. Isolating child processes into their
own process group (via a `CREATE_NEW_PROCESS_GROUP` `CreateProcess` P/Invoke, mirroring the test
harness's own technique) would close this gap for the Ctrl+Break case too, but is deliberately
deferred as an architecture change beyond this phase's approved scope.

**Remote access (opt-in).** `start.ps1`/`start.sh` read two environment variables that are unset by
default: `NEXT_PUBLIC_HALL_CORE_URL` (already the exact variable this launcher passes to Hall Web's
build below — set it to override the loopback URL it would otherwise derive from
`config.hallCorePort`) and `HALL_WEB_ORIGIN` (passed through to Hall Core as `--web-origin`, added to
its CORS/WebSocket-origin allowlist). Unset, every code path above is unaffected — same loopback URL,
same zero-CLI-flags Hall Core spawn. See `docs/remote-access.md` for the full Cloudflare Tunnel setup
this supports.

## Consequences

- A user who has run `install.ps1` once can start Hall with exactly one command.
- No new server-side flags, routes, or config fields were introduced — `start.ps1` only ever spawns
  existing built artifacts with the argument/environment shapes described above.
- The `.next` build marker is launcher-owned, gitignored (inside `.next`), and never treated as
  persisted Hall configuration — `config.json` is never written by `start.ps1`.
- A future macOS/Linux launcher can reuse `@hall-of-wisdom/hall-config` and the stdin shutdown
  protocol unchanged; only the process-spawning/Ctrl+C driver (`start.ps1`) is Windows-specific.
- The Ctrl+Break/process-group limitation above is a candidate for a future, narrowly-scoped
  follow-up (process-group isolation for spawned children) if it ever proves to matter in practice.
