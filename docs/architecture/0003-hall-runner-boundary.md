# 0003 — Hall Runner Boundary

Status: Draft (Phase 4).

## Context

Phase 4 introduces `@hall-of-wisdom/hall-runner`: a local process that registers coding-agent
adapters through the `AgentAdapter` interface, runs one task, streams normalized events as JSON
Lines, and exits with a documented code. It is deliberately still a prototype — no networking, no
Git, no real coding-agent integration — but its internal boundaries are the ones later phases (Hall
Core, Claude Code/Codex adapters) will build on, so they're recorded here.

## Hall Runner's responsibility

Hall Runner is the local process that:

1. Knows which adapters exist (via `AgentRegistry`).
2. Validates the workspace and working directory _before_ any adapter sees them.
3. Builds a validated `AgentTaskInput` from trusted input.
4. Drives one task through an adapter's `AgentAdapter` interface (`detect()`, `startTask()`).
5. Streams and re-validates the resulting `NormalizedAgentEvent`s.
6. Reports a stable exit code based on the run's terminal event.

It does not implement any of that logic _inside_ an adapter, and no adapter implements any of
Hall Runner's logic either — see the next section.

## Why adapters remain outside Hall Runner

This continues the rule from `0002-agent-adapter-boundary.md`: adapter-specific code lives in its
own `adapters/<name>` package, never inside the runner. Concretely in this phase, that means the
**generic** parts of Hall Runner (`AgentRegistry`, `runner-service.ts`, `workspace-validation.ts`,
`cli-args.ts`, `signal-cancellation.ts`) contain no reference to Mock Agent, `MockAgentAdapter`, or
any Mock-Agent-specific type. The _only_ file that imports `@hall-of-wisdom/mock-agent` is
`mock-agent-composition-root.ts` — a small, clearly-named development composition root that
converts validated CLI options into a `MockAgentConfig`, constructs the adapter, and registers it.
When Claude Code and Codex adapters exist (Phase 12+), each gets its own composition root next to
this one; `runner-service.ts` does not change, because it never knew which adapter it was running.

## Agent Registry behavior

`AgentRegistry` stores and returns adapters strictly through the `AgentAdapter` interface — its
internal map is `Map<string, AgentAdapter>`, keyed by `descriptor.adapterId`. It rejects a second
`register()` call for an adapter ID already present (`DuplicateAdapterError`) and rejects
`resolve()` for an unregistered ID (`UnknownAdapterError`). It has no import of, or special case
for, any concrete adapter type — a test asserting this (`agent-registry.test.ts`) constructs the
registry with a fake `AgentAdapter` implementation that shares no code with Mock Agent, to make
that guarantee concrete rather than aspirational.

## Development composition root

`mock-agent-composition-root.ts` is intentionally small and does exactly four things: build a
`MockAgentConfig` from CLI options (validating `--scenario` against `mockAgentScenarioSchema`),
construct a `MockAgentAdapter`, create a fresh `AgentRegistry`, and register the adapter into it.
It returns the registry; `cli.ts` then calls the fully generic `runTask()` the same way any future
caller (a real Hall Core service) would, passing only the adapter ID string — `runner-service.ts`
has no way to know the registry was built by a Mock-Agent-specific composition root versus any
other one.

## Working-directory validation and workspace-root containment

`AgentTaskInput.workingDirectory` is, per the adapter SDK contract, an unvalidated string that no
adapter checks. Hall Runner is where that validation actually happens, in two layers:

- **`path-containment.ts`** — pure, no filesystem access. `isContainedPath(root, candidate, options)`
  decides whether `candidate` is `root` itself or a descendant of it, using `path.relative` rather
  than string-prefix matching (`candidate.startsWith(root)` would incorrectly treat
  `C:\workspace-other` as contained within `C:\workspace`). It takes a `path` module parameter
  (`path.win32` or `path.posix`) specifically so Windows and POSIX containment semantics can be
  tested deterministically regardless of which OS actually runs the test suite.
- **`workspace-validation.ts`** — the filesystem-touching layer. Rejects empty/relative/NUL-containing
  paths, resolves both the workspace root and working directory to their canonical, symlink-resolved
  form via `fs.realpathSync.native` _before_ checking containment (so a symlink or Windows junction
  that already points outside the workspace root at validation time is detected and rejected),
  confirms both resolved paths are real directories, and finally calls `isContainedPath` on the
  canonical paths.

