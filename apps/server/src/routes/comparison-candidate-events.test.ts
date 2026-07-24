import { describe, expect, it, vi } from "vitest";
import { ComparisonStore } from "../comparisons/comparison-store.js";
import { EventStore } from "../events/event-store.js";
import { EventBus } from "../events/event-bus.js";
import {
  handleComparisonCandidateEventsConnection,
  CLOSE_CODE_INVALID_QUERY,
  CLOSE_CODE_NORMAL,
  CLOSE_CODE_ORIGIN_NOT_ALLOWED,
  CLOSE_CODE_UNKNOWN_CANDIDATE,
  type ComparisonCandidateEventsRouteDeps,
  type ComparisonCandidateEventsSocket,
} from "./comparison-candidate-events.js";
import type {
  AgentComparisonRecord,
  ComparisonCandidateRecord,
} from "../comparisons/comparison-record.js";

const ALLOWED_ORIGIN = "http://127.0.0.1:3000";

function buildCandidate(candidateId: string): ComparisonCandidateRecord {
  return {
    candidateId,
    adapterId: "hall.mock-agent",
    displayName: "Mock Agent",
    status: "pending",
    executionTrust: undefined,
    runId: undefined,
    agentId: undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    preparedAt: undefined,
    startedAt: undefined,
    completedAt: undefined,
    eventCount: 0,
    lastSequence: undefined,
    terminalEventType: undefined,
    failure: undefined,
    cancellationRequested: false,
    resultEvidence: undefined,
    safeFailureReason: undefined,
  };
}

function buildComparisonRecord(
  comparisonId: string,
  candidateIds: readonly [string, string],
): AgentComparisonRecord {
  return {
    comparisonId,
    sourceTaskId: "task-1",
    title: "Compare agents",
    description: "",
    priority: "normal",
    requirements: undefined,
    baseCommit: undefined,
    status: "draft",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    preparedAt: undefined,
    candidates: [buildCandidate(candidateIds[0]), buildCandidate(candidateIds[1])],
    cleanupStatus: "not_started",
    cleanupError: undefined,
    prepareFailureCode: undefined,
    prepareFailureReason: undefined,
    preference: undefined,
  };
}

function buildFakeSocket(): ComparisonCandidateEventsSocket & {
  closeCode: number | undefined;
  closeReason: string | undefined;
  readonly sendMock: ReturnType<typeof vi.fn>;
} {
  const listeners = new Map<string, (() => void)[]>();
  const state = {
    closeCode: undefined as number | undefined,
    closeReason: undefined as string | undefined,
  };
  const sendMock = vi.fn();
  const socket = {
    bufferedAmount: 0,
    get closeCode() {
      return state.closeCode;
    },
    get closeReason() {
      return state.closeReason;
    },
    sendMock,
    send: sendMock,
    close(code: number | undefined, reason: string | undefined) {
      state.closeCode = code;
      state.closeReason = reason;
    },
    on(event: "message" | "close" | "error", listener: () => void) {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
      return socket;
    },
  };
  return socket;
}

function buildDeps(): ComparisonCandidateEventsRouteDeps {
  const comparisonStore = new ComparisonStore({ maxComparisons: 10 });
  const eventStore = new EventStore({ maxEventsPerTask: 50 });
  const eventBus = new EventBus({ maxSubscribersPerTask: 5 });
  return {
    comparisonStore,
    eventStore,
    eventBus,
    maxBufferedBytes: 1024,
    allowedOrigin: ALLOWED_ORIGIN,
  };
}

