# 0009 — Codex Adapter

Status: Draft (Phase 10; hardened in Phase 10.1, Phase 10.2, Phase 10.3, and Phase 16.4). Phase
16.4 keeps strict Codex fail-closed: durable Hall-owned worktree isolation and the zero-model native
sandbox probe are present, but they do not prove exact equivalence with real
`codex exec --sandbox workspace-write` execution. Strict `detect()` remains `unsupported` until the
explicit Phase 16.6 verification proves the effective policy.
**Phase 10.2** (see
[`0010-paperclip-compatible-codex-mode.md`](0010-paperclip-compatible-codex-mode.md)) adds a
separate, explicitly opt-in "trusted-local" mode that makes Codex assignable by having it bypass
its own internal sandbox/approval enforcement instead — never the default, never reachable from
anything browser- or task-controlled. Everything in this document describes the _strict_, default
profile unless a passage explicitly says otherwise; 0010 is the authoritative source for
trusted-local mode.

## Context

Phase 10 adds `@hall-of-wisdom/codex-adapter` (`adapters/codex/`), Hall of Wisdom's second real,
non-mock `AgentAdapter`. It spawns the operator's own locally-installed, ChatGPT-authenticated
Codex CLI (`codex`, from `@openai/codex`) as a child process, mirroring the design Phase 9
established for `@hall-of-wisdom/claude-code-adapter` (see
[`0008-claude-code-adapter.md`](0008-claude-code-adapter.md)) wherever the two providers' actual
CLI behavior allows it, and diverging deliberately — and only — where reconnaissance against the
real installed CLI showed the analogy breaking down.

## Why the Codex CLI, not the OpenAI API

Exactly the same reasoning as Claude Code (0008, "Why a CLI adapter, not the Claude API SDK"): this
adapter never imports an OpenAI API SDK and never calls the Responses API or Chat Completions API
directly. It spawns the operator's own `codex` executable and speaks to it over stdout/stdin/stderr,
so that task execution rides on the operator's existing ChatGPT/Codex subscription rather than a
separately metered API key — the CLI already owns the ChatGPT-auth flow and the sandboxed
tool-execution loop, and reimplementing either against the bare API would mean rebuilding (and
re-securing) surface this adapter has no need to own.

## ChatGPT-auth requirement and billing precedence risk

`detect()` only ever reports `availability: "available"` when `codex login status`'s output
matches the one confirmed real shape, `"Logged in using ChatGPT"` (case-insensitive), classified by
`auth-classification.ts`'s `parseLoginStatusOutput`. Every other observed or hypothesized shape —
not logged in, an API-key-based login, an access-token-based login, or anything unrecognized — maps
to `chatgptVerified: false` and fails detection closed to `logged_out`/`unsupported`, never
`available`. As with Claude Code, `startTask()` re-runs `detect()` immediately before spawning the
real task process, so a stale, minutes-old `available` result from a browser's adapter-list poll can
never become optimistic permission to bill the wrong source.

### Authentication output hygiene

`codex login status` has no `--json` mode (confirmed via `codex login status --help` against the
installed CLI, `codex-cli 0.144.4`) — this adapter classifies its plain, human-readable text.
**Real, live-confirmed shape:** `"Logged in using ChatGPT"`. **Not observed live** (deliberately
never triggered, to avoid disturbing the operator's real ChatGPT session): the not-logged-in,
API-key, and access-token shapes. Those three patterns in `auth-classification.ts` are a
best-effort, conservative guess informed by the flag names `codex login --help` documents
(`--with-api-key`, `--with-access-token`); anything that doesn't clearly match one of the four
recognized patterns — including a plausible-looking but unrecognized string — classifies as
`"ambiguous"` with `chatgptVerified: false` rather than being guessed into a specific category. This
is the same "distinct `undefined`/`ambiguous` sentinel, never collapsed into a specific negative
result" discipline `0008` established for Claude's auth classifier, adapted to a boolean gate
instead of an `undefined` sentinel because `codex login status`'s exit code and stdout are both
always populated (there is no "could not parse an envelope at all" failure mode the way JSON parsing
has).

**Stream discovery (a real, live-confirmed surprise):** `codex login status`'s message arrives on
**stderr**, not stdout — confirmed by capturing the two streams separately during Phase 10
reconnaissance (stdout was empty; stderr contained the message). `detection.ts` concatenates both
bounded streams (`` `${stdout}\n${stderr}` ``) before handing the combined text to
`parseLoginStatusOutput`, rather than assuming either stream — the classifier only ever
substring-matches a fixed set of known-safe patterns, so widening its input to "either stream"
carries no additional risk, and it means detection doesn't depend on a specific, undocumented stream
assignment staying stable across CLI versions. This was caught only because a live invocation was
actually run and separately captured — see "Real smoke-test results" for how it was found (it first
manifested as a **false-negative**: a genuinely authenticated session was misreported as
`unsupported`).

Never read: `~/.codex/auth.json`, any OS credential store, `codex doctor`'s JSON report (which does
expose `CODEX_HOME`, the auth file's absolute path, the cwd, and other system detail — considered
during design and deliberately rejected as this adapter's auth-detection mechanism precisely
because of that exposure; see "Design alternative considered and rejected" below). No account
email, workspace name, `CODEX_HOME` value, or credential file path is ever read, retained, or
forwarded by this adapter, in `SafeAuthClassification`, in a `StructuredFailure`, in an
`AgentDetectionResult`, or in any Hall event.

### Design alternative considered and rejected: `codex doctor --json`

`codex doctor --json` is documented as emitting a "redacted, machine-readable report" and includes a
structured `checks["auth.credentials"]["details"]["stored auth mode"]` field (`"chatgpt"`/etc.) —
a cleaner signal in principle than parsing `login status`'s free text. It was rejected as the
primary detection mechanism because the rest of that same report is not narrowly scoped: it also
includes `CODEX_HOME`, the auth file's absolute path, the working directory, git repository root and
branch, npm install paths, and OS version. Reducing that payload safely would require the same
"hard-boundary, discard everything but N named fields" module either way, with strictly more
surface to get wrong for a single boolean gate that `login status` already answers directly. `login
status` is also what the Phase 10 kickoff's own instructions named as the primary mechanism.

## Environment sanitization

