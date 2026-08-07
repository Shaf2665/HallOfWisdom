# 0016 — Durable Isolated Codex Execution

Status: Phase 16.4 (strict isolated Codex infrastructure) is merged. Phase 16.5 (restart-safe
worktree reconciliation and cleanup, see "Phase 16.5 — restart-safe worktree reconciliation and
cleanup" below, including its post-merge hardening) is merged. Phase 16.6 (Codex trusted-local
production readiness and Git LFS worktree compatibility — see "Detached HEAD decision" below for
the checkout-filter classification fix, and "Cleanup behavior" below for the empty
residual-directory removal fix) is implemented on a branch, pending review and merge.
Strict Codex availability remains fail-closed; exact sandbox equivalence was never proven, and
that verification is now deferred as optional future hardening rather than near-term scope. A real
Codex trusted-local task did run in Phase 16.6, through a Hall-owned worktree, against a disposable
fixture repository outside Hall of Wisdom — strict-mode smoke testing remains deferred alongside
strict equivalence proof.

Phase 16 will make Codex execution run inside Hall-owned isolated Git worktrees. Phase 16.1 built
the provider-neutral foundation inside Hall Core: a durable worktree model, in-memory and SQLite
stores, a narrow Git command runner, and a manager that can create and explicitly clean up a
detached worktree by internal worktree id. Phase 16.2 added a provider-neutral, bounded terminal
execution-artifact model and stores. Phase 16.3 wires those foundations into the canonical
TaskOrchestrator execution path through provider-neutral internal services, but it does not change
Codex launch arguments or run a real Codex task.

## Ownership boundary

The worktree feature lives under `apps/server/src/agent-worktrees/`. This keeps ownership in Hall
Core, where durable state, restart recovery, task orchestration, and future cleanup reconciliation
already live.

Dependency direction is:

```text
TaskOrchestrator / future routes / scheduler integration
                  ↓
        AgentWorktreeManager
                  ↓
        AgentWorktreeStorePort
          ↙                    ↘
 in-memory store          SQLite store

        AgentWorktreeManager
                  ↓
          GitCommandRunner
```

The Codex adapter, Agent Adapter SDK, protocol package, and Hall Runner do not create or manage
worktrees. Phase 16.3 passes a ready worktree path to an explicitly isolated adapter as the ordinary
provider-neutral `workingDirectory` field.

Execution artifacts live under `apps/server/src/execution-artifacts/`. They are owned by Hall Core
and remain server-internal in Phase 16.2. Dependency direction is:

```text
TaskOrchestrator terminalization / future reconciliation
                  ↓
      AgentExecutionArtifactRecord
                  ↓
      AgentExecutionArtifactStorePort
          ↙                    ↘
 in-memory store          SQLite store
```

The artifact store does not launch providers, create worktrees, transition tasks, retry runs,
cleanup worktrees, stream events, or reconcile restarts. It records only one bounded immutable
terminal snapshot after TaskOrchestrator has already classified and persisted the run outcome.

## Data model

`AgentWorktreeRecord` is internal-only and contains:

- worktree id;
- Hall task id;
- Hall agent run id;
- canonical source repository root;
- source working-directory path relative to that repository root;
- resolved base commit object id;
- canonical Hall-owned worktree path;
- lifecycle status;
- created/ready/cleanup timestamps;
- revision;
- bounded safe failure code and summary.

The SQLite table is `agent_worktrees` in migration 7. Absolute paths are intentionally persisted
only in this internal table and are not exposed through any Phase 16.1 route or public protocol.

## Execution artifacts

`AgentExecutionArtifactRecord` is internal-only and contains:

- artifact id;
- Hall task id;
- Hall agent-run id;
- adapter id;
- optional internal worktree id;
- optional internal provider execution/session reference;
- terminal outcome: `completed`, `failed`, `cancelled`, or `abandoned`;
- optional stable terminal reason code;
- optional bounded safe terminal summary;
- execution start/finish timestamps and duration;
- optional process exit code;
- optional base and final commit object ids;
- bounded changed-file list and truncation flag;
- diff counters only: files changed, insertions, deletions;
- optional bounded final summary and truncation flag;
- artifact creation timestamp.

The record intentionally excludes raw stdout, raw stderr, raw JSONL, raw Git diffs, raw command
lines, task prompts, environment variables, credentials, authentication paths, absolute source
repository paths, absolute worktree paths, arbitrary provider payloads, and arbitrary metadata maps.

The SQLite table is `agent_execution_artifacts` in migration 8. `artifact_id` is the primary key
and `hall_agent_run_id` is unique, enforcing one immutable artifact per Hall agent run. The table
has no foreign key to `agent_worktrees`: the artifact may store a safe worktree id, but Phase 16.3's
orchestration layer will validate the relationship before creation. Keeping it nullable and
unconstrained preserves provider-neutral artifact persistence for runs that do not use a worktree.

Artifacts are not authoritative task state. The existing task, event, CEO plan-run, and future
orchestration stores continue to own lifecycle, retries, cleanup decisions, and recovery behavior.

## Artifact invariants and bounds

Artifacts are immutable. The port supports create, get/find by artifact id, get/find by Hall
agent-run id, and deterministic listing only. There are no update, delete, append, revision, or CAS
methods. List order is `createdAt ASC, artifactId ASC` in both in-memory and SQLite stores, using
fixed UTF-8 byte comparison rather than locale-dependent collation or JavaScript's UTF-16 code-unit
ordering. SQLite list queries spell this out with `COLLATE BINARY`, which also compares stored text
by its UTF-8 byte representation. This keeps in-memory and SQLite ordering identical for ASCII,
mixed case, BMP non-ASCII, and supplementary Unicode.

Central domain construction and stored-record parsing enforce the terminal invariants:

- `completed` artifacts must not include a terminal reason or terminal summary, and may include
  only exit code `0` or no exit code;
- `failed`, `cancelled`, and `abandoned` artifacts require a stable terminal reason code;
- finish time must not precede start time;
- duration, diff counters, and exit codes must stay within bounded numeric ranges;
- timestamps must be canonical ISO-8601 UTC strings;
- commits, when present, must be full 40- or 64-character Git object ids.
- when the retained changed-file list is not truncated, `diffSummary.filesChanged` must equal the
  normalized changed-file count;
