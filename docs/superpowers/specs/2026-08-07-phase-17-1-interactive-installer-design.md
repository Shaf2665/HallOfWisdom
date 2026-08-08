# Phase 17.1 — Interactive Installer + Persistent Hall Configuration — Design

Status: Approved for implementation planning.
Date: 2026-08-07
Starting commit: `d03ed4f04f77d411a17614ca0f625face70e62a2` (origin/main, working tree clean)

## 1. Problem

A normal Windows user must currently remember and retype long Hall Core startup flags every
session (`--workspace-root`, `--data-dir`, `--agent-worktree-root`, `--port`, `--web-origin`,
`--mock-scenario`, `--enable-codex-trusted-local`). Phase 17.1 introduces `.\install.ps1` as the
primary Windows onboarding experience, backed by a proper versioned, persistent Hall
configuration model — not another generated PowerShell command string.

Phase 17.2 (provider auth), 17.3 (launcher), and 17.4 (README rewrite) are explicitly out of
scope, except for the minimal `apps/server` interface additions this phase genuinely needs
(the `--verify-only` flag; splitting CLI-overrides from resolved config).

## 2. Package architecture — `packages/hall-config`

A new workspace package, `@hall-of-wisdom/hall-config`, is the single source of truth for
*persisted* configuration. It depends on nothing in `apps/server` (packages/ stays below apps/
in the dependency graph, matching `packages/protocol`); `apps/server` depends on it.

- **`schema.ts`** — `HallConfigSchema` (Zod, `.strict()`):
  ```json
  {
    "schemaVersion": 1,
    "workspaceRoot": "string",
    "dataDir": "string | undefined",
    "agentWorktreeRoot": "string | undefined",
    "comparisonRoot": "string | null",
    "hallCorePort": "number (default 4310)",
    "hallWebPort": "number (default 3000)",
    "codexTrustedLocal": "boolean (default false)"
  }
  ```
  `comparisonRoot` is a required key whose value is either a path or explicit `null`
  ("disabled") — never simply absent — so intent is always unambiguous. `mockScenario` /
  `mockStepDelayMs` are deliberately **not** part of this schema; they stay CLI-only dev/test
  flags.
- **`config-path.ts`** — resolves the config file location. Windows:
  `%LOCALAPPDATA%\HallOfWisdom\config.json` — **Local**, not Roaming, deliberately: the file
  stores machine-specific absolute paths that must never sync across machines via a roaming
  profile. macOS/Linux equivalents (`~/Library/Application Support/HallOfWisdom`,
  `$XDG_CONFIG_HOME` or `~/.config/hall-of-wisdom`) are stubbed in now so a future non-Windows
  frontend needs no schema change. Overridable via an env var for tests.
- **`config-store.ts`** — `loadConfig(path?)` / `saveConfig(config, path?)`. Atomic write: write
  a temp file in the same directory, then `fs.renameSync` over the target. Malformed JSON or an
  unsupported `schemaVersion` produce a typed, specific error — never a silent overwrite, never
  a guess at migration.
- **`cli.ts`** — thin subcommands for `install.ps1` to invoke (`status`, `validate`, `save`),
  each communicating via JSON on stdin / a temp file path — never raw path strings interpolated
  into a shell command line, never `Invoke-Expression`.
- Path pre-checks in this package (absolute, not a filesystem root, resolvable) are a
  **best-effort UX pre-check only**. The authoritative validation — canonicalization, mutual
  non-containment, the Phase 16 configuration fingerprint — remains entirely inside
  `apps/server`, untouched by this package, and is what `--verify-only` (below) actually proves.

## 3. `apps/server` changes

### 3.1 CLI-overrides vs. resolved config

`server-cli-args.ts`'s Zod schema splits in two:

- `serverCliOverridesSchema` — what `parseArgs` output validates against today, except
  `workspaceRoot` becomes **optional** here (Hall must be able to start from persisted config
  alone, with zero flags).
- `resolvedServerConfigSchema` (new, in `apps/server/src/config/resolve-server-config.ts`) —
  `workspaceRoot` **required**, `port` and `webOrigin` required-with-derived-defaults, everything
  else matching today's optionality.

`resolveServerConfig(overrides, persisted)` performs a per-field merge — **explicit CLI value
wins, else the persisted config's value, else the existing built-in default** — then validates
the merged result against `resolvedServerConfigSchema`. "No `--workspace-root` and no persisted
config" still fails fast, just one step later than today (after the merge, not during raw CLI
parsing). This is the deterministic CLI/config precedence rule for the whole phase; it applies
per-field, not as an all-or-nothing choice between "use CLI" and "use config."

