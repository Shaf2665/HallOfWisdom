# 0010 — Paperclip-Compatible Trusted-Local Codex Execution

Status: Phase 10.2. Builds directly on
[`0009-codex-adapter.md`](0009-codex-adapter.md) (Phase 10, Phase 10.1) — read that document
first. This document only covers what Phase 10.2 adds: an explicitly-enabled, opt-in
"trusted-local" execution mode for the Codex adapter, and why it exists.

## Why this phase exists

Phase 10.1 diagnosed, for free and without spending any Codex usage, why every real Codex task
execution during Phase 10 reconnaissance failed to modify a file even after every configuration
fix: the local Codex sandbox runs shell commands under a dedicated, low-privilege Windows account
(`CodexSandboxOffline`) that is denied write access to directories owned by the operator's own
account. `detectCodex` was corrected to never report `available` under that fixed sandbox profile
(`buildCodexArgv`, `--sandbox workspace-write`), regardless of how valid the CLI/auth state looks.

A review of Paperclip's own open-source Codex adapter (MIT licensed;
<https://github.com/paperclipai/paperclip>, commit `230126d80bd59b8f521ed635a3e8e14a6295ec1e`)
found that Paperclip's working Codex execution path does not solve the Windows sandbox restriction
— it disables Codex's own sandbox and approval enforcement entirely, via
`--dangerously-bypass-approvals-and-sandbox`, which is Paperclip's own _default_
(`DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX = true` in `index.ts`). **Do not read this
document as claiming Paperclip solved the restricted Windows sandbox while still using
`workspace-write`. Its default code path bypasses Codex's sandbox.**

Phase 10.2 adds an equivalent, but explicitly opt-in and more conservative, mode to Hall: an
operator who understands and accepts the tradeoff can enable it at Hall Core startup; it is never
the default, and nothing browser-, task-, or REST-request-controlled can turn it on.

## Paperclip source review (required before any code changes)

Six files were read from the pinned commit above: `index.ts`, `server/build-config.ts`,
`server/codex-args.ts`, `server/execute.ts`, `server/codex-home.ts`, `server/parse.ts`.

1. **How Paperclip builds Codex arguments.** `buildCodexExecArgs` (`codex-args.ts`) is a flat
   builder: `["exec", "--json"]`, then conditionally `--skip-git-repo-check`, `--search`,
   `--dangerously-bypass-approvals-and-sandbox`, `--model <model>`, reasoning-effort/fast-mode `-c`
   overrides, caller-supplied `extraArgs`, then `resume <id> -` or bare `-`. There is no
   `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--strict-config`, or `--disable`
   anywhere — Paperclip does not attempt CLI-flag-level configuration isolation at all.
2. **Why bypass mode is enabled by default.** `DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX =
true`; `build-config.ts` falls back to that constant unless a caller explicitly overrides it.
   There is no default fallback that uses `--sandbox workspace-write` instead.
3. **How Paperclip passes prompts through stdin.** `execute.ts` passes the prompt as a `stdin`
   option value into an internal process-execution helper
   (`runAdapterExecutionTargetProcess(runId, target, command, args, { cwd, env, stdin: prompt,
... })`); the prompt is never part of `args`. The trailing bare `"-"` in the argv is Codex's own
   "read prompt from stdin" convention.
4. **How Paperclip parses stdout JSONL.** `parseCodexJsonl(stdout: string)` (`parse.ts`) takes only
   `stdout`, never `stderr` — confirming stdout-only JSONL parsing, matching Hall's own Phase 10.1
   correction. It handles `thread.started`, `error`, `item.completed` (agent_message only —
   `command_execution`/`file_change` item types are not handled by this function), `turn.completed`
   (captures token usage), `turn.failed`. It reads as a post-hoc run-summary extractor, not a
   real-time per-event stream translator — architecturally different from Hall's `event-mapper.ts`.
5. **How Paperclip handles stderr.** `execute.ts`'s `onLog` callback forwards `stdout` chunks
   unchanged, but runs `stderr` chunks through `stripCodexRolloutNoise` (a fixed regex filter) and
   drops them entirely if empty after cleaning; the _cleaned_ text is still forwarded to Paperclip's
   own callers as a log stream. `parseCodexJsonl` is called only on `proc.stdout` — stderr is never
   JSON-parsed or a source of lifecycle events. Hall remains stricter: it discards stderr entirely
   for event purposes and never forwards raw _or_ cleaned stderr text into any Hall-visible channel.