- when the retained changed-file list is truncated, `diffSummary.filesChanged` must exceed the
  retained changed-file count;
- zero changed files require zero insertions and zero deletions.

Persisted artifact strings must be valid Unicode scalar sequences. Lone UTF-16 high or low
surrogate code units are rejected before UTF-8 byte comparison or persistence, so Node's UTF-8
encoder never has to replace invalid input ambiguously. Persisted identifiers and changed paths
also reject Unicode control characters in the C0 and C1 ranges. Safe terminal summaries are
whitespace-normalized and bounded to 500 characters. Final summaries are bounded to 8,000
characters; oversized input is truncated deterministically, the truncation flag is set, and
truncation avoids splitting valid UTF-16 surrogate pairs. Unsupported C0/C1 controls in summaries
are normalized before storage rather than stored raw.

Changed files are stored as repository-relative paths using `/`. Validation is lexical only and does
not call the filesystem. It accepts either slash style as input, rejects empty paths, NUL/control
characters, POSIX absolute paths, Windows drive-absolute paths, drive-relative paths, UNC paths,
`.`/`..` segments, and paths whose first segment is `.git` under a case-insensitive comparison.
Normal spaces, `.gitignore`, `.gitattributes`, and later path segments containing `.git`-like text
are allowed. Paths are deduplicated, sorted deterministically with the same fixed string comparator,
case-preserved, and truncated only after normalization and sorting.

Stored SQLite rows are parsed back through the same domain rules. Corrupt outcome values, malformed
or wrongly typed changed-file JSON, invalid booleans, impossible terminal combinations, invalid
changed-file/diff counter combinations, commits, invalid timestamps, and unsafe changed paths fail
closed with typed corruption errors; no partial artifact is returned. Public-safe corruption
messages use bounded sanitized labels and fixed details, replacing C0/C1 controls and lone
surrogates before display, so malformed JSON, control characters, SQL, path-like stored ids, and
long corrupt values are not echoed back to callers.

SQLite creation distinguishes duplicate immutable keys from unrelated database failures. Only
confirmed duplicate `artifact_id` or `hall_agent_run_id` failures become typed artifact conflicts;
closed connections, missing tables, check constraints, trigger failures, and other operational
errors are rethrown without creating a readable partial artifact.

## Public-safe projection

Phase 16.2 includes an internal pure projection for future route use. The projection may include the
safe terminal outcome, IDs, timestamps, exit code, commits, changed files, diff counters, final
summary, and truncation flags. It deliberately excludes the provider execution reference, internal
worktree id, absolute paths, environment data, raw output, and any future internal-only fields. The
projection is not exported through `packages/protocol` and no route consumes it in this phase.

## Phase 16.3 orchestration integration

TaskOrchestrator remains the canonical execution owner. It still performs eligibility checks,
assignment, ownership fencing, adapter selection, normalized event handling, cancellation, timeout
behavior, and authoritative task/run/event terminalization. The new orchestration dependency
direction is:

```text
TaskOrchestrator
       ↓
IsolatedAgentExecutionCoordinator
  ↙        ↓          ↘
worktree  adapter   terminalizer
                     ↓
             GitArtifactCollector
                     ↓
       AgentExecutionArtifactStorePort
```

Isolation is activated only by an injected server-internal policy configured at the composition
root. TaskOrchestrator has no Codex-specific adapter branch, and task title, task description,
adapter output, and untrusted metadata cannot opt into isolation. Unknown adapters keep the
existing non-isolated execution path. Production-like isolation wiring requires durable SQLite
stores; in-memory isolation is available only through an explicit test-only composition opt-in. The
durable production composition configures the Codex adapter id for future isolated execution only
when durable stores are present, but Phase 16.3 does not change Codex CLI arguments, permission
profiles, or adapter behavior.

Isolated execution also requires an explicit Hall-owned worktree root in composition. Hall does not
derive a sibling fallback root from the source repository, because an implicit durable path would
make worktree ownership depend on deployment layout rather than operator configuration. Tests that
exercise isolated execution with in-memory stores must opt in explicitly and supply a temporary
Hall-owned root; ordinary non-isolated test and ephemeral server composition continues without
creating any worktree root.

For isolated executions, TaskOrchestrator completes the existing launch gates before it asks
`IsolatedAgentExecutionCoordinator` to prepare a worktree. TaskOrchestrator rechecks the selected
adapter with `detect()` before worktree preparation, re-reads the committed task assignment, and
fails closed before creating a worktree if the adapter is unavailable or no longer satisfies the
task's execution requirements. Cancellation is also checked before adapter preflight, after adapter
preflight, and after worktree preparation but before provider launch. A cancellation at any of
those boundaries records an authoritative synthetic `run.cancelled` event and does not invoke the
adapter. The coordinator uses the approved canonical source working directory associated with the
task, calls `AgentWorktreeManager` with the Hall task id and Hall agent-run id, and requires a
durable `ready` worktree before adapter launch. Only the adapter input `workingDirectory` is
replaced, with the manager-produced path corresponding to the source-relative subdirectory inside
the Hall-owned worktree. The primary source checkout is not passed to the isolated adapter. The
adapter cannot choose the worktree root or path, and the path is never derived from task text,
provider output, or repository names.

If a worktree already exists for the same Hall agent run, the coordinator reuses it only when the
durable record matches the exact task id, run id, approved source location, canonical worktree path,
and `ready` status. Reuse goes through `AgentWorktreeManager.validateReadyWorktree`, which
reconstructs the expected lexical path from the canonical owned root and fixed `wt_` prefix,
rejects symlink or junction replacement with `lstat`/`realpath`, verifies Git registration,
verifies the worktree top-level, verifies the source and worktree share the same common Git
directory, and, for execution reuse, requires detached `HEAD` to equal the recorded base commit.
Conflicting records fail closed before adapter launch, and no second active worktree is created for
that run. If worktree preparation fails, the adapter is not launched; the existing authoritative
infrastructure-failure path records a bounded `WORKTREE_PREPARATION_FAILED` failure and artifact
terminalization may record a failed non-authoritative summary when enough safe state exists.

