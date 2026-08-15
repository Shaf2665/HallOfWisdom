import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import {
  EventFactory,
  parseAgentAdapterDescriptor,
  type AgentAdapter,
  type AgentAdapterDescriptor,
  type AgentDetectionResult,
  type AgentTaskInput,
} from "@hall-of-wisdom/agent-adapter-sdk";
import { TaskStore } from "./task-store.js";
import { TaskOrchestrator } from "./task-orchestrator.js";
import { EventStore } from "../events/event-store.js";
import { EventBus } from "../events/event-bus.js";
import { InMemoryAgentWorktreeStore } from "../agent-worktrees/in-memory-agent-worktree-store.js";
import type { AgentWorktreeRecord } from "../agent-worktrees/agent-worktree-record.js";
import type { CreateAgentWorktreeResult } from "../agent-worktrees/agent-worktree-manager.js";
import { InMemoryAgentExecutionArtifactStore } from "../execution-artifacts/in-memory-agent-execution-artifact-store.js";
import { AgentExecutionArtifactTerminalizer } from "../agent-execution/agent-execution-artifact-terminalizer.js";
import { ExplicitAdapterIsolationPolicy } from "../agent-execution/isolation-policy.js";
import { IsolatedAgentExecutionCoordinator } from "../agent-execution/isolated-agent-execution-coordinator.js";
import {
  HallTaskAttachmentMaterializer,
  HALL_ATTACHMENTS_DIRNAME,
} from "../agent-execution/task-attachment-materializer.js";
import { BoardStore } from "../boards/board-store.js";
import { MessageStore } from "../boards/message-store.js";
import { AttachmentBlobStore } from "../boards/attachment-blob-store.js";

const NOW = "2026-08-15T10:00:00.000Z";
const ISOLATED_ADAPTER_ID = "hall.isolated-agent";
const NON_ISOLATED_ADAPTER_ID = "hall.non-isolated-agent";
const VISION_BLIND_ADAPTER_ID = "hall.vision-blind-isolated-agent";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

