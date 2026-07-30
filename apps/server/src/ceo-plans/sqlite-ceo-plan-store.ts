import {
  ceoPlanVersionSchema,
  type CeoApproval,
  type CeoPlan,
  type CeoPlanActor,
  type CeoPlanEvent,
  type CeoPlanEventType,
  type CeoPlanStatus,
  type CeoPlanVersion,
} from "@hall-of-wisdom/protocol";
import type { HallDatabase } from "../persistence/database.js";
import { withTransaction } from "../persistence/transaction.js";
import { CorruptRecordError } from "../persistence/persistence-errors.js";
import {
  CeoPlanApprovalBindingError,
  CeoPlanNotFoundError,
  CeoPlanStateConflictError,
  CeoPlanVersionNotFoundError,
  CeoPlanAlreadyDelegatedError,
} from "../errors/app-error.js";
import type {
  CancelInput,
  CeoPlanStorePort,
  CreatePlanInput,
  CreateVersionInput,
  DecideApprovalInput,
  DelegationLink,
  RecordDelegationInput,
  SubmitInput,
  SyncProgressInput,
} from "./ceo-plan-store-port.js";

export interface SqliteCeoPlanStoreOptions {
  readonly db: HallDatabase;
}

interface PlanRow {
  plan_id: string;
  parent_task_id: string;
  status: string;
  active_version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  delegated_at: string | null;
  completed_at: string | null;
  revision: number;
  last_progress_fingerprint: string | null;
}

interface VersionRow {
  plan_id: string;
  version: number;
  objective: string;
  summary: string;
  assumptions_json: string;
  constraints_json: string;
  steps_json: string;
  created_at: string;
  created_by: string;
  content_hash: string;
}

interface ApprovalRow {
  id: number;
  plan_id: string;
  plan_version: number;
  decision: string;
  operator_note: string | null;
  decided_at: string;
  content_hash: string;
}

interface LinkRow {
  plan_id: string;
  plan_version: number;
  step_id: string;
  child_task_id: string;
  adapter_id: string;
  delegated_at: string;
}

function planRowToPlan(row: PlanRow): CeoPlan {
  return {
    id: row.plan_id,
    parentTaskId: row.parent_task_id,
    status: row.status as CeoPlanStatus,
    activeVersion: row.active_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by as CeoPlanActor,
    ...(row.delegated_at !== null ? { delegatedAt: row.delegated_at } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  };
}

/**
 * Every JSON column here is re-validated through the full public
 * `ceoPlanVersionSchema` on read, never trusted merely because Hall
 * itself wrote it — the same discipline every other Phase 13/14 SQLite
 * repository follows. `delegationLinksForThisVersion` merges each step's
 * `delegatedTaskId` in at read time; the stored `steps_json` blob itself
 * never carries it, which is what keeps an approved-and-delegated
 * version's own row byte-for-byte immutable since the moment it was
 * inserted (see `ceo-plan-store-port.ts`'s `CeoPlanVersionContent` doc
 * comment).
 */
function versionRowToVersion(
  row: VersionRow,
  delegationLinksForThisVersion: readonly LinkRow[],
): CeoPlanVersion {
  const delegatedByStepId = new Map(
    delegationLinksForThisVersion.map((link) => [link.step_id, link.child_task_id]),
  );
  let rawSteps: unknown;
  let rawAssumptions: unknown;
  let rawConstraints: unknown;
  try {
    rawSteps = JSON.parse(row.steps_json);
    rawAssumptions = JSON.parse(row.assumptions_json);
    rawConstraints = JSON.parse(row.constraints_json);
  } catch {
    throw new CorruptRecordError(
      "ceo_plan_versions",
      `${row.plan_id}:${String(row.version)}`,
      "invalid JSON",
    );
  }
  const stepsWithDelegation = Array.isArray(rawSteps)
    ? rawSteps.map((step: unknown) => {
        if (step === null || typeof step !== "object") return step;
        const stepId = (step as { id?: unknown }).id;
        const delegatedTaskId =
          typeof stepId === "string" ? delegatedByStepId.get(stepId) : undefined;
        return delegatedTaskId !== undefined ? { ...step, delegatedTaskId } : step;
      })
    : rawSteps;

  const candidate = {
    planId: row.plan_id,
    version: row.version,
    objective: row.objective,
    summary: row.summary,
    assumptions: rawAssumptions,
    constraints: rawConstraints,
    steps: stepsWithDelegation,
    createdAt: row.created_at,
    createdBy: row.created_by,
    contentHash: row.content_hash,
  };
  const parsed = ceoPlanVersionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CorruptRecordError(
      "ceo_plan_versions",
      `${row.plan_id}:${String(row.version)}`,
      "failed schema validation on read",
    );
  }
  return parsed.data;
}