The coordinator does not contain a path-only validation fallback. If isolated execution is enabled
without the manager, store, or strong manager-owned validator, it fails closed before launch. The
Git evidence collector has the same boundary: it accepts only a worktree id, calls the strong
validator before any read-only Git evidence command, and cannot be configured to trust a persisted
or lexical path by itself.

Cancellation is run-local. A cancellation request is persisted on the exact task run before the
active abort signal is triggered, and the first cancellation actor wins for that run. REST
cancellation records `user`, CEO emergency stop records `orchestrator`, and server shutdown records
`system`; later duplicate cancellation attempts do not overwrite the actor. If cancellation wins
while worktree preparation is still pending, or after the worktree manager has durably recorded a
`creation_failed` worktree but before provider launch, TaskOrchestrator records a synthetic
`run.cancelled` terminal event and does not launch the adapter. Any raw preparation exception text
remains internal and is not used as the cancellation reason.

Active execution bookkeeping is also run-local. TaskOrchestrator tracks the active controller,
promise, cancellation actor, and adapter-local event-sequence offset by Hall agent-run id, with a
task-to-current-run index used only for lookup. Cleanup after an old run settles uses compare-delete
semantics, so a delayed `finally` from attempt N cannot remove attempt N+1's controller, promise,
cancellation actor, or sequence offset. Governed retry clears only pre-run cancellation state; it
does not inherit a stale actor from the failed attempt. Server shutdown re-reads the task record and
marks cancellation only when the persisted task still names the same active run it is about to
abort.

Every provider callback is fenced by task id, run id, agent id, and adapter id before it can append
an event, publish to subscribers, mutate task status, or synthesize an infrastructure failure. If a
late callback or Hall Runner error belongs to a superseded run, TaskOrchestrator ignores it and emits
at most a bounded internal diagnostic for that stale callback kind. It never records raw provider
output, raw command text, absolute paths, or provider stack traces in the replacement diagnostic, and
it never lets the stale callback fail, cancel, complete, or detach the current retry run. The
adapter-local event sequence offset is captured on the active run record when that run starts, so
retry attempts continue the task's durable event stream without sharing mutable task-scoped sequence
state.

Terminal artifact creation is deliberately ordered after authoritative terminal state. The
orchestrator first receives or derives the terminal outcome from normalized Hall event semantics,
persists the existing task/run/event terminal state, and only then invokes the artifact
terminalizer. The terminalizer receives an immutable `AgentExecutionTerminalSnapshot` captured from
the committed pre-terminal task assignment and exact terminal event identity; it does not re-read a
mutable task record after terminalization, so later retry, reassignment, or repair mutations cannot
change the artifact's task id, run id, adapter id, agent id, outcome, timestamps, or worktree id.
If Hall Runner also returns a terminal result, the result identity must match the snapshot before
artifact creation. Artifact write failures are reported through the internal execution-error
diagnostic hook and stderr logging, but they do not roll back terminal state, change the outcome,
reopen a task, trigger retry, relaunch the provider, or clean the worktree.

When the authoritative terminal event has a matching Hall Runner result, Phase 16.3 enriches the
immutable artifact snapshot with the bounded process exit code from that same result. A mismatched
or later result is ignored instead of changing the artifact. Infrastructure failures after a ready
worktree has been prepared, including event-store failures while persisting provider events, pass
the prepared worktree id into terminal artifact creation so Git evidence can still be collected by
the strong worktree validator.

Outcome mapping is provider-neutral:

- normalized `run.completed` becomes `completed`;
- normalized `run.failed` becomes `failed`;
- normalized `run.cancelled` becomes `cancelled`;
- future authoritative abandoned classification will map to `abandoned`.

Phase 16.3 does not add startup abandonment detection. Completed artifacts contain no terminal
reason code or terminal failure summary. Failed and cancelled artifacts use stable bounded reason
codes from authoritative Hall failure/cancellation fields and never copy raw stderr automatically.
Authoritative task timestamps provide `startedAt`, `finishedAt`, and `durationMs`; the terminalizer
uses its clock only for artifact `createdAt`.

When an artifact includes a worktree id, Git evidence is collected only by internal worktree id.
`GitArtifactCollector` delegates ready-worktree identity checks to
`AgentWorktreeManager.validateReadyWorktree`, requires `ready`, revalidates the canonical
Hall-owned root and canonical worktree path, rejects symlink or non-directory replacement, verifies
the path remains inside the Hall-owned root, and verifies Git still sees that same worktree before
any Git evidence command. Post-terminal evidence collection is not controlled by the provider
execution abort signal; a late cancellation cannot truncate the immutable terminal snapshot after
authoritative task state has already landed. The terminalizer then requires the collected worktree
id, Hall task id, and Hall agent-run id to match the authoritative execution before insertion. The
artifact stores only the worktree id, base commit, final commit, relative changed paths, and diff
counters; it never stores the absolute source or worktree path and Phase 16.3 intentionally does
not add a database foreign key to `agent_worktrees`.

The Git evidence collector is read-only and uses a fixed Git command family with structured argv,
`shell: false`, bounded output, timeouts, `core.fsmonitor=false`, `--no-ext-diff`, and
`--no-textconv`:

```text
git -c core.fsmonitor=false rev-parse --verify HEAD^{commit}
git -c core.fsmonitor=false diff --name-only -z --no-renames --no-ext-diff --no-textconv <base> --
git -c core.fsmonitor=false ls-files --others --exclude-standard -z --
git -c core.fsmonitor=false diff --numstat -z --no-renames --no-ext-diff --no-textconv <base> --
```

It does not run checkout, reset, clean, merge, rebase, submodule update, remote operations, hooks,
external diff helpers, or textconv commands. Path output is parsed as strict UTF-8, NUL-delimited
records. Invalid UTF-8, malformed NUL framing, malformed `--numstat`, unsafe paths, duplicate
numstat records, numeric overflow, or output truncation fail closed and leave the authoritative
terminal state intact with no partial artifact.

Changed files represent the final worktree state relative to the recorded base commit, including
committed changes after the base, staged changes, unstaged changes, deletions, and untracked
non-ignored files. Ignored files are excluded. Paths are normalized through the Phase 16.2
repository-relative changed-path rules, deduplicated, and sorted with the artifact UTF-8
comparator. `filesChanged` equals the normalized unique path count before artifact path retention
truncation. Insertions and deletions come from `git diff --numstat` for tracked differences;
binary entries contribute zero line counts, and untracked files are not opened to estimate line
counts, so untracked files may add to `filesChanged` while contributing zero insertions and
deletions.

