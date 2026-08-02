import type { HallDatabase } from "./database.js";

export interface Migration {
  readonly version: number;
  readonly description: string;
  readonly up: (db: HallDatabase) => void;
}

/**
 * Migration 1 — the complete Phase 13 schema. Explicit tables per domain
 * concept (never one generic JSON key-value table for everything — see
 * `docs/architecture/0013-durable-persistence-and-recovery.md`, "Schema
 * design"). JSON columns are used only for bounded, already-Zod-schema-validated
 * sub-objects (task requirements, normalized event payloads, comparison
 * result evidence, message authors, operator preferences) — every one of
 * them is re-validated through its existing protocol schema when read
 * back, never trusted merely because Hall itself wrote it.
 *
 * Private/internal-only data (`task_working_directories`,
 * `comparison_internal_paths`, `comparison_candidate_worktrees`) lives in
 * its own tables, never a column on the public-facing `tasks`/
 * `comparisons`/`comparison_candidates` tables — this is a structural
 * guarantee, not just a convention: the repository queries that build a
 * public `TaskRecord`/`AgentComparisonRecord` never join against these
 * tables at all, so there is no shared row-mapper that could accidentally
 * leak a path into a public shape.
 */
const MIGRATION_1: Migration = {
  version: 1,
  description:
    "Initial Phase 13 schema: tasks, events, boards, messages, comparisons, recovery metadata.",
  up(db) {
    db.exec(`
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        priority TEXT NOT NULL,
        status TEXT NOT NULL,
        dependency_task_ids_json TEXT NOT NULL,
        requirements_json TEXT,
        run_id TEXT,
        adapter_id TEXT,
        agent_id TEXT,
        assigned_execution_trust TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        last_sequence INTEGER,
        terminal_event_type TEXT,
        failure_json TEXT,
        cancellation_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        revision INTEGER NOT NULL DEFAULT 0
      );

      -- Private-only: never joined by any query that builds a public TaskRecord.
      CREATE TABLE task_working_directories (
        task_id TEXT PRIMARY KEY REFERENCES tasks(task_id) ON DELETE CASCADE,
        working_directory TEXT NOT NULL
      );

      -- Shared by task and comparison-candidate event streams, discriminated
      -- by stream_kind — see SqliteEventStore's doc comment for why this is
      -- structurally safe against cross-stream contamination.
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_kind TEXT NOT NULL CHECK (stream_kind IN ('task', 'comparison_candidate')),
        stream_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        is_terminal INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (stream_kind, stream_id, sequence)
      );
      CREATE INDEX idx_events_stream ON events (stream_kind, stream_id);

      CREATE TABLE boards (
        board_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('general', 'task')),
        title TEXT NOT NULL,
        description TEXT,
        project_id TEXT,
        task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE messages (
        message_id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL REFERENCES boards(board_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        author_json TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (board_id, sequence)
      );

      CREATE TABLE comparisons (
        comparison_id TEXT PRIMARY KEY,
        source_task_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        priority TEXT NOT NULL,
        requirements_json TEXT,
        base_commit TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        prepared_at TEXT,
        cleanup_status TEXT NOT NULL,
        cleanup_error TEXT,
        prepare_failure_code TEXT,
        prepare_failure_reason TEXT,
        preference_json TEXT,
        revision INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE comparison_candidates (
        candidate_id TEXT PRIMARY KEY,
        comparison_id TEXT NOT NULL REFERENCES comparisons(comparison_id) ON DELETE CASCADE,
        candidate_order INTEGER NOT NULL CHECK (candidate_order IN (0, 1)),
        adapter_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL,
        execution_trust TEXT,
        run_id TEXT,
        agent_id TEXT,
        created_at TEXT NOT NULL,
        prepared_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        last_sequence INTEGER,
        terminal_event_type TEXT,
        failure_json TEXT,
        cancellation_requested INTEGER NOT NULL DEFAULT 0,
        result_evidence_json TEXT,
        safe_failure_reason TEXT,
        UNIQUE (comparison_id, candidate_order)
      );
      CREATE INDEX idx_comparison_candidates_comparison ON comparison_candidates (comparison_id);

      -- Private-only, one row per comparison: the resolved source repository root.
      CREATE TABLE comparison_internal_paths (
        comparison_id TEXT PRIMARY KEY REFERENCES comparisons(comparison_id) ON DELETE CASCADE,
        source_repository_path TEXT NOT NULL
      );

      -- Private-only, one row per candidate: its worktree path.
      CREATE TABLE comparison_candidate_worktrees (
        candidate_id TEXT PRIMARY KEY REFERENCES comparison_candidates(candidate_id) ON DELETE CASCADE,
        comparison_id TEXT NOT NULL,
        worktree_path TEXT NOT NULL
      );

      -- Small, fixed set of trusted, server-written keys (configuration
      -- fingerprint, persistence format version) — never a generic
      -- catch-all for domain state.
      CREATE TABLE server_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE boots (
        boot_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ready_at TEXT,
        shutdown_initiated_at TEXT,
        clean_shutdown_at TEXT,
        recovery_summary_json TEXT
      );
    `);
  },
};