Case sensitivity defaults to the platform's real-world behavior (case-sensitive on Linux;
case-insensitive on Windows and default-configuration macOS) — a reasonable prototype default, not
a true per-volume filesystem detection, which is out of scope here.

### What this does and does not guarantee

An earlier version of `cli.ts` had a real bug here (found by a security review and fixed before
this phase completed): it called `validateWorkspace()`, computed the canonical path, and then
discarded that result — passing the raw, unvalidated `cliOptions.workingDirectory` into
`AgentTaskInput` instead. `buildTaskInput()` (see `build-task-input.ts`) now uses
`validatedWorkspace.workingDirectory`, the canonical value, closing that specific mismatch. It is
important to be precise about what this fix does and does not achieve, since an earlier version of
this document overstated it:

- It resolves and validates canonical paths **before** invoking an adapter, and it detects path
  traversal and symlink/junction escape **as observed at validation time**.
- It closes the specific bug that was found: the path that was checked and the path that was used
  are now guaranteed to be the same string.
- It **reduces** path-substitution risk by ensuring the adapter receives the already-resolved path
  rather than a string that still needs interpreting.
- It does **not** provide absolute protection against a filesystem object being replaced _after_
  validation completes and _before_ something later actually reads or writes through that path —
  this is the general TOCTOU (time-of-check-to-time-of-use) class of race condition, and a
  `realpath()` call at one point in time cannot, by itself, close it. Nothing in this prototype
  holds an open file handle or directory handle across the validation-to-use window that would
  prevent a concurrent replacement.
- Mock Agent never reads the filesystem, so this window has no observable effect today. It will
  matter once a real adapter (Phase 12+) actually uses `workingDirectory` to read, write, or spawn
  processes.
- Closing the TOCTOU race itself — as opposed to the validated-vs-used mismatch bug fixed here —
  would require handle-based filesystem isolation (e.g. opening a directory handle at validation
  time and passing that handle, or an OS-level sandbox, to whatever later uses it). That is future
  sandboxing-phase work, not part of this prototype.

## JSON Lines event output and stdout/stderr separation

Every event the runner streams has already passed `parseNormalizedAgentEvent` (in
`runner-service.ts`, defense in depth on top of what the adapter's own `TerminalEventGuard` already
guarantees) before `cli-io.ts`'s `writeJsonLine` serializes it as one complete JSON object per line
to stdout — no decorative text is ever interleaved into that stream, so a future Hall Core can parse
it reliably without a custom framing protocol. Human-readable diagnostics (parse errors, validation
failures, signal notifications) go through `writeDiagnostic` to stderr instead, keeping the two
streams cleanly separable by any downstream consumer.

## Cancellation and SIGINT behavior

Two independent mechanisms exist and both funnel into the same `AbortController` the CLI owns:

- **`AgentExecutionOptions.signal`** — the same programmatic cancellation channel `mock-agent`
  already implements; `runTask()` just forwards whatever `options` it's given straight to
  `adapter.startTask()`.
- **`signal-cancellation.ts`** — deliberately factored out of `runner-service.ts` entirely. It knows
  nothing about tasks, adapters, or events; it only wires `process.on("SIGINT", ...)` to two
  callbacks the caller supplies. The first Ctrl+C calls `onGracefulCancel` (which the CLI wires to
  `controller.abort()`); a second Ctrl+C while a graceful cancellation is already in flight calls
  `onForceExit` instead. The listener is removed via the returned `uninstall()` once the run reaches
  a terminal state, in a `finally` block, so listeners never accumulate across sequential runs in a
  long-lived process.

Testing real OS signal delivery turned out to be unreliable specifically on Windows during this
phase's manual verification: neither Git Bash's `kill -INT` nor Node's `child_process.kill('SIGINT')`
reliably deliver a catchable signal to a Windows child process — Windows has no native POSIX
signals, and a real Ctrl+C only works through the OS console-control-event mechanism a human
keypress generates in an attached console. This is a documented Windows platform limitation, not a
Hall Runner defect. The test suite therefore triggers the handler via `process.emit("SIGINT", "SIGINT")`
— the same mechanism any Node `EventEmitter` uses — which exercises the exact same registered
listener a real signal would invoke, without depending on OS-level signal delivery at all.