function approvalRowToApproval(row: ApprovalRow): CeoApproval {
  return {
    planId: row.plan_id,
    planVersion: row.plan_version,
    decision: row.decision as "approve" | "reject",
    ...(row.operator_note !== null ? { operatorNote: row.operator_note } : {}),
    decidedAt: row.decided_at,
    contentHash: row.content_hash,
  };
}

function linkRowToLink(row: LinkRow): DelegationLink {
  return {
    planId: row.plan_id,
    planVersion: row.plan_version,
    stepId: row.step_id,
    childTaskId: row.child_task_id,
    adapterId: row.adapter_id,
    delegatedAt: row.delegated_at,
  };
}

/**
 * Durable-mode `CeoPlanStorePort` implementation — `InMemoryCeoPlanStore`'s
 * behavioral twin (see `ceo-plan-store-contract.ts`, run against both).
 * Every mutating method here goes through `withTransaction`, which is
 * what gives it the durable ownership fence (Phase 13.2) for free — no
 * CEO-plan-specific fencing code exists anywhere, exactly as the Phase 14
 * kickoff requires ("Every SQLite CEO-plan mutation must use the existing
 * fenced transaction boundary added in Phase 13... not per-repository
 * checks"). Because `withTransaction` is reentrant (Phase 14's addition
 * to `transaction.ts`), every method below can also be called from
 * *inside* another already-open `withTransaction` — this is exactly what
 * lets `ceo-plan-orchestrator.ts`'s delegation coordinator span this
 * store, `TaskStore`, and `BoardStore`/`MessageStore` as one atomic unit
 * without any bespoke "within an open transaction" method existing
 * anywhere.
 */
export class SqliteCeoPlanStore implements CeoPlanStorePort {
  readonly #db: HallDatabase;

  constructor(options: SqliteCeoPlanStoreOptions) {
    this.#db = options.db;
  }