6. **How Paperclip terminates processes.** `signalCodexChild(target, signal)`: on non-Windows, with
   a known `processGroupId`, signals the whole group first (`process.kill(-processGroupId,
signal)`), falling back to a direct PID signal if that throws; on Windows it always signals the
   PID directly. A separate output-inactivity monitor fires `SIGTERM` after a configurable silence
   window, then an unref'd timer sends `SIGKILL` after a fixed grace period if the process hasn't
   exited. Hall's existing `process-tree.ts` (Windows: `taskkill.exe /PID <pid> /T /F` for the whole
   tree; POSIX: `PosixGroupKiller`) is already at least as strong as Paperclip's approach.
7. **How Paperclip finds/uses Codex authentication.** `codex-home.ts` implements a large
   managed-`CODEX_HOME` system for running many concurrently-isolated agent instances: a shared
   source home whose `auth.json` is symlinked into per-instance isolated homes, plus config/MCP
   injection and optional API-key `auth.json` writing. This exists because Paperclip supports
   multiple concurrent agent instances per operator; Hall has no such requirement — a single
   operator's single already-logged-in Codex CLI is already visible to any child process Hall
   spawns with its existing sanitized-but-`CODEX_HOME`-preserving environment.
8. **What Hall reproduces.** The essential trusted-local argument shape (`codex exec --json ...
--dangerously-bypass-approvals-and-sandbox ... -`), stdin-delivered prompt, stdout-only JSONL,
   never combining the bypass flag with `--sandbox`/`approval_policy`/`sandbox_workspace_write.*`/
   `web_search` config, and the general graceful-then-forced termination shape (reimplemented
   against Hall's own `process-tree.ts`/`codex-run.ts`, not copied).
9. **What Hall deliberately does not reproduce.** Managed/symlinked/multi-instance `CODEX_HOME`;
   API-key auth support; custom model/provider selection, `--search`, fast mode, reasoning-effort
   tuning; arbitrary `extraArgs`/env passthrough; `--skip-git-repo-check`; session resume; MCP
   config injection; token usage/cost capture; retry/quota/session-error text classification;
   forwarding cleaned stderr as a log stream; git-worktree/runtime-services/ACP/warm-handle
   features unrelated to the one fixed execution path Hall adds.

No Paperclip source was copied verbatim into this repository; everything above was independently
reimplemented against Hall's own existing types and conventions. Per Paperclip's MIT license, no
attribution notice is required for independent reimplementation informed by reading the source, but
see "Paperclip attribution" below for the record.

## Security model

Trusted-local mode is appropriate only when all of the following hold, and Hall enforces every one
of them programmatically rather than trusting the operator to remember them:

- Hall Core is bound to loopback only (`127.0.0.1` — `LOCAL_ONLY_HOST` in `server-config.ts`, not
  configurable in this phase).
- The operator controls the Hall Core process and selected the workspace root at startup.
- The task's working directory is inside that workspace root (already enforced generically by
  `TaskOrchestrator`/`validateWorkspace`, unchanged by this phase).
- Codex authentication is verified as ChatGPT, never API-key/access-token.
- No billing-changing environment variable (`OPENAI_API_KEY`, `CODEX_API_KEY`,
  `CODEX_ACCESS_TOKEN`, ...) is present in the operator's own environment.
- The operator explicitly enabled the mode at Hall Core process startup.

**Trusted-local mode bypasses Codex's own internal sandbox and approval enforcement.** It is never
described as "sandboxed" or "restricted" execution anywhere in this adapter's diagnostics, logs, or
documentation — that would be false. Once Codex starts in this mode, it runs with the Hall Core
process's own OS-user filesystem permissions, for the entire duration of the task, everywhere that
user can write — not merely inside the task's working directory. The prompt instructs Codex to stay
within the working directory, but a prompt is not a security boundary; Hall's own pre-launch path
validation (workspace containment, symlink-escape rejection, Git-repository requirement) is the
only real boundary, and it applies before Codex ever starts, not while it runs.

## Trusted server configuration

A new Hall Core startup flag, `--enable-codex-trusted-local` (boolean, default `false`):

```powershell
pnpm --filter @hall-of-wisdom/hall-core run dev -- `
  --workspace-root "D:\HallOfWisdom" `
  --port 4310 `
  --mock-scenario success `
  --web-origin "http://127.0.0.1:3000" `
  --enable-codex-trusted-local
