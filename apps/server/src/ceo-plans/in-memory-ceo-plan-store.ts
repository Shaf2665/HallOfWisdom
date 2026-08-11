import type {
  CeoApproval,
  CeoPlan,
  CeoPlanEvent,
  CeoPlanEventType,
  CeoPlanVersion,
} from "@hall-of-wisdom/protocol";
import {
  CeoPlanApprovalBindingError,
  CeoPlanDeletionBlockedError,
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
  DeletePlanInput,
  DecideApprovalInput,
  DelegationLink,
  RecordDelegationInput,
  SubmitInput,
  SyncProgressInput,
} from "./ceo-plan-store-port.js";

interface StoredPlan {
  plan: CeoPlan;
  revision: number;
  /** Phase 14.1 — private, never on the public `CeoPlan` shape. See `SyncProgressInput`'s doc comment. */
  lastProgressFingerprint: string | undefined;
}

/** Opaque to every caller except `InMemoryCeoPlanStore` itself — see `snapshot()`'s doc comment. */
export interface InMemoryCeoPlanStoreSnapshot {
  readonly _brand: "InMemoryCeoPlanStoreSnapshot";
  readonly plans: ReadonlyMap<string, StoredPlan>;
  readonly versions: ReadonlyMap<string, CeoPlanVersion[]>;
  readonly approvals: ReadonlyMap<string, CeoApproval[]>;
  readonly delegationLinks: ReadonlyMap<string, DelegationLink[]>;
  readonly events: ReadonlyMap<string, CeoPlanEvent[]>;
  /** Phase 14.1 — the reverse child-task-id -> plan-id index (see `#childTaskToPlanId`) must roll back with everything else, or a rolled-back delegation could leave a stale/incorrect reverse-lookup entry behind. */
  readonly childTaskToPlanId: ReadonlyMap<string, string>;
}

/**
 * Ephemeral (in-process) implementation of `CeoPlanStorePort` — the
 * default when Hall Core runs without `--data-dir`, and `SqliteCeoPlanStore`'s
 * behavioral twin (see `ceo-plan-store-contract.ts`, run against both).
 * Every mutating method here can only fail *before* it starts mutating
 * any of its own maps (all validation happens first, then a single
 * synchronous block of unconditional `.set()`/`.push()` calls) — this is
 * what gives ephemeral-mode CEO plan mutations the same "impossible to
 * observe a half-applied write" guarantee `withTransaction` gives durable
 * mode, without an actual database transaction (Phase 14 kickoff, "Atomic
 * delegation": "In ephemeral mode, provide equivalent all-or-nothing
 * behavior through pre-validation and rollback-safe construction").
 */
export class InMemoryCeoPlanStore implements CeoPlanStorePort {
  readonly #plans = new Map<string, StoredPlan>();
  readonly #versions = new Map<string, CeoPlanVersion[]>();
  readonly #approvals = new Map<string, CeoApproval[]>();
  readonly #delegationLinks = new Map<string, DelegationLink[]>();
  readonly #events = new Map<string, CeoPlanEvent[]>();
  /** Phase 14.1 — reverse index maintained alongside `recordDelegation` for O(1) `findPlanIdByChildTaskId` lookups on the hot task-mutation path. */
  readonly #childTaskToPlanId = new Map<string, string>();

