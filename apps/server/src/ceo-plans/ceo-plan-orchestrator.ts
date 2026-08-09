import { randomUUID } from "node:crypto";
import type { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import {
  parseHallTask,
  type CeoApproval,
  type CeoApprovalDecision,
  type CeoPlan,
  type CeoPlanActor,
  type CeoPlanVersion,
  type CommunicationAuthor,
  type CommunicationMessage,
  type CommunicationMessageReference,
} from "@hall-of-wisdom/protocol";
import type { TaskRecord } from "../tasks/task-record.js";
import type { TaskStorePort } from "../tasks/task-store-port.js";
import type { BoardStorePort } from "../boards/board-store-port.js";
import type { MessageStorePort } from "../boards/message-store-port.js";
import type { MessageBus } from "../boards/message-bus.js";
import { detectRoutingCandidates } from "../routing/candidate-detection.js";
import { evaluateCandidateEligibility } from "../routing/routing-policy.js";
import {
  CeoPlanDelegationBlockedError,
  CeoPlanMutationTokenInvalidError,
  CeoPlanStateConflictError,
  CeoPlanStepAdapterInvalidError,
  CeoPlanningBlockedError,
} from "../errors/app-error.js";
import type { CeoPlanStorePort, DelegationLink } from "./ceo-plan-store-port.js";
import type { CeoPlannerPort } from "./ceo-planner-port.js";
import { recommendStepAdapter } from "./ceo-plan-routing.js";
import { computeCeoPlanContentHash } from "./ceo-plan-content-hash.js";
import type { CeoPlanEventBus } from "./ceo-plan-events.js";
import type { CeoPlanMutationTokenIssuer } from "./ceo-plan-mutation-token.js";
import { deriveCeoPlanProgress, type CeoPlanProgressSummary } from "./ceo-plan-progress.js";
import { synchronizePlanProgress } from "./ceo-plan-progress-sync.js";

const CEO_AGENT_AUTHOR: CommunicationAuthor = { kind: "system", displayName: "CEO Agent" };

export interface CeoPlanOrchestratorOptions {
  readonly planStore: CeoPlanStorePort;
  readonly taskStore: TaskStorePort;
  readonly boardStore: BoardStorePort;
  readonly messageStore: MessageStorePort;
  readonly messageBus: MessageBus;
  readonly planEventBus: CeoPlanEventBus;
  readonly registry: AgentRegistry;
  readonly planner: CeoPlannerPort;
  /**
   * Durable mode: `(fn) => withTransaction(db, fn)`. Ephemeral mode:
   * `(fn) => fn()`. This is the one, narrow seam composition uses to give
   * this orchestrator atomic, fenced, multi-store writes without exposing
   * a generic transaction API to routes or browser input — see
   * `ceo-plan-composition.ts` and this class's own doc comment.
   */
  readonly runAtomicUnit: <T>(fn: () => T) => T;
  /** Phase 14.1 — issues/verifies the opaque public mutation token that replaced the plain `revision` integer. See `ceo-plan-mutation-token.ts`. */
  readonly mutationTokens: CeoPlanMutationTokenIssuer;
}

export interface EditedStepInput {
  readonly id: string;
  readonly position: number;
  readonly title: string;
  readonly objective: string;
  readonly boundedInstructions: string;
  readonly acceptanceCriteria: readonly string[];
  readonly dependencies: readonly string[];
  readonly requirements?: import("@hall-of-wisdom/protocol").TaskRequirements;
  readonly selectedAdapterId?: string;
}

export interface EditedPlanContentInput {
  readonly objective: string;
  readonly summary: string;
  readonly assumptions: readonly string[];
  readonly constraints: readonly string[];
  readonly steps: readonly EditedStepInput[];
}

export interface DelegateResult {
  readonly plan: CeoPlan;
  readonly links: readonly DelegationLink[];
  readonly childTasks: readonly TaskRecord[];
}

/**
 * The one orchestrator every CEO plan route depends on. Owns exactly the
 * sequencing this phase's kickoff requires — planner call, id assignment,
 * content hashing, store mutation, event append, bounded board audit
 * message, then (strictly after the mutation has committed) WebSocket
 * publication — and nothing else: it never starts an adapter, never
 * calls `startTask`, and the only place it ever creates a `TaskRecord` is
 * `delegate()`, always with `runId: undefined` (kickoff, "Delegation
 * means... Leave the child task unstarted"). See
 * `docs/architecture/0014-ceo-planning-approval-and-delegation.md`.
 */
export class CeoPlanOrchestrator {
  readonly #planStore: CeoPlanStorePort;
  readonly #taskStore: TaskStorePort;
  readonly #boardStore: BoardStorePort;
  readonly #messageStore: MessageStorePort;
  readonly #messageBus: MessageBus;
  readonly #planEventBus: CeoPlanEventBus;
  readonly #registry: AgentRegistry;
  readonly #planner: CeoPlannerPort;
  readonly #runAtomicUnit: <T>(fn: () => T) => T;
  readonly #mutationTokens: CeoPlanMutationTokenIssuer;

  constructor(options: CeoPlanOrchestratorOptions) {
    this.#planStore = options.planStore;
    this.#taskStore = options.taskStore;
    this.#boardStore = options.boardStore;
    this.#messageStore = options.messageStore;
    this.#messageBus = options.messageBus;
    this.#planEventBus = options.planEventBus;
    this.#registry = options.registry;
    this.#planner = options.planner;
    this.#runAtomicUnit = options.runAtomicUnit;
    this.#mutationTokens = options.mutationTokens;
  }

  /**
   * Verifies `token` against the plan's CURRENT revision (read fresh,
   * right here, with no `await` between this read and the caller's
   * subsequent store write) and returns that revision for the caller to
   * pass straight into the store's own CAS call. Must only ever be
   * called from inside the same synchronous `#runAtomicUnit` callback
   * that performs the actual write — calling it earlier, before an
   * `await`, would let the verified revision go stale before the write
   * happens, silently reducing the check to "was the token ever valid at
   * some point," not "is it valid right now." See
   * `ceo-plan-mutation-token.ts`'s doc comment.
   */
  #verifyMutationToken(planId: string, token: string): number {
    const currentRevision = this.#planStore.getRevision(planId);
    if (!this.#mutationTokens.verify(planId, currentRevision, token)) {
      throw new CeoPlanMutationTokenInvalidError(planId);
    }
    return currentRevision;
  }

  #postAuditMessage(
    parentTaskId: string,
    text: string,
    now: string,
    reference?: CommunicationMessageReference,
  ): CommunicationMessage {
    const { board, created } = this.#boardStore.ensureTaskBoard(parentTaskId, now);
    if (created) this.#messageStore.registerBoard(board.boardId);
    const message = this.#messageStore.append(board.boardId, {
      messageId: randomUUID(),
      boardId: board.boardId,
      author: CEO_AGENT_AUTHOR,
      text,
      ...(reference !== undefined ? { reference } : {}),
      createdAt: now,
    });
    this.#boardStore.recordMessageAppended(board.boardId, message.sequence + 1, now);
    return message;
  }

  #publishAfterCommit(
    planId: string,
    event: import("@hall-of-wisdom/protocol").CeoPlanEvent,
    message?: CommunicationMessage,
  ): void {
    this.#planEventBus.publish(planId, event);
    if (message !== undefined) this.#messageBus.publish(message.boardId, message);
  }

  /**
   * Runs a synchronous body but always returns a `Promise` that *rejects*
   * (never throws synchronously) on failure — every mutating method on
   * this class is expected to behave like every other async orchestrator
   * method in this codebase (`TaskOrchestrator`, `ComparisonOrchestrator`):
   * a caller doing `await orchestrator.foo()` or
   * `expect(orchestrator.foo()).rejects.toThrow()` must never have to
   * special-case "this particular method happens to throw synchronously
   * because it has no `await` inside." Found by this module's own test
   * suite: `submit`/`decideApproval`/`cancel` originally threw
   * synchronously (no `async` keyword, since they have no `await`), which
   * silently broke exactly this convention.
   */
  #toPromise<T>(fn: () => T): Promise<T> {
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Phase 14, plan generation: never creates a child task, never assigns
   * an adapter, never starts one — reads the parent task and current
   * adapter capabilities, hands both to the planner, and persists exactly
   * what the planner returned (or throws `CeoPlanningBlockedError` if the
   * planner declined). `detectRoutingCandidates` runs once, before any
   * store write, so a slow/failing adapter's `detect()` can never leave a
   * partially-created plan behind.
   */
  async createPlan(
    parentTaskId: string,
    planningInstructions: string | undefined,
  ): Promise<{ readonly plan: CeoPlan; readonly version: CeoPlanVersion }> {
    const parent = this.#taskStore.get(parentTaskId);
    const candidates = await detectRoutingCandidates(this.#registry);
    const result = this.#planner.generatePlan({
      parentTask: parent.task,
      routingCandidates: candidates,
      planningInstructions,
    });
    if (result.kind === "blocked") {
      throw new CeoPlanningBlockedError(result.reason);
    }

    const stepIds = result.draft.steps.map(() => randomUUID());
    const content = {
      objective: result.draft.objective,
      summary: result.draft.summary,
      assumptions: [...result.draft.assumptions],
      constraints: [...result.draft.constraints],
      steps: result.draft.steps.map((step, index) => ({
        id: stepIds[index] as string,
        position: index,
        title: step.title,
        objective: step.objective,
        boundedInstructions: step.boundedInstructions,
        acceptanceCriteria: [...step.acceptanceCriteria],
        dependencies: step.dependsOnStepIndex.map((depIndex) => stepIds[depIndex] as string),
        ...(step.requirements !== undefined ? { requirements: step.requirements } : {}),
        ...(step.recommendedAdapterId !== undefined
          ? { recommendedAdapterId: step.recommendedAdapterId }
          : {}),
        routingSummary: step.routingSummary,
      })),
    };
    const contentHash = computeCeoPlanContentHash(content);
    const planId = randomUUID();
    const now = new Date().toISOString();

    const outcome = this.#runAtomicUnit(() => {
      const { plan, version } = this.#planStore.createPlan({
        planId,
        parentTaskId,
        createdBy: "ceo_planner",
        createdAt: now,
        content,
        contentHash,
      });
      const event = this.#planStore.appendEvent(
        planId,
        "ceo.plan.created",
        { version: 1, stepCount: version.steps.length },
        now,
      );
      const message = this.#postAuditMessage(
        parentTaskId,
        `Plan created · ${String(version.steps.length)} ${version.steps.length === 1 ? "step" : "steps"} · Draft`,
        now,
        { kind: "ceo_plan_created", planId, stepCount: version.steps.length },
      );
      return { plan, version, event, message };
    });

    this.#publishAfterCommit(planId, outcome.event, outcome.message);
    return { plan: outcome.plan, version: outcome.version };
  }

  /**
   * Phase 14, plan editing: allowed only from `draft` or `rejected`
   * (kickoff, "Plan Editing": "The operator must be able to revise a
   * draft or rejected plan"). Recommendations are freshly recomputed for
   * every step via the same `recommendStepAdapter` the planner itself
   * uses; an operator-supplied `selectedAdapterId` override is persisted
   * as given (delegation-time revalidation, not this method, is what
   * ultimately decides whether it is honored — kickoff: "Planning-time
   * recommendations are advisory. Delegation-time eligibility is
   * authoritative").
   */
  async createVersion(
    planId: string,
    expectedMutationToken: string,
    input: EditedPlanContentInput,
    actor: CeoPlanActor,
  ): Promise<{ readonly plan: CeoPlan; readonly version: CeoPlanVersion }> {
    const plan = this.#planStore.getPlan(planId);
    const parent = this.#taskStore.get(plan.parentTaskId);
    const candidates = await detectRoutingCandidates(this.#registry);

    const content = {
      objective: input.objective,
      summary: input.summary,
      assumptions: [...input.assumptions],
      constraints: [...input.constraints],
      steps: input.steps.map((step) => {
        const routing = recommendStepAdapter(step.requirements, candidates);
        return {
          id: step.id,
          position: step.position,
          title: step.title,
          objective: step.objective,
          boundedInstructions: step.boundedInstructions,
          acceptanceCriteria: [...step.acceptanceCriteria],
          dependencies: [...step.dependencies],
          ...(step.requirements !== undefined ? { requirements: step.requirements } : {}),
          ...(routing.recommendedAdapterId !== undefined
            ? { recommendedAdapterId: routing.recommendedAdapterId }
            : {}),
          ...(step.selectedAdapterId !== undefined
            ? { selectedAdapterId: step.selectedAdapterId }
            : {}),
          routingSummary: routing.routingSummary,
        };
      }),
    };

    // Phase 14.1 — server-side trust boundary: a saved `selectedAdapterId`
    // override must already be a registered, eligible adapter at
    // version-creation time, not just at delegation time. This is what
    // lets the web adapter selector (Task 9) be display-only — the
    // browser cannot persist an override that could never actually
    // delegate. `CeoPlanDelegationBlockedError` (thrown later, from
    // `delegate()`) covers the separate case of eligibility drifting
    // *after* a version was validly saved.
    for (const step of content.steps) {
      if (step.selectedAdapterId === undefined) continue;
      const candidate = candidates.find((c) => c.adapterId === step.selectedAdapterId);
      if (candidate === undefined) {
        throw new CeoPlanStepAdapterInvalidError(
          planId,
          step.id,
          `adapter "${step.selectedAdapterId}" is not currently registered.`,
        );
      }
      if (step.requirements !== undefined) {
        const eligibility = evaluateCandidateEligibility(step.requirements, candidate);
        if (!eligibility.eligible) {
          throw new CeoPlanStepAdapterInvalidError(
            planId,
            step.id,
            `adapter "${step.selectedAdapterId}" does not satisfy this step's requirements: ${eligibility.safeReason}`,
          );
        }
      }
    }

    const contentHash = computeCeoPlanContentHash(content);
    const now = new Date().toISOString();

    const outcome = this.#runAtomicUnit(() => {
      // Verified here, immediately before the store write, with no
      // `await` gap after this point — see `#verifyMutationToken`'s doc
      // comment. `createVersion` has real `await`s above (detecting
      // routing candidates), so verifying any earlier would let the
      // checked revision go stale before the write.
      const expectedRevision = this.#verifyMutationToken(planId, expectedMutationToken);
      const { plan: updatedPlan, version } = this.#planStore.createVersion({
        planId,
        expectedRevision,
        createdBy: actor,
        createdAt: now,
        content,
        contentHash,
      });
      const event = this.#planStore.appendEvent(
        planId,
        "ceo.plan.version_created",
        { version: version.version, stepCount: version.steps.length },
        now,
      );
      return { plan: updatedPlan, version, event };
    });
    void parent; // parent task is fetched only to confirm it still exists — see the doc comment above.

    this.#publishAfterCommit(planId, outcome.event);
    return { plan: outcome.plan, version: outcome.version };
  }

  /**
   * Not `async` (no `await` inside — this is a single synchronous atomic
   * store operation) but still returns a `Promise`, matching every other
   * mutating method on this class so callers (routes) can `await` all of
   * them uniformly without needing to know which ones happen to involve
   * I/O.
   */
  submit(planId: string, expectedMutationToken: string): Promise<CeoPlan> {
    return this.#toPromise(() => {
      const now = new Date().toISOString();
      const outcome = this.#runAtomicUnit(() => {
        const expectedRevision = this.#verifyMutationToken(planId, expectedMutationToken);
        const plan = this.#planStore.submit({ planId, expectedRevision });
        const event = this.#planStore.appendEvent(
          planId,
          "ceo.plan.submitted",
          { version: plan.activeVersion },
          now,
        );
        const message = this.#postAuditMessage(
          plan.parentTaskId,
          `CEO plan ${planId} version ${String(plan.activeVersion)} submitted for approval.`,
          now,
        );
        return { plan, event, message };
      });
      this.#publishAfterCommit(planId, outcome.event, outcome.message);
      return outcome.plan;
    });
  }

  decideApproval(
    planId: string,
    expectedMutationToken: string,
    planVersion: number,
    contentHash: string,
    decision: CeoApprovalDecision,
    operatorNote: string | undefined,
  ): Promise<{ readonly plan: CeoPlan; readonly approval: CeoApproval }> {
    return this.#toPromise(() => {
      const now = new Date().toISOString();
      const outcome = this.#runAtomicUnit(() => {
        const expectedRevision = this.#verifyMutationToken(planId, expectedMutationToken);
        const { plan, approval } = this.#planStore.decideApproval({
          planId,
          expectedRevision,
          planVersion,
          contentHash,
          decision,
          operatorNote,
          decidedAt: now,
        });
        const event = this.#planStore.appendEvent(
          planId,
          decision === "approve" ? "ceo.plan.approved" : "ceo.plan.rejected",
          { version: planVersion },
          now,
        );
        const message = this.#postAuditMessage(
          plan.parentTaskId,
          `CEO plan ${planId} version ${String(planVersion)} ${decision === "approve" ? "approved" : "rejected"}.`,
          now,
        );
        return { plan, approval, event, message };
      });
      this.#publishAfterCommit(planId, outcome.event, outcome.message);
      return { plan: outcome.plan, approval: outcome.approval };
    });
  }

  cancel(planId: string, expectedMutationToken: string): Promise<CeoPlan> {
    return this.#toPromise(() => {
      const now = new Date().toISOString();
      const outcome = this.#runAtomicUnit(() => {
        const expectedRevision = this.#verifyMutationToken(planId, expectedMutationToken);
        const plan = this.#planStore.cancel({ planId, expectedRevision });
        const event = this.#planStore.appendEvent(planId, "ceo.plan.cancelled", {}, now);
        return { plan, event };
      });
      this.#publishAfterCommit(planId, outcome.event);
      return outcome.plan;
    });
  }

  /**
   * Phase 14, delegation — kickoff, "Delegation semantics": everything
   * that can be checked asynchronously (adapter re-detection, per-step
   * eligibility, parent-task existence) runs *before* the atomic unit
   * opens, because `withTransaction`'s `fn` must be synchronous
   * (`persistence/transaction.ts`'s doc comment). The atomic unit itself
   * re-reads the plan's live status/version/hash/revision one more time
   * and creates every child task, the delegation links, the
   * `ceo.plan.delegated` event, and the board audit message as one
   * fenced write spanning `TaskStore`, `CeoPlanStorePort`, and
   * `BoardStorePort`/`MessageStorePort` — safe because `withTransaction`
   * is reentrant (Phase 14's change to `transaction.ts`): every one of
   * those stores' own public methods already opens its own
   * `withTransaction`, so calling them from inside this method's outer
   * `runAtomicUnit` just makes them participate in the same physical
   * transaction via `SAVEPOINT`. If any check fails, zero child tasks and
   * zero links are created — see `CeoPlanDelegationBlockedError`.
   */
  async delegate(planId: string, expectedMutationToken: string): Promise<DelegateResult> {
    const plan = this.#planStore.getPlan(planId);
    if (plan.status !== "approved") {
      throw new CeoPlanStateConflictError(planId, plan.status, "delegated");
    }
    const version = this.#planStore.getVersion(planId, plan.activeVersion);
    const parent = this.#taskStore.get(plan.parentTaskId);
    if (parent.task.status === "cancelled") {
      throw new CeoPlanDelegationBlockedError(planId, "The parent task has been cancelled.");
    }
    if (this.#taskStore.remainingCapacity() < version.steps.length) {
      throw new CeoPlanDelegationBlockedError(
        planId,
        "The server's configured task capacity would be exceeded by this delegation.",
      );
    }

    const candidates = await detectRoutingCandidates(this.#registry);
    const resolvedByStepId = new Map<
      string,
      { adapterId: string; agentId: string; executionTrust: string }
    >();
    for (const step of version.steps) {
      const chosenAdapterId = step.selectedAdapterId ?? step.recommendedAdapterId;
      if (chosenAdapterId === undefined) {
        throw new CeoPlanDelegationBlockedError(
          planId,
          `Step "${step.id}" has no selected or recommended adapter.`,
        );
      }
      const candidate = candidates.find((c) => c.adapterId === chosenAdapterId);
      if (candidate === undefined) {
        throw new CeoPlanDelegationBlockedError(
          planId,
          `Step "${step.id}"'s adapter "${chosenAdapterId}" is not currently registered.`,
        );
      }
      if (step.requirements !== undefined) {
        const eligibility = evaluateCandidateEligibility(step.requirements, candidate);
        if (!eligibility.eligible) {
          throw new CeoPlanDelegationBlockedError(
            planId,
            `Step "${step.id}"'s adapter is no longer eligible: ${eligibility.safeReason}`,
          );
        }
      } else if (candidate.availability !== "available") {
        throw new CeoPlanDelegationBlockedError(
          planId,
          `Step "${step.id}"'s adapter "${chosenAdapterId}" is not currently available.`,
        );
      }
      const resolvedAdapter = this.#registry.resolve(chosenAdapterId);
      resolvedByStepId.set(step.id, {
        adapterId: chosenAdapterId,
        agentId: resolvedAdapter.descriptor.supportedAgent.agentId,
        executionTrust: candidate.executionTrust,
      });
    }

    const childTaskIdByStepId = new Map<string, string>(
      version.steps.map((step) => [step.id, randomUUID()]),
    );
    const now = new Date().toISOString();

    const outcome = this.#runAtomicUnit(() => {
      const freshPlan = this.#planStore.getPlan(planId);
      if (freshPlan.status !== "approved" || freshPlan.activeVersion !== plan.activeVersion) {
        throw new CeoPlanStateConflictError(planId, freshPlan.status, "delegated");
      }
      const freshVersion = this.#planStore.getVersion(planId, freshPlan.activeVersion);
      if (freshVersion.contentHash !== version.contentHash) {
        throw new CeoPlanStateConflictError(planId, freshPlan.status, "delegated");
      }
      // Verified here, not before the `await`s above — see
      // `#verifyMutationToken`'s doc comment.
      const expectedRevision = this.#verifyMutationToken(planId, expectedMutationToken);

      const childTasks: TaskRecord[] = [];
      for (const step of freshVersion.steps) {
        const childTaskId = childTaskIdByStepId.get(step.id);
        const resolved = resolvedByStepId.get(step.id);
        if (childTaskId === undefined || resolved === undefined) {
          // Unreachable: both maps are built from this same freshVersion's
          // step ids just above — guards the invariant defensively rather
          // than asserting with `!`.
          throw new CeoPlanDelegationBlockedError(
            planId,
            `Step "${step.id}" could not be resolved.`,
          );
        }
        const dependencyTaskIds = step.dependencies
          .map((depStepId) => childTaskIdByStepId.get(depStepId))
          .filter((id): id is string => id !== undefined);
        const description = [
          step.objective,
          "",
          `Instructions: ${step.boundedInstructions}`,
          "",
          `Acceptance criteria:\n- ${step.acceptanceCriteria.join("\n- ")}`,
        ].join("\n");
        const hallTask = parseHallTask({
          taskId: childTaskId,
          projectId: parent.task.projectId,
          title: step.title,
          description,
          priority: parent.task.priority,
          status: "assigned",
          dependencyTaskIds,
          createdAt: now,
          updatedAt: now,
          ...(step.requirements !== undefined ? { requirements: step.requirements } : {}),
        });
        const record: TaskRecord = {
          task: hallTask,
          runId: undefined,
          adapterId: resolved.adapterId,
          agentId: resolved.agentId,
          eventCount: 0,
          lastSequence: undefined,
          terminalEventType: undefined,
          failure: undefined,
          cancellationRequested: false,
          createdAt: now,
          startedAt: undefined,
          completedAt: undefined,
          assignedExecutionTrust: resolved.executionTrust as TaskRecord["assignedExecutionTrust"],
        };
        this.#taskStore.add(record);
        this.#taskStore.setWorkingDirectory(childTaskId, undefined);
        childTasks.push(record);
      }

      const delegationLinkInputs: { stepId: string; childTaskId: string; adapterId: string }[] = [];
      for (const step of freshVersion.steps) {
        const childTaskId = childTaskIdByStepId.get(step.id);
        const resolved = resolvedByStepId.get(step.id);
        if (childTaskId === undefined || resolved === undefined) {
          // Unreachable: both maps are built from this same freshVersion's
          // step ids just above.
          throw new CeoPlanDelegationBlockedError(
            planId,
            `Step "${step.id}" could not be resolved.`,
          );
        }
        delegationLinkInputs.push({ stepId: step.id, childTaskId, adapterId: resolved.adapterId });
      }
      const { plan: delegatedPlan, links } = this.#planStore.recordDelegation({
        planId,
        expectedRevision,
        approvedVersion: freshPlan.activeVersion,
        approvedContentHash: freshVersion.contentHash,
        links: delegationLinkInputs,
        delegatedAt: now,
      });
      const event = this.#planStore.appendEvent(
        planId,
        "ceo.plan.delegated",
        { stepCount: freshVersion.steps.length },
        now,
      );
      const message = this.#postAuditMessage(
        parent.task.taskId,
        `CEO plan ${planId} delegated: ${String(freshVersion.steps.length)} child task(s) created.`,
        now,
      );
      return { plan: delegatedPlan, links, childTasks, event, message };
    });

    this.#publishAfterCommit(planId, outcome.event, outcome.message);
    return { plan: outcome.plan, links: outcome.links, childTasks: outcome.childTasks };
  }

  getPlan(planId: string): CeoPlan {
    return this.#planStore.getPlan(planId);
  }

  /**
   * Phase 14.1 — the public replacement for the old `getRevision`. Never
   * returns the internal plan-level revision integer itself (that stays
   * behind `#planStore.getRevision`, used only internally by
   * `#verifyMutationToken`) — issues an opaque token bound to the
   * current revision instead. Exposed only via `GET
   * /api/v1/ceo-plans/:planId` (see `routes/ceo-plans.ts`) — a browser
   * that lands cold on a plan's detail page has no other way to learn
   * the value it must echo back as `expectedMutationToken` on its first
   * mutating call. See `ceo-plan-mutation-token.ts`.
   */
  getMutationToken(planId: string): string {
    return this.#mutationTokens.issue(planId, this.#planStore.getRevision(planId));
  }

  listPlans(): readonly CeoPlan[] {
    return this.#planStore.listPlans();
  }

  listPlansForParentTask(parentTaskId: string): readonly CeoPlan[] {
    return this.#planStore.listPlansForParentTask(parentTaskId);
  }

  getVersion(planId: string, version: number): CeoPlanVersion {
    return this.#planStore.getVersion(planId, version);
  }

  listVersions(planId: string): readonly CeoPlanVersion[] {
    return this.#planStore.listVersions(planId);
  }

  listApprovals(planId: string): readonly CeoApproval[] {
    return this.#planStore.listApprovals(planId);
  }

  listDelegationLinks(planId: string): readonly DelegationLink[] {
    return this.#planStore.listDelegationLinks(planId);
  }

  listEvents(planId: string, afterSequence?: number) {
    return this.#planStore.listEvents(planId, afterSequence);
  }

  /**
   * Phase 14.1 — pure replacement for the old Phase 14 `refreshProgress`'s
   * read half. Derives current progress from the plan's live, linked
   * child tasks (`ceo-plan-progress.ts`) and returns it — never writes to
   * any store, never appends an event, never syncs the plan's own status.
   * Safe to call from a GET route (spec §6: "GETs must not mutate
   * storage"). A plan not yet delegated (and never having been) reports
   * empty progress; a plan that is delegated or has already reached a
   * terminal state reports progress derived fresh from its linked
   * children's live status.
   */
  getPlanWithProgress(planId: string): {
    readonly plan: CeoPlan;
    readonly progress: CeoPlanProgressSummary;
  } {
    const plan = this.#planStore.getPlan(planId);
    if (plan.status !== "delegated" && plan.status !== "completed" && plan.status !== "failed") {
      return {
        plan,
        progress: {
          totalSteps: 0,
          completed: 0,
          running: 0,
          failed: 0,
          cancelled: 0,
          blocked: 0,
          notStarted: 0,
          steps: [],
        },
      };
    }
    const version = this.#planStore.getVersion(planId, plan.activeVersion);
    const links = this.#planStore.listDelegationLinks(planId);
    return { plan, progress: deriveCeoPlanProgress(version, links, this.#taskStore) };
  }

  /**
   * Phase 14.1 — mutating half of the old `refreshProgress`, replaced by
   * the idempotent, fingerprint-compared synchronizer
   * (`ceo-plan-progress-sync.ts`). Never called from a route — only by
   * `onChildTaskMutated` (the task-mutation hook's callback) and the
   * startup reconciliation pass (`ceo-plan-progress-reconciliation.ts`).
   */
  synchronizeProgress(planId: string): { readonly changed: boolean } {
    return synchronizePlanProgress(planId, {
      planStore: this.#planStore,
      taskStore: this.#taskStore,
      runAtomicUnit: this.#runAtomicUnit,
      planEventBus: this.#planEventBus,
    });
  }

  /**
   * Called by the task-mutation hook (`task-mutation-hook.ts`) after any
   * status-changing write to a task that may be a CEO plan's delegated
   * child — looks up whether it actually is one via the store's O(1)
   * reverse index, and if so runs the idempotent synchronizer. A no-op
   * for any task not currently linked to a delegated plan (in
   * particular: a plan's own child tasks, at the moment `delegate()`
   * creates them, are not yet linked — `recordDelegation` has not run
   * yet at that point in the same atomic unit — so this is naturally a
   * no-op during delegation itself, never firing mid-transaction for a
   * plan that doesn't exist as a committed delegation yet).
   */
  onChildTaskMutated(taskId: string): void {
    const planId = this.#planStore.findPlanIdByChildTaskId(taskId);
    if (planId === undefined) return;
    this.synchronizeProgress(planId);
  }

  subscribeToPlanEvents(
    planId: string,
    listener: (event: import("@hall-of-wisdom/protocol").CeoPlanEvent) => void,
  ): () => void {
    return this.#planEventBus.subscribe(planId, listener);
  }
}