describe("handleComparisonCandidateEventsConnection", () => {
  it("closes with 4404 when the comparisonId does not exist", () => {
    const deps = buildDeps();
    const socket = buildFakeSocket();

    handleComparisonCandidateEventsConnection(
      socket,
      {
        comparisonId: "missing",
        candidateId: "candidate-a",
        afterSequenceRaw: undefined,
        originRaw: ALLOWED_ORIGIN,
      },
      deps,
    );

    expect(socket.closeCode).toBe(CLOSE_CODE_UNKNOWN_CANDIDATE);
  });

  it("closes with 4404 when candidateId does not belong to the given comparisonId", () => {
    const deps = buildDeps();
    deps.comparisonStore.add(buildComparisonRecord("comparison-1", ["candidate-a", "candidate-b"]));
    const socket = buildFakeSocket();

    handleComparisonCandidateEventsConnection(
      socket,
      {
        comparisonId: "comparison-1",
        candidateId: "candidate-from-a-different-comparison",
        afterSequenceRaw: undefined,
        originRaw: ALLOWED_ORIGIN,
      },
      deps,
    );

    expect(socket.closeCode).toBe(CLOSE_CODE_UNKNOWN_CANDIDATE);
  });

  it("closes with 4403 when the Origin header is not the allowed origin", () => {
    const deps = buildDeps();
    deps.comparisonStore.add(buildComparisonRecord("comparison-1", ["candidate-a", "candidate-b"]));
    const socket = buildFakeSocket();

    handleComparisonCandidateEventsConnection(
      socket,
      {
        comparisonId: "comparison-1",
        candidateId: "candidate-a",
        afterSequenceRaw: undefined,
        originRaw: "http://evil.example.com",
      },
      deps,
    );

    expect(socket.closeCode).toBe(CLOSE_CODE_ORIGIN_NOT_ALLOWED);
  });

  it("closes with 4400 for a negative afterSequence", () => {
    const deps = buildDeps();
    deps.comparisonStore.add(buildComparisonRecord("comparison-1", ["candidate-a", "candidate-b"]));
    const socket = buildFakeSocket();

    handleComparisonCandidateEventsConnection(
      socket,
      {
        comparisonId: "comparison-1",
        candidateId: "candidate-a",
        afterSequenceRaw: "-1",
        originRaw: ALLOWED_ORIGIN,
      },
      deps,
    );

    expect(socket.closeCode).toBe(CLOSE_CODE_INVALID_QUERY);
  });

  it("subscribes and replays stored history for a valid comparisonId/candidateId pair", () => {
    const deps = buildDeps();
    deps.comparisonStore.add(buildComparisonRecord("comparison-1", ["candidate-a", "candidate-b"]));
    deps.eventStore.append(
      "candidate-a",
      {
        protocolVersion: "0.1",
        eventId: "event-1",
        runId: "run-1",
        taskId: "candidate-a",
        agentId: "agent-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        sequence: 0,
        type: "run.started",
        payload: {},
      },
      { runId: "run-1", taskId: "candidate-a", agentId: "agent-1" },
    );
    const socket = buildFakeSocket();

    handleComparisonCandidateEventsConnection(
      socket,
      {
        comparisonId: "comparison-1",
        candidateId: "candidate-a",
        afterSequenceRaw: undefined,
        originRaw: ALLOWED_ORIGIN,
      },
      deps,
    );

    expect(socket.closeCode).toBeUndefined();
    expect(socket.sendMock).toHaveBeenCalledTimes(1);
    expect(deps.eventBus.subscriberCount("candidate-a")).toBe(1);
  });

  it("closes with 1000 immediately after replaying a stored terminal event", () => {
    const deps = buildDeps();
    deps.comparisonStore.add(buildComparisonRecord("comparison-1", ["candidate-a", "candidate-b"]));
    deps.eventStore.append(
      "candidate-a",
      {
        protocolVersion: "0.1",
        eventId: "event-1",
        runId: "run-1",
        taskId: "candidate-a",
        agentId: "agent-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        sequence: 0,
        type: "run.completed",
        payload: {},
      },
      { runId: "run-1", taskId: "candidate-a", agentId: "agent-1" },
    );
    const socket = buildFakeSocket();

    handleComparisonCandidateEventsConnection(
      socket,
      {
        comparisonId: "comparison-1",
        candidateId: "candidate-a",
        afterSequenceRaw: undefined,
        originRaw: ALLOWED_ORIGIN,
      },
      deps,
    );

    expect(socket.closeCode).toBe(CLOSE_CODE_NORMAL);
    expect(deps.eventBus.subscriberCount("candidate-a")).toBe(0);
  });
});
