import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useBoardMessages } from "./use-board-messages";

const WS_BASE_URL = "ws://127.0.0.1:4310";
const BOARD_ID = "hall.general";

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

function messageJson(sequence: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    messageId: `msg-${String(sequence)}`,
    boardId: BOARD_ID,
    sequence,
    author: { kind: "human", displayName: "Local Operator" },
    text: `message ${String(sequence)}`,
    createdAt: "2026-07-15T12:00:00.000Z",
    ...overrides,
  });
}

function latestSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("no FakeWebSocket instance was created");
  return socket;
}

describe("useBoardMessages", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("connects to the correct board path", () => {
    renderHook(() => useBoardMessages(BOARD_ID, WS_BASE_URL));
    expect(latestSocket().url).toBe(`${WS_BASE_URL}/api/v1/boards/${BOARD_ID}/messages/live`);
  });

  it("omits afterSequence before the first message", () => {
    renderHook(() => useBoardMessages(BOARD_ID, WS_BASE_URL));
    expect(latestSocket().url).not.toContain("afterSequence");
  });

  it("uses afterSequence once a message has been accepted, on reconnect", () => {
    renderHook(() => useBoardMessages(BOARD_ID, WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(messageJson(0));
      latestSocket().simulateClose(1006);
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(latestSocket().url).toContain("afterSequence=0");
  });

  it("accepts sequence zero", () => {
    const { result } = renderHook(() => useBoardMessages(BOARD_ID, WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(messageJson(0));
    });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.lastContiguousSequence).toBe(0);
  });

  it("accepts contiguous messages", () => {
    const { result } = renderHook(() => useBoardMessages(BOARD_ID, WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(messageJson(0));
      latestSocket().simulateMessage(messageJson(1));
    });
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.lastContiguousSequence).toBe(1);
  });

  it("ignores an exact duplicate", () => {
    const { result } = renderHook(() => useBoardMessages(BOARD_ID, WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(messageJson(0));
      latestSocket().simulateMessage(messageJson(0));
    });
    expect(result.current.messages).toHaveLength(1);
  });

  it("rejects a same-sequence conflicting message (moves to error state)", () => {
    const { result } = renderHook(() => useBoardMessages(BOARD_ID, WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(messageJson(0));
      latestSocket().simulateMessage(messageJson(0, { messageId: "different" }));
    });
    expect(result.current.connectionState).toBe("error");
    expect(result.current.messages).toHaveLength(1);
  });

  it("detects a sequence gap and schedules a reconnect", () => {
    const { result } = renderHook(() => useBoardMessages(BOARD_ID, WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(messageJson(0));
      latestSocket().simulateMessage(messageJson(5));
    });
    expect(result.current.connectionState).toBe("reconnecting");
  });

  it("reconnects after close code 4504 (client too slow)", () => {
    const { result } = renderHook(() => useBoardMessages(BOARD_ID, WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateClose(4504);
    });
    expect(result.current.connectionState).toBe("reconnecting");
  });

  it("reconnects after close code 4503 (subscriber limit) with bounded backoff", () => {
    const { result } = renderHook(() => useBoardMessages(BOARD_ID, WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateClose(4503);
    });
    expect(result.current.connectionState).toBe("reconnecting");
    act(() => {
      vi.advanceTimersByTime(249);
    });
    const before = FakeWebSocket.instances.length;
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(FakeWebSocket.instances.length).toBe(before + 1);
  });

  it("reconnects after abnormal close code 1006", () => {
    const { result } = renderHook(() => useBoardMessages(BOARD_ID, WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateClose(1006);
    });
    expect(result.current.connectionState).toBe("reconnecting");
  });

  it("does not retry after close code 4400 (invalid request)", () => {
    const { result } = renderHook(() => useBoardMessages(BOARD_ID, WS_BASE_URL));
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

  it("does not retry after close code 4404 (unknown board) and exposes a safe permanent message", () => {
    const { result } = renderHook(() => useBoardMessages(BOARD_ID, WS_BASE_URL));
    const socketCountBefore = FakeWebSocket.instances.length;
    act(() => {
      latestSocket().simulateClose(4404);
    });
    expect(result.current.connectionState).toBe("error");
    expect(result.current.lastError).toBe("This board no longer exists.");
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(FakeWebSocket.instances.length).toBe(socketCountBefore);
  });

  it("does not retry after close code 4403 (origin not allowed)", () => {
    const { result } = renderHook(() => useBoardMessages(BOARD_ID, WS_BASE_URL));
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

  it("reconnects even after a normal (1000) close — a board discussion has no terminal state", () => {
    const { result } = renderHook(() => useBoardMessages(BOARD_ID, WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(messageJson(0));
      latestSocket().simulateClose(1000);
    });
    expect(result.current.connectionState).toBe("reconnecting");
  });

  it("stops after the maximum number of retries and requires a manual reconnect", () => {
    const { result } = renderHook(() => useBoardMessages(BOARD_ID, WS_BASE_URL));
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

  it("a manual reconnect works after retries are exhausted", () => {
    const { result } = renderHook(() => useBoardMessages(BOARD_ID, WS_BASE_URL));
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
    act(() => {
      result.current.reconnect();
    });
    expect(result.current.connectionState).toBe("connecting");
    expect(result.current.reconnectAttempt).toBe(0);
  });

  it("closes the previous socket and opens a new one when boardId changes", () => {
    const { rerender } = renderHook(({ boardId }) => useBoardMessages(boardId, WS_BASE_URL), {
      initialProps: { boardId: BOARD_ID },
    });
    const first = latestSocket();
    rerender({ boardId: "task:task-1" });
    expect(first.closeCallCount).toBeGreaterThan(0);
    expect(latestSocket().url).toContain(encodeURIComponent("task:task-1"));
  });

  it("ignores a message delivered after boardId changes (stale callback)", () => {
    const { result, rerender } = renderHook(
      ({ boardId }) => useBoardMessages(boardId, WS_BASE_URL),
      { initialProps: { boardId: BOARD_ID } },
    );
    const staleSocket = latestSocket();
    rerender({ boardId: "task:task-1" });
    act(() => {
      staleSocket.simulateMessage(messageJson(0));
    });
    expect(result.current.messages).toHaveLength(0);
  });

  it("clears the socket and timers on unmount", () => {
    const { unmount } = renderHook(() => useBoardMessages(BOARD_ID, WS_BASE_URL));
    act(() => {
      latestSocket().simulateClose(1006);
    });
    unmount();
    const socketCountBefore = FakeWebSocket.instances.length;
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(FakeWebSocket.instances.length).toBe(socketCountBefore);
  });

  it("never sends data over the socket", () => {
    renderHook(() => useBoardMessages(BOARD_ID, WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage(messageJson(0));
    });
    expect(latestSocket().sent).toHaveLength(0);
  });

  it("stays idle and opens no socket when boardId is null", () => {
    const { result } = renderHook(() => useBoardMessages(null, WS_BASE_URL));
    expect(result.current.connectionState).toBe("idle");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("never renders an invalid message", () => {
    const { result } = renderHook(() => useBoardMessages(BOARD_ID, WS_BASE_URL));
    act(() => {
      latestSocket().simulateOpen();
      latestSocket().simulateMessage("not valid json");
    });
    expect(result.current.messages).toHaveLength(0);
  });
});
