# 0016 — Durable Isolated Codex Execution

Status: Phase 16.1 foundation implemented. Codex does **not** use these worktrees yet.

Phase 16 will make Codex execution run inside Hall-owned isolated Git worktrees. Phase 16.1 builds
only the provider-neutral foundation inside Hall Core: a durable worktree model, in-memory and
SQLite stores, a narrow Git command runner, and a manager that can create and explicitly clean up a
detached worktree by internal worktree id.

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
git worktree add --detach <generated-worktree-path> <resolved-base-commit>
```

No branch is created, moved, or published. The manager verifies after creation that:

- the worktree is registered by Git;
- worktree `HEAD` equals the recorded base commit;
- `HEAD` is detached;
- the requested source subdirectory maps to an equivalent directory inside the worktree.

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
created/canonicalized before use, outside the source repository, and not an ancestor of the source
repository. Containment uses canonical paths and `path.relative` semantics rather than string
prefix checks, protecting against traversal, prefix-confusion siblings, case variation on
case-insensitive platforms, and symlink/junction escape where the filesystem exposes it.

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

Repository hooks and checkout filters are not trusted as Hall control flow. Phase 16.1 accepts only
an already-approved local repository and does not initialize or update submodules.

## Cleanup behavior

Cleanup is explicit and accepts a worktree id, never a raw path. The manager loads the durable
record, revalidates the configured owned root, revalidates the recorded path, confirms the path
matches the worktree id, transitions to `cleanup_pending`, and runs:

```text
git worktree remove --force <recorded-worktree-path>
```

On success the record becomes `cleaned`. If both the path and Git registration are already absent,
cleanup marks the record `cleaned` idempotently. On Git failure the record becomes
`cleanup_failed`. There is no broad recursive filesystem deletion fallback and no `git clean`.
Automatic stale cleanup belongs to Phase 16.5.

## Crash boundaries

Phase 16.1 persists `creating` before invoking `git worktree add`. A crash after Git creates the
worktree but before `ready` is recorded leaves a durable `creating` record with the intended path,
source repository, and base commit. Startup reconciliation is intentionally deferred to Phase 16.5;
this phase only preserves enough evidence for that future reconciler to fail closed.

If Git fails during creation, the record transitions to `creation_failed` with bounded safe failure
fields. If cleanup fails, the record transitions to `cleanup_failed`.

## Windows considerations

The implementation uses Node path APIs, canonicalization through `fs.realpathSync.native`, and
structured process arguments. It does not rely on Bash, POSIX signals, symlinks, or case-sensitive
filesystems. Tests cover paths containing spaces and Windows-style prefix/case behavior where the
host platform can exercise it.

## Deferred work

Deferred to later Phase 16 subphases:

- Codex adapter integration;
- TaskOrchestrator launch integration;
- execution artifact persistence;
- routes and UI;
- startup reconciliation and cleanup workers;
- automatic retry/relaunch behavior;
- real opt-in Codex smoke tests;
- merge, push, pull request, or branch publication workflows.