Artifact terminalization is idempotent by Hall agent-run id. The terminalizer queries before
creation, returns an existing artifact only when its immutable semantic contents match the
authoritative terminal state, and handles uniqueness races by refetching and accepting only an
equivalent record. It never updates, deletes, recreates, or appends to an artifact, and replay does
not relaunch the provider.

Phase 16.3 intentionally retains worktrees after terminal execution. Completed, failed, and
cancelled worktrees remain available in `ready` state when creation succeeded. Artifact persistence
does not request cleanup, age-based cleanup, startup cleanup, recursive deletion, or any cleanup
worker. Restart-safe cleanup and reconciliation belong to Phase 16.5.

## Phase 16.4 strict isolated Codex compatibility

Phase 16.4 keeps the old default strict Codex capability cap in place while adding the strict
isolation infrastructure. Hall Core can configure durable Phase 16 worktree isolation and the
installed Codex CLI can pass a bounded, zero-model native sandbox probe, but that does not prove
the helper and real execution selectors enforce identical effective policy. Strict Codex therefore
remains `unsupported` until Phase 16.6 proves equivalence through explicitly authorized
verification. The primary source checkout is still never passed to strict Codex.

Strict isolated Codex configuration is constructor-time and server-controlled. It is not accepted
from tasks, REST payloads, browser data, provider output, or arbitrary environment variables. The
durable server composition supplies it only when SQLite durability is active, a canonical
Hall-owned `--agent-worktree-root` exists, the worktree store and manager validator are composed,
and trusted-local mode is not enabled. At server startup the worktree root must be absolute,
non-root, free of NUL/control characters, canonicalizable through the nearest existing ancestor,
not a symlink or junction substitution, and mutually non-contained with the workspace root, durable
data directory, and comparison root. The raw CLI value is not retained after validation; the adapter
receives only the canonical root. Normal in-memory mode leaves strict isolation disabled.
Trusted-local mode remains a separate explicit opt-in and does not depend on strict isolated mode.

The Codex adapter rejects strict execution unless Hall Core confirms the exact task/run/worktree
identity immediately before launch. The adapter calls an injected validator built by Hall Core from
`AgentWorktreeManager.validateReadyWorktree`; it does not implement a weaker path-containment
fallback. Hall Core first resolves the active worktree record by Hall agent-run id, then asks the
manager to validate the internal worktree id with `requireHeadAtBase: true`, task id, run id, Git
registration, common Git directory, detached `HEAD`, symlink/junction rejection, and canonical path
checks. The manager-returned agent working directory must equal the adapter input path using Phase
16 path equality. Primary checkouts, sibling substitutions, unregistered worktrees, attached
worktrees, symlink/junction escapes, and TOCTOU replacement fail before Codex is spawned.

Detection gates for strict isolated Codex are executable resolution, supported CLI version,
required `codex exec` flags, ChatGPT authentication, absence of billing-changing environment
variables, durable Hall isolation, explicit Hall-owned worktree root, a passing native sandbox
compatibility probe, exact sandbox-equivalence proof, and the adapter's deterministic JSONL and
process-tree cancellation coverage. Phase 16.4 deliberately leaves the equivalence gate unproven,
so strict detection returns `unsupported` with a fixed diagnostic and does not mark
`project.edit` or `command.execute` verified.

The strict sandbox policy is represented once inside the Codex adapter, but shared constants and
matching selector names are not treated as proof. The real task would use `codex exec --sandbox
workspace-write`; the native probe uses the installed CLI's sandbox helper
(`codex sandbox -P :workspace` on local 0.144.4). Both forms use the same fixed approval, network,
web-search, and feature-disable policy, and neither uses `--dangerously-bypass-approvals-and-sandbox`,
`--yolo`, `danger-full-access`, `--add-dir`, remote operations, or task-controlled security
options. Because Codex 0.144.4 does not expose a zero-model command that materializes the exact
effective `exec` sandbox state for comparison, the adapter fails closed until Phase 16.6.

The probe runs no model. It creates a disposable probe workspace under the canonical Hall-owned
worktree root, and a pre-existing outside sentinel in the same canonical root but outside that
workspace. The sandboxed script verifies read, create, modify, and delete operations inside the
workspace, attempts to alter the outside sentinel, and tries to connect to a parent-owned loopback
TCP listener on `127.0.0.1`. A successful outside sentinel mutation, a successful loopback
connection, timeout, spawn failure, unexpected output, or unsupported helper behavior all fail
closed with bounded stable codes only. The probe never contacts public internet, never performs DNS,
never exposes absolute paths in public results, closes the listener in all paths, and removes only
its own generated probe workspace and sentinel. If the platform or local Codex install cannot
express this common strict policy safely, strict Codex detection reports unsupported rather than
falling back to trusted-local or a dangerous bypass. No administrator setup, ACL changes, firewall
changes, system-user creation, or credential-file reads are performed.

Strict task launch uses a cancellation-aware fresh detection path rather than the public coalesced
polling detector. While exact equivalence is unproven, this path fails before model-backed Codex
spawn and before claiming edit or command capabilities. Cancellation is still checked before
subprocess detection starts, after version/help/auth checks, and during the sandbox probe.
Cancellation emits `run.cancelled` when it wins, never leaks raw abort reasons, and never launches
a task process.

After Phase 16.6 proves exact equivalence, strict task launch will perform preliminary worktree
validation before returning a run handle, then the lazy `CodexRun` will perform the same strong
validation again inside an async pre-spawn gate immediately before the structured `spawner.spawn`
call. That final gate revalidates task id, Hall agent-run id, adapter id, worktree id, exact
canonical worktree directory, Git registration, common git dir, detached HEAD, base commit, and
symlink/junction state through Hall Core's injected manager-backed validator. If the final check
fails, no Codex task process is spawned and a bounded `CODEX_WORKTREE_VALIDATION_FAILED` event is
emitted; if cancellation wins, `run.cancelled` is emitted instead.

The strict argv remains fixed and uses structured arguments:

