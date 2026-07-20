# 0008 — Claude Code Adapter

Status: Draft (Phase 9; hardened in Phase 9.1 — see "Phase 9.1 — Configuration isolation and
authentication output hygiene" near the end of this document for what changed and why).

## Context

Phase 9 adds the first real, non-mock `AgentAdapter`: `@hall-of-wisdom/claude-code-adapter`
(`adapters/claude-code/`), which spawns the operator's own locally-installed, subscription-
authenticated Claude Code CLI as a child process to execute a Hall task. This document records the
design decisions and their reasoning, following the same pattern as
[`0002-agent-adapter-boundary.md`](0002-agent-adapter-boundary.md) (the generic adapter contract)
and [`0004-hall-core-server.md`](0004-hall-core-server.md) (how adapters register into Hall Core).
`0001-initial-architecture.md`'s repository layout originally sketched this adapter for a later
phase; it was brought forward and delivered here in Phase 9 instead, at the same location
(`adapters/claude-code/`) the original plan anticipated.

## Why a CLI adapter, not the Claude API SDK

This adapter never imports an Anthropic API SDK and never makes a direct HTTPS request to
`api.anthropic.com` or any other Anthropic endpoint. It exclusively spawns the operator's own
installed `claude` executable as a child process and speaks to it over stdout/stdin, exactly as a
human running `claude` in a terminal would. Two reasons drove this, both load-bearing for the rest
of the design:

- **Billing source.** The whole point of this adapter is to let Hall of Wisdom drive tasks using an
  operator's existing Claude subscription (Pro/Max/Team/Enterprise) — the same auth and quota a
  human already pays for and uses interactively — never a separate, metered API key. Going through
  the CLI, which already owns the subscription-auth flow, is what makes that guarantee structural
  rather than a promise this adapter would otherwise have to enforce by hand against a raw API
  client that has no inherent concept of "subscription vs. API key."
- **Permission/tool surface.** The CLI already implements the tool-use loop (Read/Edit/Write/Bash/
  Glob/Grep, permission prompts, hooks, MCP) that a raw Messages API call does not. Reimplementing
  that loop against the bare API would mean rebuilding — and re-securing — a large surface this
  adapter has no need to own; the CLI's own `--permission-mode`/`--allowedTools`/`--disallowedTools`
  flags are the actual enforcement point (see "Permission profile" below).

## Subscription-auth requirement and authentication precedence risk

`detect()` only ever reports `availability: "available"` when the CLI's own `claude auth status`
subprocess reports `loggedIn: true`, `authMethod: "claude.ai"`, `apiProvider: "firstParty"`, and a
`subscriptionType` in `{pro, max, team, enterprise}`. Every other observed shape — not logged in, an
API-key-based auth method, a non-`firstParty` provider (Bedrock/Vertex/Foundry/a gateway), an
unrecognized subscription type, a malformed or unparseable response, a nonzero exit code, a spawn
error, or a timeout — fails closed to `unavailable`/`logged_out`/`unsupported`, never `available`.
This check is deliberately strict rather than permissive: the risk being guarded against is
_authentication precedence_ — if the installed CLI (or its environment) is ever configured to prefer
an API key or a cloud-provider credential over the interactive subscription login, a task run
through this adapter could silently bill against that other source instead of the subscription the
operator actually intended. Because Claude Code's own auth-source precedence rules are the CLI's
internal behavior, not something this adapter can inspect or override, the adapter's only reliable
lever is refusing to run at all unless the reported auth shape is unambiguously subscription-based.

`startTask()` re-runs this same `detect()` check immediately before spawning the real task process
— see "Why detection and execution share one sanitized environment" below — so a `detect()` call
made minutes earlier by a browser polling the adapter list can never become stale, optimistic
permission to actually bill the wrong source.

Raw `claude auth status` output — including the account email, organization ID, and organization
name — is read only inside `auth-classification.ts`'s `parseAuthStatusOutput`, is validated through
a Zod schema, and is never returned from `detect()`, logged, or included in any Hall event, failure
message, or REST response — see "Authentication output hygiene" under "Phase 9.1" below for the
stricter internal handling added there. Only a safe, four-valued `availability` enum and (when
unavailable) a bounded, generic `diagnosticMessage` such as `"Claude Code authentication could not
be verified as subscription-based."` ever leave this module.

## Child environment policy

`environment.ts`'s `buildChildEnvironment` is an **allowlist**, not "inherit everything, then strip
the bad ones": it copies only a fixed, named set of platform/locale variables
(`PATH`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `SYSTEMROOT`, `WINDIR`, `COMSPEC`, `TEMP`,
`TMP`, `LANG`, `LC_ALL`, `LC_CTYPE`, and `CLAUDE_CONFIG_DIR`) from the real parent environment,
matched case-insensitively. Everything else — including `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_FOUNDRY`,
`CLAUDE_CODE_OAUTH_TOKEN`, and any AWS/Google/Azure/Foundry credential variable — is never copied.
A denylist can only ever block variable names it was told about in advance; an allowlist is safe by
construction against a variable name nobody anticipated (a future Anthropic CLI release adding a new
billing-source environment variable this adapter was never told about is blocked automatically, not
only after someone remembers to update a blocklist). A second, defense-in-depth substring-based
block check (`containsBlockedEnvironmentKey`) runs after the allowlist copy, guarding against a
future accidental widening of the allowlist itself.

**Why detection and execution share one sanitized environment**: `detect()`'s `claude auth status`
call and `startTask()`'s real `claude -p ...` call are both spawned through the exact same
`buildChildEnvironment(parentEnv)` call. If they used different environments, a verified-subscription
`detect()` result would not actually predict what auth source the real task execution uses — the two
checks would be answering different questions. Sharing one function is what makes "detection says
available" mean "and therefore running the task will use that same subscription," not two
independently-plausible but potentially-divergent claims.

## Executable resolution policy

`executable-resolver.ts` searches the resolving process's own `PATH` (using `PATHEXT` on Windows)
for an executable literally named `claude`, never accepting a path, name, or hint from
`AgentTaskInput` or any other task-controlled input. Selection is deterministic:

1. A native executable always wins over an npm-installed `.cmd`/`.bat`/`.ps1` shim, regardless of
   PATH order — shims are a thinner, less-audited execution path (they invoke `node` themselves,
   effectively another layer of indirection) and a native binary is what the CLI itself installs by
   default.
2. Among multiple native candidates, the first one found in `PATH` order wins — the same rule the
   operating system's own executable resolution would apply.
3. A shim-only result (no native binary found anywhere in `PATH`) is reported as `unsupported` with
   `reason: "shim_only"`, never silently executed through the shim.

The resolved path is never exposed through `detect()`'s return value, a REST response, or any Hall
event — only used internally to actually spawn the process.

## Process launching

The only call site for `node:child_process.spawn` in this entire package is `process-spawner.ts`'s
`nodeProcessSpawner`. It always passes `shell: false` and an argv array (never a joined command
string), `stdio: ["ignore", "pipe", "pipe"]` (stdin is never opened — the prompt is always an argv
element, never something Claude Code would read from stdin), `windowsHide: true`, and
`detached: process.platform !== "win32"` (making the child the leader of its own new POSIX process
group, which is what lets a single negative-PID signal later reach grandchildren the CLI spawns,
such as its own `Bash` tool subprocess — Windows has no equivalent concept, so `detached` is never
set there). Every other module that needs to run a process (`bounded-process.ts` for detection,
`process-tree.ts` for `taskkill.exe`) is injected this same `ProcessSpawner` interface rather than
calling `child_process` directly, which is what makes every one of them testable against a fake
supervisor with no real process ever created in a deterministic test.

## Structured CLI mode

`claude` is invoked non-interactively via `-p`/`--print` with `--output-format stream-json
--verbose`. The exact flag set was derived from the actually-installed CLI (`2.1.212`), inspected
via `claude --help`, not assumed from general documentation — several flags mentioned in early
planning turned out not to exist in this version (see "Deviations from the original conceptual
command" below).

## Permission profile

The fixed, non-task-influenceable argv this adapter always passes (`permission-profile.ts`):

- `--permission-mode dontAsk`
- `--tools Read,Glob,Grep,Edit,Write,Bash`
- `--allowedTools Read Glob Grep Edit Write "Bash(git status)" "Bash(git diff)" "Bash(pnpm
typecheck)" "Bash(pnpm lint)" "Bash(pnpm test)" "Bash(pnpm build)"`
- `--disallowedTools` — an explicit denylist of destructive/exfiltration-shaped operations (`git
push`/`commit`/`reset`/`clean`/`checkout`/`switch`, `rm`/`rmdir`/`del`/`Remove-Item`,
  `curl`/`wget`/`Invoke-WebRequest`, package publish/install, `docker`, `ssh`, `scp`)
- `--safe-mode` (added in Phase 9.1; disables CLAUDE.md/skills/plugins/hooks/MCP/custom
  commands-agents/output styles/workflows/themes wholesale — see "Phase 9.1" below)
- `--strict-mcp-config` with no `--mcp-config` ever supplied (guarantees zero MCP servers load, even
  from project-level configuration)
- `--disable-slash-commands`, `--no-chrome`, `--no-session-persistence`

**No `--setting-sources` flag is ever passed** (Phase 9.1 removed `--setting-sources project`
entirely rather than replacing it with `user` or any other value — see "Phase 9.1" below for why
none of `user`/`project`/`local` is trusted).

**Three flags, three different jobs — verified from `claude --help`, not assumed.** `--tools`
controls which built-in tool _categories_ are even loaded into the session at all (per `--help`:
"Specify the list of available tools from the built-in set") — `Bash` must be present here or none
of the whitelisted `git`/`pnpm` commands would be reachable either, not just the disallowed ones.
`--allowedTools`/`--disallowedTools` are the actual fine-grained permission rule engine, using the
identical pattern syntax (`"Bash(git *)"`-style) that `settings.json`'s `permissions.allow`/
`permissions.deny` arrays populate. `ALLOWED_BASH_COMMANDS` uses exact-match patterns only, never a
prefix wildcard (e.g. never `Bash(pnpm *)`), because `pnpm` can execute arbitrary package scripts —
a wildcard there would defeat the entire allowlist.

**Why `dontAsk` still enforces the allow/deny rules, not just approves everything.** The CLI exposes
`bypassPermissions` as a _distinct_ mode from `dontAsk` in its `--permission-mode` choices
(`acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`), and reserves the "bypass
all permission checks" language and the separately-flagged, scarier
`--dangerously-skip-permissions`/`--allow-dangerously-skip-permissions` for that mode alone. If
`dontAsk` also skipped rule enforcement, `bypassPermissions` would be a redundant, confusingly-named
duplicate of it. The CLI's own naming only makes sense if `dontAsk` still evaluates the
allow/deny rules and merely resolves the outcome automatically instead of prompting a human — who
cannot exist in a `-p` non-interactive run anyway. This reasoning is verified by construction from
the CLI's own documented, self-consistent flag semantics; it was not (and could not safely be,
within this phase's scope) verified by deliberately triggering a live denied command against the
real CLI — that would be exactly the kind of "probe the account for its own sake" invocation the
phase's billing-safety discipline forbids. Deterministic fixtures cover the mapping of a denial
event once one occurs; whether one occurs at all rests on the CLI's documented behavior.

## Why `bypassPermissions` is forbidden

This adapter never sets `bypassPermissions` mode and never passes `--dangerously-skip-permissions`
or `--allow-dangerously-skip-permissions`, under any circumstance — there is no code path, task
field, or configuration option that can reach either. The CLI's own documentation for these flags
("Recommended only for sandboxes with no internet access") describes exactly the opposite of this
adapter's operating context: a real developer machine with real credentials, a real filesystem
outside the task's working directory, and real network access. Bypassing permission checks here
would mean the fixed allowlist above — the only thing standing between "run these six harmless
verification commands" and "run anything" — stops being enforced at all. The fixed permission
profile is controlled entirely by this file, never by `AgentTaskInput`, browser request data, or any
other task-controlled input.

## Task prompt construction

`prompt-builder.ts`'s `buildTaskPrompt` builds one bounded string (capped at 8000 characters, with a
visible truncation marker if the task description would otherwise exceed the budget) from the task's
title, description, priority, and project ID, prefixed with fixed safety instructions ("work only
inside the current working directory," "do not create a git commit, push, or run a destructive Git
operation," "use only the tools and commands you have been granted," "stop and explain when
blocked," "end with a concise summary"). This string is always passed as **exactly one argv
element** after `--print` — task title/description text is treated as untrusted, human-authored
content interpolated only into this prompt string, never parsed for embedded CLI flags, and never
passed through a shell. A NUL character anywhere in title/description/priority/project ID is
rejected outright (`PromptBuildError`) rather than silently stripped.

## Native stream parser boundary

`native-messages.ts`'s `classifyNativeLine` is the only place in this package that touches a raw,
Claude-native JSON shape — it validates only a `{ type: unknown }.passthrough()` envelope with Zod,
classifies known shapes strictly, and returns `{ kind: "ignored" }` for anything unrecognized rather
than failing the line or the run. `stream-parser.ts`'s `StreamParser` sits above it, incrementally
reading stdout: it handles both LF and CRLF line endings, tolerates a JSON line split across
multiple `push()` calls (Node stream chunk boundaries never align with message boundaries), bounds
both the length of any single line (1MB default) and the total number of messages processed (2000
default) — including the length of an in-progress, not-yet-newline-terminated partial line, which is
checked on every `push()` call independent of whether a terminator has arrived yet (see "Security
review findings and fixes" below) — and reports a `truncated-final-line` outcome if the stream ends
mid-message. No Claude-native type ever crosses into the SDK, Hall Runner, Hall Core, or Hall Web:
`ParsedNativeMessage` (this package's own internal discriminated union) is the boundary, and
`event-mapper.ts` is the only thing that reads it.

**Real message shapes actually observed**, from the installed CLI (`2.1.212`): `system`/`init`,
`assistant` (with `text` and `tool_use` content blocks), `user` (with `tool_result` content blocks),
`result` (`subtype: "success"`/other, `is_error` boolean), and `rate_limit_event`. An initial
zero-tool reconnaissance probe (`--tools ""`) captured the `system`/`assistant`/`result`/
`rate_limit_event` shapes live but could not exercise `tool_use`/`tool_result`, since no tool was
ever available to call. Phase 9's real isolated smoke task (see "Real smoke-test scope" below) — a
genuine `Read` then `Edit` against a throwaway fixture, driven through the actual
`ClaudeCodeAdapter`, not a manual invocation of the parsing helpers — subsequently exercised the
`tool_use`/`tool_result` path end to end: `tool.started`/`tool.completed` were emitted correctly and
`file.changed` resolved the real edited path, confirming these shapes match live behavior rather
than remaining a documented-but-unverified assumption.

## Provider-to-Hall event mapping

`event-mapper.ts`'s `EventMapper` (one instance per run, wrapping the SDK's `EventFactory` +
`TerminalEventGuard`) maps classified native messages to `NormalizedAgentEvent`s:

| Native message                                                                         | Hall event                                                                                               |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Child process spawns successfully                                                      | `run.started` (emitted immediately on spawn, before any stream content — the SDK's required first event) |
| `assistant` text content block                                                         | `message.delta`                                                                                          |
| `assistant` `tool_use` content block                                                   | `tool.started`                                                                                           |
| Matching `user` `tool_result` content block                                            | `tool.completed`                                                                                         |
| Successful `Edit`/`Write` tool result, path resolves inside the working directory      | `file.changed`                                                                                           |
| `result` permission denial(s)                                                          | `approval.required` (one per denied tool, bounded to 10)                                                 |
| `result`, `is_error: false`                                                            | `run.completed`                                                                                          |
| `result`, `is_error: true`                                                             | `run.failed`                                                                                             |
| Provider stream error / invalid stream / abnormal exit not caused by Hall cancellation | `run.failed`                                                                                             |
| Hall-initiated cancellation (`cancel()` or `AbortSignal`)                              | `run.cancelled`                                                                                          |

Tool-use/tool-result correlation state (which tool name a given `toolu_...` ID belongs to, which IDs
have already produced a `tool.completed`, which IDs are pending a file-edit path) lives entirely
inside one `EventMapper` instance per run. A duplicate `tool_result` for an already-completed ID is
silently a no-op; an unmatched `tool_result` ID (no `tool_use` was ever seen for it) is
deterministically skipped, since there is no safe tool name to report. Provider `toolu_...` IDs are
never reused as Hall `eventId`s — those are always freshly generated inside `EventFactory`.

`file.changed` path safety (`file-path-safety.ts`): the provider-reported `input.file_path` (read
only for `Edit`/`Write` — no other `input` field is ever read from a `tool_use` block) is resolved
against the task's canonical working directory. Beyond the lexical `resolve`/`relative` check, the
resolved path and the working directory are additionally passed through the filesystem's own
symlink resolution (`fs.realpathSync.native`, mirroring
`runners/hall-runner/src/workspace-validation.ts`'s canonicalization) and re-checked for containment
against the canonical forms — closing the gap where a symlink or junction _inside_ the working
directory points outside it, which a lexical check alone cannot see. This is a point-in-time check,
not a guarantee against the underlying filesystem object being replaced afterward (the general
TOCTOU class of race, in the same sense `0003-hall-runner-boundary.md` documents for workspace
validation) — a failure to resolve the canonical form (e.g. a benign race with the file's own
lifecycle) falls back to the lexical result rather than suppressing a genuine `file.changed` event.
Both `Edit` and `Write` are reported as `operation: "modified"` — this adapter has no
reliable, side-effect-free way to tell whether a `Write` call created a new file or overwrote an
existing one without an extra filesystem check outside the stream, a deliberate, disclosed Phase 9
simplification. The working directory's own absolute path is never disclosed through any event —
only a forward-slash-normalized relative path.

Raw tool-result content — file contents, command stdout, anything a real tool actually produced,
which could contain secrets — is **never** read or forwarded into any Hall event, not even
truncated. `tool.completed`'s optional `output` field (which the SDK's `EventFactory` accepts
because Mock Agent's synthetic data is safe to echo) is always left unset by this adapter; only the
`success` boolean is ever reported. An earlier version of this mapping did forward a truncated
content preview — this was found and fixed during Phase 9's security review (see below) before this
adapter was ever exercised against a real, potentially-sensitive working directory.

## Failure taxonomy

Thirteen stable `CLAUDE_*` failure codes (`failure-codes.ts`): `CLAUDE_CLI_NOT_FOUND`,
`CLAUDE_NOT_AUTHENTICATED`, `CLAUDE_SUBSCRIPTION_AUTH_UNVERIFIED`, `CLAUDE_UNSUPPORTED_VERSION`,
`CLAUDE_PROCESS_START_FAILED`, `CLAUDE_PROCESS_EXITED`, `CLAUDE_STREAM_INVALID`,
`CLAUDE_STREAM_TRUNCATED`, `CLAUDE_RESULT_MISSING`, `CLAUDE_PERMISSION_DENIED`,
`CLAUDE_TURN_LIMIT_REACHED`, `CLAUDE_RATE_LIMITED`, `CLAUDE_EXECUTION_FAILED`. Every failure message
is bounded; raw provider output (stderr, full command text, full file contents) never appears in a
`StructuredFailure.details`. Exit code and signal are reported only as safe, bounded primitives, never
raw process output. The first terminal outcome always wins (enforced by `TerminalEventGuard`, shared
with every other adapter) — cancellation can never later become a failure, and a failure can never
later become a completion.

## Cancellation and process-tree cleanup

Two-phase, platform-aware termination (`process-tree.ts`), driven by `ClaudeCodeRun`:

1. **Graceful.** POSIX: `SIGTERM` to the whole process group (the child was spawned `detached: true`
   and so is its own group leader — a negative-PID signal reaches grandchildren the CLI itself
   spawned, such as its own `Bash` tool subprocess, not just the direct child). Windows has no
   portable, catchable-by-an-arbitrary-external-process equivalent of a graceful signal, so this
   phase is a deliberate no-op there beyond the direct child's own best-effort `kill()`.
2. **Forced**, after a bounded grace period (5 seconds by default) with no exit: POSIX sends
   `SIGKILL` to the group; Windows invokes `taskkill.exe /PID <pid> /T /F` through the same
   `ProcessSpawner` every other process launch in this package uses — `pid` is always a real,
   internally-sourced numeric PID from a `SpawnedProcessHandle` this adapter itself created, never
   derived from task text, and the arguments are a fixed argv array (`shell: false`).

`PosixGroupKiller` is an injection point specifically so automated tests never call the real
`process.kill` — this package spawns and terminates real processes, and an accidental real kill in a
test could target an unrelated PID, including, in the worst case, the very session driving this
work. Every deterministic cancellation test uses a fake killer; a real POSIX group kill has never
been exercised in this phase's testing (see "Current limitations").

Cancellation is idempotent: a repeated `cancel()` call, a racing `AbortSignal`, or a cancellation
requested after the run is already terminal all resolve to a safe no-op via the same
`TerminalEventGuard`/`EventAfterTerminationError` pattern `MockAgentRun` established. A provider exit
caused by Hall's own cancellation is never reported as `run.failed`.

**Exit-vs-stdout-drain race.** Node does not guarantee that all of a child's stdout `"data"`/`"end"`
events have fired before its `"exit"` event fires — `"exit"` fires on process termination, while
stdout may still have buffered bytes in flight. `ClaudeCodeRun` only concludes "the process ended
with no terminal event" once **both** the exit callback has fired **and** stdout has fully drained;
finalizing on `"exit"` alone risked misreading a genuinely successful run (whose final `result` line
simply hadn't been delivered to the stdout handler yet) as `CLAUDE_RESULT_MISSING`. Because a
descendant process could in principle inherit the stdout pipe and keep it open past the main
process's own exit, this wait is itself bounded by a short, dedicated grace period (2 seconds by
default, independent of and much shorter than the 10-minute `maxRunDurationMs` wall-clock ceiling)
— found and fixed during Phase 9's security review, alongside the initial race fix itself.

## Session policy

Phase 9 implements **policy B**: session resumption is not supported. `startTask()` throws
immediately if `AgentTaskInput.sessionId` is present at all, rather than silently ignoring it and
starting a fresh session anyway. A provider session ID is captured internally when the CLI reports
one (for future use), but is never exposed through any REST response — no existing Hall Core
contract has a field for it, and none was added in this phase.

## Real smoke-test scope

Two genuinely real Claude Code invocations occurred in this phase, both against a throwaway fixture
directory (`D:\HallOfWisdom\.tmp\claude-adapter-smoke\`, deleted afterward, never the Hall of Wisdom
source tree), never the Hall of Wisdom codebase itself:

1. **Adapter-level.** A small Node script drove the real `ClaudeCodeAdapter` directly (not by
   manually invoking `native-messages.ts`/`event-mapper.ts` helpers) against a task asking Claude to
   append one line to a fixture file. Observed: `run.started` → `tool.started`(Read) →
   `tool.completed`(Read) → `tool.started`(Edit) → `tool.completed`(Edit) → `file.changed`
   (`greeting.txt`, `modified`) → `message.delta` → `run.completed`. The fixture file was genuinely
   modified. Every event validated through `parseNormalizedAgentEvent`. The child process exited on
   its own with no process remaining afterward.
2. **Browser-driven (Playwright).** With Hall Core and Hall Web both running, a task was created on
   the Kanban Board, moved to Ready, assigned to Claude Code, and started through the existing,
   fully generic UI flow (no Claude-specific field anywhere in the request). The same real lifecycle
   was observed live over the task-events WebSocket, ending in `Completed` with 8 stored events. No
   browser console errors or warnings. The adapter list never exposed an executable path or
   diagnostic message. Communication Boards were unaffected — the "General" board remained at 0
   messages throughout.

Both runs completed the happy path only. Neither run exercised a real permission denial, a real
process-tree kill, or Windows' `taskkill.exe` path — see "Current limitations."

**Important scope caveat, added in Phase 9.1**: both real runs above used the Phase 9 argv, which
still included `--setting-sources project` and did not include `--safe-mode` — the exact isolation
profile shipped after Phase 9.1's changes (see "Phase 9.1" below) has itself **never been run
against the real CLI**. The malicious-project-configuration regression test proves Hall/the adapter
never reads `.claude/` files or turns them into argv/env — that is verified directly, deterministically.
It does **not** prove the spawned Claude process under `--safe-mode`, with no `--setting-sources`,
actually ignores a `.claude/settings.json` permission addition at the CLI's own runtime — that rests
on `--safe-mode`'s documented behavior (verified by reading `claude --help`'s own text, the same
"verified by construction, not by live-triggering" standard already applied to `dontAsk` above), not
on a live test. Phase 9.1's explicit instruction was to make no further real Claude Code invocation
in this correction; this gap is disclosed rather than silently carried forward.

## Current limitations

- **Real cancellation and process-tree kill are untested against the real CLI.** Both smoke runs
  completed normally; cancellation logic is covered only by deterministic tests against a fake
  process supervisor and a fake `PosixGroupKiller`. The real `SIGKILL`-to-process-group path and the
  real `taskkill.exe` path have never actually run in this phase.
- **Permission-denial mapping rests on deterministic fixtures, not a live denied command.** The
  three-flag interaction (`--tools`/`--allowedTools`/`--disallowedTools`/`--permission-mode dontAsk`)
  is verified by construction from the CLI's own documented `--help` semantics (see "Permission
  profile" above), not by deliberately triggering a denial against the real, billed CLI — doing so
  was judged out of scope for the one isolated edit task this phase's billing-safety discipline
  permits.
- **`taskkill.exe`'s executable resolution under a minimal environment was not tested live on
  Windows** beyond code review — it is now spawned with the same sanitized `PATH`/`SYSTEMROOT`
  environment the main task process receives (previously an empty environment, fixed during this
  phase's security review), but no real forced-kill invocation actually ran.
- **No approval workflow.** `approval.required` events are emitted for a denied tool, but nothing in
  Hall Core or Hall Web yet lets a human respond to one — that remains a dedicated future phase (see
  below).
- **Session resumption is unsupported**, by explicit policy choice, not yet implemented.

## Why Codex is deferred to a later phase

The Phase 9 kickoff was explicit: implement only the Claude Code adapter, do not begin a Codex
adapter, do not skip ahead to Phase 10. Every design decision above (environment allowlist,
executable resolution, permission profile, stream parser boundary) is Claude-Code-specific in its
details even though the _shape_ of the problem (a subscription-authenticated CLI, a structured
stream mode, a fixed permission profile) is one a Codex adapter will likely also face. Building both
adapters in the same phase would risk prematurely generalizing an abstraction from a sample size of
one, before a second real adapter exists to reveal which parts of this design are genuinely
provider-neutral and which are Claude-specific. `AgentAdapter`/`AgentRegistry` (from
`0002-agent-adapter-boundary.md`) already provide the provider-neutral seam a Codex adapter would
plug into — nothing about this phase's work makes that seam Claude-specific.

## Why human approvals need a dedicated phase

`approval.required` is already a normalized event type this adapter can emit (for a denied tool),
and the protocol already carries it — but responding to one (approving, denying, or modifying a
blocked action and resuming the run) is a real workflow with its own UI, its own Hall Core
persistence, and its own security surface (an approval decision is itself a trust boundary: who is
allowed to grant one, and what exactly are they granting). Building that properly is out of scope
for a phase whose job was proving the adapter itself works end to end; it is called out here
explicitly so it is not mistaken for an oversight.

## Deviations from the original conceptual command

Two flags mentioned in early planning turned out not to exist, or not to be appropriate, once the
actually-installed CLI (`2.1.212`) was inspected via `claude --help`:

- **`--max-turns` does not exist in this CLI version.** Phase 9 bounds turns Hall-side instead: the
  stream parser's `maxMessages` limit (2000 default) and `ClaudeCodeRun`'s own wall-clock
  `maxRunDurationMs` timeout (10 minutes default) both independently cap how long a run can go on.
- **`--max-budget-usd` is deliberately not used**, even though it exists. It is dollar/API-billing
  denominated, which directly conflates with the billing model this entire adapter exists to avoid —
  using it would mean reasoning about a second, incompatible cost unit inside an adapter whose whole
  premise is "there is no separate dollar cost to reason about."

## Security review findings and fixes

A dedicated security review pass (before this adapter was exercised against a real, potentially-
sensitive working directory) found and fixed five issues, all addressed before the report in this
phase was finalized:

1. **Raw tool-result content leak (high severity).** `summarizeToolResultContent` returned a
   truncated (300-character) preview of a tool's actual output — file contents, command stdout — into
   `tool.completed` events, directly contradicting this module's own stated guarantee. Fixed by
   never reading `tool_result`'s `content` field at all; only the `success` boolean is reported.
2. **Unbounded stream-parser buffer.** `StreamParser`'s line-length bound was only checked once a
   line had been split out by a newline character; a chunked stream with no newline for a long time
   (or ever) could grow the internal buffer unboundedly. Fixed by also checking the in-progress
   partial buffer's length on every `push()` call, independent of whether a terminator has arrived.
3. **Symlink-based `file.changed` path-escape gap.** `file-path-safety.ts`'s check was purely
   lexical; a symlink or junction inside the working directory pointing outside it would not be
   detected. Fixed by additionally resolving both the working directory and the candidate path
   through the filesystem's own symlink resolution and re-checking containment against the canonical
   forms (see "Provider-to-Hall event mapping" above).
4. **Unbounded post-exit stdout-drain wait.** The exit-vs-stdout-drain race fix (see "Cancellation
   and process-tree cleanup" above) was itself correct but unbounded: if stdout never naturally
   emitted `"end"` after the process exited, finalization would wait all the way out to
   `maxRunDurationMs` (10 minutes). Fixed with a short, dedicated grace period (2 seconds default).
5. **`taskkill.exe` spawned with an empty environment.** The Windows force-kill path passed `env: {}`
   to the `taskkill.exe` invocation, risking a resolution failure on some Windows configurations
   (no `PATH`/`SYSTEMROOT` for the OS to find the executable with) that would silently turn the
   force-kill phase into a no-op. Fixed by reusing the same sanitized child environment
   (`PATH`/`SYSTEMROOT`/`WINDIR`/`COMSPEC`/`TEMP`/`TMP`) already built for the main task process.

Twenty-one further checklist items (API-key/cloud-billing precedence, credential-file access,
executable-path injection, shell injection, prompt-becoming-arguments, permission bypass, broad Bash
rules, task-controlled CLI flags/system prompt/MCP config, malformed/oversized provider JSON,
unknown stream messages, tool-use/result mismatch, duplicate terminal events, cancellation races,
orphan child processes, POSIX process-group termination safety, rate-limit retry storms, Hall Core
provider coupling, and Mock Agent/Communication Board regressions) were reviewed and found already
correctly handled by the design described above — see the individual module doc comments referenced
throughout this document for the specific reasoning behind each.

## Phase 9.1 — Configuration isolation and authentication output hygiene

A follow-up correction, requested after Phase 9's review, tightened two things Phase 9 left
looser than they needed to be: which settings sources could influence an adapter-launched task, and
how strictly raw `claude auth status` output is handled internally. **No real Claude Code invocation
was made in Phase 9.1** — every change below is verified by deterministic fake-process tests, by
argument-construction tests, and by reading the installed CLI's own `--help` text (free — no model
usage), not by running the production argv against the real, billed CLI. See the scope caveat under
"Real smoke-test scope" above for exactly what that leaves unverified.

### Why repository settings are not trusted as adapter policy

Phase 9 passed `--setting-sources project`, on the reasoning that a task's own working directory
might legitimately want its own Claude Code settings applied. On reflection this was the wrong
trust boundary: `.claude/settings.json`/`.claude/settings.local.json` in a task's working directory
is repository-controlled content — no more trustworthy than the task's own title or description,
both of which this adapter already treats as untrusted (see "Task prompt construction"). Those
files can define `permissions.allow` rules broader than this adapter's own fixed allowlist, an
`apiKeyHelper` that could redirect billing, hooks that run arbitrary commands on session
start/tool-use, and MCP server definitions — none of which should ever be something a task
repository can grant itself merely by containing the right file. `user`-level settings
(`~/.claude/settings.json`) were considered as an alternative and rejected for the same reason: they
can carry the _operator's own_ interactive-session hooks, plugins, MCP servers, and permission
additions, none of which should silently apply to an unattended, automated task run either. Phase
9.1 therefore removes `--setting-sources` entirely — no value is passed, not `project`, not `user`,
not `local`.

### Why `--safe-mode` is mandatory

With no discretionary setting source loaded, Claude Code's own defaults could still discover and
load `CLAUDE.md` files, skills, plugins, hooks, and MCP configuration through its normal
auto-discovery behavior. `--safe-mode` closes that gap directly — per the installed CLI's own
`--help` text: "Start with all customizations (CLAUDE.md, skills, plugins, hooks, MCP servers,
custom commands and agents, output styles, workflows, custom themes, keybindings, and more)
disabled." Critically, the same text continues: "Admin-managed (policy) settings still apply. Auth,
model selection, built-in tools, and permissions work normally." That last sentence is why
`--safe-mode` is safe to add without touching this adapter's core guarantee — subscription
authentication is unaffected, and the fixed `--tools`/`--allowedTools`/`--disallowedTools`/
`--permission-mode dontAsk` profile documented above still applies in full underneath it.

**Why `--bare` is forbidden alongside `bypassPermissions`.** A different, superficially similar CLI
flag, `--bare`, was considered and explicitly rejected: per its own `--help` text, `--bare` makes
"Anthropic auth ... strictly `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings` (OAuth and
keychain are never read)" — meaning `--bare` would force API-key billing and destroy this adapter's
entire subscription-only premise. `--safe-mode` and `--bare` look similar (both disable
customizations) but differ on the one dimension this adapter cares about most; this adapter uses
`--safe-mode` and never `--bare`, verified from the CLI's own help text, not assumed from the
similarity of their names.

### Project instructions remain available — as ordinary files, not auto-loaded customization

`--safe-mode` disabling `CLAUDE.md` auto-loading does not mean Claude Code loses access to project
guidance. `prompt-builder.ts`'s fixed instructions now explicitly tell Claude to check whether
`AGENTS.md` or `CLAUDE.md`/`.claude/CLAUDE.md` exist in the working directory and read them with the
ordinary `Read` tool — the same tool it would use to read any other project file — and to treat their
contents as context, while never executing a command, hook, or script merely because an instruction
file asks for one, and to continue obeying this adapter's own fixed permission boundaries regardless
of what a project file requests. This preserves the practical value of project guidance (Claude still
sees and can act on it) while preventing a repository from turning that guidance into an
automatically-loaded, system-level customization the operator never reviewed. Hall Core itself never
reads these files — only Claude does, through its own already-permitted `Read` tool, inside the
fixed permission profile.

### Required CLI compatibility flags and fail-closed behaviour for old versions

`cli-compatibility.ts`'s `verifyIsolationFlagSupport` is a new detection step, run after `--version`
and before `claude auth status`. Two layers: a cheap version-floor check
(`MIN_SUPPORTED_CLAUDE_VERSION`, documented in that module as `2.1.212` — the version this adapter
has actually been verified against) that fails closed immediately on an unparseable or too-old
version without spawning anything further; then, only once that passes, a bounded `claude --help`
inspection confirming every required flag name (`--safe-mode`, `--no-chrome`,
`--no-session-persistence`, `--strict-mcp-config`, `--permission-mode`, `--allowedTools`,
`--disallowedTools`, `--tools`) and the `stream-json` output-format choice are still literally
present in the CLI's own help text. The full help text is read into bounded process memory only for
this check and is never returned, logged, or exposed anywhere outside the function — only the
resulting boolean crosses that boundary. If either layer fails, `detect()` reports
`availability: "unsupported"` with the fixed message `"Installed Claude Code does not support the
required isolated execution profile."` — `startTask()` never falls back to a less secure invocation
in this case; it refuses to run at all, the same fail-closed posture the subscription-auth check
already used.

### Managed organizational policy limitation

`--safe-mode`'s own documentation is explicit that admin-managed (policy) settings still apply even
with all discretionary customization disabled. This adapter has no mechanism to inspect, bypass, or
override an organization's managed Claude Code policy, and does not attempt to — if a managed policy
blocks an operation this adapter's own fixed profile would otherwise permit, that is Claude Code's
own enforcement, external to this adapter, and any resulting failure is simply mapped to this
adapter's ordinary failure taxonomy (most likely `CLAUDE_PERMISSION_DENIED` or
`CLAUDE_EXECUTION_FAILED`, depending on how the CLI reports it) like any other blocked action. This
adapter never claims to fully control a machine or organization's managed Claude Code configuration,
and never inspects operating-system policy files or registry values directly to try to work around
one.

### Authentication output hygiene

`detection.ts` previously read `claude auth status`'s JSON output through a `.passthrough()` Zod
schema and extracted only `loggedIn`/`authMethod`/`apiProvider`/`subscriptionType` — email/org
fields were never actually read by any code path, but nothing structurally prevented a future change
from doing so. Phase 9.1 adds `auth-classification.ts` as a hard boundary: `parseAuthStatusOutput`
takes the raw stdout string, parses and validates it, and returns only a fixed
`SafeAuthClassification` shape (`loggedIn: boolean`, `authenticationKind` — a best-effort diagnostic
category, `subscriptionVerified: boolean`) or `undefined` if the output could not be safely
interpreted at all. The raw string and the parsed JSON object are both local to that one function and
are never returned, logged, stored, or embedded in a thrown error — `detection.ts` never touches
`authResult.stdout` again after passing it to this function once. `subscriptionVerified` is the only
field any caller may treat as a security gate; `authenticationKind`'s four non-subscription values
(`api_key`, `cloud_provider`, `gateway`, `ambiguous`) are inferred from `authMethod`/`apiProvider`
substrings this adapter has never actually observed live — only `claude.ai`/`firstParty`/a
recognized subscription tier has been confirmed against the real CLI — so these categories are
documented here as best-effort diagnostic labels, not verified mappings; the security-relevant
question is always "is `subscriptionVerified` true," never "which of the four categories was it."

A distinct, deliberate design point: `parseAuthStatusOutput` returning `undefined` (could not parse
at all — malformed JSON, oversized output, schema mismatch) is never collapsed into the same outcome
as a successfully-parsed `loggedIn: false` result. Doing so would misreport a CLI that produced
garbage or truncated output as merely "logged out" rather than "could not be verified" — `detection.ts`
maps the two to different `AgentDetectionResult`s (`unsupported` vs. `logged_out`) accordingly.

### The accidental Phase 9 diagnostic exposure and the preventive design here

During Phase 9's real-CLI verification, a throwaway diagnostic script wrapped every process the
adapter spawned (intending only to capture the real task's stream-json output for inspection) and
inadvertently also captured the `--version`/`auth status` preamble; inspecting that capture printed
fragments of real auth JSON — including an email address and an organization ID — into that session's
tool output. Nothing was reproduced further, the capture file was deleted immediately, and it was
disclosed transparently in the Phase 9 report rather than concealed. That incident was in ad hoc
diagnostic tooling outside the adapter's own code, not a bug in `detection.ts` itself — but it
directly motivated Phase 9.1's stricter internal handling: raw auth output is now provably confined
to one function's local scope by construction (see above), which would have made an equivalent
mistake in adapter-internal code structurally harder to write, even though it cannot prevent a
one-off external script from doing its own logging. No real email/org identifiers are reproduced
anywhere in this document or in Phase 9.1's test fixtures — all fixture values use an `.invalid` TLD
and obviously-fake tokens/identifiers.

### Malicious project configuration regression coverage

`claude-code-adapter.test.ts` adds a regression suite that writes real, harmless sentinel files —
`.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, `.claude/agents/untrusted.md`,
`.claude/skills/untrusted/SKILL.md`, `.claude/commands/untrusted.md`, `CLAUDE.md`, `AGENTS.md` — into
a real temporary working directory, then proves three things deterministically: the generated CLI
argv is byte-identical whether a task's working directory contains these files or not; no additional
process (a hook command, an MCP server, a plugin) is ever spawned beyond the expected
`--version`/`--help`/`auth status`/task-execution set; and no permission rule or environment value
from the malicious `settings.json` ever appears in the spawned task's argv or environment. This
proves the Hall/adapter side of the boundary — the adapter never reads these files and never turns
them into argv or env — by construction. It does not and cannot prove the CLI-side guarantee (that
`--safe-mode` genuinely ignores these files at runtime); see the scope caveat under "Real smoke-test
scope" above.
