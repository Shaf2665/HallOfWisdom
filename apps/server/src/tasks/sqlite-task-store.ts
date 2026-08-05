import {
  parseHallTask,
  parseTaskRequirements,
  parseWithSchema,
  structuredFailureSchema,
  executionTrustSchema,
  taskStatusSchema,
  type ExecutionTrust,
  type StructuredFailure,
  type TaskRequirements,
  type TaskStatus,
} from "@hall-of-wisdom/protocol";
import type { TerminalEventType } from "@hall-of-wisdom/hall-runner";
import {
  DuplicateTaskError,
  InvalidTaskTransitionError,
  TaskCapacityReachedError,
  TaskNotFoundError,
  TaskStateConflictError,
} from "../errors/app-error.js";
import { isValidTaskTransition } from "./task-status-transitions.js";
import type { TaskRecord } from "./task-record.js";
import type { TaskStorePort } from "./task-store-port.js";
import type { HallDatabase } from "../persistence/database.js";
import { withTransaction } from "../persistence/transaction.js";
import { CorruptRecordError } from "../persistence/persistence-errors.js";

export interface SqliteTaskStoreOptions {
  readonly db: HallDatabase;
  readonly maxTasks: number;
}

interface TaskRow {
  task_id: string;
  project_id: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  dependency_task_ids_json: string;
  requirements_json: string | null;
  run_id: string | null;
  adapter_id: string | null;
  agent_id: string | null;
  assigned_execution_trust: string | null;
  event_count: number;
  last_sequence: number | null;
  terminal_event_type: string | null;
  failure_json: string | null;
  cancellation_requested: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  revision: number;
}