```text
codex exec --json --ephemeral --ignore-user-config --ignore-rules --strict-config
  --sandbox workspace-write
  -c approval_policy="never"
  -c sandbox_workspace_write.network_access=false
  -c web_search="disabled"
  --disable hooks --disable plugins --disable plugin_sharing
  --disable remote_plugin --disable multi_agent
  --disable apps --disable browser_use --disable browser_use_external
  --disable browser_use_full_cdp_access --disable computer_use
  --cd <validated Hall worktree directory>
  -
```

The prompt is delivered through stdin only. Strict mode never passes
`--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `danger-full-access`,
`--skip-git-repo-check`, `--search`, remote/plugin/session-resume arguments, arbitrary extra args,
or task-controlled security options. `CODEX_HOME` may still be inherited through the existing
allowlisted environment only so the installed CLI can find the operator's ChatGPT login; Hall does
not read credential files or expose auth paths.

Phase 16.4 did not add automatic worktree cleanup or startup reconciliation — Phase 16.5, directly
below, adds both. Phase 16.6 will handle explicitly authorized real model-backed Codex verification;
this document's strict Codex fail-closed behavior is unchanged by Phase 16.5 and remains untouched
until then.

## Phase 16.5 — restart-safe worktree reconciliation and cleanup

Phase 16.5 makes the worktree lifecycle described above safe across normal completion, failure,
cancellation, artifact-persistence failure, cleanup failure, process termination, clean restart,
unclean restart, retry overlap, partial worktree creation, partial cleanup, and a missing execution
artifact. It does not implement Phase 16.6 and does not run a real model-backed Codex task. See
[`0013-durable-persistence-and-recovery.md`](0013-durable-persistence-and-recovery.md)'s
"Agent-worktree reconciliation (Phase 16.5)" section for the full design; this section summarizes
what changed in this package's own ownership area.

**Required lifecycle, now enforced end to end:**

```text
authoritative task terminal state
  -> immutable artifact persistence (or confirmed idempotent match)
  -> exact worktree cleanup request
  -> safe Git worktree removal (through the existing AgentWorktreeManager.cleanupWorktree)
  -> durable cleaned status
```

**Runtime cleanup.** `TaskOrchestrator#terminalizeExecution` now requests worktree cleanup — via a
new `IsolatedAgentExecutionCoordinator#cleanupWorktree` method — strictly after the execution
artifact terminalizer resolves without throwing, for completed, failed, and cancelled runs alike.
Cleanup is fail-soft by construction: it never changes the task's already-recorded terminal outcome,
never touches the artifact, never triggers a retry, and never affects a newer run, because the
worktree ID it acts on comes from the terminating run's own captured snapshot, never re-derived from
the task's current (possibly already-retried) record. A worktree is never cleaned when artifact
creation failed, the artifact conflicts or mismatches, or task/run/worktree identity is uncertain —
`AgentExecutionArtifactTerminalizer`'s existing idempotent-by-`hallAgentRunId` semantics already
guarantee this; Phase 16.5 adds no new bypass of them. **`cleanupWorktree` never reports a false
success:** if it is called with a real worktree ID but no cleaner is actually available (no worktree
manager configured, or one that does not implement cleanup), it returns a bounded
`AGENT_WORKTREE_CLEANER_UNAVAILABLE` failure rather than claiming the worktree was cleaned when
nothing attempted to clean it — this method is only ever called with a real worktree ID in the first
place, since `TaskOrchestrator` never calls it at all for a non-isolated execution.

**Startup reconciliation** (`reconcile-agent-worktrees.ts`, new) processes every persisted worktree
deterministically by status on every durable boot, not only after an unclean shutdown: `creating` is
treated as interrupted (stable code `HALL_RESTART_INTERRUPTED_WORKTREE_CREATION`) and safely
transitioned toward cleanup, handling both a missing and a partially created Git worktree without
ever falling back to recursive deletion; `creation_failed`/`cleanup_pending` resume cleanup;
`cleanup_failed` gets exactly one retry per boot; `ready` reconstructs a missing artifact only from
exact durable evidence (never a newer retry's mutable task assignment) and cleans up only after that
succeeds, or retains and reports a bounded blocked classification if exact reconstruction is
impossible; `cleaned` is left alone unless its path OR its Git registration unexpectedly reappears,
either of which is reported (independently counted) but never auto-deleted, never pruned, and never
transitions the record backward. Unknown directories under the owned root — including symlink and
junction entries, never silently skipped just because they are not an ordinary directory — are
scanned read-only and counted as orphans, never deleted; unknown Git worktree registrations under
the owned root (inspected through a new read-only `AgentWorktreeManager.listRegisteredWorktreePaths`,
never a second ad hoc Git invocation) are likewise counted as orphans and never deleted or pruned. A
source repository whose registrations could not be inspected, or an owned root that could not be
listed, contributes to a bounded inspection-failure count rather than a silent zero.

**Missing-artifact recovery** required a small, minimal schema extension:
`agent_worktrees.adapter_id`/`agent_id`, added nullable in migration 9, captured once at
worktree-creation time. `TaskRecord.adapterId`/`agentId` are mutable and get overwritten by a
governed retry's new run, so they cannot identify which adapter/agent owned an older run's worktree
after a restart — these two immutable columns close that gap. A worktree row created before this
migration has `NULL` for both; reconciliation treats that as "cannot be safely reconstructed,"
retains the worktree, and never guesses.

**Cleanup security is unchanged, not reimplemented.** Every deletion in both the runtime and restart
paths goes through the pre-existing `AgentWorktreeManager.cleanupWorktree` (Phase 16.1): exact
`wt_<id>` path reconstruction from the canonical owned root, symlink/junction rejection, mutual root
containment, Git-registration verification, and removal only via `git worktree remove --force`
through the bounded Git runner — never `rm -rf`, never a directory-name pattern, never a trusted
persisted absolute path. Nothing in Phase 16.5 adds a second, weaker deletion path.

**Recovery summary.** `RecoverySummary.agentWorktree` adds bounded counts (worktrees scanned,
interrupted creations, artifacts recovered/confirmed, cleanup attempts/successes/failures,
reconciliation-blocked, inconsistent-cleaned directories/registrations, orphan
directories/registrations, registration-inspection failures) to the same internal, path-free
mechanism `boots.recovery_summary_json` already used for task and comparison reconciliation. This
phase deliberately does not expose these new counts through `GET /api/v1/system/storage` or add any
new route, endpoint field, or UI — see 0013's "Recovery summary" note in that same section.

**Agent-worktree-root durable fingerprint.** The durable configuration fingerprint that already
scoped a `--data-dir` to `workspaceRoot`/`comparisonRoot` now also scopes it to
`agentWorktreeRoot` — recorded on first use, required to match exactly on every later startup
(unlike `comparisonRoot`, omitting it once recorded is itself a fingerprint failure, not a
tolerated "isolation is now off"), and — for a database with existing `agent_worktrees` rows but no
recorded root — never accepted until every one of those rows' reconstructed `wt_<worktreeId>` paths
is proven to belong to the newly supplied root. See
[`0013-durable-persistence-and-recovery.md`](0013-durable-persistence-and-recovery.md)'s
"Agent-worktree-root durable fingerprint" for the full design.

**Post-merge Phase 16.5 hardening.** Gaps found after the initial merge were closed across two
follow-up hotfixes, all documented in full in 0013's "Agent-worktree reconciliation (Phase 16.5)"
section:

- **Legacy omitted-root rejection, including the fully missing fingerprint case.** The fingerprint
  check above covered a _supplied_ root against pre-existing `agent_worktrees` rows from the first
  merge onward, but a database with such rows and **no** recorded root, started with the root omitted
  again, previously fell through untouched and booted successfully — composing no agent-worktree
  manager and silently skipping reconciliation for those rows indefinitely.
  `checkOrRecordConfigurationFingerprint` now fails closed on this omitted-and-never-recorded case
  (a plain row-existence check, never a path guess) unconditionally, before either the brand-new- or
  existing-database branch — closing a further, narrower gap where a database that had never recorded
  even `workspaceRoot` yet still took the brand-new-database bootstrap path unchecked. Rejects the
  startup before the server binds its port, records a boot-ready state, or touches any worktree,
  artifact, or fingerprint record (including `workspaceRoot` itself).
- **Atomic fingerprint writes.** Each of `workspaceRoot`/`comparisonRoot`/`agentWorktreeRoot`'s
  conditional writes previously went through its own independent transaction; a failure partway
  through one logical startup call could leave one key durably recorded while another silently
  wasn't. All writes for one call now happen inside a single outer transaction (via `withTransaction`'s
  existing `SAVEPOINT`-based nesting), so a failure on any key rolls back every key from that call.
