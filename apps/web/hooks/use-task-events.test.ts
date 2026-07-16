import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTaskEvents } from "./use-task-events";

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
  readonly sent: string[] = [];
  closeCallCount = 0;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCallCount += 1;
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
  }

  // --- test helpers, not part of the real WebSocket API ---

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

function makeEventJson(
  sequence: number,
  overrides: Record<string, unknown> = {},
  runId = "run-1",
  agentId = "agent-1",
  taskId = "task-1",
): string {
  return JSON.stringify({
    protocolVersion: "0.1",
    eventId: `event-${String(sequence)}`,
    runId,
    taskId,
    agentId,
    timestamp: new Date().toISOString(),
    sequence,
    type: "message.delta",
    payload: { text: "progress" },
    ...overrides,
  });
}

function runStartedJson(sequence = 0): string {
  return JSON.stringify({
    protocolVersion: "0.1",
    eventId: `event-${String(sequence)}`,
    runId: "run-1",
    taskId: "task-1",
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
    taskId: "task-1",
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

describe("useTaskEvents", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("connects to the correct task path", () => {
    renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    expect(latestSocket().url).toBe(`${WS_BASE_URL}/api/v1/tasks/task-1/events`);
  });

  it("omits afterSequence before the first event", () => {
    renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    expect(latestSocket().url).not.toContain("afterSequence");
  });

  it("accepts sequence zero", () => {
    const { result } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(runStartedJson(0));
    });
    expect(result.current.events).toHaveLength(1);
    expect(result.current.lastContiguousSequence).toBe(0);
  });

  it("accepts contiguous events", () => {
    const { result } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(runStartedJson(0));
      latestSocket().simulateMessage(makeEventJson(1));
    });
    expect(result.current.events).toHaveLength(2);
    expect(result.current.lastContiguousSequence).toBe(1);
  });

  it("ignores an exact duplicate", () => {
    const { result } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(runStartedJson(0));
      latestSocket().simulateMessage(runStartedJson(0));
    });
    expect(result.current.events).toHaveLength(1);
  });

  it("rejects a same-sequence conflicting event (moves to error state)", () => {
    const { result } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(runStartedJson(0));
      latestSocket().simulateMessage(makeEventJson(0, { eventId: "different" }));
    });
    expect(result.current.connectionState).toBe("error");
    expect(result.current.events).toHaveLength(1);
  });

  it("detects a sequence gap and schedules a reconnect", () => {
    const { result } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(runStartedJson(0));
      latestSocket().simulateMessage(makeEventJson(5));
    });
    expect(result.current.connectionState).toBe("reconnecting");
  });

  it("reconnects with the last contiguous afterSequence after a gap", () => {
    renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(runStartedJson(0));
      latestSocket().simulateMessage(makeEventJson(5));
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(latestSocket().url).toContain("afterSequence=0");
  });

  it("reconnects after close code 4504 (client too slow)", () => {
    const { result } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(runStartedJson(0));
      latestSocket().simulateClose(4504);
    });
    expect(result.current.connectionState).toBe("reconnecting");
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(latestSocket().url).toContain("afterSequence=0");
  });

  it("reconnects after close code 4503 (subscriber limit)", () => {
    const { result } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateClose(4503);
    });
    expect(result.current.connectionState).toBe("reconnecting");
  });

  it("reconnects after abnormal close code 1006", () => {
    const { result } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateClose(1006);
    });
    expect(result.current.connectionState).toBe("reconnecting");
  });

  it("does not retry after close code 4400 (invalid request)", () => {
    const { result } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    const socketCountBefore = FakeWebSocket.instances.length;
    act(() => {
      latestSocket().simulateClose(4400);
    });
    expect(result.current.connectionState).toBe("error");
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(FakeWebSocket.instances.length).toBe(socketCountBefore);
  });

  it("does not retry after close code 4404 (unknown task) and exposes a safe permanent message", () => {
    // Simulates what a client sees reconnecting after Hall Core has
    // restarted: the in-memory task no longer exists on the new process,
    // so the server closes with 4404 and the client must settle into a
    // permanent, safe state rather than reconnecting forever.
    const { result } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    const socketCountBefore = FakeWebSocket.instances.length;
    act(() => {
      latestSocket().simulateClose(4404);
    });
    expect(result.current.connectionState).toBe("error");
    expect(result.current.lastError).toBe("This task no longer exists.");
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(FakeWebSocket.instances.length).toBe(socketCountBefore);
  });

  it("does not retry after close code 4403 (origin not allowed)", () => {
    const { result } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    const socketCountBefore = FakeWebSocket.instances.length;
    act(() => {
      latestSocket().simulateClose(4403);
    });
    expect(result.current.connectionState).toBe("error");
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(FakeWebSocket.instances.length).toBe(socketCountBefore);
  });

  it("does not reconnect after a terminal event followed by a normal (1000) close", () => {
    const { result } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    const socketCountBefore = FakeWebSocket.instances.length;
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(runStartedJson(0));
      latestSocket().simulateMessage(runCompletedJson(1));
      latestSocket().simulateClose(1000);
    });
    expect(result.current.connectionState).toBe("completed");
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(FakeWebSocket.instances.length).toBe(socketCountBefore);
  });

  it("uses a bounded exponential backoff schedule", () => {
    renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    act(() => {
      latestSocket().simulateClose(1006);
    });
    const afterFirst = FakeWebSocket.instances.length;
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(FakeWebSocket.instances.length).toBe(afterFirst); // not yet
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(FakeWebSocket.instances.length).toBe(afterFirst + 1); // fires at 250ms

    act(() => {
      latestSocket().simulateClose(1006);
    });
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(FakeWebSocket.instances.length).toBe(afterFirst + 1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(FakeWebSocket.instances.length).toBe(afterFirst + 2); // fires at 500ms
  });

  it("stops after the maximum number of retries and requires a manual reconnect", () => {
    const { result } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    for (let i = 0; i < 5; i += 1) {
      act(() => {
        latestSocket().simulateClose(1006);
      });
      act(() => {
        vi.runOnlyPendingTimers();
      });
    }
    act(() => {
      latestSocket().simulateClose(1006);
    });
    expect(result.current.connectionState).toBe("disconnected");
  });

  it("resets the retry budget after a reconnect that actually delivers an event, so more than 5 total outages can be survived", () => {
    const { result } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    // Six independent outages, each one actually recovering (the socket
    // opens AND delivers an event) before the next disconnect — this must
    // never exhaust the retry budget, because each real recovery resets
    // the counter. The reset happens on the delivered event, not on
    // `open`, since `open` alone doesn't prove the connection is usable
    // (see the companion test below for why).
    for (let i = 0; i < 6; i += 1) {
      act(() => {
        latestSocket().simulateClose(1006);
      });
      act(() => {
        vi.runOnlyPendingTimers();
      });
      act(() => {
        latestSocket().simulateOpen();
      });
      expect(result.current.connectionState).toBe("connected");
      act(() => {
        latestSocket().simulateMessage(makeEventJson(i));
      });
      expect(result.current.reconnectAttempt).toBe(0);
    }
  });

  it("does not reset the retry budget on open alone, so a server that immediately rejects every connection (e.g. repeated subscriber-limit closes) still exhausts the cap", () => {
    const { result } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    // Hall Core's own checks (subscriber limit, slow-client) run AFTER the
    // WebSocket handshake completes, so `open` can fire immediately before
    // a retryable close. If the retry budget reset on `open`, a server
    // stuck rejecting every connection would let the client reconnect
    // forever at the fastest backoff step instead of ever giving up.
    for (let i = 0; i < 5; i += 1) {
      act(() => {
        latestSocket().simulateOpen();
      });
      act(() => {
        latestSocket().simulateClose(4503);
      });
      act(() => {
        vi.runOnlyPendingTimers();
      });
    }
    act(() => {
      latestSocket().simulateOpen();
    });
    act(() => {
      latestSocket().simulateClose(4503);
    });
    expect(result.current.connectionState).toBe("disconnected");
  });

  it("a manual reconnect works after retries are exhausted", () => {
    const { result } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    for (let i = 0; i < 5; i += 1) {
      act(() => {
        latestSocket().simulateClose(1006);
      });
      act(() => {
        vi.runOnlyPendingTimers();
      });
    }
    act(() => {
      latestSocket().simulateClose(1006);
    });
    expect(result.current.connectionState).toBe("disconnected");
    const countBeforeManual = FakeWebSocket.instances.length;
    act(() => {
      result.current.reconnect();
    });
    expect(FakeWebSocket.instances.length).toBe(countBeforeManual + 1);
    expect(result.current.reconnectAttempt).toBe(0);
  });

  it("closes the old task's socket when the selected task changes", () => {
    const { rerender } = renderHook(
      ({ taskId }: { taskId: string }) => useTaskEvents(taskId, WS_BASE_URL),
      {
        initialProps: { taskId: "task-1" },
      },
    );
    const first = latestSocket();
    act(() => {
      rerender({ taskId: "task-2" });
    });
    expect(first.closeCallCount).toBeGreaterThan(0);
    expect(latestSocket().url).toContain("task-2");
  });

  it("ignores stale callbacks from a socket superseded by a task change", () => {
    const { result, rerender } = renderHook(
      ({ taskId }: { taskId: string }) => useTaskEvents(taskId, WS_BASE_URL),
      { initialProps: { taskId: "task-1" } },
    );
    const first = latestSocket();
    act(() => {
      first.simulateOpen();
    });
    act(() => {
      rerender({ taskId: "task-2" });
    });
    // A message arriving late on the now-superseded socket must not affect state.
    act(() => {
      first.simulateMessage(runStartedJson(0));
    });
    expect(result.current.events).toHaveLength(0);
  });

  it("unmount closes the socket", () => {
    const { unmount } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    const socket = latestSocket();
    act(() => {
      unmount();
    });
    expect(socket.closeCallCount).toBeGreaterThan(0);
  });

  it("unmount clears any pending reconnect timer", () => {
    const { unmount } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    act(() => {
      latestSocket().simulateClose(1006);
    });
    const countAtUnmount = FakeWebSocket.instances.length;
    act(() => {
      unmount();
    });
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(FakeWebSocket.instances.length).toBe(countAtUnmount);
  });

  it("no event listener accumulates across reconnects", () => {
    renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    const first = latestSocket();
    act(() => {
      first.simulateClose(1006);
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    // The superseded socket's handlers must have been cleared.
    expect(first.onopen).toBeNull();
    expect(first.onmessage).toBeNull();
    expect(first.onclose).toBeNull();
  });

  it("rejects invalid JSON without crashing", () => {
    const { result } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage("{not valid json");
    });
    expect(result.current.connectionState).toBe("error");
    expect(result.current.lastError).not.toBeNull();
  });

  it("rejects a message that does not match the protocol event schema", () => {
    const { result } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(JSON.stringify({ nope: true }));
    });
    expect(result.current.connectionState).toBe("error");
  });

  it("rejects a taskId identity mismatch", () => {
    const { result } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(makeEventJson(0, { taskId: "wrong-task" }));
    });
    expect(result.current.connectionState).toBe("error");
  });

  it("rejects a runId identity mismatch after the run is established", () => {
    const { result } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(runStartedJson(0));
      latestSocket().simulateMessage(makeEventJson(1, { runId: "wrong-run" }));
    });
    expect(result.current.connectionState).toBe("error");
  });

  it("rejects an agentId identity mismatch after the run is established", () => {
    const { result } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(runStartedJson(0));
      latestSocket().simulateMessage(makeEventJson(1, { agentId: "wrong-agent" }));
    });
    expect(result.current.connectionState).toBe("error");
  });

  it("calls onTerminalEvent exactly once when a terminal event is accepted", () => {
    const onTerminalEvent = vi.fn();
    renderHook(() => useTaskEvents("task-1", WS_BASE_URL, { onTerminalEvent }));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(runStartedJson(0));
      latestSocket().simulateMessage(runCompletedJson(1));
    });
    expect(onTerminalEvent).toHaveBeenCalledTimes(1);
  });

  it("a duplicate terminal event does not trigger a duplicate refresh", () => {
    const onTerminalEvent = vi.fn();
    renderHook(() => useTaskEvents("task-1", WS_BASE_URL, { onTerminalEvent }));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(runStartedJson(0));
      latestSocket().simulateMessage(runCompletedJson(1));
      latestSocket().simulateMessage(runCompletedJson(1));
    });
    expect(onTerminalEvent).toHaveBeenCalledTimes(1);
  });

  it("never sends a WebSocket message", () => {
    renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(runStartedJson(0));
    });
    expect(latestSocket().sent).toHaveLength(0);
  });

  it("remains idle when taskId is null", () => {
    const { result } = renderHook(() => useTaskEvents(null, WS_BASE_URL));
    expect(result.current.connectionState).toBe("idle");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("transitions through connecting -> connected on open", () => {
    const { result } = renderHook(() => useTaskEvents("task-1", WS_BASE_URL));
    expect(result.current.connectionState).toBe("connecting");
    act(() => {
      latestSocket().simulateOpen();
    });
    expect(result.current.connectionState).toBe("connected");
  });
});