class CountSignal {
  #count = 0;
  readonly #waiters = new Map<number, (() => void)[]>();
  notify(): void {
    this.#count += 1;
    const waiting = this.#waiters.get(this.#count);
    if (waiting === undefined) return;
    this.#waiters.delete(this.#count);
    for (const resolve of waiting) resolve();
  }
  wait(target: number): Promise<void> {
    if (this.#count >= target) return Promise.resolve();
    return new Promise((resolve) => {
      const waiting = this.#waiters.get(target) ?? [];
      waiting.push(resolve);
      this.#waiters.set(target, waiting);
    });
  }
}

describe("TaskOrchestrator attachment materialization", () => {
  it("propagates a linked human-message attachment into the AgentTaskInput the adapter receives", async () => {
    const harness = buildHarness();
    const { task } = harness.orchestrator.createTask({
      projectId: "project-1",
      title: "Task with an attachment",
      adapterId: ISOLATED_ADAPTER_ID,
    });
    harness.linkAttachment(task.taskId, {
      attachmentId: "11111111-1111-4111-8111-111111111111",
      filename: "spec.txt",
      mimeType: "text/plain",
      byteSize: 7,
      kind: "file",
      bytes: Buffer.from("content"),
    });

    await harness.capturedInputsSignal.wait(1);

    const input = harness.capturedInputs[0];
    expect(input?.attachments).toEqual([
      {
        relativePath: `${HALL_ATTACHMENTS_DIRNAME}/11111111-1111-4111-8111-111111111111/spec.txt`,
        filename: "spec.txt",
        mimeType: "text/plain",
        kind: "file",
      },
    ]);
    const writtenPath = path.join(
      harness.lastAgentWorkingDirectory ?? "",
      HALL_ATTACHMENTS_DIRNAME,
      "11111111-1111-4111-8111-111111111111",
      "spec.txt",
    );
    expect(fs.readFileSync(writtenPath, "utf8")).toBe("content");
  });

  it("propagates multiple attachments across multiple messages", async () => {
    const harness = buildHarness();
    const { task } = harness.orchestrator.createTask({
      projectId: "project-1",
      title: "Task with multiple attachments",
      adapterId: ISOLATED_ADAPTER_ID,
    });
    harness.linkAttachment(task.taskId, {
      attachmentId: "11111111-1111-4111-8111-111111111111",
      filename: "a.txt",
      mimeType: "text/plain",
      byteSize: 1,
      kind: "file",
      bytes: Buffer.from("a"),
    });
    harness.linkAttachment(task.taskId, {
      attachmentId: "22222222-2222-4222-8222-222222222222",
      filename: "b.png",
      mimeType: "image/png",
      byteSize: 1,
      kind: "image",
      bytes: Buffer.from("b"),
    });

    await harness.capturedInputsSignal.wait(1);

    const input = harness.capturedInputs[0];
    expect(input?.attachments?.map((entry) => entry.filename).sort()).toEqual(["a.txt", "b.png"]);
  });

  it("leaves a text-only task's AgentTaskInput byte-identical (no attachments key at all)", async () => {
    const harness = buildHarness();
    harness.orchestrator.createTask({
      projectId: "project-1",
      title: "Text-only task",
      adapterId: ISOLATED_ADAPTER_ID,
    });

    await harness.capturedInputsSignal.wait(1);

    const input = harness.capturedInputs[0];
    expect(input).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(input as object, "attachments")).toBe(false);
  });

  it("cleans up the worktree even when attachment materialization fails (missing blob)", async () => {
    const executionErrors: unknown[] = [];
    const harness = buildHarness({ onExecutionError: (error) => executionErrors.push(error) });
    const { task } = harness.orchestrator.createTask({
      projectId: "project-1",
      title: "Task with a broken attachment",
      adapterId: ISOLATED_ADAPTER_ID,
    });
    // Linked in the message store, but never written to the blob store —
    // simulates a missing/corrupt blob.
    harness.linkAttachmentWithoutBytes(task.taskId, {
      attachmentId: "33333333-3333-4333-8333-333333333333",
      filename: "missing.txt",
      mimeType: "text/plain",
      byteSize: 3,
      kind: "file",
    });

    await harness.cleanupSignal.wait(1);

    expect(harness.taskStore.get(task.taskId).task.status).toBe("failed");
    expect(harness.taskStore.get(task.taskId).failure?.code).toBe("ATTACHMENT_BLOB_UNAVAILABLE");
    expect(harness.cleanupCalls).toHaveLength(1);
    expect(harness.capturedInputs).toHaveLength(0);
  });

  it("fails clearly (never silently drops) when attachments exceed the materialization cap", async () => {
    const harness = buildHarness();
    const { task } = harness.orchestrator.createTask({
      projectId: "project-1",
      title: "Task with too many attachments",
      adapterId: ISOLATED_ADAPTER_ID,
    });
    for (let index = 0; index < 21; index += 1) {
      harness.linkAttachment(task.taskId, {
        attachmentId: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
        filename: `file-${String(index)}.txt`,
        mimeType: "text/plain",
        byteSize: 1,
        kind: "file",
        bytes: Buffer.from("x"),
      });
    }

    await harness.cleanupSignal.wait(1);

    expect(harness.taskStore.get(task.taskId).task.status).toBe("failed");
    expect(harness.taskStore.get(task.taskId).failure?.code).toBe(
      "ATTACHMENT_MATERIALIZATION_LIMIT_EXCEEDED",
    );
    expect(harness.capturedInputs).toHaveLength(0);
  });

  it("fails clearly when a non-isolated adapter's task has attachments, without inventing another temp-storage path", async () => {
    const harness = buildHarness();
    const { task } = harness.orchestrator.createTask({
      projectId: "project-1",
      title: "Non-isolated task with an attachment",
      adapterId: NON_ISOLATED_ADAPTER_ID,
    });
    harness.linkAttachment(task.taskId, {
      attachmentId: "11111111-1111-4111-8111-111111111111",
      filename: "notes.txt",
      mimeType: "text/plain",
      byteSize: 4,
      kind: "file",
      bytes: Buffer.from("data"),
    });

    await harness.failureSignal.wait(1);

    expect(harness.taskStore.get(task.taskId).task.status).toBe("failed");
    expect(harness.taskStore.get(task.taskId).failure?.code).toBe(
      "ATTACHMENT_REQUIRES_ISOLATED_EXECUTION",
    );
    // Never even reached the adapter.
    expect(harness.capturedInputs).toHaveLength(0);
    // No worktree was ever created for this non-isolated run, so nothing to clean up.
    expect(harness.cleanupCalls).toHaveLength(0);
  });

  it("blocks an image attachment on an isolated adapter that lacks verified vision.image, and still cleans up the worktree", async () => {
    const harness = buildHarness();
    const { task } = harness.orchestrator.createTask({
      projectId: "project-1",
      title: "Image task on a vision-blind adapter",
      adapterId: VISION_BLIND_ADAPTER_ID,
    });
    harness.linkAttachment(task.taskId, {
      attachmentId: "44444444-4444-4444-8444-444444444444",
      filename: "screenshot.png",
      mimeType: "image/png",
      byteSize: 1,
      kind: "image",
      bytes: Buffer.from("i"),
    });

    await harness.cleanupSignal.wait(1);

    expect(harness.taskStore.get(task.taskId).task.status).toBe("failed");
    expect(harness.taskStore.get(task.taskId).failure?.code).toBe(
      "IMAGE_ATTACHMENT_REQUIRES_VISION_CAPABILITY",
    );
    expect(harness.capturedInputs).toHaveLength(0);
    expect(harness.cleanupCalls).toHaveLength(1);
  });

  it("a non-image attachment on a vision-blind adapter is completely unaffected", async () => {
    const harness = buildHarness();
    const { task } = harness.orchestrator.createTask({
      projectId: "project-1",
      title: "Text attachment on a vision-blind adapter",
      adapterId: VISION_BLIND_ADAPTER_ID,
    });
    harness.linkAttachment(task.taskId, {
      attachmentId: "55555555-5555-4555-8555-555555555555",
      filename: "spec.pdf",
      mimeType: "application/pdf",
      byteSize: 1,
      kind: "file",
      bytes: Buffer.from("p"),
    });

    await harness.capturedInputsSignal.wait(1);

    expect(harness.capturedInputs[0]?.attachments?.[0]?.filename).toBe("spec.pdf");
  });

  it("routeAndAssign routes against an injected vision.image requirement but never persists it onto the task record", async () => {
    const harness = buildHarness();
    const { task } = harness.orchestrator.createTask({
      projectId: "project-1",
      title: "Deferred task with an image attachment",
      executionMode: "deferred",
      requirements: {
        requiredCapabilities: ["structured.events"],
        allowedExecutionTrust: ["isolated"],
      },
    });
    harness.linkAttachment(task.taskId, {
      attachmentId: "66666666-6666-4666-8666-666666666666",
      filename: "screenshot.png",
      mimeType: "image/png",
      byteSize: 1,
      kind: "image",
      bytes: Buffer.from("i"),
    });
    harness.orchestrator.transitionTask(task.taskId, { targetStatus: "ready" });

    const result = await harness.orchestrator.routeAndAssign(task.taskId, {});

    // Routed to the vision-verified adapter, not the vision-blind one —
    // proves the injected requirement actually influenced the decision.
    expect(result.record.adapterId).toBe(ISOLATED_ADAPTER_ID);
    // But the persisted requirements are exactly what the operator
    // declared — no synthetic, attachment-derived capability survives
    // into durable state (it would otherwise permanently gate this task
    // even after the image attachment is later deleted).
    expect(result.record.task.requirements?.requiredCapabilities).toEqual(["structured.events"]);
    expect(harness.taskStore.get(task.taskId).task.requirements?.requiredCapabilities).toEqual([
      "structured.events",
    ]);
  });

  it("a non-isolated, text-only task is completely unaffected", async () => {
    const harness = buildHarness();
    harness.orchestrator.createTask({
      projectId: "project-1",
      title: "Non-isolated, text-only task",
      adapterId: NON_ISOLATED_ADAPTER_ID,
    });

    // Reaching `startTask` at all (with no thrown `ATTACHMENT_REQUIRES_ISOLATED_EXECUTION`)
    // is what this test proves — a text-only task on a non-isolated adapter
    // must never be affected by the attachment-materialization gate.
    await harness.capturedInputsSignal.wait(1);

    const input = harness.capturedInputs[0];
    expect(Object.prototype.hasOwnProperty.call(input as object, "attachments")).toBe(false);
  });
});