  #getPlanRow(planId: string): PlanRow {
    const row = this.#db.prepare("SELECT * FROM ceo_plans WHERE plan_id = ?").get(planId);
    if (!row) throw new CeoPlanNotFoundError(planId);
    return row as unknown as PlanRow;
  }

  #getVersionRow(planId: string, version: number): VersionRow {
    const row = this.#db
      .prepare("SELECT * FROM ceo_plan_versions WHERE plan_id = ? AND version = ?")
      .get(planId, version) as unknown as VersionRow | undefined;
    if (!row) throw new CeoPlanVersionNotFoundError(planId, version);
    return row;
  }

  #linksForVersion(planId: string, version: number): LinkRow[] {
    return this.#db
      .prepare("SELECT * FROM ceo_delegation_links WHERE plan_id = ? AND plan_version = ?")
      .all(planId, version) as unknown as LinkRow[];
  }

  createPlan(input: CreatePlanInput): { plan: CeoPlan; version: CeoPlanVersion } {
    return withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO ceo_plans (
            plan_id, parent_task_id, status, active_version, created_at, updated_at, created_by, revision
          ) VALUES (?, ?, 'draft', 1, ?, ?, ?, 0)`,
        )
        .run(input.planId, input.parentTaskId, input.createdAt, input.createdAt, input.createdBy);
      this.#db
        .prepare(
          `INSERT INTO ceo_plan_versions (
            plan_id, version, objective, summary, assumptions_json, constraints_json, steps_json,
            created_at, created_by, content_hash
          ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.planId,
          input.content.objective,
          input.content.summary,
          JSON.stringify(input.content.assumptions),
          JSON.stringify(input.content.constraints),
          JSON.stringify(input.content.steps),
          input.createdAt,
          input.createdBy,
          input.contentHash,
        );
      const plan = planRowToPlan(this.#getPlanRow(input.planId));
      const version = versionRowToVersion(this.#getVersionRow(input.planId, 1), []);
      return { plan, version };
    });
  }

  createVersion(input: CreateVersionInput): { plan: CeoPlan; version: CeoPlanVersion } {
    return withTransaction(this.#db, () => {
      const row = this.#getPlanRow(input.planId);
      const allowedSourceStatuses = new Set(["draft", "rejected", "awaiting_approval", "approved"]);
      if (!allowedSourceStatuses.has(row.status)) {
        throw new CeoPlanStateConflictError(input.planId, row.status, "given a new version");
      }
      const nextVersionNumber = row.active_version + 1;
      const result = this.#db
        .prepare(
          `UPDATE ceo_plans SET status = 'draft', active_version = ?, updated_at = ?, revision = revision + 1
           WHERE plan_id = ? AND revision = ?`,
        )
        .run(nextVersionNumber, input.createdAt, input.planId, input.expectedRevision);
      if (result.changes === 0) {
        throw new CeoPlanStateConflictError(input.planId, row.status, "given a new version");
      }
      this.#db
        .prepare(
          `INSERT INTO ceo_plan_versions (
            plan_id, version, objective, summary, assumptions_json, constraints_json, steps_json,
            created_at, created_by, content_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.planId,
          nextVersionNumber,
          input.content.objective,
          input.content.summary,
          JSON.stringify(input.content.assumptions),
          JSON.stringify(input.content.constraints),
          JSON.stringify(input.content.steps),
          input.createdAt,
          input.createdBy,
          input.contentHash,
        );
      const plan = planRowToPlan(this.#getPlanRow(input.planId));
      const version = versionRowToVersion(this.#getVersionRow(input.planId, nextVersionNumber), []);
      return { plan, version };
    });
  }

  submit(input: SubmitInput): CeoPlan {
    return withTransaction(this.#db, () => {
      const row = this.#getPlanRow(input.planId);
      if (row.status !== "draft") {
        throw new CeoPlanStateConflictError(input.planId, row.status, "submitted for approval");
      }
      const result = this.#db
        .prepare(
          `UPDATE ceo_plans SET status = 'awaiting_approval', revision = revision + 1
           WHERE plan_id = ? AND revision = ?`,
        )
        .run(input.planId, input.expectedRevision);
      if (result.changes === 0) {
        throw new CeoPlanStateConflictError(input.planId, row.status, "submitted for approval");
      }
      return planRowToPlan(this.#getPlanRow(input.planId));
    });
  }

  decideApproval(input: DecideApprovalInput): { plan: CeoPlan; approval: CeoApproval } {
    return withTransaction(this.#db, () => {
      const row = this.#getPlanRow(input.planId);
      if (row.status !== "awaiting_approval") {
        throw new CeoPlanStateConflictError(input.planId, row.status, "decided");
      }
      if (row.active_version !== input.planVersion) {
        throw new CeoPlanApprovalBindingError(input.planId);
      }
      const versionRow = this.#getVersionRow(input.planId, row.active_version);
      if (versionRow.content_hash !== input.contentHash) {
        throw new CeoPlanApprovalBindingError(input.planId);
      }

      const nextStatus = input.decision === "approve" ? "approved" : "rejected";
      const result = this.#db
        .prepare(
          `UPDATE ceo_plans SET status = ?, updated_at = ?, revision = revision + 1
           WHERE plan_id = ? AND revision = ?`,
        )
        .run(nextStatus, input.decidedAt, input.planId, input.expectedRevision);
      if (result.changes === 0) {
        throw new CeoPlanStateConflictError(input.planId, row.status, "decided");
      }
      this.#db
        .prepare(
          `INSERT INTO ceo_approvals (plan_id, plan_version, decision, operator_note, decided_at, content_hash)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.planId,
          input.planVersion,
          input.decision,
          input.operatorNote ?? null,
          input.decidedAt,
          input.contentHash,
        );
      const plan = planRowToPlan(this.#getPlanRow(input.planId));
      const approvalRow = this.#db
        .prepare("SELECT * FROM ceo_approvals WHERE plan_id = ? ORDER BY id DESC LIMIT 1")
        .get(input.planId) as unknown as ApprovalRow;
      return { plan, approval: approvalRowToApproval(approvalRow) };
    });
  }

  cancel(input: CancelInput): CeoPlan {
    return withTransaction(this.#db, () => {
      const row = this.#getPlanRow(input.planId);
      const allowed = new Set(["draft", "awaiting_approval", "approved", "rejected", "delegated"]);
      if (!allowed.has(row.status)) {
        throw new CeoPlanStateConflictError(input.planId, row.status, "cancelled");
      }
      const result = this.#db
        .prepare(
          `UPDATE ceo_plans SET status = 'cancelled', revision = revision + 1
           WHERE plan_id = ? AND revision = ?`,
        )
        .run(input.planId, input.expectedRevision);
      if (result.changes === 0) {
        throw new CeoPlanStateConflictError(input.planId, row.status, "cancelled");
      }
      return planRowToPlan(this.#getPlanRow(input.planId));
    });
  }

  recordDelegation(input: RecordDelegationInput): {
    plan: CeoPlan;
    links: readonly DelegationLink[];
  } {
    return withTransaction(this.#db, () => {
      const row = this.#getPlanRow(input.planId);
      if (row.status === "delegated") {
        throw new CeoPlanAlreadyDelegatedError(input.planId);
      }
      if (row.status !== "approved") {
        throw new CeoPlanStateConflictError(input.planId, row.status, "delegated");
      }
      if (row.active_version !== input.approvedVersion) {
        throw new CeoPlanApprovalBindingError(input.planId);
      }
      const versionRow = this.#getVersionRow(input.planId, row.active_version);
      if (versionRow.content_hash !== input.approvedContentHash) {
        throw new CeoPlanApprovalBindingError(input.planId);
      }

      const result = this.#db
        .prepare(
          `UPDATE ceo_plans SET status = 'delegated', updated_at = ?, delegated_at = ?, revision = revision + 1
           WHERE plan_id = ? AND revision = ?`,
        )
        .run(input.delegatedAt, input.delegatedAt, input.planId, input.expectedRevision);
      if (result.changes === 0) {
        throw new CeoPlanStateConflictError(input.planId, row.status, "delegated");
      }
      for (const link of input.links) {
        this.#db
          .prepare(
            `INSERT INTO ceo_delegation_links (plan_id, plan_version, step_id, child_task_id, adapter_id, delegated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.planId,
            row.active_version,
            link.stepId,
            link.childTaskId,
            link.adapterId,
            input.delegatedAt,
          );
      }
      const plan = planRowToPlan(this.#getPlanRow(input.planId));
      const links = this.#linksForVersion(input.planId, row.active_version).map(linkRowToLink);
      return { plan, links };
    });
  }

  syncProgress(input: SyncProgressInput): { plan: CeoPlan; event: CeoPlanEvent } {
    return withTransaction(this.#db, () => {
      const row = this.#getPlanRow(input.planId);
      if (row.status !== "delegated") {
        throw new CeoPlanStateConflictError(input.planId, row.status, "synchronized");
      }
      const result =
        input.newStatus !== undefined
          ? this.#db
              .prepare(
                `UPDATE ceo_plans SET status = ?, updated_at = ?, completed_at = ?, last_progress_fingerprint = ?, revision = revision + 1
                 WHERE plan_id = ? AND revision = ?`,
              )
              .run(
                input.newStatus,
                input.now,
                input.now,
                input.fingerprint,
                input.planId,
                input.expectedRevision,
              )
          : this.#db
              .prepare(
                `UPDATE ceo_plans SET last_progress_fingerprint = ?, revision = revision + 1
                 WHERE plan_id = ? AND revision = ?`,
              )
              .run(input.fingerprint, input.planId, input.expectedRevision);
      if (result.changes === 0) {
        throw new CeoPlanStateConflictError(input.planId, row.status, "synchronized");
      }
      const plan = planRowToPlan(this.#getPlanRow(input.planId));
      const event = this.appendEvent(input.planId, input.eventType, input.eventPayload, input.now);
      return { plan, event };
    });
  }

  getLastProgressFingerprint(planId: string): string | undefined {
    return this.#getPlanRow(planId).last_progress_fingerprint ?? undefined;
  }

  findPlanIdByChildTaskId(childTaskId: string): string | undefined {
    const row = this.#db
      .prepare("SELECT plan_id FROM ceo_delegation_links WHERE child_task_id = ?")
      .get(childTaskId) as { plan_id: string } | undefined;
    return row?.plan_id;
  }

  getPlan(planId: string): CeoPlan {
    return planRowToPlan(this.#getPlanRow(planId));
  }

  listPlans(): readonly CeoPlan[] {
    const rows = this.#db
      .prepare("SELECT * FROM ceo_plans ORDER BY created_at ASC")
      .all() as unknown as PlanRow[];
    return rows.map(planRowToPlan);
  }

  listPlansForParentTask(parentTaskId: string): readonly CeoPlan[] {
    const rows = this.#db
      .prepare("SELECT * FROM ceo_plans WHERE parent_task_id = ? ORDER BY created_at ASC")
      .all(parentTaskId) as unknown as PlanRow[];
    return rows.map(planRowToPlan);
  }

  getVersion(planId: string, version: number): CeoPlanVersion {
    this.#getPlanRow(planId);
    return versionRowToVersion(
      this.#getVersionRow(planId, version),
      this.#linksForVersion(planId, version),
    );
  }

  listVersions(planId: string): readonly CeoPlanVersion[] {
    this.#getPlanRow(planId);
    const rows = this.#db
      .prepare("SELECT * FROM ceo_plan_versions WHERE plan_id = ? ORDER BY version ASC")
      .all(planId) as unknown as VersionRow[];
    return rows.map((row) => versionRowToVersion(row, this.#linksForVersion(planId, row.version)));
  }

  listApprovals(planId: string): readonly CeoApproval[] {
    this.#getPlanRow(planId);
    const rows = this.#db
      .prepare("SELECT * FROM ceo_approvals WHERE plan_id = ? ORDER BY id ASC")
      .all(planId) as unknown as ApprovalRow[];
    return rows.map(approvalRowToApproval);
  }

  listDelegationLinks(planId: string): readonly DelegationLink[] {
    this.#getPlanRow(planId);
    const rows = this.#db
      .prepare("SELECT * FROM ceo_delegation_links WHERE plan_id = ? ORDER BY step_id ASC")
      .all(planId) as unknown as LinkRow[];
    return rows.map(linkRowToLink);
  }

  getRevision(planId: string): number {
    return this.#getPlanRow(planId).revision;
  }

  appendEvent(
    planId: string,
    type: CeoPlanEventType,
    payload: Record<string, string | number | boolean | null>,
    createdAt: string,
  ): CeoPlanEvent {
    return withTransaction(this.#db, () => {
      this.#getPlanRow(planId);
      const maxRow = this.#db
        .prepare("SELECT MAX(sequence) AS m FROM ceo_plan_events WHERE plan_id = ?")
        .get(planId) as { m: number | null };
      const sequence = (maxRow.m ?? -1) + 1;
      this.#db
        .prepare(
          `INSERT INTO ceo_plan_events (plan_id, sequence, event_type, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(planId, sequence, type, JSON.stringify(payload), createdAt);
      return { planId, sequence, type, payload, timestamp: createdAt };
    });
  }

  listEvents(planId: string, afterSequence?: number): readonly CeoPlanEvent[] {
    this.#getPlanRow(planId);
    const rows = (
      afterSequence === undefined
        ? this.#db
            .prepare("SELECT * FROM ceo_plan_events WHERE plan_id = ? ORDER BY sequence ASC")
            .all(planId)
        : this.#db
            .prepare(
              "SELECT * FROM ceo_plan_events WHERE plan_id = ? AND sequence > ? ORDER BY sequence ASC",
            )
            .all(planId, afterSequence)
    ) as {
      plan_id: string;
      sequence: number;
      event_type: string;
      payload_json: string;
      created_at: string;
    }[];
    return rows.map((row) => ({
      planId: row.plan_id,
      sequence: row.sequence,
      type: row.event_type as CeoPlanEventType,
      payload: JSON.parse(row.payload_json) as Record<string, string | number | boolean | null>,
      timestamp: row.created_at,
    }));
  }
}
