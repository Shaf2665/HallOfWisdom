import { describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { MockAgentAdapter } from "@hall-of-wisdom/mock-agent";
import type {
  AgentAdapter,
  AgentAdapterDescriptor,
  AgentDetectionResult,
} from "@hall-of-wisdom/agent-adapter-sdk";
import type {
  CapabilityObservation,
  CeoPlanEvent,
  MessageAttachment,
  TaskRequirements,
} from "@hall-of-wisdom/protocol";
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

function buildHarness(
  options: {
    plannerKind?: "scripted" | "deterministic";
    /** Replaces the default single `MockAgentAdapter()` registration entirely, when supplied — used by the vision-aware delegation tests, which need a registry with no non-vision candidate at all so `recommendedAdapterId` resolves deterministically. */
    adapters?: readonly AgentAdapter[];
    /**
     * Overrides the default parent task's `requirements` (deliberately
     * pinned to `{requiredCapabilities: [], allowedExecutionTrust: ["simulated"]}`
     * — matching `MockAgentAdapter` — for every other test in this suite).
     * Omit entirely to keep the default; pass `null` for "no requirements
     * at all"; pass an object to use it verbatim.
     */
    parentRequirements?: TaskRequirements | null;
  } = {},
) {
  const registry = new AgentRegistry();
  for (const adapter of options.adapters ?? [new MockAgentAdapter()]) {
    registry.register(adapter);
  }
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
  // Matches MockAgentAdapter's own detect() output (simulated,
  // structured.events/cancellation only) so the planner has enough
  // information to recommend an adapter without fabricating anything.
  // Overridable via `options.parentRequirements` — see that option's doc
  // comment.
  const defaultParentRequirements: TaskRequirements = {
    requiredCapabilities: [],
    allowedExecutionTrust: ["simulated"],
  };
  const parentRequirements =
    options.parentRequirements === null
      ? undefined
      : (options.parentRequirements ?? defaultParentRequirements);
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
      ...(parentRequirements !== undefined ? { requirements: parentRequirements } : {}),
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

/**
 * A registrable fixture adapter reporting the given `executionTrust` and
 * `capabilityObservations` — shared builder for every fixture adapter this
 * suite's Issue #23 tests need (vision-capable, isolated-but-no-vision
 * mimicking Codex/Hermes, non-isolated mimicking Claude Code's real
 * default). `MockAgentAdapter` never declares vision and is always
 * `"simulated"`, so tests that need a genuinely eligible attachment-work
 * candidate register one of these instead.
 */
function buildFixtureAdapter(
  adapterId: string,
  executionTrust: AgentDetectionResult["executionTrust"],
  capabilityObservations: readonly CapabilityObservation[],
): AgentAdapter {
  const descriptor: AgentAdapterDescriptor = {
    adapterId,
    displayName: adapterId,
    adapterVersion: "0.0.0-test",
    integrationLevel: "structured_cli",
    supportedOperatingSystems: ["windows", "macos", "linux"],
    supportedAgent: {
      agentId: adapterId,
      displayName: adapterId,
      adapterId,
      adapterVersion: "0.0.0-test",
    },
    capabilities: {
      streaming: true,
      cancellation: true,
      sessionResume: false,
      toolEvents: true,
      fileEditing: true,
      shellExecution: true,
      subagents: false,
      mcp: false,
      acp: false,
    },
    declaredCapabilities: [...new Set(capabilityObservations.map((o) => o.capability))],
  };
  const detection: AgentDetectionResult = {
    installed: true,
    availability: "available",
    executionTrust,
    capabilityObservations: [...capabilityObservations],
  };
  return {
    descriptor,
    detect: () => Promise.resolve(detection),
    startTask: () =>
      Promise.reject(new Error(`${adapterId}.startTask must never be called by this test suite`)),
  };
}

function verifiedObservation(
  capability: CapabilityObservation["capability"],
): CapabilityObservation {
  return {
    capability,
    status: "verified",
    safeSummary: "Test fixture.",
    evidence: "environment_probe",
  };
}

/** Reports a *verified* `vision.image` observation and isolated execution trust. */
function buildVisionCapableAdapter(): AgentAdapter {
  return buildFixtureAdapter("hall.vision-fixture", "isolated", [
    verifiedObservation("vision.image"),
    verifiedObservation("structured.events"),
    verifiedObservation("cancellation"),
  ]);
}

/** Isolated, no vision — mimics Codex/Hermes running isolated, eligible for normal-file (non-image) attachment work but not image work. */
function buildIsolatedNoVisionAdapter(adapterId = "hall.isolated-fixture"): AgentAdapter {
  return buildFixtureAdapter(adapterId, "isolated", [
    verifiedObservation("structured.events"),
    verifiedObservation("cancellation"),
  ]);
}

/** Not isolated, no vision — mimics Claude Code's real default (`docs/architecture/0020-communication-board-attachments.md`: "hall.claude-code is not [isolated by default]"), so it must be ineligible for any attachment-bearing work. */
function buildNonIsolatedNoVisionAdapter(adapterId = "hall.claude-like-fixture"): AgentAdapter {
  return buildFixtureAdapter(adapterId, "trusted_local", [
    verifiedObservation("structured.events"),
    verifiedObservation("cancellation"),
  ]);
}

function imageAttachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    attachmentId: "11111111-1111-4111-8111-111111111111",
    filename: "screenshot.png",
    mimeType: "image/png",
    byteSize: 2048,
    kind: "image",
    ...overrides,
  };
}

