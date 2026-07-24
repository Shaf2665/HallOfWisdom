import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useComparisonCandidateEvents } from "./use-comparison-candidate-events";

const WS_BASE_URL = "ws://127.0.0.1:4310";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closeCallCount = 0;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(): void {
    // not used by this hook.
  }

  close(): void {
    this.closeCallCount += 1;
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  simulateClose(code: number, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

function runStartedJson(sequence = 0): string {
  return JSON.stringify({
    protocolVersion: "0.1",
    eventId: `event-${String(sequence)}`,
    runId: "run-1",
    taskId: "candidate-a",
    agentId: "agent-1",
    timestamp: new Date().toISOString(),
    sequence,
    type: "run.started",
    payload: {},
  });
}

function runCompletedJson(sequence: number): string {
  return JSON.stringify({
    protocolVersion: "0.1",
    eventId: `event-${String(sequence)}`,
    runId: "run-1",
    taskId: "candidate-a",
    agentId: "agent-1",
    timestamp: new Date().toISOString(),
    sequence,
    type: "run.completed",
    payload: {},
  });
}

function latestSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("no FakeWebSocket instance was created");
  return socket;
}

describe("useComparisonCandidateEvents", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("connects to the comparisonId/candidateId-scoped path", () => {
    renderHook(() => useComparisonCandidateEvents("comparison-1", "candidate-a", WS_BASE_URL));
    expect(latestSocket().url).toBe(
      `${WS_BASE_URL}/api/v1/comparisons/comparison-1/candidates/candidate-a/events`,
    );
  });

  it("stays idle and opens no socket when comparisonId or candidateId is null", () => {
    const { result } = renderHook(() => useComparisonCandidateEvents(null, null, WS_BASE_URL));
    expect(result.current.connectionState).toBe("idle");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("accepts events in order and updates lastContiguousSequence", () => {
    const { result } = renderHook(() =>
      useComparisonCandidateEvents("comparison-1", "candidate-a", WS_BASE_URL),
    );
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(runStartedJson(0));
    });
    expect(result.current.events).toHaveLength(1);
    expect(result.current.lastContiguousSequence).toBe(0);
  });

  it("calls onTerminalEvent exactly once when a terminal event arrives, and marks terminalEventReceived", () => {
    const onTerminalEvent = vi.fn();
    const { result } = renderHook(() =>
      useComparisonCandidateEvents("comparison-1", "candidate-a", WS_BASE_URL, {
        onTerminalEvent,
      }),
    );
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(runStartedJson(0));
      latestSocket().simulateMessage(runCompletedJson(1));
    });
    expect(result.current.terminalEventReceived).toBe(true);
    expect(onTerminalEvent).toHaveBeenCalledTimes(1);
  });

  it("transitions to 'completed' when the socket closes normally after a terminal event", () => {
    const { result } = renderHook(() =>
      useComparisonCandidateEvents("comparison-1", "candidate-a", WS_BASE_URL),
    );
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(runCompletedJson(0));
      latestSocket().simulateClose(1000, "terminal event delivered");
    });
    expect(result.current.connectionState).toBe("completed");
  });

  it("does not retry on a non-retryable close code (4404 unknown candidate) and surfaces a safe error message", () => {
    const { result } = renderHook(() =>
      useComparisonCandidateEvents("comparison-1", "candidate-a", WS_BASE_URL),
    );
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateClose(4404, "unknown candidate");
    });
    expect(result.current.connectionState).toBe("error");
    expect(result.current.lastError).toBe("This candidate no longer exists.");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("reconnects with backoff on an abnormal close, opening a second socket", () => {
    renderHook(() => useComparisonCandidateEvents("comparison-1", "candidate-a", WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateClose(1006, "");
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("reconnects at a new comparisonId/candidateId and resets accumulated events", () => {
    const { result, rerender } = renderHook(
      ({ comparisonId, candidateId }) =>
        useComparisonCandidateEvents(comparisonId, candidateId, WS_BASE_URL),
      { initialProps: { comparisonId: "comparison-1", candidateId: "candidate-a" } },
    );
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(runStartedJson(0));
    });
    expect(result.current.events).toHaveLength(1);

    rerender({ comparisonId: "comparison-1", candidateId: "candidate-b" });
    expect(result.current.events).toHaveLength(0);
    expect(latestSocket().url).toBe(
      `${WS_BASE_URL}/api/v1/comparisons/comparison-1/candidates/candidate-b/events`,
    );
  });
});
