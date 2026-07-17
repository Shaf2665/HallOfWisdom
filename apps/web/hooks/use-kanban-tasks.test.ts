import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useKanbanTasks } from "./use-kanban-tasks";
import * as apiClient from "../lib/api-client";
import type { TaskRecord } from "../lib/api-schemas";

vi.mock("../lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/api-client")>("../lib/api-client");
  return { ...actual, listTasks: vi.fn() };
});

const BASE_URL = "http://127.0.0.1:4310";

function makeTask(overrides: Partial<TaskRecord["task"]> = {}): TaskRecord {
  const now = new Date().toISOString();
  return {
    task: {
      taskId: "task-1",
      projectId: "project-1",
      title: "Test",
      description: "",
      priority: "normal",
      status: "backlog",
      dependencyTaskIds: [],
      createdAt: now,
      updatedAt: now,
      ...overrides,
    },
    eventCount: 0,
    cancellationRequested: false,
    createdAt: now,
  };
}

/** Flushes pending microtasks (Promise .then/.finally chains) without advancing fake timers. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useKanbanTasks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(apiClient.listTasks).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("loads tasks on mount", async () => {
    vi.mocked(apiClient.listTasks).mockResolvedValue({ tasks: [makeTask()] });
    const { result } = renderHook(() => useKanbanTasks(BASE_URL));
    await flush();
    expect(result.current.state).toBe("ready");
    expect(result.current.tasks).toHaveLength(1);
  });

  it("polls at the active interval (3s) when a task is assigned or running", async () => {
    vi.mocked(apiClient.listTasks).mockResolvedValue({
      tasks: [makeTask({ status: "running" })],
    });
    renderHook(() => useKanbanTasks(BASE_URL));
    await flush();
    expect(apiClient.listTasks).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2999);
    });
    expect(apiClient.listTasks).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await flush();
    expect(apiClient.listTasks).toHaveBeenCalledTimes(2);
  });

  it("polls at the idle interval (15s) when nothing is assigned or running", async () => {
    vi.mocked(apiClient.listTasks).mockResolvedValue({
      tasks: [makeTask({ status: "backlog" })],
    });
    renderHook(() => useKanbanTasks(BASE_URL));
    await flush();
    expect(apiClient.listTasks).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(14999);
    });
    expect(apiClient.listTasks).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await flush();
    expect(apiClient.listTasks).toHaveBeenCalledTimes(2);
  });

  it("pauses polling while the document is hidden", async () => {
    vi.mocked(apiClient.listTasks).mockResolvedValue({ tasks: [] });
    renderHook(() => useKanbanTasks(BASE_URL));
    await flush();
    const callsBefore = vi.mocked(apiClient.listTasks).mock.calls.length;

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(apiClient.listTasks).toHaveBeenCalledTimes(callsBefore);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  it("refreshes immediately when visibility is restored", async () => {
    vi.mocked(apiClient.listTasks).mockResolvedValue({ tasks: [] });
    renderHook(() => useKanbanTasks(BASE_URL));
    await flush();
    const callsBefore = vi.mocked(apiClient.listTasks).mock.calls.length;

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(apiClient.listTasks).toHaveBeenCalledTimes(callsBefore + 1);
  });

  it("refreshes on window focus", async () => {
    vi.mocked(apiClient.listTasks).mockResolvedValue({ tasks: [] });
    renderHook(() => useKanbanTasks(BASE_URL));
    await flush();
    const callsBefore = vi.mocked(apiClient.listTasks).mock.calls.length;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(apiClient.listTasks).toHaveBeenCalledTimes(callsBefore + 1);
  });

  it("manual refresh() re-fetches immediately", async () => {
    vi.mocked(apiClient.listTasks).mockResolvedValue({ tasks: [] });
    const { result } = renderHook(() => useKanbanTasks(BASE_URL));
    await flush();
    const callsBefore = vi.mocked(apiClient.listTasks).mock.calls.length;

    act(() => {
      void result.current.refresh();
    });
    await flush();
    expect(apiClient.listTasks).toHaveBeenCalledTimes(callsBefore + 1);
  });

  it("does not overwrite the list with a stale (superseded) response", async () => {
    vi.mocked(apiClient.listTasks).mockResolvedValue({
      tasks: [makeTask({ taskId: "task-mount" })],
    });
    const { result } = renderHook(() => useKanbanTasks(BASE_URL));
    await flush();
    expect(result.current.tasks.map((t) => t.task.taskId)).toEqual(["task-mount"]);

    let resolveStale: (value: { tasks: TaskRecord[] }) => void = () => undefined;
    const stale = new Promise<{ tasks: TaskRecord[] }>((resolve) => {
      resolveStale = resolve;
    });
    vi.mocked(apiClient.listTasks).mockReturnValueOnce(stale);
    act(() => {
      void result.current.refresh();
    });
    await flush();
    // The stale request is still pending — a second, newer refresh supersedes it.
    vi.mocked(apiClient.listTasks).mockResolvedValueOnce({
      tasks: [makeTask({ taskId: "task-new" })],
    });
    act(() => {
      void result.current.refresh();
    });
    await flush();
    expect(result.current.tasks.map((t) => t.task.taskId)).toEqual(["task-new"]);

    // The stale response now arrives late — must not overwrite the newer result.
    await act(async () => {
      resolveStale({ tasks: [makeTask({ taskId: "task-stale" })] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.tasks.map((t) => t.task.taskId)).toEqual(["task-new"]);
  });

  it("keeps the last-known tasks and shows a bounded warning on a failed refresh, without clearing existing cards", async () => {
    vi.mocked(apiClient.listTasks).mockResolvedValueOnce({ tasks: [makeTask()] });
    const { result } = renderHook(() => useKanbanTasks(BASE_URL));
    await flush();
    expect(result.current.tasks).toHaveLength(1);

    vi.mocked(apiClient.listTasks).mockRejectedValueOnce(
      new apiClient.ApiClientError("NETWORK_ERROR", "offline"),
    );
    act(() => {
      void result.current.refresh();
    });
    await flush();

    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.warning).not.toBeNull();
  });

  it("clears the timer and aborts the in-flight request on unmount", async () => {
    const abortSpy = vi.fn();
    vi.mocked(apiClient.listTasks).mockImplementation(
      (_baseUrl: string, options?: { signal?: AbortSignal | undefined }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            abortSpy();
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const { unmount } = renderHook(() => useKanbanTasks(BASE_URL));
    unmount();
    expect(abortSpy).toHaveBeenCalled();

    const callsAtUnmount = vi.mocked(apiClient.listTasks).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(apiClient.listTasks).toHaveBeenCalledTimes(callsAtUnmount);
  });

  it("does not accumulate visibilitychange listeners across remounts", async () => {
    vi.mocked(apiClient.listTasks).mockResolvedValue({ tasks: [] });
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");

    const { unmount } = renderHook(() => useKanbanTasks(BASE_URL));
    await flush();
    const addCount = addSpy.mock.calls.filter((call) => call[0] === "visibilitychange").length;
    unmount();
    const removeCount = removeSpy.mock.calls.filter(
      (call) => call[0] === "visibilitychange",
    ).length;
    expect(removeCount).toBe(addCount);
  });
});