interface LinkAttachmentInput {
  readonly attachmentId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly kind: "file" | "image";
  readonly bytes?: Buffer;
}

interface Harness {
  orchestrator: TaskOrchestrator;
  readonly taskStore: TaskStore;
  readonly capturedInputs: AgentTaskInput[];
  readonly capturedInputsSignal: CountSignal;
  readonly cleanupCalls: string[];
  readonly cleanupSignal: CountSignal;
  readonly failureSignal: CountSignal;
  lastAgentWorkingDirectory: string | undefined;
  linkAttachment(taskId: string, input: LinkAttachmentInput): void;
  linkAttachmentWithoutBytes(taskId: string, input: Omit<LinkAttachmentInput, "bytes">): void;
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync.native(dir);
}

function buildHarness(
  options: { readonly onExecutionError?: (error: unknown) => void } = {},
): Harness {
  const taskStore = new TaskStore({ maxTasks: 10 });
  const worktreeStore = new InMemoryAgentWorktreeStore();
  const artifactStore = new InMemoryAgentExecutionArtifactStore();
  const boardStore = new BoardStore({ maxBoards: 10, taskStore });
  const messageStore = new MessageStore({ maxMessagesPerBoard: 100 });
  const attachmentBlobStore = new AttachmentBlobStore({
    rootDir: makeTempDir("hall-attachments-blob-"),
  });
  const attachmentMaterializer = new HallTaskAttachmentMaterializer({
    boardStore,
    messageStore,
    blobStore: attachmentBlobStore,
  });

  const capturedInputs: AgentTaskInput[] = [];
  const capturedInputsSignal = new CountSignal();
  const cleanupCalls: string[] = [];
  const cleanupSignal = new CountSignal();
  const failureSignal = new CountSignal();
  const worktreeRoot = makeTempDir("hall-owned-worktrees-");
  const source = makeTempDir("hall-source-");

  const harness: Harness = {
    orchestrator: undefined as unknown as TaskOrchestrator,
    taskStore,
    capturedInputs,
    capturedInputsSignal,
    cleanupCalls,
    cleanupSignal,
    failureSignal,
    lastAgentWorkingDirectory: undefined,
    linkAttachment(taskId, input) {
      if (input.bytes !== undefined) attachmentBlobStore.write(input.attachmentId, input.bytes);
      linkAttachmentMessage(boardStore, messageStore, taskId, input);
    },
    linkAttachmentWithoutBytes(taskId, input) {
      linkAttachmentMessage(boardStore, messageStore, taskId, input);
    },
  };

  const worktreeManager = {
    createWorktree(input: {
      readonly hallTaskId: string;
      readonly hallAgentRunId: string;
      readonly adapterId?: string | undefined;
      readonly agentId?: string | undefined;
    }): Promise<CreateAgentWorktreeResult> {
      const worktreeId = `wt-${input.hallAgentRunId}`;
      const worktreePath = path.join(worktreeRoot, `wt_${worktreeId}`);
      fs.mkdirSync(worktreePath, { recursive: true });
      const creating = worktreeStore.createCreating({
        worktreeId,
        hallTaskId: input.hallTaskId,
        hallAgentRunId: input.hallAgentRunId,
        adapterId: input.adapterId,
        agentId: input.agentId,
        canonicalSourceRepositoryRoot: source,
        sourceWorkingDirectoryRelativePath: ".",
        baseCommit: "a".repeat(40),
        canonicalWorktreePath: fs.realpathSync.native(worktreePath),
        createdAt: NOW,
      });
      const ready = worktreeStore.markReady({
        worktreeId,
        expectedRevision: creating.revision,
        readyAt: NOW,
      });
      harness.lastAgentWorkingDirectory = worktreePath;
      return Promise.resolve({ record: ready, agentWorkingDirectory: worktreePath });
    },
    cleanupWorktree(worktreeId: string): Promise<AgentWorktreeRecord> {
      cleanupCalls.push(worktreeId);
      const record = worktreeStore.get(worktreeId);
      const result = worktreeStore.markCleaned({
        worktreeId,
        expectedRevision: worktreeStore.requestCleanup({
          worktreeId,
          expectedRevision: record.revision,
          now: NOW,
        }).revision,
        now: NOW,
      });
      cleanupSignal.notify();
      return Promise.resolve(result);
    },
  };

  const coordinator = new IsolatedAgentExecutionCoordinator({
    isolationPolicy: new ExplicitAdapterIsolationPolicy([
      ISOLATED_ADAPTER_ID,
      VISION_BLIND_ADAPTER_ID,
    ]),
    worktreeStore,
    worktreeValidator: { validateReadyWorktree: () => Promise.reject(new Error("unused")) },
    worktreeManager,
  });

  const terminalizer = new AgentExecutionArtifactTerminalizer({
    store: artifactStore,
    now: () => "2026-08-15T10:00:05.000Z",
    artifactIdFactory: (() => {
      let count = 0;
      return () => `artifact-${String((count += 1))}`;
    })(),
    gitArtifactCollector: {
      collect(worktreeId: string) {
        const record = worktreeStore.get(worktreeId);
        return Promise.resolve({
          worktreeId,
          hallTaskId: record.hallTaskId,
          hallAgentRunId: record.hallAgentRunId,
          baseCommit: record.baseCommit,
          finalCommit: record.baseCommit,
          changedFiles: [],
          diffSummary: { filesChanged: 0, insertions: 0, deletions: 0 },
        });
      },
    },
  });

  const registry = new AgentRegistry();
  registry.register(recordingAdapter(ISOLATED_ADAPTER_ID, capturedInputs, capturedInputsSignal));
  registry.register(
    recordingAdapter(NON_ISOLATED_ADAPTER_ID, capturedInputs, capturedInputsSignal),
  );
  registry.register(
    recordingAdapter(VISION_BLIND_ADAPTER_ID, capturedInputs, capturedInputsSignal, {
      visionVerified: false,
    }),
  );

  harness.orchestrator = new TaskOrchestrator({
    taskStore,
    eventStore: new EventStore({ maxEventsPerTask: 100 }),
    eventBus: new EventBus({ maxSubscribersPerTask: 10 }),
    registry,
    workspaceRoot: source,
    executionCoordinator: coordinator,
    artifactTerminalizer: terminalizer,
    attachmentMaterializer,
    onExecutionError: (_taskId: string, error: unknown) => {
      options.onExecutionError?.(error);
      failureSignal.notify();
    },
  });

  return harness;
}