/** Posts a human-authored board message carrying `attachment` onto `taskId`'s own Communication Board — the same shape a real Gateway/Communication-Board upload produces, built directly against the store ports so tests don't need the HTTP routes. */
function postHumanAttachment(
  harness: ReturnType<typeof buildHarness>,
  taskId: string,
  attachment: MessageAttachment,
): void {
  const { boardStore, messageStore } = harness;
  const { board, created } = boardStore.ensureTaskBoard(taskId, "2026-01-01T00:00:00.000Z");
  if (created) messageStore.registerBoard(board.boardId);
  messageStore.append(board.boardId, {
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    boardId: board.boardId,
    author: { kind: "human", displayName: "Test User" },
    text: "here is a screenshot",
    attachments: [attachment],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
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

describe("CeoPlanOrchestrator — vision-aware delegation (Issue #23)", () => {
  async function approve(
    orchestrator: ReturnType<typeof buildHarness>["orchestrator"],
    planId: string,
  ) {
    await orchestrator.submit(planId, orchestrator.getMutationToken(planId));
    const version = orchestrator.getVersion(planId, 1);
    await orchestrator.decideApproval(
      planId,
      orchestrator.getMutationToken(planId),
      1,
      version.contentHash,
      "approve",
      undefined,
    );
    return version;
  }

  it("bakes isolated-only allowedExecutionTrust and vision.image into every step when the parent has an image attachment", async () => {
    const harness = buildHarness({
      plannerKind: "deterministic",
      // The shared harness's default parent task is pinned to
      // `allowedExecutionTrust: ["simulated"]` to match `MockAgentAdapter`
      // for every other test — an attachment now always needs "isolated"
      // in that list, so this test supplies one that has it.
      parentRequirements: {
        requiredCapabilities: [],
        allowedExecutionTrust: ["isolated", "trusted_local"],
      },
    });
    const { orchestrator, parentTaskId } = harness;
    postHumanAttachment(harness, parentTaskId, imageAttachment());

    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    const version = orchestrator.getVersion(plan.id, 1);
    for (const step of version.steps) {
      expect(step.requirements?.requiredCapabilities).toContain("vision.image");
      // Intersected with ["isolated"] — never widened, and "trusted_local"
      // (present on the parent's own list) is dropped.
      expect(step.requirements?.allowedExecutionTrust).toEqual(["isolated"]);
    }
  });

  it("narrows allowedExecutionTrust to isolated-only for a normal (non-image) attachment, without requiring vision.image", async () => {
    const harness = buildHarness({
      plannerKind: "deterministic",
      parentRequirements: {
        requiredCapabilities: [],
        allowedExecutionTrust: ["isolated", "trusted_local"],
      },
    });
    const { orchestrator, parentTaskId } = harness;
    postHumanAttachment(
      harness,
      parentTaskId,
      imageAttachment({ filename: "notes.txt", mimeType: "text/plain", kind: "file" }),
    );

    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    const version = orchestrator.getVersion(plan.id, 1);
    for (const step of version.steps) {
      expect(step.requirements?.requiredCapabilities).not.toContain("vision.image");
      expect(step.requirements?.allowedExecutionTrust).toEqual(["isolated"]);
    }
  });

  it("does not mutate the parent task's own persisted requirements when baking isolated-only + vision.image into the plan", async () => {
    const harness = buildHarness({
      plannerKind: "deterministic",
      parentRequirements: {
        requiredCapabilities: [],
        allowedExecutionTrust: ["isolated", "trusted_local"],
      },
    });
    const { orchestrator, taskStore, parentTaskId } = harness;
    const requirementsBefore = taskStore.get(parentTaskId).task.requirements;
    postHumanAttachment(harness, parentTaskId, imageAttachment());

    await orchestrator.createPlan(parentTaskId, undefined);
    expect(taskStore.get(parentTaskId).task.requirements).toEqual(requirementsBefore);
  });

  it("blocks delegation with CeoPlanDelegationBlockedError when the only isolated candidate has no verified vision.image", async () => {
    // Isolated (so it is NOT excluded by the isolation requirement) but no
    // verified vision — isolates the vision-specific gate from the
    // isolation gate, which a bare `MockAgentAdapter` (simulated, never
    // isolated) would conflate.
    const harness = buildHarness({
      plannerKind: "deterministic",
      adapters: [buildIsolatedNoVisionAdapter()],
      parentRequirements: null,
    });
    const { orchestrator, taskStore, parentTaskId } = harness;
    postHumanAttachment(harness, parentTaskId, imageAttachment());

    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    const before = taskStore.list().length;
    await approve(orchestrator, plan.id);

    await expect(
      orchestrator.delegate(plan.id, orchestrator.getMutationToken(plan.id)),
    ).rejects.toThrow(CeoPlanDelegationBlockedError);
    // Fail-closed: zero child tasks created, exactly like every other
    // ineligibility case delegation already guards against.
    expect(taskStore.list().length).toBe(before);
  });

  it("delegates to the registered vision-capable adapter when the parent has an image attachment", async () => {
    // A registry with ONLY the vision-capable fixture (no MockAgentAdapter)
    // and a parent task with no pre-set `requirements`, so the synthesized
    // vision requirement's own `allowedExecutionTrust` default
    // (`["isolated"]`) governs eligibility — the shared harness's default
    // parent task is deliberately pinned to `["simulated"]` to match
    // `MockAgentAdapter`, which would make this fixture's `"isolated"`
    // trust ineligible for an unrelated reason.
    const harness = buildHarness({
      plannerKind: "deterministic",
      adapters: [buildVisionCapableAdapter()],
      parentRequirements: null,
    });
    const { orchestrator, taskStore } = harness;
    const parentTaskId = "parent-vision-task";
    taskStore.add({
      task: {
        taskId: parentTaskId,
        projectId: "project-1",
        title: "Analyze the attached screenshot",
        description: "Describe what is shown in the attached screenshot.",
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
    postHumanAttachment(harness, parentTaskId, imageAttachment());

    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    await approve(orchestrator, plan.id);

    const result = await orchestrator.delegate(plan.id, orchestrator.getMutationToken(plan.id));
    expect(result.childTasks.length).toBeGreaterThan(0);
    for (const childTask of result.childTasks) {
      expect(childTask.adapterId).toBe("hall.vision-fixture");
    }
  });

  it("still requires verified vision.image (an adapter that only 'declares' vision.image, like Claude Code, is never selected) when the parent has an image attachment", async () => {
    // Reports `vision.image` at status "declared" only — matching the real
    // Claude Code adapter's own detection (`adapters/claude-code/src/detection.ts`:
    // "never independently verified live, so routing never treats this as
    // satisfying required vision work"). `evaluateCandidateEligibility`
    // never treats "declared" as satisfying a required capability — only
    // "verified" counts.
    const declaredOnlyVisionAdapter: AgentAdapter = {
      descriptor: { ...buildVisionCapableAdapter().descriptor, adapterId: "hall.declared-vision" },
      detect: () =>
        Promise.resolve<AgentDetectionResult>({
          installed: true,
          availability: "available",
          executionTrust: "isolated",
          capabilityObservations: [
            {
              capability: "vision.image",
              status: "declared",
              safeSummary: "Declared only — never independently verified live.",
              evidence: "declared_only",
            },
          ],
        }),
      startTask: () => Promise.reject(new Error("must never be called")),
    };
    const harness = buildHarness({
      plannerKind: "deterministic",
      adapters: [declaredOnlyVisionAdapter],
    });
    const { orchestrator, taskStore } = harness;
    const parentTaskId = "parent-declared-vision-task";
    taskStore.add({
      task: {
        taskId: parentTaskId,
        projectId: "project-1",
        title: "Analyze the attached screenshot",
        description: "Describe what is shown in the attached screenshot.",
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
    postHumanAttachment(harness, parentTaskId, imageAttachment());

    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    const version = orchestrator.getVersion(plan.id, 1);
    // Planning-time: no eligible (verified) vision candidate exists, so no
    // adapter can be safely recommended — mirrors "must not pretend to
    // understand information it cannot derive."
    expect(version.steps.every((step) => step.recommendedAdapterId === undefined)).toBe(true);

    await approve(orchestrator, plan.id);
    await expect(
      orchestrator.delegate(plan.id, orchestrator.getMutationToken(plan.id)),
    ).rejects.toThrow(CeoPlanDelegationBlockedError);
  });

  it("still blocks delegation to a non-vision adapter when the image is attached after plan creation (ephemeral revalidation at delegate-time)", async () => {
    const harness = buildHarness({ plannerKind: "deterministic" });
    const { orchestrator, parentTaskId } = harness;

    // No image yet — the default harness parent task's requirements match
    // MockAgentAdapter exactly (empty capabilities, "simulated" trust), so
    // it is legitimately recommended and selectable at this point.
    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    const version = orchestrator.getVersion(plan.id, 1);
    expect(version.steps[0]?.requirements?.requiredCapabilities).not.toContain("vision.image");
    expect(version.steps[0]?.recommendedAdapterId).toBe("hall.mock-agent");
    await orchestrator.submit(plan.id, orchestrator.getMutationToken(plan.id));
    await orchestrator.decideApproval(
      plan.id,
      orchestrator.getMutationToken(plan.id),
      1,
      version.contentHash,
      "approve",
      undefined,
    );

    // The image arrives on the parent's board only now — after approval,
    // before delegation. The plan's own persisted step.requirements were
    // never re-baked (no re-versioning happened), so this is exactly the
    // gap a plan-creation-time-only check would miss.
    postHumanAttachment(harness, parentTaskId, imageAttachment());

    await expect(
      orchestrator.delegate(plan.id, orchestrator.getMutationToken(plan.id)),
    ).rejects.toThrow(CeoPlanDelegationBlockedError);
  });

  it("Gateway + PDF: excludes a non-isolated Claude-like adapter from recommendation, recommending the isolated candidate instead, and delegates to it", async () => {
    const isolatedAdapter = buildIsolatedNoVisionAdapter("hall.isolated-fixture");
    const nonIsolatedAdapter = buildNonIsolatedNoVisionAdapter("hall.claude-like-fixture");
    const harness = buildHarness({
      plannerKind: "deterministic",
      adapters: [isolatedAdapter, nonIsolatedAdapter],
      parentRequirements: null,
    });
    const { orchestrator, parentTaskId } = harness;
    // A normal (non-image — e.g. PDF) attachment, exactly like a real
    // Gateway request would post via `ensureTaskBoard` → `uploadBoardAttachment`.
    postHumanAttachment(
      harness,
      parentTaskId,
      imageAttachment({ filename: "spec.pdf", mimeType: "application/pdf", kind: "file" }),
    );

    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    const version = orchestrator.getVersion(plan.id, 1);
    for (const step of version.steps) {
      expect(step.recommendedAdapterId).toBe("hall.isolated-fixture");
    }

    await approve(orchestrator, plan.id);
    const result = await orchestrator.delegate(plan.id, orchestrator.getMutationToken(plan.id));
    for (const childTask of result.childTasks) {
      expect(childTask.adapterId).toBe("hall.isolated-fixture");
    }
  });

  it("rejects delegation to a non-isolated adapter manually selected (selectedAdapterId override) for an inherited normal file, even though createVersion's own check did not catch it", async () => {
    // createVersion()'s selectedAdapterId eligibility check only runs
    // `evaluateCandidateEligibility` when the edited step carries
    // `requirements` — a step with none at all (as here) only has its
    // adapter's registration and availability checked, not its execution
    // trust. This is the gap `delegate()`'s own ephemeral revalidation
    // (Issue #23, final correction) exists to close independently of how
    // a step's selected adapter was chosen.
    const nonIsolatedAdapter = buildNonIsolatedNoVisionAdapter("hall.claude-like-fixture");
    const harness = buildHarness({
      plannerKind: "deterministic",
      adapters: [nonIsolatedAdapter],
      parentRequirements: null,
    });
    const { orchestrator, parentTaskId } = harness;
    const { plan, version } = await orchestrator.createPlan(parentTaskId, undefined);
    expect(version.steps.every((step) => step.requirements === undefined)).toBe(true);

    await orchestrator.createVersion(
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
          ...(index === 0 ? { selectedAdapterId: "hall.claude-like-fixture" } : {}),
        })),
      },
      "operator",
    );
    const editedVersion = orchestrator.getVersion(plan.id, 2);
    expect(editedVersion.steps[0]?.selectedAdapterId).toBe("hall.claude-like-fixture");

    await orchestrator.submit(plan.id, orchestrator.getMutationToken(plan.id));
    await orchestrator.decideApproval(
      plan.id,
      orchestrator.getMutationToken(plan.id),
      2,
      editedVersion.contentHash,
      "approve",
      undefined,
    );

    postHumanAttachment(
      harness,
      parentTaskId,
      imageAttachment({ filename: "notes.txt", mimeType: "text/plain", kind: "file" }),
    );

    await expect(
      orchestrator.delegate(plan.id, orchestrator.getMutationToken(plan.id)),
    ).rejects.toThrow(CeoPlanDelegationBlockedError);
  });

  it("fails clearly at plan-creation time when the parent's existing allowedExecutionTrust excludes isolated entirely", async () => {
    const harness = buildHarness({
      plannerKind: "deterministic",
      parentRequirements: { requiredCapabilities: [], allowedExecutionTrust: ["trusted_local"] },
    });
    const { orchestrator, taskStore, parentTaskId } = harness;
    postHumanAttachment(
      harness,
      parentTaskId,
      imageAttachment({ filename: "notes.txt", mimeType: "text/plain", kind: "file" }),
    );

    const before = taskStore.list().length;
    await expect(orchestrator.createPlan(parentTaskId, undefined)).rejects.toThrow(
      CeoPlanningBlockedError,
    );
    try {
      await orchestrator.createPlan(parentTaskId, undefined);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CeoPlanningBlockedError);
      expect((error as CeoPlanningBlockedError).message).toContain("isolated");
    }
    expect(taskStore.list().length).toBe(before);
  });

  it("a late-added (after approval) normal file attachment is caught during delegation, even though it did not exist at plan-creation time", async () => {
    const harness = buildHarness({ plannerKind: "deterministic" });
    const { orchestrator, parentTaskId } = harness;

    // No attachment yet — the default harness parent task's requirements
    // match MockAgentAdapter exactly (empty capabilities, "simulated"
    // trust), so it is legitimately recommended and selectable here.
    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    const version = orchestrator.getVersion(plan.id, 1);
    expect(version.steps[0]?.requirements?.allowedExecutionTrust).toEqual(["simulated"]);
    expect(version.steps[0]?.recommendedAdapterId).toBe("hall.mock-agent");
    await approve(orchestrator, plan.id);

    // The normal (non-image) file arrives on the parent's board only now.
    postHumanAttachment(
      harness,
      parentTaskId,
      imageAttachment({ filename: "notes.txt", mimeType: "text/plain", kind: "file" }),
    );

    await expect(
      orchestrator.delegate(plan.id, orchestrator.getMutationToken(plan.id)),
    ).rejects.toThrow(CeoPlanDelegationBlockedError);
  });

  it("no attachment preserves previous routing behavior, even for a parent whose allowedExecutionTrust would otherwise conflict with attachment work", async () => {
    const harness = buildHarness({
      plannerKind: "deterministic",
      // Deliberately a trust list that would BLOCK planning if any
      // attachment were present (see the "fails clearly" test above) — with
      // no attachment at all, none of this correction's machinery should
      // even engage.
      parentRequirements: { requiredCapabilities: [], allowedExecutionTrust: ["simulated"] },
    });
    const { orchestrator, parentTaskId } = harness;

    const { plan } = await orchestrator.createPlan(parentTaskId, undefined);
    const version = orchestrator.getVersion(plan.id, 1);
    for (const step of version.steps) {
      expect(step.requirements?.allowedExecutionTrust).toEqual(["simulated"]);
      expect(step.recommendedAdapterId).toBe("hall.mock-agent");
    }
    await approve(orchestrator, plan.id);
    const result = await orchestrator.delegate(plan.id, orchestrator.getMutationToken(plan.id));
    for (const childTask of result.childTasks) {
      expect(childTask.adapterId).toBe("hall.mock-agent");
    }
  });

  it("regression: the predictable old failure (a non-isolated adapter recommended/delegated for attachment-bearing work, later crashing at execution with ATTACHMENT_REQUIRES_ISOLATED_EXECUTION) is now prevented before execution — planning itself refuses", async () => {
    // Mimics Claude Code's real, documented default: not isolated
    // (`docs/architecture/0020-communication-board-attachments.md`:
    // "hall.claude-code is not [isolated by default]"). Before this
    // correction, a parent task whose own requirements matched this
    // adapter (as here) would have had it recommended and delegated for a
    // normal-file attachment — and `TaskAttachmentMaterializer` would only
    // discover the conflict once execution actually started, throwing
    // `AttachmentsRequireIsolatedExecutionError`
    // (`ATTACHMENT_REQUIRES_ISOLATED_EXECUTION`). This test proves that
    // failure can no longer happen: with only this one, non-isolated
    // candidate registered, planning itself refuses outright.
    const nonIsolatedAdapter = buildNonIsolatedNoVisionAdapter("hall.claude-like-fixture");
    const harness = buildHarness({
      plannerKind: "deterministic",
      adapters: [nonIsolatedAdapter],
      parentRequirements: { requiredCapabilities: [], allowedExecutionTrust: ["trusted_local"] },
    });
    const { orchestrator, taskStore, parentTaskId } = harness;
    postHumanAttachment(
      harness,
      parentTaskId,
      imageAttachment({ filename: "spec.pdf", mimeType: "application/pdf", kind: "file" }),
    );

    const before = taskStore.list().length;
    await expect(orchestrator.createPlan(parentTaskId, undefined)).rejects.toThrow(
      CeoPlanningBlockedError,
    );
    // No plan, no child task — the doomed-to-fail-at-execution adapter
    // choice was never made in the first place.
    expect(taskStore.list().length).toBe(before);
  });
});
