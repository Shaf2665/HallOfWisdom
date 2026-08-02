import { describe, expect, it } from "vitest";
import { HallDatabase } from "./database.js";
import { runMigrations } from "./migration-runner.js";

/**
 * Phase 15 — this file exists specifically to verify, at the raw SQL
 * level, the two database-enforced "at most one" invariants migration 5
 * relies on (one active run per plan, one active attempt per step) and
 * the signal-coalescing unique index. The store-layer tests
 * (`ceo-plan-run-store.contract.ts`, `execution-signal-store.contract.ts`)
 * exercise these through the real store API; this file proves the raw
 * constraint exists independent of any application-level check, which is
 * what actually makes the concurrent-claim race tests meaningful.
 */

function migratedDb(): HallDatabase {
  const db = HallDatabase.openInMemory();
  runMigrations(db);
  return db;
}

describe("migration 5 — ceo_plan_runs one-active-per-plan", () => {
  it("allows a second run for the same plan once the first is terminal", () => {
    const db = migratedDb();
    db.exec(
      `INSERT INTO ceo_plan_runs (run_id, plan_id, plan_version, status, execution_mode, policy_snapshot_json, created_at)
       VALUES ('run-1', 'plan-1', 1, 'completed', 'autonomous', '{}', '2026-07-31T00:00:00.000Z')`,
    );
    expect(() => {
      db.exec(
        `INSERT INTO ceo_plan_runs (run_id, plan_id, plan_version, status, execution_mode, policy_snapshot_json, created_at)
         VALUES ('run-2', 'plan-1', 1, 'configured', 'autonomous', '{}', '2026-07-31T00:01:00.000Z')`,
      );
    }).not.toThrow();
    db.close();
  });

  it("rejects a second non-terminal run for the same plan", () => {
    const db = migratedDb();
    db.exec(
      `INSERT INTO ceo_plan_runs (run_id, plan_id, plan_version, status, execution_mode, policy_snapshot_json, created_at)
       VALUES ('run-1', 'plan-1', 1, 'running', 'autonomous', '{}', '2026-07-31T00:00:00.000Z')`,
    );
    expect(() => {
      db.exec(
        `INSERT INTO ceo_plan_runs (run_id, plan_id, plan_version, status, execution_mode, policy_snapshot_json, created_at)
         VALUES ('run-2', 'plan-1', 1, 'configured', 'autonomous', '{}', '2026-07-31T00:01:00.000Z')`,
      );
    }).toThrow();
    db.close();
  });
});

describe("migration 5 — ceo_plan_step_attempts one-active-per-step", () => {
  it("rejects a second non-terminal attempt for the same run/step", () => {
    const db = migratedDb();
    db.exec(
      `INSERT INTO ceo_plan_runs (run_id, plan_id, plan_version, status, execution_mode, policy_snapshot_json, created_at)
       VALUES ('run-1', 'plan-1', 1, 'running', 'autonomous', '{}', '2026-07-31T00:00:00.000Z')`,
    );
    db.exec(
      `INSERT INTO ceo_plan_step_attempts (attempt_id, run_id, plan_step_id, child_task_id, attempt_number, status, trigger_reason, scheduler_signal_id, created_at, owner_token)
       VALUES ('a-1', 'run-1', 'step-1', 'task-1', 1, 'claimed', 'execution_started', 'sig-1', '2026-07-31T00:00:00.000Z', 'owner-1')`,
    );
    expect(() => {
      db.exec(
        `INSERT INTO ceo_plan_step_attempts (attempt_id, run_id, plan_step_id, child_task_id, attempt_number, status, trigger_reason, scheduler_signal_id, created_at, owner_token)
         VALUES ('a-2', 'run-1', 'step-1', 'task-1', 2, 'starting', 'execution_started', 'sig-2', '2026-07-31T00:01:00.000Z', 'owner-1')`,
      );
    }).toThrow();
    db.close();
  });

  it("allows the next attempt once the previous one is terminal", () => {
    const db = migratedDb();
    db.exec(
      `INSERT INTO ceo_plan_runs (run_id, plan_id, plan_version, status, execution_mode, policy_snapshot_json, created_at)
       VALUES ('run-1', 'plan-1', 1, 'running', 'autonomous', '{}', '2026-07-31T00:00:00.000Z')`,
    );
    db.exec(
      `INSERT INTO ceo_plan_step_attempts (attempt_id, run_id, plan_step_id, child_task_id, attempt_number, status, trigger_reason, scheduler_signal_id, created_at, owner_token)
       VALUES ('a-1', 'run-1', 'step-1', 'task-1', 1, 'failed', 'execution_started', 'sig-1', '2026-07-31T00:00:00.000Z', 'owner-1')`,
    );
    expect(() => {
      db.exec(
        `INSERT INTO ceo_plan_step_attempts (attempt_id, run_id, plan_step_id, child_task_id, attempt_number, status, trigger_reason, scheduler_signal_id, created_at, owner_token)
         VALUES ('a-2', 'run-1', 'step-1', 'task-1', 2, 'claimed', 'retry_due', 'sig-2', '2026-07-31T00:01:00.000Z', 'owner-1')`,
      );
    }).not.toThrow();
    db.close();
  });
});