function linkAttachmentMessage(
  boardStore: BoardStore,
  messageStore: MessageStore,
  taskId: string,
  input: Omit<LinkAttachmentInput, "bytes">,
): void {
  const boardId = `task:${taskId}`;
  const { board, created } = boardStore.ensureTaskBoard(taskId, NOW);
  if (created) messageStore.registerBoard(board.boardId);
  messageStore.append(boardId, {
    messageId: `msg-${input.attachmentId}`,
    boardId,
    author: { kind: "human", displayName: "Ada" },
    text: `Attached ${input.filename}`,
    attachments: [
      {
        attachmentId: input.attachmentId,
        filename: input.filename,
        mimeType: input.mimeType,
        byteSize: input.byteSize,
        kind: input.kind,
      },
    ],
    createdAt: NOW,
  });
}

function recordingAdapter(
  adapterId: string,
  capturedInputs: AgentTaskInput[],
  capturedInputsSignal: CountSignal,
  options: { readonly visionVerified?: boolean } = {},
): AgentAdapter {
  const visionVerified = options.visionVerified ?? true;
  return {
    descriptor: agentDescriptor(adapterId, adapterId),
    detect(): Promise<AgentDetectionResult> {
      return Promise.resolve({
        installed: true,
        availability: "available",
        executionTrust: "isolated",
        capabilityObservations: [
          {
            capability: "structured.events",
            status: "verified",
            safeSummary: "Test fixture.",
            evidence: "deterministic_test",
          },
          ...(visionVerified
            ? [
                {
                  capability: "vision.image" as const,
                  status: "verified" as const,
                  safeSummary: "Test fixture.",
                  evidence: "environment_probe" as const,
                },
              ]
            : []),
        ],
      });
    },
    startTask(input) {
      capturedInputs.push(input);
      capturedInputsSignal.notify();
      const factory = new EventFactory({
        runId: input.runId,
        taskId: input.hallTask.taskId,
        agentId: input.agentIdentity.agentId,
      });
      async function* events() {
        await Promise.resolve();
        yield factory.runStarted();
        yield factory.runCompleted("done");
      }
      return Promise.resolve({
        runId: input.runId,
        events: events(),
        completion: new Promise(() => {
          // Hall Runner drives completion from the event stream in these tests.
        }),
        currentState: "running",
        cancel(): void {
          // Completes immediately via the event stream above.
        },
      });
    },
  };
}

function agentDescriptor(adapterId: string, displayName: string): AgentAdapterDescriptor {
  return parseAgentAdapterDescriptor({
    adapterId,
    displayName,
    adapterVersion: "0.0.0",
    integrationLevel: "native",
    supportedOperatingSystems: ["windows", "macos", "linux"],
    supportedAgent: {
      agentId: adapterId,
      displayName,
      adapterId,
      adapterVersion: "0.0.0",
    },
    capabilities: {
      streaming: true,
      cancellation: true,
      sessionResume: false,
      toolEvents: true,
      fileEditing: true,
      shellExecution: false,
      subagents: false,
      mcp: false,
      acp: false,
    },
    declaredCapabilities: [],
  });
}