```

- **Default `false`**: Codex behaves exactly as Phase 10.1 left it — `detect()` caps at
  `unsupported`, no trusted-local process ever starts, byte-for-byte unchanged.
- **`true`**: `CodexAdapter` may register in trusted-local mode; `detect()` still runs every
  strict-mode check (installed, isolation-flag support, ChatGPT auth) _and_ the additional
  trusted-local preconditions above before ever reporting `available`.
- This flag is parsed once, at process startup, by `parseServerCliArguments`
  (`apps/server/src/config/server-cli-args.ts`) and threaded through
  `createServerComposition` → `registerCodexAdapter` → `CodexAdapter`'s constructor-only
  `trustedLocal` config. It is **not** a field on `AgentTaskInput`, the task-creation REST
  contract, `AgentExecutionOptions`, Communication Boards, or any URL query parameter — there is no
  code path, anywhere, by which a browser request or task payload can turn this on. Sending
  `trustedLocal`, `enableCodexTrustedLocal`, `dangerouslyBypassApprovalsAndSandbox`, or similar
  fields in a task-creation request body is rejected outright by the existing `.strict()` schema.

## Codex argument profile

Two internal, named profiles now exist in `adapters/codex/src/permission-profile.ts`:

- **`strict`** (`buildCodexArgv`, unchanged from Phase 10.1): `exec --json --ephemeral
--ignore-user-config --ignore-rules --strict-config --sandbox workspace-write -c
approval_policy="never" -c sandbox_workspace_write.network_access=false -c
web_search="disabled" --disable hooks --disable plugins --disable plugin_sharing --disable
remote_plugin --disable multi_agent --cd <dir> -`.
- **`trusted_local`** (`buildCodexTrustedLocalArgv`, new): `exec --json --ephemeral
--ignore-user-config --ignore-rules --strict-config --dangerously-bypass-approvals-and-sandbox
--disable hooks --disable plugins --disable plugin_sharing --disable remote_plugin --disable
multi_agent --cd <dir> -`.

The trusted-local profile deliberately excludes `--sandbox`, `-c approval_policy=...`, `-c
sandbox_workspace_write.network_access=...`, and `-c web_search=...` — the bypass flag replaces
that entire enforcement layer; passing contradictory sandbox arguments alongside it would describe
a policy the bypass flag has already made irrelevant, which the kickoff for this phase called "a
misleading policy," not a stronger one. Configuration-isolation flags (`--ephemeral`,
`--ignore-user-config`, `--ignore-rules`, `--strict-config`, `--disable ...`) are unchanged from the
strict profile: the bypass flag removes sandbox/approval enforcement, not Hall's own
project/user-configuration isolation guarantees, which are independent of it.

This exact flag combination (with a deliberately-invalid trailing `-c bogus=1` probe key
substituted for `--cd`'s real value) was verified live against the installed CLI (`codex-cli
0.144.4`) via the same zero-usage `--strict-config` config-parse-failure technique Phase 10 used:
the probe failed with `Error loading config.toml: unknown configuration field ... in -c/--config
override`, proving every real flag parses together and the run reaches config validation — never a
model call — before the deliberately-invalid key was ever reached. No Codex usage was spent
confirming this.

The `strict` profile's own argv builder, `buildCodexArgv`, is untouched by this phase — it is not
parameterized to conditionally add the bypass flag; `buildCodexTrustedLocalArgv` is a wholly
separate function.

## The single source of truth for trusted-local mode

`CodexAdapter` accepts one constructor-only config object,
`trustedLocal: { enabled, loopbackBound, workspaceRoot }`. The identical `enabled` field is read in
exactly two places:

1. `detectCodex` — the only thing that can make `detect()` return `availability: "available"`.
2. `CodexAdapter#startTask` — the only thing that selects `buildCodexTrustedLocalArgv` over
   `buildCodexArgv`.