Field name mapping at this boundary: persisted `hallCorePort` → resolved `port` (existing
internal naming is kept as-is inside `apps/server`; the persisted file uses `hallCorePort` /
`hallWebPort` because both appear together in one document and benefit from the disambiguation).

### 3.2 `webOrigin` derivation from `hallWebPort`

If `--web-origin` is explicitly supplied, it is used as-is (existing `parseWebOrigin`
validation, unchanged). Otherwise `webOrigin` is derived as `http://127.0.0.1:<resolved
hallWebPort>` — replacing the flat `DEFAULT_WEB_ORIGIN` constant as the fallback source. This
guarantees a persisted `hallWebPort` change can never silently create a CORS/origin mismatch
against Hall Core's own CORS check.

**Known limitation, explicitly out of scope for 17.1**: `apps/web`'s `dev`/`start` scripts are
still hardcoded to port 3000 today. Actually starting Hall Web listening on a non-default
`hallWebPort` is Phase 17.3's launcher's job. 17.1 only persists the value and makes Hall Core's
own origin-derivation correct for whatever port Hall Web eventually uses.

### 3.3 `comparisonRoot` is a normal, persisted setting

Comparison composition is disabled whenever `comparisonRoot` is omitted — it is not a dev-only
feature, so the installer must not silently leave it off. The installer derives a real default
(`%LOCALAPPDATA%\HallOfWisdom\comparisons`, sibling to `dataDir`/`agentWorktreeRoot`, canonicalized
and checked for mutual non-containment exactly like the other Hall-owned roots) without an extra
interactive prompt, shown in the install summary. Advanced users can override via `-ComparisonRoot`
or disable via reconfigure (persisting `null`). Server-side, `ResolvedServerConfig.comparisonRoot`
stays optional/nullable exactly as today — the fingerprint's existing leniency toward this field
(freely droppable even once recorded) is unchanged. `mockScenario`/`mockStepDelayMs` remain
CLI-only, untouched by this phase.

### 3.4 `--verify-only` — a genuinely side-effect-minimized preflight

A new boolean flag on `server.ts`'s existing entrypoint (reusing the real startup code path so
verification proves what real startup would actually do, rather than a parallel copy that could
drift). It does **not** reimplement `openDurableStorage()` — it calls it as-is, because that
function's existing ordering (`acquireInstanceOwnership()` before `acquireDatabaseEpoch()`,
`apps/server/src/persistence/durable-startup.ts`) already fails closed with
`InstanceOwnershipConflictError` against a live-heartbeat owner *before* ever bumping the
database epoch — so a live Hall Core instance is never fenced out by a concurrent `--verify-only`
run, as long as `--verify-only` treats that specific error as "skip storage checks," not as a
hard failure.

Flow:
1. Resolve config (§3.1), canonicalize paths exactly as real startup does.
2. No `dataDir` → ephemeral mode, nothing durable to check, report success, exit 0.
3. `dataDir` given → call `openDurableStorage()`.
   - Catches `InstanceOwnershipConflictError` specifically: reports "Hall Core is currently
     running — storage checks skipped (expected and safe)," still exits 0 for everything else
     already checked (paths, schema, prerequisites).
   - On success: call `checkOrRecordConfigurationFingerprint()` **directly**, imported from
     `server-metadata-repository.ts` exactly as `restart-recovery.ts` already does — confirmed
     during design research to already be an independently-callable function, not entangled with
     reconciliation logic. **`runRestartRecovery()` itself is never called** — no task
     reconciliation, no comparison reconciliation, no agent-worktree reconciliation/cleanup, no
     CEO plan recovery.
   - Optionally calls `createServerComposition()` for pure in-memory wiring validation (no I/O
     per its existing design).
   - Explicitly `db.close()` then `ownershipHandle.release()` before exiting — orderly release,
     not reliance on the 20s staleness timeout.
4. Never calls `app.listen()`.

### 3.5 Reconfigure: verify-before-promote, never write-then-rollback

