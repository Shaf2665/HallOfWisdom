import type {
  CeoApproval,
  CeoApprovalDecision,
  CeoPlan,
  CeoPlanActor,
  CeoPlanEvent,
  CeoPlanEventType,
  CeoPlanStatus,
  CeoPlanStep,
  CeoPlanVersion,
} from "@hall-of-wisdom/protocol";

/**
 * The content of one plan version, exactly as the orchestrator hands it
 * to the store — steps already carry real, orchestrator-assigned ids and
 * id-based `dependencies` (never the planner's index-based
 * `dependsOnStepIndex`; see `ceo-planner-port.ts`). `delegatedTaskId` is
 * always `undefined` here even for what will become the approved,
 * eventually-delegated version — the store derives it at read time from
 * `ceo_delegation_links`, never storing it inside the version's own
 * immutable content. This is what keeps "the approved version becomes
 * immutable" (kickoff, "Plan editing") a structural guarantee rather than
 * a convention: nothing ever `UPDATE`s a `ceo_plan_versions` row after
 * its one `INSERT`.
 */
export type CeoPlanVersionContent = Pick<
  CeoPlanVersion,
  "objective" | "summary" | "assumptions" | "constraints"
> & {
  readonly steps: readonly Omit<CeoPlanStep, "delegatedTaskId">[];
};

export interface CreatePlanInput {
  readonly planId: string;
  readonly parentTaskId: string;
  readonly createdBy: CeoPlanActor;
  readonly createdAt: string;
  readonly content: CeoPlanVersionContent;
  readonly contentHash: string;
}

export interface CreateVersionInput {
  readonly planId: string;
  readonly expectedRevision: number;
  readonly createdBy: CeoPlanActor;
  readonly createdAt: string;
  readonly content: CeoPlanVersionContent;
  readonly contentHash: string;
}

export interface SubmitInput {
  readonly planId: string;
  readonly expectedRevision: number;
}

/**
 * Binds a decision to the exact `(planId, version, contentHash)` triple
 * the operator actually saw (kickoff, "Plan versioning," item 5) — the
 * store re-verifies `planVersion` is still the plan's `activeVersion` and
 * `contentHash` still matches that version's own stored hash, inside the
 * same fenced write as recording the decision, and throws
 * `CeoPlanApprovalBindingError` if either has moved. Never trusts
 * `contentHash` as authoritative on its own (kickoff, item 9) — it is
 * checked against, never substituted for, the store's own value.
 */
export interface DecideApprovalInput {
  readonly planId: string;
  readonly expectedRevision: number;
  readonly planVersion: number;
  readonly contentHash: string;
  readonly decision: CeoApprovalDecision;
  readonly operatorNote: string | undefined;
  readonly decidedAt: string;
}

export interface CancelInput {
  readonly planId: string;
  readonly expectedRevision: number;
}

export interface DeletePlanInput {
  readonly planId: string;
  readonly expectedRevision: number;
}

export interface DelegationLinkInput {
  readonly stepId: string;
  readonly childTaskId: string;
  readonly adapterId: string;
}

/** Same version/hash binding discipline as `DecideApprovalInput` — delegation re-verifies both before writing a single link. */
export interface RecordDelegationInput {
  readonly planId: string;
  readonly expectedRevision: number;
  readonly approvedVersion: number;
  readonly approvedContentHash: string;
  readonly links: readonly DelegationLinkInput[];
  readonly delegatedAt: string;
}

export interface DelegationLink {
  readonly planId: string;
  readonly planVersion: number;
  readonly stepId: string;
  readonly childTaskId: string;
  readonly adapterId: string;
  readonly delegatedAt: string;
}