There is no second flag, no derived value, and no path from `detection.availability` back into argv
selection — `startTask` reads `this.#trustedLocal.enabled` directly. This means strict mode
(`enabled: false`, the default) can never reach a real `codex exec` spawn at all (Phase 10.1's
existing fail-closed behavior — `detect()` never returns `available` there), so the bypass argv can
never be constructed in that mode, let alone spawned. A deterministic test in
`codex-adapter.test.ts` (titled "keystone: startTask spawns the real 'codex exec' process using the
Paperclip-compatible bypass argv only when the same `#trustedLocal.enabled` field that made
`detect()` report available is true") exercises exactly this coupling end to end.

## Authentication

Unchanged from Phase 10.1: `codex login status` classification remains the sole authentication
boundary; only a `chatgpt` classification permits execution; API-key, access-token, logged-out, and
ambiguous results are all rejected the same way in both modes. This adapter never reads
`auth.json`, any credential store, browser cookies, or OAuth tokens itself, and never symlinks or
copies credential files — Paperclip's managed-`CODEX_HOME` auth symlinking is not needed for Hall's
single-operator local prototype, since the operator's existing `codex login` is already visible to
any child process Hall spawns.

Additionally, trusted-local mode's `detect()` refuses to report `available` if a billing-changing
environment variable (`OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, and the other
substrings in `environment.ts`'s `BLOCKED_ENV_KEY_SUBSTRINGS`) is present anywhere in the
_operator's own_ environment — even though `buildChildEnvironment`'s allowlist already makes it
structurally impossible for such a variable to reach a spawned Codex process either way. This is a
second, earlier, independent check: an operator whose shell has `OPENAI_API_KEY` set is a signal
Codex's own billing resolution may not be the verified ChatGPT subscription the auth check just
confirmed.

## Environment policy

Unchanged: the same sanitized, allowlist-based `buildChildEnvironment` is used for both modes. Hall
does not switch to Paperclip's broader `{ ...process.env, ...env }` inheritance model, and the child
environment is never logged.

## Trusted workspace policy

Trusted-local mode does not weaken or bypass Hall's existing workspace boundary. `TaskOrchestrator`
(via `@hall-of-wisdom/hall-runner`'s `validateWorkspace`) resolves, canonicalizes (realpath), and
confirms containment for every task's working directory _before_ any adapter — Codex included, in
either mode — ever sees it; this is generic, provider-neutral infrastructure unchanged by this
phase. `CodexAdapter` never re-derives, re-resolves, or second-guesses the directory it receives —
a deterministic regression test confirms the exact canonical string it's given is what both the new
writability probe and the trusted-local argv's `--cd` value receive, verbatim.

Trusted-local mode adds one new adapter-owned preflight check that did not previously exist:
**writability**. `workspace-writability-probe.ts` creates a uniquely-named, empty sentinel file
directly inside the task's working directory and immediately removes it — a real write-then-remove
probe, the same technique Phase 10.1 used to diagnose the Windows sandbox account's own
restrictions, since ACL/mode-bit inspection alone (`fs.access`) is not reliable on Windows. This
check runs only when trusted-local mode is enabled for the task; strict mode never consults it
(Codex's own sandbox already enforces writability there, and the probe would be redundant). A
failed probe fails closed with `CODEX_WORKSPACE_NOT_WRITABLE`, before Codex is ever spawned.

The Git-repository requirement is unchanged and still enforced in trusted-local mode:
`--skip-git-repo-check` is never passed in either profile.

Once Codex starts in trusted-local mode, it has the Hall Core OS user's permissions beyond the
working directory boundary Hall validated before launch — Hall does not, and cannot, constrain what
Codex does with those permissions once it is running; see "Security model" above.

## Availability policy

- **Strict mode** (`trustedLocal.enabled` false or omitted): `availability: "unsupported"`,
  diagnostic `"Codex file-edit execution is not verified in the current sandbox."` — byte-for-byte
  Phase 10.1, unchanged.
- **Trusted-local, any precondition failed**: `availability: "unsupported"` with one of four fixed,
  safe diagnostics (`TRUSTED_LOCAL_NOT_LOOPBACK_MESSAGE`,
  `TRUSTED_LOCAL_WORKSPACE_NOT_CONFIGURED_MESSAGE`, `TRUSTED_LOCAL_BILLING_ENV_BLOCKED_MESSAGE`,
  `TRUSTED_LOCAL_FLAG_UNSUPPORTED_MESSAGE`), or the existing strict-mode auth/install diagnostics if
  those fail first — never `available`.
- **Trusted-local, every precondition passed**: `availability: "available"`, with the fixed
  diagnostic `"Trusted-local mode: Codex sandbox and approval protections are bypassed. Codex runs
with the Hall Core user's filesystem permissions."` — never "sandboxed," never "restricted."
  Never exposes the Windows sandbox account name, executable path, `CODEX_HOME`, or any
  login/help/account detail.

## Surfacing the warning to Hall Web

The Agent SDK's `AgentDetectionResult` schema (`agentDetectionResultSchema`, `.strict()`) has no
dedicated "trust mode" field, and this phase does not redesign that protocol. Instead, `GET
/api/v1/adapters` (`apps/server/src/routes/adapters.ts`) exposes a new, generic
`limitationNotice?: string` field on each adapter summary, populated **only** when
`availability === "available"` _and_ the adapter's own `detect()` result carries a
`diagnosticMessage`. Every adapter in this codebase treats "available" as the outcome that needs no
explanation, so a `diagnosticMessage` attached to an `available` result is, by construction, never
raw captured process output describing a problem — it is the adapter's own small, fixed,
hand-authored caveat about an otherwise-successful result. This is provider-neutral: the route never
branches on `adapterId`. In practice today this surfaces two things: Codex's trusted-local bypass
notice, and (unchanged, pre-existing behavior, now also reaching the client) Claude Code's own
"installed and authenticated with a Claude subscription" message. Every other `availability` value
continues to omit this field entirely — the blanket exclusion of `diagnosticMessage` for anything
that isn't `available` (which really can embed unredacted output) is unchanged.

Hall Web's `AssignDialog` (`apps/web/components/kanban/assign-dialog.tsx`) renders
`limitationNotice`, when present, as a visible amber notice beneath the agent-selection dropdown for
the currently-selected adapter, plus a short `" (see notice below)"` suffix and full-text `title`
tooltip on the corresponding `<option>`. The suffix is deliberately generic, not
`" (trusted-local mode)"` — an earlier draft used that Codex-specific wording and, caught live
during Phase 10.2's own Playwright verification, it mislabeled Claude Code (whose `detect()` also
attaches a `diagnosticMessage`, but never trusted-local content) as being in "trusted-local mode"
too. The full, accurate text for whichever adapter is selected is always in the notice paragraph
below the dropdown; the option-list suffix only ever signals "read the notice," never asserts what
kind of notice it is.

## Stdout and stderr

Unchanged from Phase 10.1 in both modes: stdout alone drives JSONL event mapping; stderr is
received and immediately discarded, never parsed, stored, classified, or forwarded into any Hall
event, `StructuredFailure`, or log. The one narrow exception — the bounded no-output inactivity
timer below resets on a stderr chunk's mere _arrival_, never its _content_ — does not change this.

## Process management

Unchanged process-tree architecture (`process-tree.ts`): injectable spawner, `shell: false`, stdin
prompt delivery, bounded stdout/stderr reads, first-terminal-outcome guarantee via
`TerminalEventGuard`, idempotent cancellation, two-phase graceful-then-forced termination (Windows:
`taskkill.exe /PID <pid> /T /F`; POSIX: process-group `SIGTERM` then `SIGKILL` via
`PosixGroupKiller`), listener/timer cleanup.

New in this phase: a bounded no-output **inactivity timeout** (`CodexRun`, default 120 seconds,
configurable via `inactivityTimeoutMs`), reviewed alongside Paperclip's own inactivity-monitor
concept but independently reimplemented against this class's existing timer/termination plumbing —
not copied. It is distinct from the existing startup timeout (which only guards the silence before
the very first byte and is cleared permanently after it) and the existing max-run-duration timeout
(an absolute cap regardless of activity): this timer re-arms on every stdout _or_ stderr chunk and
fires if none arrives for the configured window at any point during the run, terminating the
process the same way a startup/max-duration timeout does. It applies in both strict and
trusted-local modes.

## Event mapping

Unchanged. The existing Codex JSONL → Hall event mapping (`event-mapper.ts`) is not modified by
this phase in any way — trusted-local mode changes only argv/spawn/detection behavior, never event
translation.

## Deterministic tests

Spread across the modules they exercise rather than one monolithic file, per this repository's
existing per-module test convention:

- `permission-profile.test.ts` — trusted-local argv contains the bypass flag, isolation flags, and
  `--disable` set; excludes `--sandbox`/`workspace-write`/`approval_policy`/`web_search`/`--model`/
  `--search`/`resume`/etc.; task-text-injection immunity; byte-identical for repeated calls; the
  strict profile is provably untouched; a dedicated "Paperclip parity" test
  (`buildCodexTrustedLocalArgv — Paperclip parity (Phase 10.2)` →
  `"uses the Paperclip-compatible trusted-local Codex execution profile"`).
- `cli-compatibility.test.ts` — `verifyTrustedLocalFlagSupport` marker matching, version-floor
  fail-closed behavior, and that it never requires `--sandbox` to be present.
- `detection.test.ts` — strict-mode-unchanged-by-default, `enabled: false` never returns available,
  every trusted-local precondition (loopback, workspace-configured, billing-env-blocked×3,
  flag-support, auth-unverified, logged-out) fails closed independently, never exposes secrets, and
  a dedicated regression proving `codex exec --help` is fetched exactly once even though both
  marker sets are checked.
- `codex-adapter.test.ts` — the keystone coupling test described above; strict mode never reaches a
  real spawn; the trusted-local spawn's real argv contains the bypass flag and excludes sandbox
  flags; Git-repository requirement still enforced; writability preflight enforced and never
  consulted in strict mode; working directory passed verbatim to both the probe and `--cd`; no
  secret leakage in preflight failures.
- `codex-run.test.ts` — the bounded inactivity timeout fires after silence, resets on stdout and
  stderr chunks without forwarding stderr content, stops ticking after a clean completion (no
  redundant kill), and has a bounded non-zero default.
- `server-cli-args.test.ts` — `--enable-codex-trusted-local` defaults to `false`, parses `true`.
- `codex-composition-root.test.ts` — the real production composition wiring (not the
  `buildTestApp`/`additionalAdapters` test shortcut) constructs a `CodexAdapter` that defaults to
  disabled trusted-local mode.
- `codex-integration.test.ts` (`apps/server`) — a trusted-local-enabled Codex lists as `available`
  end to end through `GET /api/v1/adapters`; a strict-mode Codex alongside it still lists
  `unsupported`; the `limitationNotice` text is exposed only for the available case and never
  describes the mode as sandboxed/restricted; no executable path/`CODEX_HOME`/account info leaks
  alongside it; a trusted-local-available Codex can be assigned a task through the same
  provider-neutral route Mock Agent and Claude Code use; task-creation requests that try to smuggle
  trusted-local-shaped fields (`trustedLocal`, `enableCodexTrustedLocal`,
  `dangerouslyBypassApprovalsAndSandbox`, nested `codexTrustedLocal`) through the request body are
  rejected by the existing `.strict()` contract; task title/description text mentioning
  bypass/trusted-local phrasing is accepted as inert data and never activates anything.
- `adapters.test.ts` (`apps/server`) — the generic `limitationNotice` mechanism itself, proven with
  a fake adapter (no `adapterId` branching in the route): populated only when `availability ===
"available"` and a `diagnosticMessage` is present; never populated otherwise, even if a
  `diagnosticMessage` is present on a non-available result.
- `assign-dialog.test.tsx` (`apps/web`) — renders the trusted-local notice text and the generic
  `" (see notice below)"` option suffix when `limitationNotice` is present; renders neither when it
  is absent; the suffix never says "trusted-local mode" for an adapter that isn't in that mode
  (Claude Code carries a `limitationNotice` too, but a different, non-trusted-local one).

## Real Codex smoke test and Playwright verification

Both performed, each after its own separate explicit operator confirmation, and both succeeded. The
adapter-level smoke test (real `CodexAdapter`, no browser) produced a genuine `file.changed` +
`run.completed` pair against an isolated fixture. The Playwright browser pass drove the real Hall
Web/Hall Core workflow end to end — create, ready, assign, the explicit start confirmation, start,
and observed the same real event shape through the UI's own Live Event Timeline, including the raw
`file.changed` event payload (relative path only). See the Phase 10.2 session report for the full,
detailed results of each; a real UI-wording bug (the option-list suffix incorrectly read
`" (trusted-local mode)"` for every adapter carrying any `limitationNotice`, including Claude
Code's unrelated one) was caught live during this pass and fixed — see "Surfacing the warning to
Hall Web" above.

Together, exactly two real Codex invocations have been spent across this phase (one per
verification), each under its own explicit confirmation; no further Codex invocation is authorized
without a new one.

## Remaining limitations

- The Windows sandbox restriction diagnosed in Phase 10.1 is unchanged and still applies to strict
  mode; trusted-local mode works around it by disabling sandboxing rather than fixing it.
- A one-off cold-start detection flake (`detect()` briefly reporting `unavailable`/"Codex CLI could
  not be started" on the very first call after Hall Core starts, succeeding immediately on a second
  call) was observed and recurred across both real verification passes; it appears to be a spawn-
  timing issue with the npm `.cmd` shim, not a logic defect, but has not been root-caused further.
- `limitationNotice` is a generic mechanism now shared by any adapter whose `available` result
  carries a `diagnosticMessage` — currently Codex (trusted-local) and Claude Code.

## How to disable trusted-local mode

Omit `--enable-codex-trusted-local` (or pass nothing) at Hall Core startup — this is already the
default. There is no other switch: the flag is read once, at process construction, and nothing at
runtime can toggle it.

## Phase 16.4 coexistence with strict isolated Codex

Phase 16.4 adds a separate strict isolated Codex path for durable Hall-owned worktrees. It does not
reuse trusted-local mode and does not make trusted-local safer. Strict isolated mode keeps
`--sandbox workspace-write`, disables network and web search, disables hooks/plugins/remote plugin
and multi-agent features, and retains the exact Hall worktree validation infrastructure through
`AgentWorktreeManager`. A passing zero-model native sandbox probe is necessary but not sufficient:
because `codex sandbox -P :workspace` is not exact proof of real `codex exec --sandbox
workspace-write` policy equivalence, strict detection remains `unsupported`. The explicitly
authorized real-Codex equivalence verification originally planned to resolve this was deferred as
optional future hardening rather than completed — Phase 16.6 was re-scoped instead to Codex
trusted-local production readiness and Git LFS worktree compatibility (see the "Phase 16.6 — Git
LFS worktree compatibility for trusted-local" section below), and strict Codex remains fail-closed
with no phase currently planned to prove that equivalence.

Trusted-local remains exactly what this document says it is: explicitly opt-in, not sandboxed, and
backed by `--dangerously-bypass-approvals-and-sandbox`. If trusted-local is enabled, it remains a
separate operator choice and is never silently selected as a fallback when strict isolated mode is
missing durability, lacks an explicit worktree root, fails the sandbox probe, lacks exact sandbox
equivalence proof, or rejects a worktree at start time.

Phase 16.4 does not run a real model-backed Codex task. Restart-safe worktree cleanup and
reconciliation remain Phase 16.5.

## Phase 16.6 — Git LFS worktree compatibility for trusted-local

When durable storage and an explicit `--agent-worktree-root` are both configured, trusted-local
Codex execution uses the same Hall-owned worktree infrastructure strict mode is designed for (see
"Phase 16.4 coexistence with strict isolated Codex" above and `0016-codex-worktree-execution.md`)
— the worktree here is a primary-checkout safety mechanism, never an OS sandbox, and it does not
make trusted-local's own OS-level bypass any less real. Before Phase 16.6, `AgentWorktreeManager`
rejected any configured Git checkout filter by key-name suffix alone, which also rejected the
standard Git LFS profile Git for Windows registers at system scope by default — meaning trusted-
local Codex tasks failed closed with `GIT_CHECKOUT_FILTER_UNSUPPORTED` before Codex was ever
invoked on any such machine, never reaching this document's own bypass argv at all. Phase 16.6
narrows that rejection to recognize exactly the standard Git LFS profile (by key and value, never
by name alone) and disables automatic LFS object download/materialization for the worktree
checkout (`GIT_LFS_SKIP_SMUDGE=1`, scoped to that one invocation) — see
`0016-codex-worktree-execution.md` and `0009-codex-adapter.md`'s own Phase 16.6 section for the
full mechanism. Nothing about trusted-local's own argv, environment policy, or opt-in requirement
changed. Real Codex smoke verification — the one this document's Phase 16.4 section deferred — was
completed in Phase 16.6, but scoped to trusted-local, not strict mode: exact strict-mode sandbox-
equivalence proof remains deferred as optional future hardening.

## Paperclip attribution

Paperclip (<https://github.com/paperclipai/paperclip>) is MIT licensed. Files studied at commit
`230126d80bd59b8f521ed635a3e8e14a6295ec1e`: `index.ts`, `server/build-config.ts`,
`server/codex-args.ts`, `server/execute.ts`, `server/codex-home.ts`, `server/parse.ts`. No
Paperclip source was copied verbatim into this repository — every behavior reproduced here (see
"What Hall reproduces" above) was independently reimplemented against Hall's own existing
types, conventions, and safety discipline after reading Paperclip's source for orientation. No
`THIRD_PARTY_NOTICES` entry is required under those circumstances, but this section serves as the
project's own record of the reference material and its license.
