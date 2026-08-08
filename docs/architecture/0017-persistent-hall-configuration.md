# ADR 0017: Persistent Hall Configuration

## Status

Accepted (Phase 17.1).

## Context

Hall Core's startup configuration (`--workspace-root`, `--data-dir`, `--agent-worktree-root`,
`--port`, `--web-origin`, `--comparison-root`, `--enable-codex-trusted-local`) was, through Phase
16, supplied exclusively via CLI flags on every invocation. A normal Windows user had to remember
and retype a long command every session. Phase 17.1 introduces `.\install.ps1` as the primary
onboarding path, which requires a durable place to store the answers a user gives once.

## Decision

A new workspace package, `@hall-of-wisdom/hall-config`, owns a versioned, schema-validated
configuration file (`HallConfigSchema`, `schemaVersion: 1`) stored at a machine-local,
user-specific location (`%LOCALAPPDATA%\HallOfWisdom\config.json` on Windows — deliberately
*Local*, not *Roaming*, since the file stores machine-specific absolute paths that must never
sync across machines via a roaming profile; macOS/Linux equivalents are defined now for a future
non-Windows frontend). Writes are atomic (temp file + rename). The schema explicitly excludes any
provider credential, token, or secret — it stores only filesystem roots, ports, and a boolean
Codex trusted-local opt-in.

`apps/server`'s CLI parsing splits into two layers: `ServerCliOverrides` (every field optional,
including `workspaceRoot`) and a `ResolvedServerConfig` (workspaceRoot required) produced by
`resolveServerConfig()`, which merges CLI overrides over the persisted config over built-in
defaults, per field. An explicit CLI flag always wins. `webOrigin` is derived from the resolved
`hallWebPort` unless `--web-origin` is explicitly supplied, so a persisted web-port change can
never silently create a CORS/WebSocket-origin mismatch. `comparisonRoot` is a normal, persisted
setting (not dev-only) — the installer derives a real default rather than leaving comparisons
disabled by omission, since comparison composition depends entirely on this value being present.
`mockScenario`/`mockStepDelayMs` remain CLI-only development flags, never persisted.

A new `--verify-only` flag on `apps/server`'s existing entrypoint provides a side-effect-minimized
configuration preflight, used by `install.ps1` both for first-install verification and for
validating a reconfiguration candidate before promoting it. It reuses `openDurableStorage()`
exactly as real startup does; that function's existing ownership-acquisition ordering
(filesystem lock via `acquireInstanceOwnership()` before the database epoch bump via
`acquireDatabaseEpoch()`) already fails closed with `InstanceOwnershipConflictError` against a
live-heartbeat owner before the epoch is ever touched, so `--verify-only` can never fence out a
live Hall Core instance — it catches that specific error and reports a skip, not a failure. It
calls `checkOrRecordConfigurationFingerprint()` directly rather than `runRestartRecovery()`, so it
never runs task/comparison/agent-worktree reconciliation, CEO plan recovery, or worktree cleanup,
and it never calls `app.listen()`.

Reconfiguration (`install.ps1`'s "reconfigure" flow) validates the candidate by invoking
`--verify-only` with the candidate's values passed as explicit CLI flags — which, by the
precedence rule above, always wins over the still-untouched active `config.json` — and only
atomically promotes the candidate over the active file on a `0` exit. The active configuration is
never overwritten before verification and never partially written.

## Consequences

- A user who has run `install.ps1` once can start Hall Core with zero flags.
- The Phase 16 configuration fingerprint and worktree path-safety code are reused unmodified —
  this ADR introduces no new authority over what counts as a safe path.
- A future macOS/Linux installer can reuse `@hall-of-wisdom/hall-config` unchanged; only the
  PowerShell driver (`install.ps1`) is Windows-specific.
- `apps/web`'s hardcoded port-3000 startup scripts are unchanged by this phase — Hall Core's own
  `webOrigin` derivation is correct for whatever port Hall Web eventually uses, but actually
  starting Hall Web on a non-default `hallWebPort` remains Phase 17.3's launcher's responsibility.