/**
 * Migration 2 — Phase 13.2's durable ownership fence: a single-row table
 * (`id` is always `1`, enforced by the `CHECK`) recording the current
 * owner's opaque token and monotonically increasing epoch. This is a
 * *second*, database-level layer on top of the filesystem lock
 * (`instance-ownership.ts`) — the filesystem lock decides who may *start*;
 * this table decides whether an already-running instance's *writes* are
 * still valid, checked inside every fenced transaction (see
 * `transaction.ts`). `acquired_at`/`heartbeat_at` are diagnostic only,
 * never a second staleness authority — the filesystem lock's heartbeat
 * remains the sole staleness mechanism. See
 * `docs/architecture/0013-durable-persistence-and-recovery.md`, "Database
 * fencing."
 */
const MIGRATION_2: Migration = {
  version: 2,
  description: "Phase 13.2: durable ownership fence (single-row owner token + epoch).",
  up(db) {
    db.exec(`
      CREATE TABLE durable_ownership (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner_token TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      );
    `);
  },
};

/**
 * Migration 3 — Phase 14's CEO plan control plane. `ceo_plan_versions` is
 * append-only (never `UPDATE`d, never deleted): "editing" a plan always
 * inserts a new row with `version = active_version + 1`, so historical
 * versions stay readable exactly as they were created (kickoff, "Plan
 * versioning," item 3). `ceo_approvals` is append-only for the same
 * reason ("Rejection does not delete history"); the current, binding
 * approval (if any) is whichever row has the highest `id` for a
 * `plan_version` equal to the plan's current `active_version` — an older
 * approval row is never deleted when a new version invalidates it, it
 * simply stops being "the current one." `ceo_delegation_links.child_task_id
 * UNIQUE` and its `(plan_id, step_id)` primary key together enforce, at
 * the database level, "each plan step may link to at most one child task"
 * and "each child task may originate from at most one CEO plan step"
 * (kickoff, "Delegation links") — a second delegation attempt against an
 * already-delegated step cannot silently double-insert. `ceo_plan_events`
 * is its own dedicated stream/table (own `sequence` scoped by `plan_id`),
 * deliberately never inserted into the shared `events` table migration 1
 * created for task/comparison-candidate streams (kickoff, "Do not insert
 * these into agent-run normalized-event streams... comparison-candidate
 * event streams").
 */