  #mustGetPlan(planId: string): StoredPlan {
    const stored = this.#plans.get(planId);
    if (!stored) throw new CeoPlanNotFoundError(planId);
    return stored;
  }

  #checkRevision(stored: StoredPlan, expectedRevision: number, action: string): void {
    if (stored.revision !== expectedRevision) {
      throw new CeoPlanStateConflictError(stored.plan.id, stored.plan.status, action);
    }
  }

  #requireStatus(stored: StoredPlan, allowed: readonly string[], action: string): void {
    if (!allowed.includes(stored.plan.status)) {
      throw new CeoPlanStateConflictError(stored.plan.id, stored.plan.status, action);
    }
  }

  #mustGetVersion(planId: string, version: number): CeoPlanVersion {
    const found = (this.#versions.get(planId) ?? []).find((v) => v.version === version);
    if (!found) throw new CeoPlanVersionNotFoundError(planId, version);
    return found;
  }

  createPlan(input: CreatePlanInput): { plan: CeoPlan; version: CeoPlanVersion } {
    if (this.#plans.has(input.planId)) {
      throw new CeoPlanStateConflictError(input.planId, "draft", "created (already exists)");
    }
    const plan: CeoPlan = {
      id: input.planId,
      parentTaskId: input.parentTaskId,
      status: "draft",
      activeVersion: 1,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      createdBy: input.createdBy,
    };
    const version: CeoPlanVersion = {
      planId: input.planId,
      version: 1,
      objective: input.content.objective,
      summary: input.content.summary,
      assumptions: input.content.assumptions,
      constraints: input.content.constraints,
      steps: input.content.steps.map((step) => ({ ...step })),
      createdAt: input.createdAt,
      createdBy: input.createdBy,
      contentHash: input.contentHash,
    };
    this.#plans.set(input.planId, { plan, revision: 0, lastProgressFingerprint: undefined });
    this.#versions.set(input.planId, [version]);
    this.#approvals.set(input.planId, []);
    this.#delegationLinks.set(input.planId, []);
    this.#events.set(input.planId, []);
    return { plan, version };
  }

  createVersion(input: CreateVersionInput): { plan: CeoPlan; version: CeoPlanVersion } {
    const stored = this.#mustGetPlan(input.planId);
    this.#checkRevision(stored, input.expectedRevision, "given a new version");
    this.#requireStatus(
      stored,
      ["draft", "rejected", "awaiting_approval", "approved"],
      "given a new version",
    );

    const nextVersionNumber = stored.plan.activeVersion + 1;
    const version: CeoPlanVersion = {
      planId: input.planId,
      version: nextVersionNumber,
      objective: input.content.objective,
      summary: input.content.summary,
      assumptions: input.content.assumptions,
      constraints: input.content.constraints,
      steps: input.content.steps.map((step) => ({ ...step })),
      createdAt: input.createdAt,
      createdBy: input.createdBy,
      contentHash: input.contentHash,
    };
    const updatedPlan: CeoPlan = {
      ...stored.plan,
      status: "draft",
      activeVersion: nextVersionNumber,
      updatedAt: input.createdAt,
    };
    this.#plans.set(input.planId, {
      plan: updatedPlan,
      revision: stored.revision + 1,
      lastProgressFingerprint: stored.lastProgressFingerprint,
    });
    this.#versions.get(input.planId)?.push(version);
    return { plan: updatedPlan, version };
  }

  submit(input: SubmitInput): CeoPlan {
    const stored = this.#mustGetPlan(input.planId);
    this.#checkRevision(stored, input.expectedRevision, "submitted for approval");
    this.#requireStatus(stored, ["draft"], "submitted for approval");

    const updatedPlan: CeoPlan = { ...stored.plan, status: "awaiting_approval" };
    this.#plans.set(input.planId, {
      plan: updatedPlan,
      revision: stored.revision + 1,
      lastProgressFingerprint: stored.lastProgressFingerprint,
    });
    return updatedPlan;
  }

  decideApproval(input: DecideApprovalInput): { plan: CeoPlan; approval: CeoApproval } {
    const stored = this.#mustGetPlan(input.planId);
    this.#checkRevision(stored, input.expectedRevision, "decided");
    this.#requireStatus(stored, ["awaiting_approval"], "decided");

    if (stored.plan.activeVersion !== input.planVersion) {
      throw new CeoPlanApprovalBindingError(input.planId);
    }
    const activeVersion = this.#mustGetVersion(input.planId, stored.plan.activeVersion);
    if (activeVersion.contentHash !== input.contentHash) {
      throw new CeoPlanApprovalBindingError(input.planId);
    }

    const approval: CeoApproval = {
      planId: input.planId,
      planVersion: input.planVersion,
      decision: input.decision,
      ...(input.operatorNote !== undefined ? { operatorNote: input.operatorNote } : {}),
      decidedAt: input.decidedAt,
      contentHash: input.contentHash,
    };
    const updatedPlan: CeoPlan = {
      ...stored.plan,
      status: input.decision === "approve" ? "approved" : "rejected",
      updatedAt: input.decidedAt,
    };
    this.#plans.set(input.planId, {
      plan: updatedPlan,
      revision: stored.revision + 1,
      lastProgressFingerprint: stored.lastProgressFingerprint,
    });
    this.#approvals.get(input.planId)?.push(approval);
    return { plan: updatedPlan, approval };
  }

  cancel(input: CancelInput): CeoPlan {
    const stored = this.#mustGetPlan(input.planId);
    this.#checkRevision(stored, input.expectedRevision, "cancelled");
    this.#requireStatus(
      stored,
      ["draft", "awaiting_approval", "approved", "rejected", "delegated"],
      "cancelled",
    );

    const updatedPlan: CeoPlan = { ...stored.plan, status: "cancelled" };
    this.#plans.set(input.planId, {
      plan: updatedPlan,
      revision: stored.revision + 1,
      lastProgressFingerprint: stored.lastProgressFingerprint,
    });
    return updatedPlan;
  }

  deletePlan(input: DeletePlanInput): void {
    const stored = this.#mustGetPlan(input.planId);
    this.#checkRevision(stored, input.expectedRevision, "deleted");
    this.#requireStatus(stored, ["cancelled"], "deleted");
    if ((this.#delegationLinks.get(input.planId) ?? []).length > 0) {
      throw new CeoPlanDeletionBlockedError(
        input.planId,
        "it has delegated child tasks. Child tasks are not deleted automatically.",
      );
    }

    this.#plans.delete(input.planId);
    this.#versions.delete(input.planId);
    this.#approvals.delete(input.planId);
    this.#delegationLinks.delete(input.planId);
    this.#events.delete(input.planId);
  }

  recordDelegation(input: RecordDelegationInput): {
    plan: CeoPlan;
    links: readonly DelegationLink[];
  } {
    const stored = this.#mustGetPlan(input.planId);
    if (stored.plan.status === "delegated") {
      throw new CeoPlanAlreadyDelegatedError(input.planId);
    }
    this.#checkRevision(stored, input.expectedRevision, "delegated");
    this.#requireStatus(stored, ["approved"], "delegated");
    if (stored.plan.activeVersion !== input.approvedVersion) {
      throw new CeoPlanApprovalBindingError(input.planId);
    }
    const activeVersion = this.#mustGetVersion(input.planId, stored.plan.activeVersion);
    if (activeVersion.contentHash !== input.approvedContentHash) {
      throw new CeoPlanApprovalBindingError(input.planId);
    }

    const links: DelegationLink[] = input.links.map((link) => ({
      planId: input.planId,
      planVersion: stored.plan.activeVersion,
      stepId: link.stepId,
      childTaskId: link.childTaskId,
      adapterId: link.adapterId,
      delegatedAt: input.delegatedAt,
    }));
    const updatedPlan: CeoPlan = {
      ...stored.plan,
      status: "delegated",
      updatedAt: input.delegatedAt,
      delegatedAt: input.delegatedAt,
    };
    this.#plans.set(input.planId, {
      plan: updatedPlan,
      revision: stored.revision + 1,
      lastProgressFingerprint: stored.lastProgressFingerprint,
    });
    this.#delegationLinks.set(input.planId, [
      ...(this.#delegationLinks.get(input.planId) ?? []),
      ...links,
    ]);
    for (const link of links) {
      this.#childTaskToPlanId.set(link.childTaskId, input.planId);
    }
    return { plan: updatedPlan, links };
  }

  syncProgress(input: SyncProgressInput): { plan: CeoPlan; event: CeoPlanEvent } {
    const stored = this.#mustGetPlan(input.planId);
    this.#checkRevision(stored, input.expectedRevision, "synchronized");
    this.#requireStatus(stored, ["delegated"], "synchronized");

    const updatedPlan: CeoPlan =
      input.newStatus !== undefined
        ? {
            ...stored.plan,
            status: input.newStatus,
            updatedAt: input.now,
            completedAt: input.now,
          }
        : stored.plan;
    this.#plans.set(input.planId, {
      plan: updatedPlan,
      revision: stored.revision + 1,
      lastProgressFingerprint: input.fingerprint,
    });
    const event = this.appendEvent(input.planId, input.eventType, input.eventPayload, input.now);
    return { plan: updatedPlan, event };
  }

  getLastProgressFingerprint(planId: string): string | undefined {
    return this.#mustGetPlan(planId).lastProgressFingerprint;
  }

  findPlanIdByChildTaskId(childTaskId: string): string | undefined {
    return this.#childTaskToPlanId.get(childTaskId);
  }

  getPlan(planId: string): CeoPlan {
    return this.#mustGetPlan(planId).plan;
  }

  listPlans(): readonly CeoPlan[] {
    return Array.from(this.#plans.values(), (stored) => stored.plan);
  }

  listPlansForParentTask(parentTaskId: string): readonly CeoPlan[] {
    return this.listPlans().filter((plan) => plan.parentTaskId === parentTaskId);
  }

  getVersion(planId: string, version: number): CeoPlanVersion {
    this.#mustGetPlan(planId);
    return this.#mustGetVersion(planId, version);
  }

  listVersions(planId: string): readonly CeoPlanVersion[] {
    this.#mustGetPlan(planId);
    return [...(this.#versions.get(planId) ?? [])];
  }

  listApprovals(planId: string): readonly CeoApproval[] {
    this.#mustGetPlan(planId);
    return [...(this.#approvals.get(planId) ?? [])];
  }

  listDelegationLinks(planId: string): readonly DelegationLink[] {
    this.#mustGetPlan(planId);
    return [...(this.#delegationLinks.get(planId) ?? [])];
  }

  getRevision(planId: string): number {
    return this.#mustGetPlan(planId).revision;
  }

  appendEvent(
    planId: string,
    type: CeoPlanEventType,
    payload: Record<string, string | number | boolean | null>,
    createdAt: string,
  ): CeoPlanEvent {
    this.#mustGetPlan(planId);
    const existing = this.#events.get(planId) ?? [];
    const event: CeoPlanEvent = {
      planId,
      sequence: existing.length,
      type,
      payload,
      timestamp: createdAt,
    };
    this.#events.set(planId, [...existing, event]);
    return event;
  }

  listEvents(planId: string, afterSequence?: number): readonly CeoPlanEvent[] {
    this.#mustGetPlan(planId);
    const events = this.#events.get(planId) ?? [];
    return afterSequence === undefined
      ? [...events]
      : events.filter((event) => event.sequence > afterSequence);
  }

  /**
   * Phase 14.1 — the ephemeral-mode analogue of `withTransaction`'s
   * durable-mode SAVEPOINT (see `TaskStore.snapshot()`'s doc comment for
   * the full rationale). `#plans`'s `StoredPlan` values are always
   * replaced wholesale via `.set()` (never mutated in place — no method
   * on this class ever writes `stored.plan = ...`/`stored.revision =
   * ...`), so a shallow `Map` clone is correct for it. The four
   * array-valued maps (`#versions`/`#approvals`/`#delegationLinks`/
   * `#events`) mix `.push()` (mutates the stored array in place) and
   * `.set()` (replaces it) across their methods, so each gets its own
   * shallow per-key array copy — cheap, and correct regardless of which
   * pattern a given method happens to use. `#childTaskToPlanId` (the
   * `recordDelegation` reverse index) is also included — a rolled-back
   * delegation must not leave a stale entry pointing a child task at a
   * plan it was never actually linked to.
   */
  snapshot(): InMemoryCeoPlanStoreSnapshot {
    const cloneArrayMap = <T>(map: ReadonlyMap<string, readonly T[]>): Map<string, T[]> =>
      new Map(Array.from(map, ([planId, items]) => [planId, [...items]]));
    return {
      _brand: "InMemoryCeoPlanStoreSnapshot",
      plans: new Map(this.#plans),
      versions: cloneArrayMap(this.#versions),
      approvals: cloneArrayMap(this.#approvals),
      delegationLinks: cloneArrayMap(this.#delegationLinks),
      events: cloneArrayMap(this.#events),
      childTaskToPlanId: new Map(this.#childTaskToPlanId),
    };
  }

  /** Replaces this store's entire state with `snapshot`'s — see `TaskStore.restore()`'s doc comment. */
  restore(snapshot: InMemoryCeoPlanStoreSnapshot): void {
    this.#plans.clear();
    for (const [planId, stored] of snapshot.plans) this.#plans.set(planId, stored);
    this.#versions.clear();
    for (const [planId, versions] of snapshot.versions) this.#versions.set(planId, versions);
    this.#approvals.clear();
    for (const [planId, approvals] of snapshot.approvals) this.#approvals.set(planId, approvals);
    this.#delegationLinks.clear();
    for (const [planId, links] of snapshot.delegationLinks) {
      this.#delegationLinks.set(planId, links);
    }
    this.#events.clear();
    for (const [planId, events] of snapshot.events) this.#events.set(planId, events);
    this.#childTaskToPlanId.clear();
    for (const [childTaskId, planId] of snapshot.childTaskToPlanId) {
      this.#childTaskToPlanId.set(childTaskId, planId);
    }
  }
}