Reconfigure answers are validated structurally first (schema-level, via `hall-config`'s
`validate` subcommand). They are then passed as **explicit CLI flags** to
`node dist/server.js --verify-only <candidate values>` — since CLI overrides already win over
persisted config in the precedence rule (§3.1), this runs the candidate through the exact real
startup validation path, including fingerprint compatibility against the existing database,
**without ever touching the active `config.json`**. Only a `0` exit triggers promotion: atomic
write-temp-then-rename over the active config file, in one step. A non-zero exit (e.g.
`ConfigurationFingerprintMismatchError`) leaves the active config completely untouched and
reports the exact error. No separate "candidate config path" concept is needed inside
`apps/server` — the candidacy lives entirely in how `install.ps1` sequences the (already
existing) CLI-overrides-win precedence.

## 4. `install.ps1` flow

Located via the script's own path (`$PSScriptRoot`), not the caller's working directory.

Order: prerequisite checks (Git/Node/pnpm presence and version, read from root `package.json`'s
`engines`/`packageManager` fields rather than hardcoded) → existing-config detection (raw
`ConvertFrom-Json` read, no build needed yet) → prompts (workspace root, data directory, agent
worktree root, Codex trusted-local toggle; comparison root derived silently per §3.3) → `pnpm
install` → build just `hall-config` and use its CLI to structurally validate + atomically save
the answers ("✓ Configuration saved") → `pnpm typecheck` + `pnpm build` (**blocking** — Hall
literally won't run if these fail) → `--verify-only` smoke test ("✓ Installation verified") →
`pnpm lint` + `pnpm test` (reported, **non-blocking** — correctness gate is typecheck/build; the
full test suite includes slow process-recovery integration tests and isn't itself a "is Hall
installed" signal) → summary.

Non-interactive/testable: named parameters (`-WorkspaceRoot`, `-DataDir`, `-AgentWorktreeRoot`,
`-ComparisonRoot`, `-EnableCodexTrustedLocal`, `-NonInteractive`) — any parameter supplied on the
command line skips its prompt; `-NonInteractive` requires all needed values be supplied or fails
with a clear, specific error (never silently guesses).

Reinstall/reconfigure menu on existing-config detection: keep & verify / reconfigure / cancel.
"Keep & verify" only re-runs build + `--verify-only`. "Reconfigure" follows §3.5. Neither path
ever deletes the SQLite database or agent worktrees.

Security constraints throughout: no `Invoke-Expression` on generated/untrusted data; all spawned
processes use structured argument arrays, never string-concatenated shell commands; no
credential/token/cookie handling of any kind; no global execution-policy changes; no
Administrator requirement; no recursive deletion of pre-existing user directories; no global Git
config changes.

## 5. Testing

Vitest for `hall-config`: schema validation (valid/malformed/wrong `schemaVersion`), path
resolution per-platform, precedence merge (all three source combinations per field), atomic
write survives simulated interruption, no-secrets-ever-serialized. Extended `apps/server` tests:
CLI-overrides-optional-workspaceRoot parsing, resolved-config-requires-workspaceRoot-after-merge,
`webOrigin` derivation from `hallWebPort` when `--web-origin` omitted, `--verify-only` skips
`runRestartRecovery`/CEO recovery/worktree reconciliation entirely (spy/assert not-called),
`--verify-only` against a data dir with a live-heartbeat lock reports skip-not-failure and does
not touch the epoch, `--verify-only` against a data dir with an incompatible recorded fingerprint
fails closed exactly as real startup would. One new `apps/server/src/process-tests/` scenario
exercises `--verify-only` against a real built binary and a persisted config end-to-end.

PowerShell: syntax validated; installer logic (prerequisite parsing, prompt/parameter
precedence, existing-config detection, reconfigure candidate flow) exercised via
`-NonInteractive` + parameters rather than a new heavyweight PowerShell test framework, per the
project's dependency policy.

## 6. Documentation

Minimal ADR for the persistent Hall configuration model (`docs/architecture/` — next available
number). Correct any README instructions that would become dangerously incorrect because of this
phase (e.g., note that `.\install.ps1` is now the primary path) without doing the full README
rewrite (that's Phase 17.4).

## 7. Explicit non-goals for this phase

- No provider-authentication UI (Phase 17.2).
- No process launcher that actually starts Hall Core + Hall Web together (Phase 17.3) — the
  installer verifies but does not leave anything running.
- No change to `apps/web`'s hardcoded port-3000 startup scripts beyond what §3.2 already covers
  on the Hall Core side.
- No migration framework beyond `schemaVersion` existing and being checked — there is nothing to
  migrate from yet at schema version 1.