const MIGRATION_3: Migration = {
  version: 3,
  description: "Phase 14: CEO plan control plane (plans, versions, approvals, delegation, events).",
  up(db) {
    db.exec(`
      CREATE TABLE ceo_plans (
        plan_id TEXT PRIMARY KEY,
        parent_task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        active_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        delegated_at TEXT,
        completed_at TEXT,
        revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_ceo_plans_parent_task ON ceo_plans (parent_task_id);

      CREATE TABLE ceo_plan_versions (
        plan_id TEXT NOT NULL REFERENCES ceo_plans(plan_id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        objective TEXT NOT NULL,
        summary TEXT NOT NULL,
        assumptions_json TEXT NOT NULL,
        constraints_json TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (plan_id, version)
      );

      CREATE TABLE ceo_approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id TEXT NOT NULL REFERENCES ceo_plans(plan_id) ON DELETE CASCADE,
        plan_version INTEGER NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
        operator_note TEXT,
        decided_at TEXT NOT NULL,
        content_hash TEXT NOT NULL
      );
      CREATE INDEX idx_ceo_approvals_plan ON ceo_approvals (plan_id);

      CREATE TABLE ceo_delegation_links (
        plan_id TEXT NOT NULL REFERENCES ceo_plans(plan_id) ON DELETE CASCADE,
        plan_version INTEGER NOT NULL,
        step_id TEXT NOT NULL,
        child_task_id TEXT NOT NULL UNIQUE,
        adapter_id TEXT NOT NULL,
        delegated_at TEXT NOT NULL,
        PRIMARY KEY (plan_id, step_id)
      );

      CREATE TABLE ceo_plan_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (plan_id, sequence)
      );
      CREATE INDEX idx_ceo_plan_events_plan ON ceo_plan_events (plan_id);
    `);
  },
};

/**
 * Phase 14.1 — backs the idempotent progress synchronizer
 * (`ceo-plan-progress-sync.ts`): a SHA-256 fingerprint of a plan's
 * derived per-step progress, compared on every sync attempt so a
 * repeated or out-of-order trigger appends at most one
 * `ceo.plan.progress_changed`/`ceo.plan.completed`/`ceo.plan.failed`
 * event per real transition. Nullable — every plan created before this
 * migration (and every plan not yet delegated) simply has no fingerprint
 * yet, which the synchronizer treats as "never synced," not an error.
 * Internal-only, like `revision`: never selected into `planRowToPlan`'s
 * public `CeoPlan` shape, exposed only via `SqliteCeoPlanStore`'s own
 * dedicated `getLastProgressFingerprint` accessor.
 *
 * `ceo_delegation_links.child_task_id UNIQUE` (migration 3) already gives
 * `findPlanIdByChildTaskId`'s `WHERE child_task_id = ?` lookup a unique
 * index for free — no new index needed for that query.
 */
const MIGRATION_4: Migration = {
  version: 4,
  description: "Phase 14.1: idempotent CEO plan progress fingerprint.",
  up(db) {
    db.exec(`ALTER TABLE ceo_plans ADD COLUMN last_progress_fingerprint TEXT;`);
  },
};

/**
 * Migration 5 — Phase 15's autonomous plan execution domain. Every table
 * here is dedicated to the execution runtime, never sharing a table with
 * the immutable plan-definition tables migration 3 created — a run's own
 * `plan_id`/`plan_version` are the only link back, never a foreign key
 * into `ceo_plan_versions` that could tempt a query to also mutate plan
 * content. `internal_revision`/lease/owner-token columns exist on several
 * tables (mirroring `ceo_plans.revision`'s precedent: kept as a plain
 * column, simply never selected into the public row-mapper) rather than a
 * separate private table, since none of this data is a filesystem path —
 * the one genuinely sensitive category Phase 13 always isolates into its
 * own table.
 *
 * Two partial unique indexes enforce, at the database level (not just in
 * application code — required so the concurrent-claim race tests actually
 * prove something), the two "at most one" invariants the kickoff calls
 * out by name: at most one non-terminal run per plan, and at most one
 * non-terminal attempt per step. A third partial unique index
 * (`idx_ceo_plan_execution_signals_coalesce`) makes duplicate-signal
 * coalescing atomic: an INSERT that would collide with an existing
 * *pending* signal for the same `(run_id, step-or-plan-level, generation)`
 * key fails with a constraint violation the store layer turns into a
 * merge (`ON CONFLICT DO UPDATE`), never a second row.
 */