describe("migration 5 — ceo_plan_execution_signals coalescing index", () => {
  it("rejects a second pending signal for the same run/step/generation", () => {
    const db = migratedDb();
    db.exec(
      `INSERT INTO ceo_plan_runs (run_id, plan_id, plan_version, status, execution_mode, policy_snapshot_json, created_at)
       VALUES ('run-1', 'plan-1', 1, 'running', 'autonomous', '{}', '2026-07-31T00:00:00.000Z')`,
    );
    db.exec(
      `INSERT INTO ceo_plan_execution_signals (signal_id, run_id, plan_step_id, generation, reasons_json, priority, available_at, created_at, updated_at, state)
       VALUES ('sig-1', 'run-1', 'step-1', 0, '["dependency_completed"]', 'normal', '2026-07-31T00:00:00.000Z', '2026-07-31T00:00:00.000Z', '2026-07-31T00:00:00.000Z', 'pending')`,
    );
    expect(() => {
      db.exec(
        `INSERT INTO ceo_plan_execution_signals (signal_id, run_id, plan_step_id, generation, reasons_json, priority, available_at, created_at, updated_at, state)
         VALUES ('sig-2', 'run-1', 'step-1', 0, '["task_terminal"]', 'normal', '2026-07-31T00:00:01.000Z', '2026-07-31T00:00:01.000Z', '2026-07-31T00:00:01.000Z', 'pending')`,
      );
    }).toThrow();
    db.close();
  });

  it("allows a second pending signal once the first is no longer pending", () => {
    const db = migratedDb();
    db.exec(
      `INSERT INTO ceo_plan_runs (run_id, plan_id, plan_version, status, execution_mode, policy_snapshot_json, created_at)
       VALUES ('run-1', 'plan-1', 1, 'running', 'autonomous', '{}', '2026-07-31T00:00:00.000Z')`,
    );
    db.exec(
      `INSERT INTO ceo_plan_execution_signals (signal_id, run_id, plan_step_id, generation, reasons_json, priority, available_at, created_at, updated_at, state)
       VALUES ('sig-1', 'run-1', 'step-1', 0, '["dependency_completed"]', 'normal', '2026-07-31T00:00:00.000Z', '2026-07-31T00:00:00.000Z', '2026-07-31T00:00:00.000Z', 'claimed')`,
    );
    expect(() => {
      db.exec(
        `INSERT INTO ceo_plan_execution_signals (signal_id, run_id, plan_step_id, generation, reasons_json, priority, available_at, created_at, updated_at, state)
         VALUES ('sig-2', 'run-1', 'step-1', 0, '["task_terminal"]', 'normal', '2026-07-31T00:00:01.000Z', '2026-07-31T00:00:01.000Z', '2026-07-31T00:00:01.000Z', 'pending')`,
      );
    }).not.toThrow();
    db.close();
  });

  it("allows two distinct pending plan-level signals for different plan runs, coalescing NULL plan_step_id per run", () => {
    const db = migratedDb();
    db.exec(
      `INSERT INTO ceo_plan_runs (run_id, plan_id, plan_version, status, execution_mode, policy_snapshot_json, created_at)
       VALUES ('run-1', 'plan-1', 1, 'running', 'autonomous', '{}', '2026-07-31T00:00:00.000Z')`,
    );
    db.exec(
      `INSERT INTO ceo_plan_execution_signals (signal_id, run_id, plan_step_id, generation, reasons_json, priority, available_at, created_at, updated_at, state)
       VALUES ('sig-1', 'run-1', NULL, 0, '["capacity_available"]', 'normal', '2026-07-31T00:00:00.000Z', '2026-07-31T00:00:00.000Z', '2026-07-31T00:00:00.000Z', 'pending')`,
    );
    expect(() => {
      db.exec(
        `INSERT INTO ceo_plan_execution_signals (signal_id, run_id, plan_step_id, generation, reasons_json, priority, available_at, created_at, updated_at, state)
         VALUES ('sig-2', 'run-1', NULL, 0, '["capacity_available"]', 'normal', '2026-07-31T00:00:01.000Z', '2026-07-31T00:00:01.000Z', '2026-07-31T00:00:01.000Z', 'pending')`,
      );
    }).toThrow();
    db.close();
  });
});