- **Strict, complete Git worktree registration parsing.** Every registration-checking call site now
  reads Git's NUL-delimited `git worktree list --porcelain -z` output through one strict, shared
  parser (`worktree-list-parser.ts`) instead of the previous ad hoc newline-oriented line filter.
  Output that does not exactly match Git's own documented porcelain vocabulary — an unrecognized
  attribute label, a duplicate or structurally conflicting combination (`bare` with `HEAD`, `branch`
  with `detached`, either state missing), an invalid-length `HEAD` value, or a duplicate registered
  path (compared with platform-correct case sensitivity) — fails closed with a bounded
  `GIT_WORKTREE_LIST_MALFORMED` code, including an `exitCode: 0` response that looks superficially
  successful. Genuinely empty stdout with a `0` exit code is treated the same way, not as a trivial
  empty list: a successful invocation against any repository always reports at least one record, so
  empty output can never be silently read as "nothing is registered" — this closes the specific case
  where a missing worktree path plus empty registration output could previously have caused cleanup to
  report success without ever having proven the worktree was safe to consider gone.

**Real-process verification.** `pnpm verify:process-recovery` includes three dedicated Phase 16.5
scenarios driven through the actual built binary. The original: a real completed (Mock Agent,
non-isolated) task, a real Git worktree created in-process against the same database file with no
execution artifact yet, a real restart that recovers the artifact and safely cleans up, a second real
restart proving idempotency, and direct inspection confirming the primary checkout and an unrelated
orphan directory were both left untouched throughout — no model-backed provider task is run. The
second, added by the first post-merge hardening pass: a database seeded with a real
`agent_worktrees` row but no recorded root refuses to start when the root is omitted (no health
response, exit code `2`, no new boot record, the row itself untouched), then boots successfully once
the exact proven root is supplied. The third, added by this final review correction: a database with
no fingerprint of any kind ever recorded (no server has ever booted against it) but a real seeded
worktree row still refuses a single boot attempt with the root omitted the same way — proving the
brand-new-database bootstrap branch specifically, not only the existing-database branch the second
scenario exercises.

## Lifecycle

Implemented states:

- `creating`
- `ready`
- `creation_failed`
- `cleanup_pending`
- `cleaned`
- `cleanup_failed`

Allowed transitions:

- `creating -> ready`
- `creating -> creation_failed`
- `creating -> cleanup_pending`
- `ready -> cleanup_pending`
- `creation_failed -> cleanup_pending`
- `cleanup_pending -> cleaned`
- `cleanup_pending -> cleanup_failed`
- `cleanup_failed -> cleanup_pending`

Invalid transitions throw typed errors. Mutating store methods use revision checks; failed
mutations do not increment revision. SQLite additionally enforces valid status values and at most
one active worktree per Hall agent run id.

## Detached HEAD decision

Phase 16.1 creates worktrees using the functional equivalent of:

```text
git -c core.fsmonitor=false worktree add --detach --no-checkout <generated-worktree-path> <resolved-base-commit>
git -c core.fsmonitor=false config --null --get-regexp '^filter\..*\.'
git -c core.fsmonitor=false -c core.hooksPath=<hall-owned-empty-hooks-dir> checkout --detach --force <resolved-base-commit>
```

The third command additionally carries `GIT_LFS_SKIP_SMUDGE=1` as a process-environment override —
never a `-c` config flag — scoped to only this one invocation, and only when the filter inspection
below classified the effective configuration as the recognized standard Git LFS profile.

No branch is created, moved, or published. The manager verifies after creation that:

- the worktree is registered by Git;
- worktree `HEAD` equals the recorded base commit;
- `HEAD` is detached;
- the requested source subdirectory maps to an equivalent directory inside the worktree.

The first step intentionally uses `--no-checkout`. This creates Git's worktree metadata and the
empty worktree directory without populating repository files, so repository-controlled checkout
programs have not yet had a chance to run. Only after the durable `creating` record exists and the
new worktree path is canonicalized does Hall inspect effective Git configuration from inside that
worktree. Inspecting from the final path matters because conditional Git configuration may depend
on the worktree location.

