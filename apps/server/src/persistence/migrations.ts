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

/** Ordered by `version`, ascending — `migration-runner.ts` applies whichever ones a given database hasn't recorded yet, one transaction each. */
export const MIGRATIONS: readonly Migration[] = [MIGRATION_1, MIGRATION_2];

export const HIGHEST_KNOWN_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;