`environment.ts`'s `buildChildEnvironment` is an allowlist, not a denylist — see 0008's identical
reasoning (an allowlist is safe by construction against a future billing-related environment
variable this adapter was never told about; a denylist is not). Preserved when present: `PATH`,
`PATHEXT`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `SYSTEMROOT`, `WINDIR`, `COMSPEC`,
`TEMP`, `TMP`, `LANG`/`LC_ALL`/`LC_CTYPE`, and `CODEX_HOME`. `CODEX_HOME` is preserved deliberately:
it is where the operator's own `codex login` already wrote ChatGPT credentials (confirmed via
`codex doctor --json`'s `auth.credentials.details["auth file"]` during reconnaissance, observed to
live under `%CODEX_HOME%\auth.json`) — without it (or without `HOME`/`USERPROFILE` resolving to the
same location), Codex would fail to find the operator's already-established login, producing a
spurious "logged out" result rather than a genuine one. Blocked regardless of allowlist construction
(defense in depth): `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `OPENAI_BASE_URL`,
`OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, Azure OpenAI variables, `CODEX_OSS`, `CODEX_PROFILE`, and
proxy credential variables (`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`). The same sanitized environment
is used for both `detect()`'s bounded calls and the real task's `codex exec` call, for the same
reason 0008 documents: a verified-ChatGPT detection result must actually predict what auth source
the real task execution ends up using.