**Phase 16.6 correction.** Before Phase 16.6, any configured `filter.*.clean`/`filter.*.smudge`/
`filter.*.process` key rejected worktree creation by key-name suffix alone, regardless of which
filter it was — this also rejected the standard Git LFS profile Git for Windows registers at
system scope by default, making every Codex worktree fail closed with
`GIT_CHECKOUT_FILTER_UNSUPPORTED` on any machine with Git LFS installed, before Codex was ever
invoked. Phase 16.6 replaces the blanket key-name rejection with a narrow classification
(`apps/server/src/agent-worktrees/checkout-filter-policy.ts`) that inspects both key **and value**:

- **No filters configured** — proceeds, exactly as before.
- **Exactly the recognized standard Git LFS profile** — proceeds. Recognition requires the filter
  subsection name to be exactly `lfs` (case-sensitive — a differently-cased or differently-named
  subsection is an unknown filter, not LFS), and `clean`/`smudge`/`required` present with values
  matching a small, exact allowlist of Git LFS's own documented output (including the `--skip`
  smudge/process forms some installs configure); `process` — the modern single-process protocol —
  is accepted with a recognized value or accepted as entirely absent, since older-but-standard Git
  LFS installs configure only `clean`/`smudge`/`required`. `required` must hold one of Git's own
  true-spellings (`true`/`1`/`yes`/`on`); `required=false`, an absent `required` key, or any
  unrecognized subkey under `filter.lfs.*` all fall through to rejection.
- **Everything else is still rejected**, closed by default: any filter name other than exactly
  `lfs`; more than one distinct filter name; a key appearing more than once (Hall does not attempt
  to re-derive Git's own multi-scope precedence order from unordered `--get-regexp` output, so a
  duplicate — even with matching values — fails closed as ambiguous rather than guessed);
  a modified, ambiguous, or absolute-custom-executable `clean`/`smudge`/`process` command; command
  chaining or shell metacharacters appended to an otherwise-recognized value (rejected by the same
  exact-match discipline, not a separate check); and malformed or truncated configuration output
  (a missing trailing NUL, an unparseable key shape, or `GitCommandResult.stdoutTruncated`).

The configured filter command text is never copied into the public-safe failure summary or any
stored record — only a bounded, fixed classification code
(`GIT_CHECKOUT_FILTER_UNSUPPORTED`/`GIT_CHECKOUT_FILTER_MALFORMED`/
`GIT_LFS_CONFIGURATION_UNSUPPORTED`/`GIT_LFS_NOT_AVAILABLE`) and a fixed, safe message. A Git
config exit code of 1 with empty output is treated as no matching filters; other config-query
failures remain bounded Git failures (`GIT_FILTER_CONFIG_INSPECTION_FAILED`), a separate
classification from a malformed/truncated _successful_ query.

When the recognized Git LFS profile is present, Hall never lets Git LFS automatically download or
materialize LFS objects while preparing an agent worktree: the subsequent checkout invocation
carries `GIT_LFS_SKIP_SMUDGE=1`, an environment variable Git LFS's own smudge filter reads,
scoped to that one process only (never persisted, never logged, never inherited from or widened to
the parent Hall Core environment) via a small, closed-shape `GitCommandRunner` extension
(`GitCommandEnvOverrides`, currently just this one fixed key) — not a general environment-
passthrough mechanism. An LFS-tracked file therefore checks out as a pointer, never a downloaded
object, inside a Hall-owned worktree; an ordinary, non-LFS-tracked file checks out normally either
way. Hall never installs, configures, or invokes `git-lfs` itself, and future LFS object
materialization (should it ever be wanted) remains a separate, explicitly-operator-approved future
change, not something this phase enables implicitly.

Checkout runs only with a Hall-controlled empty hooks directory under the validated Hall-owned root:
`core.hooksPath=<hall-owned-empty-hooks-dir>`. The hooks directory is created from fixed internal
names, canonicalized, verified to be inside the Hall-owned root and outside the source repository,
rejected if it is a symlink or junction, and verified empty before checkout. Hall does not trust or
execute repository-provided checkout hooks as part of worktree preparation.

Hall also passes `core.fsmonitor=false` as a command-line Git configuration override for
manager-controlled Git invocations. This suppresses repository or user configuration that would ask
Git to invoke an external filesystem-monitor command while Hall is resolving status, listing
worktrees, inspecting config, checking out, or cleaning up.

## Clean-source requirement

Phase 16.1 fails closed unless the source repository is clean. The manager checks:

```text
git status --porcelain=v1 --untracked-files=all
```

Modified tracked files, staged changes, untracked files, and unresolved conflicts prevent worktree
creation. Hall does not stash, commit, copy, patch, or discard source changes, and there is no
override in this phase.

## Source-subdirectory mapping

The source working directory may be below the repository root. The manager:

1. canonicalizes the approved source working directory;
2. resolves the Git top-level repository;
3. verifies the source directory is inside that repository;
4. stores the source-relative path;
5. creates the worktree at the repository base commit;
6. resolves the equivalent relative path inside the worktree.

For example, a source directory of `apps/server` maps to `<worktree>/apps/server`.

## Owned-root containment

The manager requires an explicitly configured Hall-owned worktree root. It must be absolute,
non-empty, not a filesystem root, outside the source repository, and not an ancestor of the source
repository.

Owned-root validation preflights the raw configured path before any directory is created. Hall
normalizes the raw absolute path lexically, canonicalizes the nearest existing ancestor, resolves
the intended owned-root location from that canonical ancestor, and proves mutual non-containment
with the canonical source repository. This catches traversal, prefix-confusion, case variation on
case-insensitive platforms, and existing parent symlink/junction redirects before `mkdir` can
mutate the source checkout. Only after the preflight passes does Hall create the owned root,
canonicalize the created directory, and repeat the mutual non-containment checks.

Worktree directory names are generated from bounded safe identifiers. They are never derived from
task titles, task descriptions, branch names, agent messages, or repository names.

## Git process boundary