const MIGRATION_5: Migration = {
  version: 5,
  description: "Phase 15: autonomous plan execution runs, signals, attempts, and events.",
  up(db) {
    db.exec(`
      CREATE TABLE ceo_plan_runs (
        run_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        plan_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        execution_mode TEXT NOT NULL,
        policy_snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        paused_at TEXT,
        completed_at TEXT,
        failed_at TEXT,
        cancelled_at TEXT,
        active_generation INTEGER NOT NULL DEFAULT 0,
        last_scheduler_decision_at TEXT,
        recovery_classification TEXT NOT NULL DEFAULT 'none',
        internal_revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_ceo_plan_runs_plan ON ceo_plan_runs (plan_id);
      CREATE INDEX idx_ceo_plan_runs_status ON ceo_plan_runs (status);
      -- At most one active (non-terminal) run per plan.
      CREATE UNIQUE INDEX idx_ceo_plan_runs_one_active_per_plan
        ON ceo_plan_runs (plan_id)
        WHERE status NOT IN ('completed', 'failed', 'cancelled');

      CREATE TABLE ceo_plan_step_executions (
        run_id TEXT NOT NULL REFERENCES ceo_plan_runs(run_id) ON DELETE CASCADE,
        plan_step_id TEXT NOT NULL,
        child_task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        active_attempt_id TEXT,
        last_failure_code TEXT,
        next_eligible_at TEXT,
        dependency_summary_json TEXT NOT NULL,
        readiness_reason TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        internal_revision INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, plan_step_id)
      );
      CREATE INDEX idx_ceo_plan_step_executions_child_task ON ceo_plan_step_executions (child_task_id);

      CREATE TABLE ceo_plan_step_attempts (
        attempt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES ceo_plan_runs(run_id) ON DELETE CASCADE,
        plan_step_id TEXT NOT NULL,
        child_task_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        trigger_reason TEXT NOT NULL,
        scheduler_signal_id TEXT NOT NULL,
        task_run_id TEXT,
        safe_failure_code TEXT,
        safe_failure_summary TEXT,
        created_at TEXT NOT NULL,
        claimed_at TEXT,
        started_at TEXT,
        finished_at TEXT,
        lease_generation INTEGER NOT NULL DEFAULT 0,
        owner_token TEXT NOT NULL,
        UNIQUE (run_id, plan_step_id, attempt_number)
      );
      -- At most one active (non-terminal) attempt per step.
      CREATE UNIQUE INDEX idx_ceo_plan_step_attempts_one_active
        ON ceo_plan_step_attempts (run_id, plan_step_id)
        WHERE status NOT IN ('completed', 'failed', 'cancelled', 'abandoned');

      CREATE TABLE ceo_plan_execution_signals (
        signal_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES ceo_plan_runs(run_id) ON DELETE CASCADE,
        plan_step_id TEXT,
        generation INTEGER NOT NULL,
        reasons_json TEXT NOT NULL,
        priority TEXT NOT NULL,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        claim_lease TEXT,
        claim_owner_token TEXT,
        claim_expires_at TEXT,
        internal_revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_ceo_plan_execution_signals_claimable
        ON ceo_plan_execution_signals (state, available_at, priority);
      -- Coalescing key: only one *pending* signal per (run, step-or-plan-level, generation).
      CREATE UNIQUE INDEX idx_ceo_plan_execution_signals_coalesce
        ON ceo_plan_execution_signals (run_id, COALESCE(plan_step_id, ''), generation)
        WHERE state = 'pending';

      CREATE TABLE ceo_plan_execution_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES ceo_plan_runs(run_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, sequence)
      );

      CREATE TABLE ceo_plan_execution_circuit_state (
        run_id TEXT PRIMARY KEY REFERENCES ceo_plan_runs(run_id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'closed',
        trip_reason TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        consecutive_same_code_failures INTEGER NOT NULL DEFAULT 0,
        last_failure_code TEXT,
        no_progress_attempts INTEGER NOT NULL DEFAULT 0,
        tripped_at TEXT,
        tripped_step_id TEXT,
        internal_revision INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE ceo_plan_execution_interventions (
        intervention_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES ceo_plan_runs(run_id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_ceo_plan_execution_interventions_run ON ceo_plan_execution_interventions (run_id);

      -- Board-summary deduplication: one row per (run, summary kind) ever posted.
      CREATE TABLE ceo_plan_execution_board_audit (
        run_id TEXT NOT NULL REFERENCES ceo_plan_runs(run_id) ON DELETE CASCADE,
        dedup_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, dedup_key)
      );
    `);
  },
};