function safeJsonParse(table: string, id: string, raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CorruptRecordError(
      table,
      id,
      `stored JSON is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function rowToTaskRecord(row: TaskRow): TaskRecord {
  try {
    const task = parseHallTask({
      taskId: row.task_id,
      projectId: row.project_id,
      title: row.title,
      description: row.description,
      priority: row.priority,
      status: row.status,
      dependencyTaskIds: safeJsonParse("tasks", row.task_id, row.dependency_task_ids_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.requirements_json !== null
        ? {
            requirements: parseTaskRequirements(
              safeJsonParse("tasks", row.task_id, row.requirements_json),
            ),
          }
        : {}),
    });

    const failure: StructuredFailure | undefined =
      row.failure_json !== null
        ? parseWithSchema(
            structuredFailureSchema,
            safeJsonParse("tasks", row.task_id, row.failure_json),
            "StructuredFailure",
          )
        : undefined;

    const assignedExecutionTrust: ExecutionTrust | undefined =
      row.assigned_execution_trust !== null
        ? parseWithSchema(executionTrustSchema, row.assigned_execution_trust, "ExecutionTrust")
        : undefined;

    return {
      task,
      runId: row.run_id ?? undefined,
      adapterId: row.adapter_id ?? undefined,
      agentId: row.agent_id ?? undefined,
      eventCount: row.event_count,
      lastSequence: row.last_sequence ?? undefined,
      terminalEventType: (row.terminal_event_type as TerminalEventType | null) ?? undefined,
      failure,
      cancellationRequested: row.cancellation_requested !== 0,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      assignedExecutionTrust,
    };
  } catch (error) {
    if (error instanceof CorruptRecordError) throw error;
    throw new CorruptRecordError(
      "tasks",
      row.task_id,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * SQLite-backed durable sibling of `TaskStore` — implements the identical
 * `TaskStorePort` contract, verified by the shared contract-test suite in
 * `task-store.contract-test.ts`. Every JSON column is re-validated through
 * its existing protocol Zod schema on read (`rowToTaskRecord`), never
 * trusted merely because Hall itself wrote it.
 *
 * Only `assignIfEligible` performs true compare-and-swap: its `UPDATE`
 * includes `revision = expectedRevision` in the `WHERE` clause, so
 * `changes === 0` is the authoritative signal of a stale revision — the
 * four-field snapshot compare happens in JS first (mirroring `TaskStore`'s
 * own defense-in-depth order) but the actual race-closing guarantee is the
 * SQL condition, not the JS check. Every other mutating method here has no
 * caller-supplied expected revision to check (matching `TaskStore`'s own
 * behavior for those methods) and simply updates by `task_id`, bumping
 * `revision` unconditionally on success — safe because this whole class,
 * like `TaskStore`, is only ever driven by a single synchronous JS call
 * stack per mutation with no `await` in between the read and the write.
 */
export class SqliteTaskStore implements TaskStorePort {
  readonly #db: HallDatabase;
  readonly #maxTasks: number;

  constructor(options: SqliteTaskStoreOptions) {
    this.#db = options.db;
    this.#maxTasks = options.maxTasks;
  }

  setWorkingDirectory(taskId: string, workingDirectory: string | undefined): void {
    this.#mustGetRow(taskId);
    if (workingDirectory === undefined) return;
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO task_working_directories (task_id, working_directory) VALUES (?, ?)
           ON CONFLICT(task_id) DO UPDATE SET working_directory = excluded.working_directory`,
        )
        .run(taskId, workingDirectory);
    });
  }

  getWorkingDirectory(taskId: string): string | undefined {
    this.#mustGetRow(taskId);
    const row = this.#db
      .prepare("SELECT working_directory FROM task_working_directories WHERE task_id = ?")
      .get(taskId) as { working_directory: string } | undefined;
    return row?.working_directory;
  }

  remainingCapacity(): number {
    const count = (this.#db.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c: number }).c;
    return Math.max(0, this.#maxTasks - count);
  }

  add(record: TaskRecord): void {
    const existing = this.#db
      .prepare("SELECT 1 FROM tasks WHERE task_id = ?")
      .get(record.task.taskId);
    if (existing) throw new DuplicateTaskError(record.task.taskId);

    const count = (this.#db.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c: number }).c;
    if (count >= this.#maxTasks) throw new TaskCapacityReachedError(this.#maxTasks);

    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO tasks (
            task_id, project_id, title, description, priority, status,
            dependency_task_ids_json, requirements_json, run_id, adapter_id, agent_id,
            assigned_execution_trust, event_count, last_sequence, terminal_event_type,
            failure_json, cancellation_requested, created_at, updated_at, started_at,
            completed_at, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(
          record.task.taskId,
          record.task.projectId,
          record.task.title,
          record.task.description,
          record.task.priority,
          record.task.status,
          JSON.stringify(record.task.dependencyTaskIds),
          record.task.requirements !== undefined ? JSON.stringify(record.task.requirements) : null,
          record.runId ?? null,
          record.adapterId ?? null,
          record.agentId ?? null,
          record.assignedExecutionTrust ?? null,
          record.eventCount,
          record.lastSequence ?? null,
          record.terminalEventType ?? null,
          record.failure !== undefined ? JSON.stringify(record.failure) : null,
          record.cancellationRequested ? 1 : 0,
          record.createdAt,
          record.task.updatedAt,
          record.startedAt ?? null,
          record.completedAt ?? null,
        );
    });
  }

  get(taskId: string): TaskRecord {
    return rowToTaskRecord(this.#mustGetRow(taskId));
  }

  list(): TaskRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM tasks ORDER BY rowid ASC")
      .all() as unknown as TaskRow[];
    return rows.map(rowToTaskRecord);
  }

  getRevision(taskId: string): number {
    return this.#mustGetRow(taskId).revision;
  }

  updateStatus(taskId: string, nextStatus: TaskStatus): void {
    const row = this.#mustGetRow(taskId);
    if (!isValidTaskTransition(row.status as TaskStatus, nextStatus)) {
      throw new InvalidTaskTransitionError(taskId, row.status, nextStatus);
    }
    const now = new Date().toISOString();
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          "UPDATE tasks SET status = ?, updated_at = ?, revision = revision + 1 WHERE task_id = ?",
        )
        .run(taskStatusSchema.parse(nextStatus), now, taskId);
    });
  }

  recordEventMeta(taskId: string, sequence: number): void {
    this.#mustGetRow(taskId);
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          "UPDATE tasks SET event_count = event_count + 1, last_sequence = ?, revision = revision + 1 WHERE task_id = ?",
        )
        .run(sequence, taskId);
    });
  }

  setStarted(taskId: string, startedAt: string): void {
    this.#mustGetRow(taskId);
    withTransaction(this.#db, () => {
      this.#db
        .prepare("UPDATE tasks SET started_at = ?, revision = revision + 1 WHERE task_id = ?")
        .run(startedAt, taskId);
    });
  }

  setCompleted(
    taskId: string,
    completedAt: string,
    terminalEventType: TerminalEventType,
    failure?: StructuredFailure,
  ): void {
    this.#mustGetRow(taskId);
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `UPDATE tasks SET completed_at = ?, terminal_event_type = ?, failure_json = ?, revision = revision + 1
           WHERE task_id = ?`,
        )
        .run(
          completedAt,
          terminalEventType,
          failure !== undefined ? JSON.stringify(failure) : null,
          taskId,
        );
    });
  }

  setCancellationRequested(taskId: string): void {
    this.#mustGetRow(taskId);
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          "UPDATE tasks SET cancellation_requested = 1, revision = revision + 1 WHERE task_id = ?",
        )
        .run(taskId);
    });
  }

  assignIfEligible(
    taskId: string,
    expectedRevision: number,
    expected: {
      readonly status: TaskStatus;
      readonly runId: string | undefined;
      readonly adapterId: string | undefined;
      readonly agentId: string | undefined;
    },
    assignment: {
      readonly adapterId: string;
      readonly agentId: string;
      readonly executionTrust: ExecutionTrust;
      readonly requirements?: TaskRequirements;
    },
  ): TaskRecord {
    const row = this.#mustGetRow(taskId);

    const isFirstAssignment = row.status === "ready";
    const isReassignment = row.status === "assigned" && row.run_id === null;
    const stillMatchesExpectation =
      row.revision === expectedRevision &&
      row.status === expected.status &&
      (row.run_id ?? undefined) === expected.runId &&
      (row.adapter_id ?? undefined) === expected.adapterId &&
      (row.agent_id ?? undefined) === expected.agentId;

    if ((!isFirstAssignment && !isReassignment) || !stillMatchesExpectation) {
      throw new TaskStateConflictError(taskId, row.status, "assigned");
    }

    const now = new Date().toISOString();
    const nextStatus = isFirstAssignment ? "assigned" : row.status;
    const requirementsJson =
      assignment.requirements !== undefined
        ? JSON.stringify(assignment.requirements)
        : row.requirements_json;

    const result = withTransaction(this.#db, () => {
      const update = this.#db
        .prepare(
          `UPDATE tasks SET adapter_id = ?, agent_id = ?, assigned_execution_trust = ?, status = ?,
             updated_at = ?, requirements_json = ?, revision = revision + 1
           WHERE task_id = ? AND revision = ?`,
        )
        .run(
          assignment.adapterId,
          assignment.agentId,
          assignment.executionTrust,
          nextStatus,
          now,
          requirementsJson,
          taskId,
          expectedRevision,
        );
      if (update.changes === 0) {
        throw new TaskStateConflictError(taskId, row.status, "assigned");
      }
      return rowToTaskRecord(this.#mustGetRow(taskId));
    });
    return result;
  }

  clearAssignment(taskId: string): void {
    this.#mustGetRow(taskId);
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `UPDATE tasks SET adapter_id = NULL, agent_id = NULL, assigned_execution_trust = NULL,
             revision = revision + 1 WHERE task_id = ?`,
        )
        .run(taskId);
    });
  }

  setRunId(taskId: string, runId: string): void {
    this.#mustGetRow(taskId);
    withTransaction(this.#db, () => {
      const update = this.#db
        .prepare(
          "UPDATE tasks SET run_id = ?, revision = revision + 1 WHERE task_id = ? AND run_id IS NULL",
        )
        .run(runId, taskId);
      if (update.changes === 0) {
        const current = this.#mustGetRow(taskId);
        throw new TaskStateConflictError(taskId, current.status, "started");
      }
    });
  }

  clearRunId(taskId: string): void {
    this.#mustGetRow(taskId);
    withTransaction(this.#db, () => {
      this.#db
        .prepare("UPDATE tasks SET run_id = NULL, revision = revision + 1 WHERE task_id = ?")
        .run(taskId);
    });
  }

  /** See `TaskStore.startIfEligible()`'s doc comment — same TOCTOU-safe launch-reservation contract, SQLite-backed. */
  startIfEligible(
    taskId: string,
    expectedRevision: number,
    expected: {
      readonly status: TaskStatus;
      readonly runId: string | undefined;
      readonly adapterId: string | undefined;
      readonly agentId: string | undefined;
    },
    runId: string,
  ): TaskRecord {
    const row = this.#mustGetRow(taskId);

    const isLaunchable = row.status === "assigned" && row.run_id === null;
    const stillMatchesExpectation =
      row.revision === expectedRevision &&
      row.status === expected.status &&
      (row.run_id ?? undefined) === expected.runId &&
      (row.adapter_id ?? undefined) === expected.adapterId &&
      (row.agent_id ?? undefined) === expected.agentId;

    if (!isLaunchable || !stillMatchesExpectation) {
      throw new TaskStateConflictError(taskId, row.status, "started");
    }

    return withTransaction(this.#db, () => {
      const update = this.#db
        .prepare(
          "UPDATE tasks SET run_id = ?, revision = revision + 1 WHERE task_id = ? AND revision = ?",
        )
        .run(runId, taskId, expectedRevision);
      if (update.changes === 0) {
        const current = this.#mustGetRow(taskId);
        throw new TaskStateConflictError(taskId, current.status, "started");
      }
      return rowToTaskRecord(this.#mustGetRow(taskId));
    });
  }

  /** See `TaskStore.prepareRetryIfEligible()`'s doc comment — same atomic governed-retry-reset contract, SQLite-backed. */
  prepareRetryIfEligible(
    taskId: string,
    expectedRevision: number,
    expected: {
      readonly status: TaskStatus;
      readonly runId: string | undefined;
      readonly adapterId: string | undefined;
      readonly agentId: string | undefined;
    },
  ): TaskRecord {
    const row = this.#mustGetRow(taskId);

    const isRetryable = row.status === "failed";
    const stillMatchesExpectation =
      row.revision === expectedRevision &&
      row.status === expected.status &&
      (row.run_id ?? undefined) === expected.runId &&
      (row.adapter_id ?? undefined) === expected.adapterId &&
      (row.agent_id ?? undefined) === expected.agentId;

    if (!isRetryable || !stillMatchesExpectation) {
      throw new TaskStateConflictError(taskId, row.status, "assigned");
    }

    const now = new Date().toISOString();

    return withTransaction(this.#db, () => {
      const update = this.#db
        .prepare(
          `UPDATE tasks SET status = 'assigned', run_id = NULL, terminal_event_type = NULL,
             failure_json = NULL, cancellation_requested = 0,
             completed_at = NULL, started_at = NULL, updated_at = ?,
             revision = revision + 1
           WHERE task_id = ? AND revision = ?`,
        )
        .run(now, taskId, expectedRevision);
      if (update.changes === 0) {
        const current = this.#mustGetRow(taskId);
        throw new TaskStateConflictError(taskId, current.status, "assigned");
      }
      return rowToTaskRecord(this.#mustGetRow(taskId));
    });
  }

  #mustGetRow(taskId: string): TaskRow {
    const row = this.#db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as
      TaskRow | undefined;
    if (!row) throw new TaskNotFoundError(taskId);
    return row;
  }
}