`GitCommandRunner` is a narrow Git runner, not a general shell abstraction. It uses structured argv
arrays, `shell: false`, bounded stdout/stderr, a timeout, optional `AbortSignal`, fixed
noninteractive environment overrides, and an allowlisted environment.

Git environment variables that can redirect repository state, including `GIT_DIR`, `GIT_WORK_TREE`,
`GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, and `GIT_ALTERNATE_OBJECT_DIRECTORIES`, are not inherited.
`GIT_TERMINAL_PROMPT=0` prevents interactive authentication prompts. Phase 16.1 does not run remote
Git operations, clone, fetch, pull, push, merge, rebase, reset, clean, or submodule update.

Repository hooks, clean filters, smudge filters, process filters, and external filesystem-monitor
commands are not trusted as Hall control flow. The worktree is first prepared without checkout,
then filters are detected from effective configuration before any repository files are populated,
then checkout runs with an empty Hall-owned hooks path and filesystem-monitor suppression.
Phase 16.1 accepts only an already-approved local repository and does not initialize or update
submodules.

If a Git runner receives an already-aborted signal, it returns a bounded aborted result without
spawning a child process. If a signal aborts after spawn, the runner kills the child and still
settles through bounded stdout/stderr collection.

## Cleanup behavior

Cleanup is explicit and accepts a worktree id, never a raw path. The manager loads the exact durable
record, revalidates the configured owned root, reconstructs the only valid worktree path from the
canonical owned root plus the fixed `wt_` prefix and persisted worktree id, and requires the stored
path to match that expected path using platform-aware equality.

If the path exists, Hall inspects it with `lstat`, rejects symlink or junction replacement, resolves
it with `realpath`, requires the canonical target to equal the expected canonical worktree path, and
requires it to remain inside the canonical Hall-owned root. The same target validation is repeated
immediately before invoking Git removal. A safety-precondition failure occurs before a valid `ready`
record transitions to `cleanup_pending`.

If both the path and Git registration are already absent, cleanup marks the record `cleaned`
idempotently, unchanged from Phase 16.1. Otherwise, Git remains the primary and preferred removal
mechanism whenever it still registers the path at all — including when the directory itself has
already been deleted (`git worktree remove --force` still succeeds there, removing only Git's own
administrative record for a path it already marks prunable):

```text
git -c core.fsmonitor=false worktree remove --force <manager-constructed-worktree-path>
```

On success, Hall re-confirms the registration is genuinely gone before considering anything else. On
Git failure the record becomes `cleanup_failed`.

**Phase 16.6 — empty residual-directory removal.** `git worktree remove --force` does not always
delete the top-level directory it created, even after genuinely succeeding — observed on Windows: a
completed removal that still leaves an empty directory at the exact worktree path. Retrying
`git worktree remove --force` against that path fails a second time, since Git no longer considers it
a working tree at all ("not a working tree"), which used to leave the record `cleanup_failed`
permanently. Once Git confirms no registration remains for a path (whether reached that way, or
because registration was already absent to begin with), Hall may remove the directory itself — but
only as an exact, non-recursive `fs.rmdirSync` call, and only once every one of the following is
re-proven fresh, immediately before that one call: the worktree ID is a safe token; the reconstructed
`wt_<id>` path matches the durable record; the path is inside the Hall-owned root; `lstat` reports an
ordinary directory, never a symlink or junction; its canonicalized real path matches the expected path
exactly; and the directory contains exactly zero entries. A non-empty directory, a symlink/junction, a
canonicalization mismatch, or a directory that cannot be listed at all is left completely untouched
and fails cleanup closed with one of three bounded codes
(`AGENT_WORKTREE_RESIDUAL_DIRECTORY_NOT_EMPTY`/`_UNSAFE`/`_REMOVE_FAILED`) — the record becomes
`cleanup_failed` through the same existing path, never a special case. There is no broad recursive
filesystem deletion fallback anywhere in this flow and no `git clean`/`git worktree prune`. Hall does
not delete symlink/junction targets, at either the Git-removal step or this one. Automatic stale
cleanup (retrying `cleanup_failed`/`cleanup_pending`/`creation_failed` records on restart, including
convergence of exactly this empty-residual-directory scenario) belongs to Phase 16.5's restart
reconciliation — see `0013-durable-persistence-and-recovery.md`'s "Empty residual-directory removal
(Phase 16.6)" for the full design and its real-process proof.

## Crash boundaries

Phase 16.1 persists `creating` before invoking `git worktree add`. A crash after Git creates the
no-checkout worktree but before filter inspection, checkout, or `ready` recording leaves a durable
`creating` record with the intended path, source repository, and base commit. A fail-closed filter
rejection leaves a durable `creation_failed` record and an unpopulated worktree that requires
explicit cleanup. Startup reconciliation is intentionally deferred to Phase 16.5; this phase only
preserves enough evidence for that future reconciler to fail closed.

If Git fails during creation, the record transitions to `creation_failed` with bounded safe failure
fields. If cleanup fails, the record transitions to `cleanup_failed`.

Phase 16.3 collects Git evidence and writes an execution artifact only after TaskOrchestrator has
persisted authoritative terminal task/run/event state. A crash after authoritative terminalization
but before artifact creation leaves a terminal run with a missing artifact. Phase 16.3 did not
reconcile that state, relaunch the provider, or infer retry eligibility from the missing artifact.
Phase 16.5 reconciles missing artifacts without provider relaunch — see "Phase 16.5 — restart-safe
worktree reconciliation and cleanup" above. The artifact remains evidence for later inspection and
reconciliation, not a lifecycle source of truth.

## Windows considerations

The implementation uses Node path APIs, canonicalization through `fs.realpathSync.native`, and
structured process arguments. It does not rely on Bash, POSIX signals, symlinks, or case-sensitive
filesystems. Tests cover paths containing spaces and Windows-style prefix/case behavior where the
host platform can exercise it.

## Deferred work

Deferred to later Phase 16 subphases:

- additional Codex-specific launch behavior beyond the strict isolated profile described above;
- routes and UI;
- automatic retry/relaunch behavior;
- real opt-in Codex smoke tests and exact sandbox-equivalence proof (Phase 16.6);
- merge, push, pull request, or branch publication workflows.

Startup reconciliation and cleanup are no longer deferred — see "Phase 16.5 — restart-safe worktree
reconciliation and cleanup" above.
