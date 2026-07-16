"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { listTasks } from "../lib/api-client";
import type { TaskRecord } from "../lib/api-schemas";

const ACTIVE_POLL_INTERVAL_MS = 3000;
const IDLE_POLL_INTERVAL_MS = 15000;

export type KanbanTasksState = "loading" | "ready" | "error";

export interface UseKanbanTasksResult {
  readonly tasks: readonly TaskRecord[];
  readonly state: KanbanTasksState;
  /** A bounded, safe warning shown alongside the last-known task list — never clears existing cards. */
  readonly warning: string | null;
  /** Re-fetches immediately and resets the poll schedule. Call after every transition/assignment/start/cancellation. */
  readonly refresh: () => void;
}

/**
 * Hall Core remains authoritative: this hook only ever reflects
 * `GET /api/v1/tasks`, never optimistic local state. Polls at
 * `ACTIVE_POLL_INTERVAL_MS` while at least one task is `assigned` or
 * `running`, `IDLE_POLL_INTERVAL_MS` otherwise; pauses entirely while the
 * document is hidden and refreshes immediately on visibility/focus
 * regain. See `docs/architecture/0006-kanban-board.md`, "Polling
 * strategy".
 */
export function useKanbanTasks(baseUrl: string): UseKanbanTasksResult {
  const [tasks, setTasks] = useState<readonly TaskRecord[]>([]);
  const [state, setState] = useState<KanbanTasksState>("loading");
  const [warning, setWarning] = useState<string | null>(null);

  const tasksRef = useRef<readonly TaskRecord[]>([]);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRef = useRef<() => void>(() => undefined);

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const scheduleNext = useCallback(() => {
    clearPollTimer();
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    const hasActiveTask = tasksRef.current.some(
      (record) => record.task.status === "assigned" || record.task.status === "running",
    );
    const delay = hasActiveTask ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
    pollTimerRef.current = setTimeout(() => {
      pollTimerRef.current = null;
      loadRef.current();
    }, delay);
  }, [clearPollTimer]);

  const load = useCallback(() => {
    // Superseding an in-flight request (rather than letting two overlap)
    // is what "no overlapping list requests" and "stale responses are
    // ignored" both reduce to: only the request tied to the current
    // generation is ever allowed to update state.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const generation = ++generationRef.current;

    listTasks(baseUrl, { signal: controller.signal })
      .then((response) => {
        if (generationRef.current !== generation) return;
        tasksRef.current = response.tasks;
        setTasks(response.tasks);
        setState("ready");
        setWarning(null);
      })
      .catch(() => {
        if (generationRef.current !== generation || controller.signal.aborted) return;
        // Never clears already-loaded cards — only a bounded warning, and
        // only surfaces "error" state if nothing has ever loaded yet.
        setWarning("Could not refresh the task list. Showing the last known tasks.");
        setState((current) => (current === "loading" ? "error" : current));
      })
      .finally(() => {
        if (generationRef.current !== generation) return;
        scheduleNext();
      });
  }, [baseUrl, scheduleNext]);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    load();

    function handleVisibilityOrFocus(): void {
      if (document.visibilityState === "hidden") {
        clearPollTimer();
        return;
      }
      loadRef.current();
    }

    document.addEventListener("visibilitychange", handleVisibilityOrFocus);
    window.addEventListener("focus", handleVisibilityOrFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
      window.removeEventListener("focus", handleVisibilityOrFocus);
      clearPollTimer();
      abortRef.current?.abort();
      generationRef.current += 1;
    };
    // Deliberately re-runs only when `baseUrl` changes (via `load`'s own
    // dependency) — mirrors the Phase 6 WebSocket hook's mount-effect
    // pattern for the same reason: this synchronizes with an external
    // resource keyed on an external identity, not derived render state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl]);

  return { tasks, state, warning, refresh: load };
}