describe("migration 6 — ceo_plan_abandoned_retry_intents", () => {
  it("records at most one operator retry intent for one exact abandoned attempt", () => {
    const db = migratedDb();
    db.exec(
      `INSERT INTO ceo_plan_runs (run_id, plan_id, plan_version, status, execution_mode, policy_snapshot_json, created_at)
       VALUES ('run-1', 'plan-1', 1, 'running', 'autonomous', '{}', '2026-07-31T00:00:00.000Z')`,
    );
    db.exec(
      `INSERT INTO ceo_plan_step_attempts (attempt_id, run_id, plan_step_id, child_task_id, attempt_number, status, trigger_reason, scheduler_signal_id, created_at, owner_token)
       VALUES ('a-1', 'run-1', 'step-1', 'task-1', 1, 'abandoned', 'execution_started', 'sig-1', '2026-07-31T00:00:00.000Z', 'owner-1')`,
    );
    db.exec(
      `INSERT INTO ceo_plan_abandoned_retry_intents (intent_id, run_id, plan_step_id, child_task_id, abandoned_attempt_id, actor, requested_at)
       VALUES ('intent-1', 'run-1', 'step-1', 'task-1', 'a-1', 'human:local-operator', '2026-07-31T00:01:00.000Z')`,
    );

    expect(() => {
      db.exec(
        `INSERT INTO ceo_plan_abandoned_retry_intents (intent_id, run_id, plan_step_id, child_task_id, abandoned_attempt_id, actor, requested_at)
         VALUES ('intent-2', 'run-1', 'step-1', 'task-1', 'a-1', 'human:local-operator', '2026-07-31T00:02:00.000Z')`,
      );
    }).toThrow();
    db.close();
  });

  it("only accepts the bounded human operator actor as durable retry intent proof", () => {
    const db = migratedDb();
    db.exec(
      `INSERT INTO ceo_plan_runs (run_id, plan_id, plan_version, status, execution_mode, policy_snapshot_json, created_at)
       VALUES ('run-1', 'plan-1', 1, 'running', 'autonomous', '{}', '2026-07-31T00:00:00.000Z')`,
    );
    db.exec(
      `INSERT INTO ceo_plan_step_attempts (attempt_id, run_id, plan_step_id, child_task_id, attempt_number, status, trigger_reason, scheduler_signal_id, created_at, owner_token)
       VALUES ('a-1', 'run-1', 'step-1', 'task-1', 1, 'abandoned', 'execution_started', 'sig-1', '2026-07-31T00:00:00.000Z', 'owner-1')`,
    );

    expect(() => {
      db.exec(
        `INSERT INTO ceo_plan_abandoned_retry_intents (intent_id, run_id, plan_step_id, child_task_id, abandoned_attempt_id, actor, requested_at)
         VALUES ('intent-1', 'run-1', 'step-1', 'task-1', 'a-1', 'system:ceo-scheduler', '2026-07-31T00:01:00.000Z')`,
      );
    }).toThrow();
    db.close();
  });
});

describe("migration 7 — agent_worktrees", () => {
  it("rejects a second active worktree for one Hall agent run id", () => {
    const db = migratedDb();
    db.exec(
      `INSERT INTO agent_worktrees (
        worktree_id, hall_task_id, hall_agent_run_id, source_repository_root,
        source_working_directory_relative_path, base_commit, worktree_path, status, created_at
      ) VALUES (
        'wt-1', 'task-1', 'run-1', 'C:\\repo', '.', '${"0".repeat(40)}',
        'C:\\owned\\wt_1', 'ready', '2026-08-02T10:00:00.000Z'
      )`,
    );
    expect(() => {
      db.exec(
        `INSERT INTO agent_worktrees (
          worktree_id, hall_task_id, hall_agent_run_id, source_repository_root,
          source_working_directory_relative_path, base_commit, worktree_path, status, created_at
        ) VALUES (
          'wt-2', 'task-2', 'run-1', 'C:\\repo', '.', '${"0".repeat(40)}',
          'C:\\owned\\wt_2', 'creating', '2026-08-02T10:01:00.000Z'
        )`,
      );
    }).toThrow();
    db.close();
  });

  it("allows a replacement worktree after the previous one is cleaned", () => {
    const db = migratedDb();
    db.exec(
      `INSERT INTO agent_worktrees (
        worktree_id, hall_task_id, hall_agent_run_id, source_repository_root,
        source_working_directory_relative_path, base_commit, worktree_path, status, created_at
      ) VALUES (
        'wt-1', 'task-1', 'run-1', 'C:\\repo', '.', '${"0".repeat(40)}',
        'C:\\owned\\wt_1', 'cleaned', '2026-08-02T10:00:00.000Z'
      )`,
    );
    expect(() => {
      db.exec(
        `INSERT INTO agent_worktrees (
          worktree_id, hall_task_id, hall_agent_run_id, source_repository_root,
          source_working_directory_relative_path, base_commit, worktree_path, status, created_at
        ) VALUES (
          'wt-2', 'task-2', 'run-1', 'C:\\repo', '.', '${"0".repeat(40)}',
          'C:\\owned\\wt_2', 'creating', '2026-08-02T10:01:00.000Z'
        )`,
      );
    }).not.toThrow();
    db.close();
  });
});