/**
 * Phase 14.1 — the idempotent progress synchronizer's one atomic write:
 * updates the plan's private fingerprint and appends exactly one event,
 * optionally also transitioning the plan to a terminal status in the
 * same write. `now` is always the event's own timestamp, and — only when
 * `newStatus` is present — also the plan's `completedAt`/`updatedAt`.
 * CAS'd on `expectedRevision` exactly like every other mutating method
 * here; the caller (`synchronizePlanProgress`) always supplies a
 * revision it just read with no `await` gap before this call. Replaces
 * the old Phase 14 `markCompleted`/`markFailed` methods (removed) —
 * every terminal transition now goes through this one fingerprint-aware
 * path, so there is exactly one way a plan ever reaches `completed`/
 * `failed`, never two independent, semantically-overlapping ones.
 */
export interface SyncProgressInput {
  readonly planId: string;
  readonly expectedRevision: number;
  readonly fingerprint: string;
  readonly now: string;
  readonly eventType: "ceo.plan.progress_changed" | "ceo.plan.completed" | "ceo.plan.failed";
  readonly eventPayload: Record<string, string | number | boolean | null>;
  readonly newStatus?: "completed" | "failed";
}

/**
 * Everything `ceo-plan-orchestrator.ts` and the CEO plan routes need from
 * a plan store — the CEO-plan analogue of `TaskStorePort`/
 * `ComparisonStorePort` (Phase 13). `InMemoryCeoPlanStore` and
 * `SqliteCeoPlanStore` both satisfy this identically; composition picks
 * one based on whether `--data-dir` was supplied, exactly like every
 * other Phase 13/14 store. See
 * `docs/architecture/0014-ceo-planning-approval-and-delegation.md`.
 */
export interface CeoPlanStorePort {
  createPlan(input: CreatePlanInput): { readonly plan: CeoPlan; readonly version: CeoPlanVersion };
  createVersion(input: CreateVersionInput): {
    readonly plan: CeoPlan;
    readonly version: CeoPlanVersion;
  };
  submit(input: SubmitInput): CeoPlan;
  decideApproval(input: DecideApprovalInput): {
    readonly plan: CeoPlan;
    readonly approval: CeoApproval;
  };
  cancel(input: CancelInput): CeoPlan;
  deletePlan(input: DeletePlanInput): void;
  recordDelegation(input: RecordDelegationInput): {
    readonly plan: CeoPlan;
    readonly links: readonly DelegationLink[];
  };
  /** Phase 14.1 — see `SyncProgressInput`'s doc comment. */
  syncProgress(input: SyncProgressInput): { readonly plan: CeoPlan; readonly event: CeoPlanEvent };

  getPlan(planId: string): CeoPlan;
  listPlans(): readonly CeoPlan[];
  listPlansForParentTask(parentTaskId: string): readonly CeoPlan[];
  getVersion(planId: string, version: number): CeoPlanVersion;
  listVersions(planId: string): readonly CeoPlanVersion[];
  listApprovals(planId: string): readonly CeoApproval[];
  listDelegationLinks(planId: string): readonly DelegationLink[];
  /** Private — never returned by a route; used only by the orchestrator for optimistic-concurrency CAS. */
  getRevision(planId: string): number;
  /** Private — never returned by a route; used only by `synchronizePlanProgress` to decide whether progress genuinely changed since the last sync. `undefined` means "never synced." */
  getLastProgressFingerprint(planId: string): string | undefined;
  /**
   * Phase 14.1 — O(1) reverse lookup from a delegated child task back to
   * the plan that delegated it, used by the task-mutation hook
   * (`task-mutation-hook.ts`) to decide whether a task mutation is even
   * relevant to any CEO plan before doing any real work. `undefined` for
   * any task not currently linked as a delegated child of any plan.
   */
  findPlanIdByChildTaskId(childTaskId: string): string | undefined;

  appendEvent(
    planId: string,
    type: CeoPlanEventType,
    payload: Record<string, string | number | boolean | null>,
    createdAt: string,
  ): CeoPlanEvent;
  listEvents(planId: string, afterSequence?: number): readonly CeoPlanEvent[];
}

/** Re-exported for callers that only need the status enum without importing the whole protocol surface. */
export type { CeoPlanStatus };