/**
 * Migration 6 — Phase 15.1 hardening: durable, idempotent operator intent
 * for abandoned-step retry. This table is the authoritative restart-proof
 * evidence that a human explicitly requested retry of one exact abandoned
 * attempt; Board messages and inferred task state are not authoritative.
 */
const MIGRATION_6: Migration = {
  version: 6,
  description: "Phase 15.1: durable abandoned CEO step retry intents.",
  up(db) {
    db.exec(`
      CREATE TABLE ceo_plan_abandoned_retry_intents (
        intent_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES ceo_plan_runs(run_id) ON DELETE CASCADE,
        plan_step_id TEXT NOT NULL,
        child_task_id TEXT NOT NULL,
        abandoned_attempt_id TEXT NOT NULL REFERENCES ceo_plan_step_attempts(attempt_id),
        actor TEXT NOT NULL CHECK (actor = 'human:local-operator'),
        requested_at TEXT NOT NULL,
        replacement_attempt_id TEXT REFERENCES ceo_plan_step_attempts(attempt_id),
        replacement_claimed_at TEXT,
        UNIQUE (run_id, plan_step_id, abandoned_attempt_id)
      );
      CREATE INDEX idx_ceo_plan_abandoned_retry_intents_run
        ON ceo_plan_abandoned_retry_intents (run_id, plan_step_id);
      CREATE UNIQUE INDEX idx_ceo_plan_abandoned_retry_intents_replacement
        ON ceo_plan_abandoned_retry_intents (replacement_attempt_id)
        WHERE replacement_attempt_id IS NOT NULL;
    `);
  },
};

/**
 * Migration 7 — Phase 16.1's provider-neutral, server-owned agent worktree
 * foundation. Absolute filesystem paths are deliberately kept in this
 * internal-only table, never in a public task or run projection.
 */
const MIGRATION_7: Migration = {
  version: 7,
  description: "Phase 16.1: Hall-owned agent worktree foundation.",
  up(db) {
    db.exec(`
      CREATE TABLE agent_worktrees (
        worktree_id TEXT PRIMARY KEY,
        hall_task_id TEXT NOT NULL,
        hall_agent_run_id TEXT NOT NULL,
        source_repository_root TEXT NOT NULL,
        source_working_directory_relative_path TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN (
            'creating',
            'ready',
            'creation_failed',
            'cleanup_pending',
            'cleaned',
            'cleanup_failed'
          )
        ),
        created_at TEXT NOT NULL,
        ready_at TEXT,
        cleanup_requested_at TEXT,
        cleaned_at TEXT,
        safe_failure_code TEXT CHECK (safe_failure_code IS NULL OR length(safe_failure_code) <= 80),
        safe_failure_summary TEXT CHECK (
          safe_failure_summary IS NULL OR length(safe_failure_summary) <= 501
        ),
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
      );
      CREATE INDEX idx_agent_worktrees_task ON agent_worktrees (hall_task_id);
      CREATE INDEX idx_agent_worktrees_status ON agent_worktrees (status, created_at);
      CREATE UNIQUE INDEX idx_agent_worktrees_one_active_per_agent_run
        ON agent_worktrees (hall_agent_run_id)
        WHERE status NOT IN ('creation_failed', 'cleaned');
    `);
  },
};

/** Ordered by `version`, ascending — `migration-runner.ts` applies whichever ones a given database hasn't recorded yet, one transaction each. */
export const MIGRATIONS: readonly Migration[] = [
  MIGRATION_1,
  MIGRATION_2,
  MIGRATION_3,
  MIGRATION_4,
  MIGRATION_5,
  MIGRATION_6,
  MIGRATION_7,
];

export const HIGHEST_KNOWN_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;
