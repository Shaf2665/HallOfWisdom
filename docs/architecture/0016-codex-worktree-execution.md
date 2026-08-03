# 0016 — Durable Isolated Codex Execution

Status: Phase 16.2 foundation implemented. Codex does **not** use these worktrees or execution
artifacts yet.

Phase 16 will make Codex execution run inside Hall-owned isolated Git worktrees. Phase 16.1 builds
only the provider-neutral foundation inside Hall Core: a durable worktree model, in-memory and
SQLite stores, a narrow Git command runner, and a manager that can create and explicitly clean up a
detached worktree by internal worktree id. Phase 16.2 adds a provider-neutral, bounded terminal
execution-artifact model and stores for future orchestration to write after an agent run reaches a
terminal outcome.

## Ownership boundary

The worktree feature lives under `apps/server/src/agent-worktrees/`. This keeps ownership in Hall
Core, where durable state, restart recovery, task orchestration, and future cleanup reconciliation
already live.

Dependency direction is:

```text
future routes / orchestration / scheduler integration
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
worktrees. A future integration will pass a ready worktree path to the adapter as an ordinary
working directory.

Execution artifacts live under `apps/server/src/execution-artifacts/`. They are owned by Hall Core
and remain server-internal in Phase 16.2. Dependency direction is:

```text
future orchestration / terminalization
                  ↓
      AgentExecutionArtifactRecord
                  ↓
      AgentExecutionArtifactStorePort
          ↙                    ↘
 in-memory store          SQLite store
```

The artifact store does not launch providers, create worktrees, transition tasks, retry runs,
cleanup worktrees, stream events, or reconcile restarts. It records only one bounded immutable
terminal snapshot after some future owner has already classified the run outcome.

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
git -c core.fsmonitor=false config --name-only --get-regexp '^filter\..*\.'
git -c core.fsmonitor=false -c core.hooksPath=<hall-owned-empty-hooks-dir> checkout --detach --force <resolved-base-commit>
```

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

If the effective configuration contains `filter.*.clean`, `filter.*.smudge`, or
`filter.*.process`, Hall fails closed with `GIT_CHECKOUT_FILTER_UNSUPPORTED`, records
`creation_failed`, and does not run checkout. The configured filter command text is not copied into
the public-safe failure summary. A Git config exit code of 1 with empty output is treated as no
matching filters; other config-query failures are bounded Git failures.

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

Only after those checks pass does cleanup run:

```text
git -c core.fsmonitor=false worktree remove --force <manager-constructed-worktree-path>
```

On success the record becomes `cleaned`. If both the path and Git registration are already absent,
cleanup marks the record `cleaned` idempotently. On Git failure the record becomes
`cleanup_failed`. There is no broad recursive filesystem deletion fallback and no `git clean`.
Hall does not delete symlink/junction targets. Automatic stale cleanup belongs to Phase 16.5.

## Crash boundaries

Phase 16.1 persists `creating` before invoking `git worktree add`. A crash after Git creates the
no-checkout worktree but before filter inspection, checkout, or `ready` recording leaves a durable
`creating` record with the intended path, source repository, and base commit. A fail-closed filter
rejection leaves a durable `creation_failed` record and an unpopulated worktree that requires
explicit cleanup. Startup reconciliation is intentionally deferred to Phase 16.5; this phase only
preserves enough evidence for that future reconciler to fail closed.

If Git fails during creation, the record transitions to `creation_failed` with bounded safe failure
fields. If cleanup fails, the record transitions to `cleanup_failed`.

Phase 16.2 does not collect Git artifacts, infer terminal status, reconcile restarts, or write an
artifact automatically. Future terminalization may create an artifact after it has already decided a
run is `completed`, `failed`, `cancelled`, or `abandoned`. If a process crashes before that future
write, authoritative lifecycle remains in the existing task/run/event stores; the missing artifact is
evidence to be handled by a later reconciliation phase, not a lifecycle source of truth.

## Windows considerations

The implementation uses Node path APIs, canonicalization through `fs.realpathSync.native`, and
structured process arguments. It does not rely on Bash, POSIX signals, symlinks, or case-sensitive
filesystems. Tests cover paths containing spaces and Windows-style prefix/case behavior where the
host platform can exercise it.

## Deferred work

Deferred to later Phase 16 subphases:

- Codex adapter integration;
- TaskOrchestrator launch integration;
- orchestration integration that creates execution artifacts;
- Git artifact collection;
- routes and UI;
- startup reconciliation and cleanup workers;
- automatic retry/relaunch behavior;
- real opt-in Codex smoke tests;
- merge, push, pull request, or branch publication workflows.