**Disclosed scope limitation:** this adapter reuses the operator's full, real `CODEX_HOME` rather
than a hermetically isolated one (a fully isolated `CODEX_HOME` would break ChatGPT auth resolution,
which is why it's not done). `--ignore-user-config`/`--ephemeral` suppress `config.toml` loading and
session/rollout persistence respectively, but other state under `CODEX_HOME` (the models cache,
memories, goals — all observed to exist during reconnaissance) is not guaranteed hermetically
isolated from the operator's ordinary interactive Codex use. This mirrors, and is bounded by, the
same category of limitation 0008 discloses for Claude Code's managed-policy interaction.

## Executable resolution and Windows shim policy

`executable-resolver.ts`'s `resolveCodexExecutable` mirrors Claude's `resolveClaudeExecutable`
(deterministic `PATH` scan via `node:path`, no shell `which`/`where`, native wins over shim,
first-found-in-PATH-order wins among same-kind candidates), with two deliberate differences:

1. **A `.cmd`/`.bat` shim is accepted, not rejected.** Unlike the Claude Code adapter (which reports
   a shim-only installation as `unsupported`), this adapter executes the shim — see "Process
   launching" below for how. This was necessary, not optional: reconnaissance found the real
   npm-managed Windows install of `@openai/codex` provides only `codex`, `codex.cmd`, and
   `codex.ps1` at the npm global bin directory; there is no directly-PATH-reachable native `.exe`.
   The real native `codex.exe` exists, but nested several directories deep inside a version-pinned
   platform package (`node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/
x86_64-pc-windows-msvc/bin/codex.exe`) that `codex.cmd` locates dynamically via a Node wrapper
   (`bin/codex.js`) — resolving directly to that path was considered and rejected as too fragile
   (an internal npm package layout detail with no stability guarantee across versions).
2. **The extensionless `codex` file on Windows is treated as a shim candidate, not native.** npm's
   shim generator (`cmd-shim`) always produces this file as a POSIX shell script (for Git
   Bash/WSL), never a native Windows process image — confirmed live: `file` reported "POSIX shell
   script, ASCII text executable" for the real installed path. Windows `CreateProcess` cannot
   execute it directly. (This corrects an initial implementation bug, caught only by writing a
   `.ps1`-exclusion regression test: the first version of the resolver's Windows branch treated
   _any_ file found via the extensionless check as native, misclassifying this exact case — a real,
   observed misclassification during Phase 10's instrumented smoke run, harmless in that instance
   only because `cross-spawn`'s own internal resolution happened to compensate. Fixed by an explicit
   `WINDOWS_NATIVE_EXTENSIONS = {.exe, .com}` allowlist rather than "not obviously a shim".)
   `.ps1` is excluded from both the native and shim buckets for the same reason 0008 excludes it for
   Claude: Windows does not auto-invoke a PowerShell script the way it does `.cmd`/`.bat`, and this
   adapter does not implement the `powershell -File` invocation that would be required.

### Windows shim execution: `cross-spawn`

`process-spawner.ts` uses `cross-spawn` (a small, reviewed, extremely widely used package — it is
what `npm` itself uses internally) as the one process-spawn compatibility dependency the Phase 10
kickoff pre-authorized for exactly this situation. `cross-spawn` is a transparent drop-in for
`node:child_process.spawn`: for a real native executable, or on any POSIX platform, it delegates
straight through with no behavioral change; only for a Windows `.cmd`/`.bat` target does it apply
its own correctly-escaped `cmd.exe` invocation. This is **not** `shell: true` and **not** a manually
concatenated command string — every argv element passed to it is either a fixed, Hall-controlled
constant (`permission-profile.ts`'s `buildCodexArgv`) or, for the prompt, delivered separately over
stdin, never through `args`. `cross-spawn`'s own internal resolution was also confirmed live to
correctly locate and invoke the adjacent `.cmd` shim even when handed the (mis-resolved, pre-fix)
extensionless path directly, independent evidence that its escaping/resolution logic is doing real,
correct work here rather than being a purely theoretical safety margin.

## `codex exec` JSONL boundary and the fixed sandbox/approval profile

`permission-profile.ts`'s `buildCodexArgv(workingDirectory)` builds the complete, fixed argv for
one task execution:

```
exec --json --ephemeral --ignore-user-config --ignore-rules --strict-config
  --sandbox workspace-write
  -c approval_policy="never"
  -c sandbox_workspace_write.network_access=false
  -c web_search="disabled"
  --cd <working directory>
  -
```

Every flag here — including the two deliberate deviations from the Phase 10 kickoff's own
"conceptual" example invocation below — was verified against the real installed CLI
(`codex-cli 0.144.4`) before being written, using a zero-usage technique: `--strict-config` makes
`codex exec` reject an unrecognized `-c` key with `Error loading config.toml: unknown configuration
field ... in -c/--config override` _during config parsing, before any model or network call_, so
every key name below was confirmed real (not merely silently ignored) by first triggering that exact
error with a deliberately-invalid key at the same argv position, then substituting the real one and
observing the error disappear (or, for `web_search`, change into a value-type error that itself
revealed the required TOML string type and the accepted enum). This is the same "prove the exact
flag semantics from the installed CLI's own behavior, not from what looks similar" discipline 0008
used to distinguish `--safe-mode` from `--bare`.

**Deviation 1 — no `--ask-for-approval` flag.** `codex exec --help`'s own option list does not
include `-a`/`--ask-for-approval` at all (it exists only on the root/interactive `codex` command).
Passing it to `codex exec` fails immediately: `error: unexpected argument '--ask-for-approval'
found`, exit code 2, before any config or model step (confirmed live).

**Deviation 2 — `-c approval_policy="never"` used instead, added after a real failure, not part of
the original design.** The first real isolated smoke run (see "Real smoke-test results" below)
completed its full lifecycle cleanly — `run.started` through `run.completed`, no error — but the
model's own final message reported every attempted shell command "rejected: blocked by policy", and
the isolated fixture file was never actually modified. `codex exec` without an explicit approval
policy defaults to **denying** command execution rather than auto-approving everything the fixed
`--sandbox workspace-write` profile would otherwise permit. There is still no human to prompt in a
non-interactive run; `approval_policy="never"` is what makes that concretely mean "auto-resolve every
approval decision within the sandbox's own bounds" rather than "deny everything that would otherwise
need to ask." This adapter's own wall-clock run timeout (`codex-run.ts`) remains the backstop against
a hang; `approval_policy` never grants an escalation the `--sandbox workspace-write`/no-network/
no-web-search profile does not already independently allow.

**`-c sandbox_workspace_write.network_access=false`** and **`-c web_search="disabled"`** are
confirmed-real keys per the technique above; `web_search`'s value must be a quoted TOML string
(`web_search=false` fails with `invalid type: unit variant, expected string only`), and the accepted
enum — read directly off the resulting error message — is `disabled`/`cached`/`indexed`/`live`.

Never used, per the kickoff's explicit prohibition list (all confirmed absent from every generated
argv by `permission-profile.test.ts`): `--dangerously-bypass-approvals-and-sandbox`,
`--dangerously-bypass-hook-trust`, `--skip-git-repo-check` (for normal tasks — see "Git repository
policy" below), `--search`/`--oss`/`--local-provider`/`--remote`/`--profile`, `--add-dir`,
`--image`, `--output-schema`/`--output-last-message`, `resume`, `--sandbox danger-full-access`,
`--ask-for-approval` (re-confirmed absent from `codex exec --help`'s option list during Phase 10.1
— see "Phase 10.1" below).

**Phase 10.1 addition:** `-c ...`, `--disable hooks`, `--disable plugins`, `--disable
plugin_sharing`, `--disable remote_plugin`, and `--disable multi_agent` are also always present —
see "Phase 10.1", "Approval and sandbox argument review" and "Configuration, hook, skill, and
plugin isolation" below for why.

### Prompt delivery over stdin

The task prompt is never an argv element. `permission-profile.ts`'s trailing `"-"` is Codex's own
documented convention (confirmed live) for "read the prompt from stdin rather than an argument."
`codex-run.ts` writes the bounded prompt to the child's stdin immediately after `run.started` is
emitted, then closes it. This keeps task-controlled content (the prompt) fully out of the process
argument list and — specifically on Windows — out of the `.cmd` shim's command line entirely, which
is exactly the property the kickoff asked stdin delivery to provide.

## Project configuration isolation

Reconnaissance found evidence, from the real installed CLI, that project-level `.codex/config.toml`
is **not** auto-loaded from the task's working directory: a deliberately-invalid key placed in a
`.codex/config.toml` inside the probe fixture produced no `--strict-config` error — neither with nor
without `--ignore-user-config`/`--ignore-rules` present — where the identical invalid key at the
same position via `-c` reliably does error. This is treated as reasonably strong evidence (not
absolute proof) that this CLI version has no separate "project config" auto-discovery path the way
Claude Code's `.claude/settings.json` does, and is the basis for this adapter's isolation posture:
Hall's fixed CLI flags remain authoritative, and a project cannot silently escalate sandbox mode,
approval policy, or network access through its own `.codex/config.toml`.

The `codex-adapter.test.ts` malicious-project-configuration regression proves the adapter-level
half of this independently of the CLI-level finding above: a real temp directory containing a
`.codex/config.toml` (with `sandbox_mode = "danger-full-access"`, a fake `mcp_servers.evil`
entry, and `approval_policy = "never"` set redundantly), a `.codex/hooks.json`, a
`.codex/rules/untrusted.rules`, and an `AGENTS.md` produces byte-identical generated argv compared
to an empty directory, spawns no additional process, and never lets `danger-full-access` reach the
real argv — regardless of what the CLI itself does with the file, Hall never reads, parses, or
forwards its content.

## AGENTS.md policy

`prompt-builder.ts`'s fixed instructions tell Codex to treat any `AGENTS.md` it finds as untrusted
project guidance: it may inform _what_ the task should do, but it cannot expand the sandbox, enable
network access, add command-line flags, enable hooks/MCP servers/plugins, or override the no-commit/
no-push policy. Hall Core never reads or parses `AGENTS.md` itself — the prompt only instructs Codex
to check for and read it using its own tools, exactly as 0008 does for Claude Code and `CLAUDE.md`.

## Git repository policy

`git-repository-check.ts`'s `isInsideGitRepository` walks up from the working directory looking for
a `.git` entry (directory or file — a linked worktree's `.git` is a text file, and its mere presence
is sufficient evidence), using `fs.existsSync` through an injectable probe, never a shell `git`
invocation. This runs _before_ `CodexAdapter.startTask` ever spawns Codex: a non-repository working
directory fails closed with the stable code `CODEX_GIT_REPOSITORY_REQUIRED`, rather than depending
on however Codex's own internal Git-repository check happens to fail. `--skip-git-repo-check` is
never passed for a normal task. The real isolated smoke-test fixture
(`D:\HallOfWisdom\.tmp\codex-adapter-smoke\`, deleted after use — see "Residual data review") was a
real, `git init`-created repository for exactly this reason.

## Native JSONL mapping

### Confirmed live (two real invocations, both against `codex-cli 0.144.4`)

- `{"type":"thread.started","thread_id":"..."}` — the real `thread_id` is never forwarded; classified
  `"ignored"`.
- `{"type":"turn.started"}` — classified `"ignored"`: `run.started` is already emitted by
  `CodexRun` the moment the child process successfully spawns (mirroring Claude Code's identical
  discipline), so this native event carries no additional information this adapter needs.
- `{"type":"item.completed","item":{"id":...,"type":"agent_message","text":...}}` — a single,
  complete message; no `item.started`/partial variant was observed for a plain message turn, so
  Phase 10 uses complete `message.delta` events only, matching 0008's own precedent of not
  inventing a partial-message protocol without live evidence it exists.
- `{"type":"item.started"/"item.completed","item":{"id":...,"type":"command_execution","command":
...,"aggregated_output":...,"exit_code":...,"status":...}}` — real observed `status` values:
  `"in_progress"` (started), `"completed"` (exit_code `0`), `"declined"` (exit_code `-1`, the
  sandbox-rejection case — see "Real smoke-test results"). `command` and `aggregated_output` are
  read only to _classify_ success/failure; neither is ever forwarded into a Hall event — `tool.name`
  is always the fixed, generic label `"Codex command"`.
- `{"type":"turn.completed","usage":{"input_tokens":...,"cached_input_tokens":...,
"output_tokens":...,"reasoning_output_tokens":...}}` — `usage` (token counts) is never read or
  forwarded; maps to `run.completed`.
- `{"type":"turn.failed","message":...}` and `{"type":"error","message":...}` — both map to
  `run.failed` with `CODEX_EXECUTION_FAILED`.

### Not observed live — speculative, tolerant-by-design

`file_change` items were never observed: every real write attempt across two live invocations was
rejected by the sandbox before completion (see "Real smoke-test results"), so no `file_change` item
was ever emitted by the real CLI to confirm its shape against. `codex-native-messages.ts`'s
`classifyFileChangeItem` models a best-effort shape (`item.completed`, `status: "completed"`,
`changes: [{path, kind}]`) informed by the general documented event family names, and is
deliberately tolerant: any item that doesn't match is classified `"ignored"` rather than failing the
line. **This is the one path in this adapter's event mapping that remains genuinely unverified
against the real CLI.** `mcp_tool_call`, `web_search`, `plan`/`plan_update`, and `reasoning` items,
and `item.updated` events, are real per the documented event family list but were not specifically
observed; all classify safely to `"ignored"`.

### Event-channel isolation (corrected in Phase 10.1)

**Superseded design, kept here only for history:** Phase 10 originally had `CodexRun` parse
_both_ stdout and stderr as JSONL, reasoning from the `login status`-on-stderr discovery (see
"Authentication output hygiene") that "the JSONL event stream is on stdout" could not be taken on
faith. A Phase 10.1 security review rejected this: treating stderr as a second authoritative event
source created exactly the classes of risk a review must not accept speculatively (an injected or
malformed stderr line producing a false terminal event, a phantom tool/file event, or corrupting
provider-event ordering), and `login status` and `codex exec` are different commands with no
guarantee of sharing a stream convention in the first place.

**Current design:** `codex exec --help` itself documents `--json` as "Print events to stdout as
JSONL" — the CLI's own words, not an inference. `CodexRun` now parses **stdout only** as the native
event stream. stderr bytes are received and immediately discarded (`() => undefined`) — never
parsed, stored, classified, forwarded into a `StructuredFailure`, or forwarded into any Hall event.
stderr cannot create a Hall event, cannot create or contribute to a terminal outcome, cannot
advance provider-event ordering, cannot satisfy the missing-result check, and cannot produce
`tool.started`/`tool.completed`/`file.changed`/`message.delta` — by construction, since nothing on
that stream is ever inspected at all. A well-formed, even terminal-shaped JSONL line arriving on
stderr (a malicious or buggy provider sending `turn.completed` there, for example) has zero effect.
Malformed/oversized/truncated conditions are only ever fatal
(`CODEX_STREAM_INVALID`/`CODEX_STREAM_TRUNCATED`) when they occur on stdout — the sole authoritative
stream. See `codex-run.test.ts`'s "event-channel isolation (Phase 10.1)" describe block for the
regression suite proving each of these properties individually (well-formed stderr
turn.started/turn.completed/item.completed/command_execution/file_change all produce nothing;
malformed and oversized stderr never corrupt stdout processing; a sensitive-looking stderr sentinel
never reaches any emitted event; cancellation remains first-terminal-wins even if stderr carries a
well-formed terminal-shaped event).

## Command execution events, file change events, and path safety

Mirrors 0008's design directly: `tool.started`/`tool.completed` never carry a raw command string,
command output, or environment value — only the generic `"Codex command"` label, a stable
`toolCallId` (the provider's own `item` id, never reused as a Hall `eventId`), and a `success`
boolean derived from `exit_code`/`status`. `file.changed` (when the speculative `file_change` path
does fire) resolves the reported path through `file-path-safety.ts`'s `toSafeRelativeFilePath` —
byte-identical logic to 0008's own implementation: lexical `resolve`/`relative` containment check,
then a canonical (`fs.realpathSync.native`) re-check to close the gap where a symlink _inside_ the
working directory points outside it, falling back to the lexical result only if realpath genuinely
cannot resolve (not treating that as an automatic escape). Never returns an absolute path.

## Failure taxonomy

`CODEX_CLI_NOT_FOUND`, `CODEX_NOT_AUTHENTICATED`, `CODEX_CHATGPT_AUTH_UNVERIFIED`,
`CODEX_API_KEY_AUTH_REJECTED`, `CODEX_ACCESS_TOKEN_AUTH_REJECTED`, `CODEX_UNSUPPORTED_VERSION`,
`CODEX_ISOLATION_UNSUPPORTED`, `CODEX_GIT_REPOSITORY_REQUIRED`, `CODEX_PROCESS_START_FAILED`,
`CODEX_PROCESS_EXITED`, `CODEX_STREAM_INVALID`, `CODEX_STREAM_TRUNCATED`, `CODEX_RESULT_MISSING`,
`CODEX_SANDBOX_DENIED`, `CODEX_APPROVAL_REQUIRED`, `CODEX_RATE_LIMITED`,
`CODEX_USAGE_LIMIT_REACHED`, `CODEX_EXECUTION_FAILED`. Every `StructuredFailure` carries a bounded,
safe message and no `details` object — no raw stderr, native JSON, account info, command output, or
absolute path ever reaches one. `CODEX_API_KEY_AUTH_REJECTED`/`CODEX_ACCESS_TOKEN_AUTH_REJECTED` are
defined for the failure taxonomy's completeness but are not currently produced by any specific
detection branch beyond the generic `CODEX_CHATGPT_AUTH_UNVERIFIED` path (`detectCodex` maps
`api_key`/`access_token`/`ambiguous` classifications alike to `unsupported`); wiring the more
specific codes would require the negative-auth-shape verification this phase's "Authentication
output hygiene" section already discloses as unconfirmed. `CODEX_SANDBOX_DENIED`/
`CODEX_APPROVAL_REQUIRED` are likewise defined but not wired to a specific native event in Phase 10
— the real, observed "blocked by policy" rejections currently surface only as a `tool.completed`
event with `success: false`, not as a distinct Hall failure code, since the run itself still
completes successfully from Codex's own perspective (see "Real smoke-test results").

## Process launching and cancellation

`process-spawner.ts`/`process-tree.ts`/`codex-run.ts` mirror 0008's design closely: `shell: false`
always; stdin/stdout/stderr all piped (stdin piped rather than ignored, unlike Claude Code, because
the prompt travels over it); a bounded startup timeout, a bounded max-run-duration timeout, and a
`PosixGroupKiller`-injectable two-phase termination (graceful `SIGTERM` to the POSIX process group /
no-op on Windows, then a bounded grace period, then forced `SIGKILL` or `taskkill.exe /PID <pid> /T
/F`). `TerminalEventGuard` enforces exactly one terminal event; `cancel()` and `AbortSignal`
cancellation are both idempotent; cancellation before spawn never spawns; a provider exit after
cancellation is never reported as `run.failed`. No `CodexRun` internals are exposed outside the
package; no child process outlives run termination in the deterministic test suite. A dedicated
early-stdin-failure handler (`#writePromptToStdin`) prevents an unhandled `"error"` event on the
stdin stream — which would otherwise crash the whole adapter process — from ever going uncaught.

## Hall Core integration

`apps/server/src/composition/codex-composition-root.ts` is the only file in Hall Core allowed to
know about the Codex adapter specifically, registered unconditionally (no `--enable-codex` flag,
same reasoning as Claude Code: `detect()` is itself bounded and safe) alongside Mock Agent and
Claude Code in `server-composition.ts`. No generic module (`TaskStore`, `TaskOrchestrator`, route
handlers, Hall Web, Kanban components) ever branches on `adapterId === "hall.codex"`. `GET
/api/v1/adapters` lists all three; a Codex detection failure never breaks Mock Agent's or Claude
Code's own registration or listing (`codex-integration.test.ts`). No Codex-specific field exists on
the generic task-creation contract.

## Real smoke-test results

Three real, user-approved invocations were performed beyond the one minimal JSONL reconnaissance
probe, after the first attempt produced an inconclusive result (see below) — each spend was
explicitly confirmed with the operator before proceeding, per the kickoff's usage-conservation
constraint.

1. **First real edit attempt (through `CodexAdapter`, before the `approval_policy` fix).** Completed
   a full, clean lifecycle — `run.started`, an initial message, three `tool.started`/`tool.completed`
   pairs, a final summary message, `run.completed` — with no error. The target file was **not**
   modified (`git status` clean). This was the "misleadingly clean failure" the design review had
   specifically flagged as the risk of not separately capturing raw output; length-only event
   logging left no way to diagnose why.
2. **Instrumented raw-capture run (separated stdout/stderr, direct CLI invocation using the exact
   adapter-built argv/env/prompt).** Recovered the real cause: every attempted shell command,
   including the one that would have appended to the file, was rejected with `"rejected: blocked by
policy"`, and the model's own final message explicitly stated the append was blocked by "the
   read-only filesystem policy." This is what identified the missing `approval_policy` config key
   (see "Deviation 2" above) — the fix was applied and confirmed for free first (`--strict-config`
   accepted `-c approval_policy="never"` without a model call).
3. **Confirmation run (through `CodexAdapter`, with the fix applied).** More commands executed this
   time (read-only ones — listing and reading the file — succeeded), but the actual append was
   **still** rejected, and the model's final message again reported the change was blocked by "the
   read-only sandbox." The file remained unmodified.

**Conclusion, disclosed rather than worked around:** `approval_policy="never"` measurably changed
behavior (more commands were attempted) but did not resolve the underlying write rejection. The root
cause of the persistent write denial under `--sandbox workspace-write` on this Windows installation
is **undetermined** without further, costed investigation (a `--sandbox danger-full-access`
diagnostic-only comparison was proposed and explicitly declined by the operator in favor of stopping
and documenting). What _is_ verified, live, through the real adapter and real CLI: process spawning,
ChatGPT-auth detection (including the stderr discovery and fix), ChatGPT-auth-gated execution, full
ordinary lifecycle event mapping (`run.started`/`message.delta`/`tool.started`/`tool.completed`/
`run.completed`), ChatGPT authentication was used throughout (`login status` confirmed ChatGPT before
every run), no API-key/access-token environment variables were ever present, and no repository
hook/MCP server/plugin process ran. What is **not** verified: an actual successful file write, and
therefore the `file_change` native item shape and this adapter's `file.changed` event mapping for
it.

## Current limitations

- **File-editing capability is unverified.** See "Real smoke-test results" — this is the phase's one
  open, disclosed gap, not a documentation afterthought. Do not assign Codex a task that requires a
  file change until this is investigated further (candidate next steps: check whether Windows
  sandboxing specifically, versus the sandbox mechanism in general, is implicated — e.g. by testing
  on a non-Windows machine, or by consulting OpenAI's own Codex sandboxing documentation/support for
  known Windows `workspace-write` limitations).
- The `file_change` native JSONL shape is speculative (see "Native JSONL mapping").
- `CODEX_API_KEY_AUTH_REJECTED`/`CODEX_ACCESS_TOKEN_AUTH_REJECTED`/`CODEX_SANDBOX_DENIED`/
  `CODEX_APPROVAL_REQUIRED` are defined in the failure taxonomy but not wired to a specific
  detection/mapping branch (see "Failure taxonomy").
- The negative auth-status text shapes (`logged_out`/`api_key`/`access_token`) in
  `auth-classification.ts` are unverified against the real CLI, for the same reason 0008 discloses
  for the equivalent Claude gap: deliberately never triggered live, to avoid disturbing the
  operator's real session.
- `CODEX_HOME` is the operator's real, shared directory, not a hermetically isolated one (see
  "Environment sanitization").
- **`--ignore-user-config`'s scope is narrower than its name suggests; partially addressed in
  Phase 10.1.** Its own `--help` text says only "Do not load `$CODEX_HOME/config.toml`". Phase 10.1
  confirmed, for free via `codex features list` (no model call), that `hooks`/`plugins`/
  `plugin_sharing`/`remote_plugin`/`multi_agent` are all real, `stable`, and enabled (`true`) on the
  installed CLI — and, since no top-level `skills` feature flag exists in that same listing, skills
  most likely activate from filesystem presence rather than being config.toml/feature-gated at all.
  The fixed argv now explicitly passes `--disable hooks --disable plugins --disable plugin_sharing
--disable remote_plugin --disable multi_agent` as a defense-in-depth second layer (see
  "Approval and sandbox argument review" below) — but whether a `.codex/skills/` directory is ever
  read by `codex exec` specifically remains **unconfirmed**, since no equivalent `--disable` control
  for skills was found. Treat project-adjacent skill isolation as unconfirmed, distinct from the
  hooks/plugins/multi-agent case, which now has both a config-suppression layer
  (`--ignore-user-config`) and an explicit feature-disable layer.

## Coexistence with Claude Code

No shared provider abstraction was introduced between the two adapters beyond what already existed
in `@hall-of-wisdom/agent-adapter-sdk` (`EventFactory`, `TerminalEventGuard`, the `AgentAdapter`
interface) — per the Phase 10 kickoff's explicit instruction not to force one "unless clearly
justified." The two packages independently reimplement structurally similar but not identical
modules (environment sanitizer, executable resolver, JSONL/stream-json parser, event mapper,
process launcher) because their actual constraints differ enough — stdin-vs-argv prompt delivery,
Windows shim policy, auth-output shape and stream — that a shared abstraction would have meant
either leaking Codex's specifics into Claude's package or vice versa. Neither adapter is aware of
the other's existence; `apps/server/src/composition/server-composition.ts` is the only file that
assembles both onto one shared, provider-neutral `AgentRegistry`.

## Why further adapters are deferred

Per the kickoff's explicit restriction: no OpenAI API calls, no API-key support, no Codex cloud/
app-server/MCP server, no open-source model support, no model/sandbox/approval selection surfaced in
Hall Web, no session resumption, no Git worktrees, no commits or pushes by agent tasks, and no
further coding-agent adapter in this phase. Phase 11 (multi-agent task routing and comparison) is
the next proposed phase; it is not implemented here.

## Phase 10.1 — Event-channel isolation, capability accuracy, and sandbox diagnosis

Phase 10.1 is a correction phase, conditionally approved after Phase 10's review. It ran under a
strict no-model-invocation budget: only deterministic fake-process tests and free CLI commands
(`--version`, `--help`, `login status`, `features list`, `sandbox`) were used — no `codex exec`
model call was made anywhere in this phase.

### Event-channel isolation

See "Event-channel isolation (corrected in Phase 10.1)" above (in "Native JSONL mapping") for the
full design change: stdout is now the sole authoritative native-event stream; stderr is received
and discarded, never parsed. `codex-run.test.ts`'s "event-channel isolation (Phase 10.1)" describe
block and `codex-adapter.test.ts`'s matching sensitive-stderr test are the regression suite.

### Capability and availability policy

Phase 10's three real task executions never successfully modified a file (see below for the
now-understood root cause). Continuing to report `availability: "available"` for a coding agent
whose core edit capability was unverified was assessed as capability overclaiming — a real risk
(routing an implementation task to an agent that cannot implement, silently, since the run itself
still completes "successfully" from Codex's own perspective with no distinct failure signal).

**Policy adopted (the kickoff's preferred, fail-closed option):** `detectCodex` now never returns
`availability: "available"`. Installation and authentication problems still report their own
accurate, specific status (`unavailable` when not installed, `logged_out` when not signed in, and
the pre-existing `unsupported` branches for non-ChatGPT auth or an unverifiable isolation-flag
profile) — only the single "everything checks out" outcome that previously became `"available"` is
now capped at `unsupported`, with the fixed, safe diagnostic `"Codex file-edit execution is not
verified in the current sandbox."` `startTask` inherits this automatically (it already re-runs
`detect()` before spawning), so it now always returns a `PreflightFailedRun` with
`CODEX_ISOLATION_UNSUPPORTED` — the real `codex exec` process is never spawned by this adapter at
all while this policy is active. This uses the existing, provider-neutral
`AgentDetectionResult`/`AvailabilityStatus` contract with no new field and no Codex-specific REST
surface, per the kickoff's explicit instruction. Hall Web's existing "unavailable for assignment"
handling for `unsupported` adapters applies unchanged; Mock Agent and Claude Code are unaffected
(verified — see "Verification" below).

This is a deliberately conservative, blunt instrument: it also blocks Codex's already-verified,
working capabilities (message streaming, command-execution event mapping, cancellation) from ever
being exercised for a real task, not just the unverified file-edit path. A more granular
"read/analysis-only" capability was considered (the kickoff's alternative option) and rejected for
Phase 10.1: the existing `AgentDetectionResult`/`AgentAdapterDescriptor` contracts have no field for
a partial/reduced capability set that Hall Web could safely render and route around without
guessing, and inventing one would be new provider-specific surface the kickoff's restrictions list
forbids. The fully-fail-closed policy needs no such surface — it fits inside a single existing enum
value.

### Sandbox diagnosis

**Free, no-model investigation.** `codex sandbox --help` revealed a subcommand (`codex sandbox
[OPTIONS] [COMMAND]...`) that runs an arbitrary trusted command directly under Codex's own local
sandbox helper, independent of `codex exec` or any model call. A first probe attempt
(`codex sandbox windows --help`, a mistaken invocation — `windows` was interpreted as the literal
command to run, not a subcommand) still produced a highly informative failure:

```
windows sandbox failed: runner failed during SpawnChild: CreateProcessAsUserW failed: 2
(The system cannot find the file specified.) | cwd=C:\Users\CodexSandboxOffline\.codex\.sandbox\...
```

This revealed that the local Windows sandbox mechanism runs commands via `CreateProcessAsUserW`
under a **dedicated, separate, low-privilege Windows user account** (`CodexSandboxOffline`) — not
merely an in-process restricted token under the operator's own account. A follow-up trusted probe,
run in an isolated fixture (`D:\HallOfWisdom\.tmp\codex-sandbox-probe\`, its own Git repository,
containing one sentinel file, deleted after use), confirmed the consequence directly:

```
Add-Content : Access to the path 'D:\...\codex-sandbox-probe\sentinel.txt' is denied.
    + FullyQualifiedErrorId : ...UnauthorizedAccessException
```

An explicit `UnauthorizedAccessException`, not a silent no-op — even with an ad-hoc permission
profile granting `disk_full_write_access=true`. **Classification: `sandbox_write_blocked`.** The
`CodexSandboxOffline` account does not have write access to a directory owned by the operator's own
Windows account, at the OS ACL/token level — a genuine, structural, machine-configuration-level
restriction, independent of this adapter's argv, approval policy, or any Hall of Wisdom code. This
is the most probable root cause of Phase 10's unresolved write-rejection finding, though it was
reached via a different tool (`codex sandbox`, not `codex exec`) and is not a 100%-certain proof
that `codex exec`'s own sandboxing uses the identical account/mechanism — treat this as strong,
not conclusive, evidence. No raw sandbox log content, no absolute path beyond the already-disclosed
fixture path, and no device security-policy change were involved; no elevation was requested; no
Codex credential file was touched. The probe fixture was fully deleted after use (its removal was
briefly blocked by the shell's own working directory still pointing at it, not by any process
holding a lock — resolved by changing directory first).

### Approval and sandbox argument review

Re-inspected `codex exec --help` fresh (installed CLI unchanged, `codex-cli 0.144.4`) and
re-confirmed `-a`/`--ask-for-approval` is still absent from `codex exec`'s own option list — Phase
10's design decision (use `-c approval_policy="never"` instead) stands unmodified; the two are not
redundant, since only one of them (the config key) is valid syntax for `exec` at all. `--json`'s
help text was re-read closely and confirmed to say, verbatim, "Print events to stdout as JSONL" —
official, direct confirmation (not an inference) that stdout is the documented event channel,
reinforcing the event-channel isolation change above.

**New hardening, confirmed free via the `--strict-config` zero-usage config-parse technique (see
`0009`'s "codex exec JSONL boundary" section for the general method):** `--disable hooks --disable
plugins --disable plugin_sharing --disable remote_plugin --disable multi_agent` all parse cleanly
alongside every other fixed flag. Added to `buildCodexArgv` as an explicit, defense-in-depth second
isolation layer — see "Configuration, hook, skill, and plugin isolation" below. No flag was weakened
or removed; `--sandbox workspace-write`, `network_access=false`, and `web_search="disabled"` are
unchanged.

### Configuration, hook, skill, and plugin isolation

`codex features list` (free — a local feature-flag inspection, no model call) was the key new
evidence source. Real, live findings against the installed CLI:

- `hooks`: `stable`, **enabled**.
- `plugins`, `plugin_sharing`, `remote_plugin`: `stable`, **enabled**.
- `multi_agent`: `stable`, **enabled**; `multi_agent_v2`: under development, disabled.
- `memories`: experimental, **disabled** by default (not explicitly re-disabled by this adapter,
  since it is already off).
- No `skills`-named feature flag exists in the full listing at all — skills most likely activate
  from filesystem presence (a `.codex/skills/` or `$CODEX_HOME/skills/` directory existing), not
  from a `config.toml`/feature toggle `--ignore-user-config`/`--disable` could suppress. This
  remains the one **unconfirmed** isolation gap — see "Current limitations".
- `codex exec --help`'s description of `--dangerously-bypass-hook-trust` — "Run enabled hooks
  without requiring persisted hook trust for **this invocation**" — confirms hooks additionally
  require pre-established, persisted trust by default; this adapter never passes that flag, so even
  though `hooks` is a live, enabled feature, a hook from a project the operator has never previously
  and interactively trusted has no documented path to execute anyway.
- `codex mcp --help`/`codex plugin --help` confirmed MCP servers and plugins are both
  `config.toml`/local-cache-backed (`add`/`list`/`remove` subcommands operate on persisted
  configuration) — consistent with `--ignore-user-config` suppressing them and `--disable
plugins`/`--disable remote_plugin` now additionally disabling the underlying features outright.

**Resulting policy:** `--ignore-user-config` and `--ignore-rules` remain the primary suppression
layer (user `config.toml` and user/project execpolicy `.rules` files); the five `--disable` flags
above are an explicit second layer specifically for the features confirmed live-enabled and
directly relevant to the kickoff's isolation concerns. Skills isolation could not be similarly
confirmed or hardened this phase and is disclosed as open. No `auth.json`, OS credential store, or
OAuth/browser-cookie data was read at any point; no second `CODEX_HOME` or credential store was
created.

### Detection stability

Reviewed the one transient cold-start "unavailable" result observed during Phase 10's Playwright
verification. At the time, `detectCodex` had no cache and no retry loop — confirmed by code
inspection and by a dedicated test (`detection.test.ts`, "performs exactly one bounded process spawn
per detection stage"). Added four new tests proving `--version`/`exec --help`/`login status`
timeouts each produce a distinct, correctly-classified result (`unavailable` for a `--version`
timeout; `unsupported` with the isolation diagnostic for an `exec --help` timeout; `unsupported`
with the unverified-auth diagnostic, explicitly not `logged_out`, for a `login status` timeout) —
using `vi.useFakeTimers()` against a `HangingHandle` fake, no real elapsed time. No automatic retry
was added in this phase, per the kickoff's explicit prohibition; `startTask` already re-checks
`detect()` before every real run, which is the existing, sufficient mechanism for "a stale poll
result can never become stale permission to execute." **Phase 10.3 (below) later added exactly one
bounded retry, scoped narrowly to the specific flake this section describes — see "Phase 10.3 —
Bounded detection retry and in-flight coalescing."**

### Verification

`pnpm install`/`typecheck`/`lint`/`format`/`test`/`build` all clean across the full workspace.
Codex adapter: 267/267 tests passing (was 256 before Phase 10.1's new/updated tests). Hall Core
`codex-integration.test.ts`: 7/7 passing, updated to assert Codex is never `"available"`. Claude
Code adapter and Mock Agent test suites unaffected (unchanged pass counts). `verify:package-entry`
and `pnpm pack --dry-run` clean for both `adapters/codex` and `apps/server` (confirmed after
rebuilding `adapters/codex`'s `dist/` — the same stale-`dist` pitfall Phase 9.1 documented recurred
once here and was caught by re-running the Hall Core integration test after a fresh build, not
before). No `codex exec` model invocation occurred anywhere in this phase. No commit was created.

## Phase 10.3 — Bounded detection retry and in-flight coalescing

Real verification during Phase 10.2 (Task #74, Task #75) observed the same transient failure twice:
`codex --version` failed to start on the very first spawn issued right after Hall Core's own process
started, then succeeded immediately on an identical second call moments later — a cold-start flake,
not a genuine installation problem. Phase 10.1's "no retry" decision (previous section) was correct
for the general case but too broad for this specific, now-repeatedly-observed one, so Phase 10.3
narrows it rather than reversing it wholesale.

**What changed, in `detection.ts`:**

- `detectCodex`'s `--version` probe now gets exactly one bounded retry, and only when the first
  attempt fails structurally — `BoundedProcessResult.spawnError` set, or `timedOut` — after a fixed
  `250ms` default delay (`DEFAULT_VERSION_RETRY_DELAY_MS`, overridable via
  `DetectionOptions.versionRetryDelayMs` purely so tests can drive it with `vi.useFakeTimers()`; never
  tuned in production). The second attempt's result is returned unconditionally, success or failure —
  there is no third attempt.
- Every other failure path is still never retried, on purpose: a structurally-completed `--version`
  process (whatever its exit code or output), an unresolved executable, a failed/timed-out
  `exec --help` or `login status` probe, a non-ChatGPT or ambiguous auth classification, and every
  trusted-local precondition. These are either real, completed answers (retrying spends a process for
  no possible different outcome) or, for `login status` specifically, a deliberate decision not to
  speculatively retry an authentication-adjacent command that Phase 10.2's real verification never
  observed flaking. See the classification doc comment directly above
  `DEFAULT_VERSION_RETRY_DELAY_MS` in `detection.ts` for the full per-branch reasoning.
- `CodexAdapter.detect()` now coalesces concurrent callers: while a detection is in flight, every
  caller that invokes `detect()` before it settles shares the same promise instead of each starting an
  independent `--version`/`exec --help`/`login status` spawn sequence — relevant when, e.g., overlapping
  `GET /api/v1/adapters` requests arrive close together. The in-flight reference is cleared
  unconditionally in a `finally` the moment that detection settles, success or failure, so it is never
  a cache: the very next call after that always starts a genuinely fresh detection. This is orthogonal
  to `startTask`'s own re-verification — `startTask` still always calls `detect()` immediately before
  spawning a real task, so a stale poll result still can never become stale permission to execute.

**Tests added:** `detection.test.ts`'s "Phase 10.3 bounded version-probe retry" block (structurally
successful first attempts are never retried across every detection stage; both retryable failure
kinds retry exactly once; the retry delay is genuinely bounded via fake timers; no extra spawn occurs
anywhere in the retry path). `codex-adapter.test.ts`'s "Phase 10.3 detection stability" block
(concurrent `detect()` calls coalesce to a single `--version` spawn; a later, non-concurrent call is
genuinely fresh, not a replayed coalesced result; `startTask` still re-verifies trusted-local
preconditions fresh immediately after a prior `detect()` completed; trusted-local disabled still
starts no task process even though the version probe itself supports a retry).

**Verification:** the full `@hall-of-wisdom/codex-adapter` suite (14 test files, 350 tests) was run
five times in direct succession with no flakiness — every run passed 350/350. No model invocation
occurred anywhere in this phase; no commit was created.

## Residual data review

Every diagnostic artifact created during Phase 10 reconnaissance and the real smoke tests —
`.tmp/codex-probe-fixture/` (contained a real `thread_id`), `.tmp/codex-adapter-smoke/` (the real
smoke-test Git fixture), `.tmp/codex-instrumented-stdout.log`/`.tmp/codex-instrumented-stderr.log`
(the raw separated-stream capture that diagnosed the `approval_policy` gap), and the throwaway
Playwright verification fixture directory — was deleted after use. Phase 10.1 additionally created
and deleted `.tmp/codex-sandbox-probe/` (the sandbox-write-permission fixture) and a scratch
`.tmp/argv-check/` (used only for free `--strict-config` argv validation, never executed a real
task). `.tmp/` is gitignored; none of
these were ever committed. No real account email, workspace name, `CODEX_HOME` path, or auth-status
JSON was found in any tracked file, test fixture, or snapshot during review.

## Phase 16.4 — Strict isolated compatibility

Phase 16.4 keeps the default strict Codex availability rule fail-closed. The adapter now has the
durable worktree and native-probe infrastructure it needs, but strict mode must not report
`available` merely because the helper probe passes. Availability still requires an exact proof that
the real `codex exec --sandbox workspace-write` policy and the zero-model helper policy have the
same effective filesystem and network restrictions; that proof is deferred to the explicitly
authorized Phase 16.6 verification.

The probe uses the installed `codex sandbox` helper rather than `codex exec`, so it spends no model
usage. On the local `codex-cli 0.144.4` install, the working helper shape is
`codex sandbox -P :workspace -C <workspace> ...`. It verifies read/write/delete behavior inside a
disposable workspace, rejects outside writes, rejects network success, bounds output and time, and
returns only stable safe probe codes. This is useful native-sandbox evidence, but it is not exact
equivalence proof for the real execution selector. If equivalence is unproven, strict detection
fails closed as `unsupported` and does not mark editing or command execution verified.

Once exact equivalence is proven in a later phase, strict task launch performs a fresh detection
and then calls a server-injected worktree validator before constructing `CodexRun`. That validator
is built from Hall Core's `AgentWorktreeManager.validateReadyWorktree`, not from adapter-owned
lexical path checks. While equivalence is unproven, the adapter fails before worktree validation and
before any model-backed Codex task process is spawned.

The strict argv remains sandboxed and fixed:

```text
exec --json --ephemeral --ignore-user-config --ignore-rules --strict-config
  --sandbox workspace-write
  -c approval_policy="never"
  -c sandbox_workspace_write.network_access=false
  -c web_search="disabled"
  --disable hooks --disable plugins --disable plugin_sharing
  --disable remote_plugin --disable multi_agent
  --disable apps --disable browser_use --disable browser_use_external
  --disable browser_use_full_cdp_access --disable computer_use
  --cd <validated Hall worktree>
  -
```

Strict mode still never uses dangerous bypass flags, `--yolo`, `danger-full-access`,
`--skip-git-repo-check`, `--search`, session resume, arbitrary extra arguments, arbitrary
environment variables, task-controlled security options, hooks, plugins, remote plugins, or
multi-agent Codex features. The prompt remains stdin-only. No real Codex task is run in Phase
16.4; explicitly authorized model-backed smoke verification is deferred to Phase 16.6.
