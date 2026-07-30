import { describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { MockAgentAdapter } from "@hall-of-wisdom/mock-agent";
import type { CeoPlanEvent } from "@hall-of-wisdom/protocol";
import { TaskStore } from "../tasks/task-store.js";
import { BoardStore } from "../boards/board-store.js";
import { MessageStore } from "../boards/message-store.js";
import { MessageBus } from "../boards/message-bus.js";
import { InMemoryCeoPlanStore } from "./in-memory-ceo-plan-store.js";
import { CeoPlanEventBus } from "./ceo-plan-events.js";
import { createScriptedCeoPlanner } from "./scripted-ceo-planner.js";
import { createDeterministicCeoPlanner } from "./deterministic-ceo-planner.js";
import { CeoPlanOrchestrator } from "./ceo-plan-orchestrator.js";
import { createCeoPlanMutationTokenIssuer } from "./ceo-plan-mutation-token.js";
import { createEphemeralAtomicUnit } from "./ephemeral-atomic-unit.js";
import {
  CeoPlanDelegationBlockedError,
  CeoPlanStateConflictError,
  CeoPlanStepAdapterInvalidError,
  CeoPlanningBlockedError,
} from "../errors/app-error.js";

function buildHarness(options: { plannerKind?: "scripted" | "deterministic" } = {}) {
  const registry = new AgentRegistry();
  registry.register(new MockAgentAdapter());
  const taskStore = new TaskStore({ maxTasks: 100 });
  const boardStore = new BoardStore({ maxBoards: 100, taskStore });
  const messageStore = new MessageStore({ maxMessagesPerBoard: 200 });
  const messageBus = new MessageBus({ maxSubscribersPerBoard: 20 });
  const planStore = new InMemoryCeoPlanStore();
  const planEventBus = new CeoPlanEventBus({ maxSubscribersPerPlan: 20 });
  const planner =
    options.plannerKind === "deterministic"
      ? createDeterministicCeoPlanner()
      : createScriptedCeoPlanner();

  const orchestrator = new CeoPlanOrchestrator({
    planStore,
    taskStore,
    boardStore,
    messageStore,
    messageBus,
    planEventBus,
    registry,
    planner,
    // Phase 14.1 — the real ephemeral atomic-unit coordinator, not a bare
    // `(fn) => fn()` passthrough, so this harness exercises the same
    // all-or-nothing rollback behavior real ephemeral composition uses.
    runAtomicUnit: createEphemeralAtomicUnit({ taskStore, boardStore, messageStore, planStore }),
    mutationTokens: createCeoPlanMutationTokenIssuer(),
  });

  const parentTaskId = "parent-task-1";
  taskStore.add({
    task: {
      taskId: parentTaskId,
      projectId: "project-1",
      title: "Parent task",
      description: "A real bug: the login redirect goes to /404 instead of /dashboard.",
      priority: "normal",
      status: "backlog",
      dependencyTaskIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      // Matches MockAgentAdapter's own detect() output (simulated,
      // structured.events/cancellation only) so the planner has enough
      // information to recommend an adapter without fabricating anything.
      requirements: { requiredCapabilities: [], allowedExecutionTrust: ["simulated"] },
    },
    runId: undefined,
    adapterId: undefined,
    agentId: undefined,
    eventCount: 0,
    lastSequence: undefined,
    terminalEventType: undefined,
    failure: undefined,
    cancellationRequested: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: undefined,
    completedAt: undefined,
    assignedExecutionTrust: undefined,
  });

  return {
    orchestrator,
    taskStore,
    boardStore,
    messageStore,
    messageBus,
    planStore,
    planEventBus,
    parentTaskId,
  };
}

describe("CeoPlanOrchestrator — plan generation", () => {
  it("creates a draft plan at version 1 and never creates a child task or assigns an adapter", async () => {
    const { orchestrator, taskStore, parentTaskId } = buildHarness();
    const before = taskStore.list().length;
    const { plan, version } = await orchestrator.createPlan(parentTaskId, undefined);
    expect(plan.status).toBe("draft");
    expect(plan.activeVersion).toBe(1);
    expect(version.steps.length).toBeGreaterThan(0);
    expect(taskStore.list().length).toBe(before);
    for (const step of version.steps) {
      expect(step.delegatedTaskId).toBeUndefined();
    }
  });

  it("posts a bounded board audit message and a plan event on creation", async () => {
    const { orchestrator, boardStore, messageStore, parentTaskId } = buildHarness();
    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    const events = orchestrator.listEvents(plan.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("ceo.plan.created");

    const board = boardStore.ensureTaskBoard(parentTaskId, "2026-01-01T00:00:00.000Z").board;
    const messages = messageStore.list(board.boardId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.author).toEqual({ kind: "system", displayName: "CEO Agent" });
    expect(messages[0]?.text).toContain(plan.id);
    // Never the full plan text, never a hash, never a path.
    expect(messages[0]?.text).not.toContain("boundedInstructions");
  });

  it("blocks with CeoPlanningBlockedError, creating no plan, when the parent task has no description", async () => {
    const { orchestrator, taskStore, planStore } = buildHarness({ plannerKind: "deterministic" });
    taskStore.add({
      task: {
        taskId: "empty-task",
        projectId: "project-1",
        title: "Empty",
        description: "",
        priority: "normal",
        status: "backlog",
        dependencyTaskIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      runId: undefined,
      adapterId: undefined,
      agentId: undefined,
      eventCount: 0,
      lastSequence: undefined,
      terminalEventType: undefined,
      failure: undefined,
      cancellationRequested: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: undefined,
      completedAt: undefined,
      assignedExecutionTrust: undefined,
    });
    await expect(orchestrator.createPlan("empty-task", undefined)).rejects.toThrow(
      CeoPlanningBlockedError,
    );
    expect(planStore.listPlansForParentTask("empty-task")).toHaveLength(0);
  });
});

describe("CeoPlanOrchestrator — approval gate", () => {
  it("submit and approve never create a child task; approval alone starts nothing", async () => {
    const { orchestrator, taskStore, parentTaskId } = buildHarness();
    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    const before = taskStore.list().length;

    const submitted = await orchestrator.submit(plan.id, orchestrator.getMutationToken(plan.id));
    expect(submitted.status).toBe("awaiting_approval");
    expect(taskStore.list().length).toBe(before);

    const version = orchestrator.getVersion(plan.id, 1);
    const { plan: approvedPlan } = await orchestrator.decideApproval(
      plan.id,
      orchestrator.getMutationToken(plan.id),
      1,
      version.contentHash,
      "approve",
      undefined,
    );
    expect(approvedPlan.status).toBe("approved");
    expect(taskStore.list().length).toBe(before);
  });

  it("rejection preserves plan/approval history and allows a later revision", async () => {
    const { orchestrator, parentTaskId } = buildHarness();
    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    await orchestrator.submit(plan.id, orchestrator.getMutationToken(plan.id));
    const version = orchestrator.getVersion(plan.id, 1);
    const { plan: rejected } = await orchestrator.decideApproval(
      plan.id,
      orchestrator.getMutationToken(plan.id),
      1,
      version.contentHash,
      "reject",
      "Not detailed enough.",
    );
    expect(rejected.status).toBe("rejected");
    expect(orchestrator.listApprovals(plan.id)).toHaveLength(1);

    const { plan: revised, version: v2 } = await orchestrator.createVersion(
      plan.id,
      orchestrator.getMutationToken(plan.id),
      {
        objective: version.objective,
        summary: "Revised: more detail.",
        assumptions: version.assumptions,
        constraints: version.constraints,
        steps: version.steps.map((step) => ({
          id: step.id,
          position: step.position,
          title: step.title,
          objective: step.objective,
          boundedInstructions: step.boundedInstructions,
          acceptanceCriteria: step.acceptanceCriteria,
          dependencies: step.dependencies,
          ...(step.requirements !== undefined ? { requirements: step.requirements } : {}),
        })),
      },
      "operator",
    );
    expect(revised.status).toBe("draft");
    expect(v2.version).toBe(2);
    // History is preserved.
    expect(orchestrator.getVersion(plan.id, 1).summary).toBe(version.summary);
  });

  it("an approval submitted for a version that is no longer active is rejected (edit invalidates approval)", async () => {
    const { orchestrator, parentTaskId } = buildHarness();
    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    await orchestrator.submit(plan.id, orchestrator.getMutationToken(plan.id));
    const v1 = orchestrator.getVersion(plan.id, 1);
    await orchestrator.decideApproval(
      plan.id,
      orchestrator.getMutationToken(plan.id),
      1,
      v1.contentHash,
      "reject",
      undefined,
    );
    await orchestrator.createVersion(
      plan.id,
      orchestrator.getMutationToken(plan.id),
      {
        objective: v1.objective,
        summary: "v2",
        assumptions: v1.assumptions,
        constraints: v1.constraints,
        steps: v1.steps.map((step) => ({
          id: step.id,
          position: step.position,
          title: step.title,
          objective: step.objective,
          boundedInstructions: step.boundedInstructions,
          acceptanceCriteria: step.acceptanceCriteria,
          dependencies: step.dependencies,
        })),
      },
      "operator",
    );
    await orchestrator.submit(plan.id, orchestrator.getMutationToken(plan.id));

    await expect(
      orchestrator.decideApproval(
        plan.id,
        orchestrator.getMutationToken(plan.id),
        1,
        v1.contentHash,
        "approve",
        undefined,
      ),
    ).rejects.toThrow();
  });
});

describe("CeoPlanOrchestrator — Phase 14.1 extended plan editing", () => {
  it("createVersion is allowed from awaiting_approval and resets the new version to draft, leaving the old approval binding unusable", async () => {
    const { orchestrator, parentTaskId } = buildHarness();
    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    await orchestrator.submit(plan.id, orchestrator.getMutationToken(plan.id));
    const v1 = orchestrator.getVersion(plan.id, 1);

    const { plan: revised, version: v2 } = await orchestrator.createVersion(
      plan.id,
      orchestrator.getMutationToken(plan.id),
      {
        objective: v1.objective,
        summary: "Edited while awaiting approval.",
        assumptions: v1.assumptions,
        constraints: v1.constraints,
        steps: v1.steps.map((step) => ({
          id: step.id,
          position: step.position,
          title: step.title,
          objective: step.objective,
          boundedInstructions: step.boundedInstructions,
          acceptanceCriteria: step.acceptanceCriteria,
          dependencies: step.dependencies,
          ...(step.requirements !== undefined ? { requirements: step.requirements } : {}),
        })),
      },
      "operator",
    );
    expect(revised.status).toBe("draft");
    expect(revised.activeVersion).toBe(2);
    expect(v2.version).toBe(2);
    // v1 remains readable, unchanged.
    expect(orchestrator.getVersion(plan.id, 1).summary).toBe(v1.summary);
    // Approving against the now-stale v1 binding fails.
    await expect(
      orchestrator.decideApproval(
        plan.id,
        orchestrator.getMutationToken(plan.id),
        1,
        v1.contentHash,
        "approve",
        undefined,
      ),
    ).rejects.toThrow();
  });

  it("createVersion is allowed from approved (but not yet delegated), resetting to draft", async () => {
    const { orchestrator, parentTaskId } = buildHarness();
    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    await orchestrator.submit(plan.id, orchestrator.getMutationToken(plan.id));
    const v1 = orchestrator.getVersion(plan.id, 1);
    await orchestrator.decideApproval(
      plan.id,
      orchestrator.getMutationToken(plan.id),
      1,
      v1.contentHash,
      "approve",
      undefined,
    );

    const { plan: revised } = await orchestrator.createVersion(
      plan.id,
      orchestrator.getMutationToken(plan.id),
      {
        objective: v1.objective,
        summary: "Edited after approval, before delegation.",
        assumptions: v1.assumptions,
        constraints: v1.constraints,
        steps: v1.steps.map((step) => ({
          id: step.id,
          position: step.position,
          title: step.title,
          objective: step.objective,
          boundedInstructions: step.boundedInstructions,
          acceptanceCriteria: step.acceptanceCriteria,
          dependencies: step.dependencies,
          ...(step.requirements !== undefined ? { requirements: step.requirements } : {}),
        })),
      },
      "operator",
    );
    expect(revised.status).toBe("draft");
  });

  it("createVersion is rejected once a plan is delegated — delegated plans remain immutable", async () => {
    const { orchestrator, parentTaskId } = buildHarness();
    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    await orchestrator.submit(plan.id, orchestrator.getMutationToken(plan.id));
    const v1 = orchestrator.getVersion(plan.id, 1);
    await orchestrator.decideApproval(
      plan.id,
      orchestrator.getMutationToken(plan.id),
      1,
      v1.contentHash,
      "approve",
      undefined,
    );
    await orchestrator.delegate(plan.id, orchestrator.getMutationToken(plan.id));

    await expect(
      orchestrator.createVersion(
        plan.id,
        orchestrator.getMutationToken(plan.id),
        {
          objective: v1.objective,
          summary: v1.summary,
          assumptions: v1.assumptions,
          constraints: v1.constraints,
          steps: v1.steps.map((step) => ({
            id: step.id,
            position: step.position,
            title: step.title,
            objective: step.objective,
            boundedInstructions: step.boundedInstructions,
            acceptanceCriteria: step.acceptanceCriteria,
            dependencies: step.dependencies,
            ...(step.requirements !== undefined ? { requirements: step.requirements } : {}),
          })),
        },
        "operator",
      ),
    ).rejects.toThrow(CeoPlanStateConflictError);
  });

  it("createVersion rejects a step whose selectedAdapterId is not a registered adapter", async () => {
    const { orchestrator, parentTaskId } = buildHarness();
    const { plan, version } = await orchestrator.createPlan(parentTaskId, undefined);

    await expect(
      orchestrator.createVersion(
        plan.id,
        orchestrator.getMutationToken(plan.id),
        {
          objective: version.objective,
          summary: version.summary,
          assumptions: version.assumptions,
          constraints: version.constraints,
          steps: version.steps.map((step, index) => ({
            id: step.id,
            position: step.position,
            title: step.title,
            objective: step.objective,
            boundedInstructions: step.boundedInstructions,
            acceptanceCriteria: step.acceptanceCriteria,
            dependencies: step.dependencies,
            ...(step.requirements !== undefined ? { requirements: step.requirements } : {}),
            ...(index === 0 ? { selectedAdapterId: "not-a-real-adapter" } : {}),
          })),
        },
        "operator",
      ),
    ).rejects.toThrow(CeoPlanStepAdapterInvalidError);
  });

  it("createVersion rejects a step whose selectedAdapterId does not satisfy its own requirements", async () => {
    const { orchestrator, parentTaskId } = buildHarness();
    const { plan, version } = await orchestrator.createPlan(parentTaskId, undefined);

    await expect(
      orchestrator.createVersion(
        plan.id,
        orchestrator.getMutationToken(plan.id),
        {
          objective: version.objective,
          summary: version.summary,
          assumptions: version.assumptions,
          constraints: version.constraints,
          steps: version.steps.map((step, index) => ({
            id: step.id,
            position: step.position,
            title: step.title,
            objective: step.objective,
            boundedInstructions: step.boundedInstructions,
            acceptanceCriteria: step.acceptanceCriteria,
            dependencies: step.dependencies,
            ...(index === 0
              ? {
                  requirements: {
                    requiredCapabilities: ["project.edit"],
                    allowedExecutionTrust: ["isolated" as const],
                  },
                  selectedAdapterId: "hall.mock-agent",
                }
              : step.requirements !== undefined
                ? { requirements: step.requirements }
                : {}),
          })),
        },
        "operator",
      ),
    ).rejects.toThrow(CeoPlanStepAdapterInvalidError);
  });

  it("delegation only ever uses the adapter approved in the exact version — editing an approved plan resets it to draft, which cannot be delegated until re-approved", async () => {
    const { orchestrator, parentTaskId } = buildHarness();
    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    await orchestrator.submit(plan.id, orchestrator.getMutationToken(plan.id));
    const v1 = orchestrator.getVersion(plan.id, 1);
    await orchestrator.decideApproval(
      plan.id,
      orchestrator.getMutationToken(plan.id),
      1,
      v1.contentHash,
      "approve",
      undefined,
    );
    expect(orchestrator.getPlan(plan.id).status).toBe("approved");

    // Editing the now-approved plan (Task 2's newly allowed source
    // status) resets it to draft — there is no server-side path that
    // lets a browser change v1's recorded adapter and then still
    // delegate v1 itself; any edit always produces a new version that
    // must go through submit -> approve again before it can ever be
    // delegated, so delegation can never use an adapter other than the
    // one the exact approved version recorded.
    const { plan: revised } = await orchestrator.createVersion(
      plan.id,
      orchestrator.getMutationToken(plan.id),
      {
        objective: v1.objective,
        summary: v1.summary,
        assumptions: v1.assumptions,
        constraints: v1.constraints,
        steps: v1.steps.map((step) => ({
          id: step.id,
          position: step.position,
          title: step.title,
          objective: step.objective,
          boundedInstructions: step.boundedInstructions,
          acceptanceCriteria: step.acceptanceCriteria,
          dependencies: step.dependencies,
          ...(step.requirements !== undefined ? { requirements: step.requirements } : {}),
        })),
      },
      "operator",
    );
    expect(revised.status).toBe("draft");

    await expect(
      orchestrator.delegate(plan.id, orchestrator.getMutationToken(plan.id)),
    ).rejects.toThrow(CeoPlanStateConflictError);
  });
});

describe("CeoPlanOrchestrator — delegation", () => {
  async function approvedPlan(harness: ReturnType<typeof buildHarness>) {
    const { orchestrator, parentTaskId } = harness;
    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    await orchestrator.submit(plan.id, orchestrator.getMutationToken(plan.id));
    const version = orchestrator.getVersion(plan.id, 1);
    const { plan: approved } = await orchestrator.decideApproval(
      plan.id,
      orchestrator.getMutationToken(plan.id),
      1,
      version.contentHash,
      "approve",
      undefined,
    );
    return { plan: approved, version };
  }

  it("delegation creates exactly one unstarted child task per step, correctly linked and assigned, and posts an audit message", async () => {
    const harness = buildHarness();
    const { orchestrator, taskStore } = harness;
    const { plan, version } = await approvedPlan(harness);

    const result = await orchestrator.delegate(plan.id, orchestrator.getMutationToken(plan.id));
    expect(result.plan.status).toBe("delegated");
    expect(result.childTasks).toHaveLength(version.steps.length);
    expect(result.links).toHaveLength(version.steps.length);

    for (const childTask of result.childTasks) {
      expect(childTask.runId).toBeUndefined();
      expect(childTask.task.status).toBe("assigned");
      expect(childTask.adapterId).toBeDefined();
    }
    // Every link references a real, existing task.
    for (const link of result.links) {
      expect(() => taskStore.get(link.childTaskId)).not.toThrow();
    }

    const events = orchestrator.listEvents(plan.id);
    expect(events.some((e) => e.type === "ceo.plan.delegated")).toBe(true);
  });

  it("Phase 14.1: ephemeral mode — a subscriber never observes a ceo.plan.delegated event, and no child task or audit message survives, for a delegation that fails partway through", async () => {
    const harness = buildHarness();
    const { orchestrator, taskStore, boardStore, messageStore, parentTaskId } = harness;
    const { plan, version } = await approvedPlan(harness);
    expect(version.steps.length).toBeGreaterThanOrEqual(2);

    const received: string[] = [];
    orchestrator.subscribeToPlanEvents(plan.id, (event) => received.push(event.type));
    const taskCountBeforeDelegation = taskStore.list().length; // includes the parent task the harness seeds
    // The task board already exists (plan creation posts its own audit
    // message there) — capture its message count before the failed
    // delegation attempt, so the assertion below proves the delegation's
    // OWN audit-message write rolled back, not that the board is new.
    const messageCountBeforeDelegation = messageStore.list(`task:${parentTaskId}`).length;

    let calls = 0;
    const addSpy = vi.spyOn(taskStore, "add").mockImplementation(function (
      this: typeof taskStore,
      ...args: Parameters<typeof taskStore.add>
    ) {
      calls += 1;
      if (calls === 2) throw new Error("injected failure while linking the final step");
      TaskStore.prototype.add.apply(this, args);
    });

    await expect(
      orchestrator.delegate(plan.id, orchestrator.getMutationToken(plan.id)),
    ).rejects.toThrow("injected failure while linking the final step");
    addSpy.mockRestore();

    expect(received).not.toContain("ceo.plan.delegated");
    expect(taskStore.list()).toHaveLength(taskCountBeforeDelegation);
    expect(orchestrator.getPlan(plan.id).status).toBe("approved");
    expect(orchestrator.listEvents(plan.id).some((e) => e.type === "ceo.plan.delegated")).toBe(
      false,
    );
    // The audit-message write is part of the same atomic unit — the
    // delegation attempt's own message must not survive the rollback,
    // even though the board itself (created earlier, at plan creation)
    // legitimately still exists.
    expect(boardStore.has(`task:${parentTaskId}`)).toBe(true);
    expect(messageStore.list(`task:${parentTaskId}`)).toHaveLength(messageCountBeforeDelegation);

    // Repeated delegation after the failed attempt succeeds exactly once.
    const result = await orchestrator.delegate(plan.id, orchestrator.getMutationToken(plan.id));
    expect(result.childTasks).toHaveLength(version.steps.length);
    expect(taskStore.list()).toHaveLength(taskCountBeforeDelegation + version.steps.length);
  });

  it("an unapproved plan cannot be delegated, and delegation cannot be repeated automatically after approval", async () => {
    const harness = buildHarness();
    const { orchestrator, parentTaskId } = harness;
    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    await expect(
      orchestrator.delegate(plan.id, orchestrator.getMutationToken(plan.id)),
    ).rejects.toThrow(CeoPlanStateConflictError);
  });

  it("a step with no selected or recommended adapter at all blocks the whole delegation — zero child tasks are created", async () => {
    const harness = buildHarness({ plannerKind: "deterministic" });
    const { orchestrator, taskStore } = harness;
    // No `requirements` at all — the deterministic planner's "never
    // fabricate" discipline (ceo-plan-routing.ts) leaves every step's
    // recommendedAdapterId undefined, and nothing ever sets
    // selectedAdapterId in this phase (no adapter-override UI/API).
    taskStore.add({
      task: {
        taskId: "no-requirements-task",
        projectId: "project-1",
        title: "Task with no requirements",
        description: "A task created without going through routing/assignment.",
        priority: "normal",
        status: "backlog",
        dependencyTaskIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      runId: undefined,
      adapterId: undefined,
      agentId: undefined,
      eventCount: 0,
      lastSequence: undefined,
      terminalEventType: undefined,
      failure: undefined,
      cancellationRequested: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: undefined,
      completedAt: undefined,
      assignedExecutionTrust: undefined,
    });
    const before = taskStore.list().length;
    const { plan } = await orchestrator.createPlan("no-requirements-task", undefined);
    const version = orchestrator.getVersion(plan.id, 1);
    expect(version.steps.every((step) => step.recommendedAdapterId === undefined)).toBe(true);
    await orchestrator.submit(plan.id, orchestrator.getMutationToken(plan.id));
    await orchestrator.decideApproval(
      plan.id,
      orchestrator.getMutationToken(plan.id),
      1,
      version.contentHash,
      "approve",
      undefined,
    );

    await expect(
      orchestrator.delegate(plan.id, orchestrator.getMutationToken(plan.id)),
    ).rejects.toThrow(CeoPlanDelegationBlockedError);
    expect(taskStore.list().length).toBe(before);
    expect(orchestrator.getPlan(plan.id).status).toBe("approved");
  });

  it("an ineligible adapter blocks the whole delegation — zero child tasks are created", async () => {
    const harness = buildHarness();
    const { orchestrator, taskStore } = harness;
    // Requirements MockAgentAdapter (simulated, no project.edit) cannot satisfy.
    taskStore.add({
      task: {
        taskId: "strict-task",
        projectId: "project-1",
        title: "Strict task",
        description: "Needs isolated execution and project.edit, which Mock cannot provide.",
        priority: "normal",
        status: "backlog",
        dependencyTaskIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        requirements: {
          requiredCapabilities: ["project.edit"],
          allowedExecutionTrust: ["isolated"],
        },
      },
      runId: undefined,
      adapterId: undefined,
      agentId: undefined,
      eventCount: 0,
      lastSequence: undefined,
      terminalEventType: undefined,
      failure: undefined,
      cancellationRequested: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: undefined,
      completedAt: undefined,
      assignedExecutionTrust: undefined,
    });
    const before = taskStore.list().length;
    const { plan } = await orchestrator.createPlan("strict-task", undefined);
    await orchestrator.submit(plan.id, orchestrator.getMutationToken(plan.id));
    const version = orchestrator.getVersion(plan.id, 1);
    await orchestrator.decideApproval(
      plan.id,
      orchestrator.getMutationToken(plan.id),
      1,
      version.contentHash,
      "approve",
      undefined,
    );

    await expect(
      orchestrator.delegate(plan.id, orchestrator.getMutationToken(plan.id)),
    ).rejects.toThrow(CeoPlanDelegationBlockedError);
    expect(taskStore.list().length).toBe(before);
    expect(orchestrator.getPlan(plan.id).status).toBe("approved");
  });

  it("a repeated delegation request after success creates no duplicate child tasks", async () => {
    const harness = buildHarness();
    const { orchestrator, taskStore } = harness;
    const { plan } = await approvedPlan(harness);
    await orchestrator.delegate(plan.id, orchestrator.getMutationToken(plan.id));
    const countAfterFirst = taskStore.list().length;

    await expect(
      orchestrator.delegate(plan.id, orchestrator.getMutationToken(plan.id)),
    ).rejects.toThrow();
    expect(taskStore.list().length).toBe(countAfterFirst);
  });

  it("does not start any real provider — every created child task has adapterId from the registered fixture and no runId", async () => {
    const harness = buildHarness();
    const { plan } = await approvedPlan(harness);
    const result = await harness.orchestrator.delegate(
      plan.id,
      harness.orchestrator.getMutationToken(plan.id),
    );
    for (const childTask of result.childTasks) {
      expect(childTask.runId).toBeUndefined();
      expect(childTask.adapterId).toBe("hall.mock-agent");
    }
  });

  it("dependent child tasks carry the delegated sibling's real task id as a dependency", async () => {
    const harness = buildHarness({ plannerKind: "scripted" });
    const { plan, version } = await approvedPlan(harness);
    expect(version.steps.length).toBeGreaterThanOrEqual(2);
    const result = await harness.orchestrator.delegate(
      plan.id,
      harness.orchestrator.getMutationToken(plan.id),
    );
    const secondChild = result.childTasks[1];
    expect(secondChild?.task.dependencyTaskIds).toEqual([result.childTasks[0]?.task.taskId]);
  });
});

describe("CeoPlanOrchestrator — progress sync", () => {
  it("getPlanWithProgress never mutates plan status or appends an event, even once every child task has completed", async () => {
    const harness = buildHarness({ plannerKind: "scripted" });
    const { orchestrator, taskStore, parentTaskId } = harness;
    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    await orchestrator.submit(plan.id, orchestrator.getMutationToken(plan.id));
    const version = orchestrator.getVersion(plan.id, 1);
    await orchestrator.decideApproval(
      plan.id,
      orchestrator.getMutationToken(plan.id),
      1,
      version.contentHash,
      "approve",
      undefined,
    );
    const { childTasks } = await orchestrator.delegate(
      plan.id,
      orchestrator.getMutationToken(plan.id),
    );
    for (const child of childTasks) {
      taskStore.updateStatus(child.task.taskId, "running");
      taskStore.updateStatus(child.task.taskId, "completed");
    }

    const before = orchestrator.listEvents(plan.id).length;
    const { plan: readPlan } = orchestrator.getPlanWithProgress(plan.id);
    expect(readPlan.status).toBe("delegated"); // NOT auto-advanced to completed by the read
    expect(orchestrator.listEvents(plan.id).length).toBe(before); // no event appended by the read

    // Calling it again changes nothing either — reads are idempotent by
    // construction, not merely "idempotent so far."
    orchestrator.getPlanWithProgress(plan.id);
    expect(orchestrator.getPlan(plan.id).status).toBe("delegated");
    expect(orchestrator.listEvents(plan.id).length).toBe(before);
  });

  it("stays delegated while children are still in progress, then syncs to completed once every child task completes, exactly once", async () => {
    const harness = buildHarness({ plannerKind: "scripted" });
    const { orchestrator, taskStore } = harness;
    const { plan } = await (async () => {
      const { orchestrator: o, parentTaskId } = harness;
      const created = await o.createPlan(parentTaskId, undefined);
      await o.submit(created.plan.id, o.getMutationToken(created.plan.id));
      const version = o.getVersion(created.plan.id, 1);
      const approved = await o.decideApproval(
        created.plan.id,
        o.getMutationToken(created.plan.id),
        1,
        version.contentHash,
        "approve",
        undefined,
      );
      return { plan: approved.plan };
    })();
    const result = await orchestrator.delegate(plan.id, orchestrator.getMutationToken(plan.id));

    const midway = orchestrator.getPlanWithProgress(plan.id);
    expect(midway.plan.status).toBe("delegated");

    for (const childTask of result.childTasks) {
      taskStore.updateStatus(childTask.task.taskId, "running");
      taskStore.updateStatus(childTask.task.taskId, "completed");
      taskStore.setCompleted(childTask.task.taskId, "2026-01-01T01:00:00.000Z", "run.completed");
    }

    // Phase 14.1 — nothing synchronizes progress automatically on a mere
    // read anymore; this test's harness updates `taskStore` directly
    // (bypassing the task-mutation hook entirely), so the transition must
    // be triggered explicitly, exactly like `onChildTaskMutated` would.
    const syncResult = orchestrator.synchronizeProgress(plan.id);
    expect(syncResult.changed).toBe(true);

    const afterAll = orchestrator.getPlanWithProgress(plan.id);
    expect(afterAll.plan.status).toBe("completed");
    expect(afterAll.plan.completedAt).toBeDefined();

    const events = orchestrator.listEvents(plan.id);
    expect(events.filter((e) => e.type === "ceo.plan.completed")).toHaveLength(1);

    // A second sync must never append a second terminal event or
    // re-mutate an already-terminal plan.
    const countBefore = events.length;
    const secondSync = orchestrator.synchronizeProgress(plan.id);
    expect(secondSync.changed).toBe(false);
    expect(orchestrator.listEvents(plan.id)).toHaveLength(countBefore);
  });

  it("syncs to failed as soon as one child task fails, even while a sibling is still running, and never rewrites the sibling's own state", async () => {
    const harness = buildHarness({ plannerKind: "scripted" });
    const { orchestrator, taskStore } = harness;
    const { orchestrator: o, parentTaskId } = harness;
    const created = await o.createPlan(parentTaskId, undefined);
    await o.submit(created.plan.id, o.getMutationToken(created.plan.id));
    const version = o.getVersion(created.plan.id, 1);
    const { plan } = await o.decideApproval(
      created.plan.id,
      o.getMutationToken(created.plan.id),
      1,
      version.contentHash,
      "approve",
      undefined,
    );
    const result = await orchestrator.delegate(plan.id, orchestrator.getMutationToken(plan.id));

    const [first, second] = result.childTasks;
    if (first) {
      taskStore.updateStatus(first.task.taskId, "running");
      taskStore.updateStatus(first.task.taskId, "failed");
      taskStore.setCompleted(first.task.taskId, "2026-01-01T01:00:00.000Z", "run.failed", {
        code: "SIMULATED_FAILURE",
        message: "simulated",
      });
    }
    const secondStatusBefore = second ? taskStore.get(second.task.taskId).task.status : undefined;

    orchestrator.synchronizeProgress(plan.id);
    const refreshed = orchestrator.getPlanWithProgress(plan.id);
    expect(refreshed.plan.status).toBe("failed");
    if (second) {
      expect(taskStore.get(second.task.taskId).task.status).toBe(secondStatusBefore);
    }
  });
});

describe("CeoPlanOrchestrator — event publication", () => {
  it("publishes each plan event to subscribers strictly after the underlying mutation commits", async () => {
    const harness = buildHarness();
    const { orchestrator, parentTaskId } = harness;
    const received: CeoPlanEvent[] = [];
    // Subscribe using a placeholder id first is not possible (planId
    // unknown until creation) — subscribe immediately after creation
    // instead and drive a second mutation to observe live publication.
    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    const unsubscribe = orchestrator.subscribeToPlanEvents(plan.id, (event) => {
      received.push(event);
    });
    await orchestrator.submit(plan.id, orchestrator.getMutationToken(plan.id));
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("ceo.plan.submitted");
    unsubscribe();
  });
});

describe("CeoPlanOrchestrator — mutation token concurrency contract", () => {
  it("rejects a stale mutation token with CeoPlanMutationTokenInvalidError, and performs no mutation", async () => {
    const harness = buildHarness();
    const { orchestrator, parentTaskId, taskStore } = harness;
    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    const staleToken = orchestrator.getMutationToken(plan.id);
    await orchestrator.submit(plan.id, staleToken); // advances the revision
    const before = taskStore.list().length;

    await expect(orchestrator.submit(plan.id, staleToken)).rejects.toThrow();
    expect(orchestrator.getPlan(plan.id).status).toBe("awaiting_approval");
    expect(taskStore.list().length).toBe(before);
  });

  it("rejects a malformed mutation token without throwing an unrelated error", async () => {
    const harness = buildHarness();
    const { orchestrator, parentTaskId } = harness;
    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    await expect(orchestrator.submit(plan.id, "not-a-real-token")).rejects.toThrow();
  });

  it("getMutationToken rotates to a new value after every successful mutation", async () => {
    const harness = buildHarness();
    const { orchestrator, parentTaskId } = harness;
    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    const tokenAfterCreate = orchestrator.getMutationToken(plan.id);
    await orchestrator.submit(plan.id, tokenAfterCreate);
    const tokenAfterSubmit = orchestrator.getMutationToken(plan.id);
    expect(tokenAfterSubmit).not.toBe(tokenAfterCreate);
  });
});