## Exit-code policy

| Code  | Meaning                                                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`   | `run.completed` — the _only_ condition that produces this code                                                                                         |
| `1`   | `run.failed`, or an unavailable adapter (treated as a failure)                                                                                         |
| `2`   | Invalid CLI input or runner configuration                                                                                                              |
| `3`   | An internal runner or adapter error (anything not covered by the above)                                                                                |
| `130` | `run.cancelled`, including SIGINT-driven cancellation (`128 + SIGINT`'s signal number `2`, the conventional POSIX shell exit-code-for-signal encoding) |

The runner never reports success (`0`) unless it received exactly one confirmed `run.completed`
event; a missing terminal event throws `NoTerminalEventError` rather than silently exiting `0`, and
a cancellation or failure that arrives after the CLI has already returned an exit code cannot alter
it — the exit code is a pure function of `runTask()`'s single returned result.

## Why `process.exit()` is restricted to the CLI boundary

`runner-service.ts`, `agent-registry.ts`, `workspace-validation.ts`, and `signal-cancellation.ts`
never call `process.exit()`. `runTask()` returns a plain `RunTaskResult` object; `runCli()` returns
a plain exit-code number. Only two places in the whole package ever touch the process's exit
behavior: the bottom of `cli.ts` (setting `process.exitCode` from `runCli()`'s return value, letting
Node exit naturally once stdout/stderr flush) and the injectable `exit` callback used solely for the
forced-second-Ctrl+C path. Keeping `runTask()` and `runCli()` free of `process.exit()` is what makes
them directly unit-testable (a real `process.exit()` call inside a Vitest test would kill the whole
test worker) and reusable by a future Hall Core service that runs tasks without ever wanting a
child process's lifecycle tied to `process.exit()`.

## Why Hall Runner does not read provider credentials

Nothing in this phase reads, stores, logs, or forwards environment variables or credentials of any
kind. `AgentTaskInput` and `AgentDetectionResult` remain structurally incapable of carrying them
(per `0002-agent-adapter-boundary.md`), and Hall Runner's own error messages reference only adapter
IDs, run IDs, and (already-validated, non-secret) paths — never raw process output or `process.env`
values. A dedicated test (`runner-service.test.ts`) sets a uniquely-named environment variable and
asserts its value never appears in a `RunTaskResult`, as a concrete regression guard.

## Why networking is deferred

Fastify, HTTP, and WebSockets are explicitly out of scope for this phase. Hall Runner today is a
local, single-process CLI; Phase 5 (Hall Core Server) is where a network boundary first appears, and
it will consume `runTask()` the same way this CLI does — as a plain async function returning a typed
result — rather than Hall Runner growing its own networking code.

## Why Git validation is deferred

`AgentTaskInput.workingDirectory` is validated as a directory (exists, is a real directory, is
contained within the workspace root) but is **not** required to be a Git repository. Git-specific
concerns (branch naming, worktree creation/cleanup, diff collection) belong to Phase 10+ per
`0001-initial-architecture.md`'s phase plan; requiring a Git repository now would couple this
prototype to functionality that doesn't exist yet.

## Where future secret redaction will occur

Unchanged from `0002-agent-adapter-boundary.md`: still unbuilt. This phase adds one more place that
will eventually need it — Hall Runner's own diagnostic messages, should a future adapter's `detect()`
or event stream surface captured process output through this runner. Today, nothing in Hall Runner
captures real process output at all (Mock Agent makes no real process calls), so there is nothing to
redact yet; the gap is recorded so it isn't forgotten once real adapters exist.

## Permanent subagent and plugin usage rules

Formalized in [`CLAUDE.md`](../../CLAUDE.md)'s "Subagent and Plugin Usage" section: subagents are
for exploration, specification/code-quality/security/documentation review, and isolated bug
investigation — not for delegating final architectural decisions, and not for parallel file edits
until Git worktree isolation exists (deferred to Phase 11). The main Claude session always reruns
the complete workspace verification after integrating any subagent's findings; a subagent's own
test run is never treated as sufficient on its own.
