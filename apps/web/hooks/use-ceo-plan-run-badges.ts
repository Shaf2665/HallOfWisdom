"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getCeoPlanRun, listCeoPlanRuns } from "../lib/api-client";
import type { CeoPlanExecutionMode, CeoPlanStepExecutionStatus } from "../lib/api-schemas";

const ACTIVE_POLL_INTERVAL_MS = 3000;
const IDLE_POLL_INTERVAL_MS = 15000;

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

export interface CeoPlanRunBadge {
  readonly runId: string;
  readonly planId: string;
  readonly executionMode: CeoPlanExecutionMode;
  readonly stepStatus: CeoPlanStepExecutionStatus;
}

/** `childTaskId -> CeoPlanRunBadge`, for every step execution belonging to a still-active (non-terminal) run. */
export type CeoPlanRunBadgeMap = ReadonlyMap<string, CeoPlanRunBadge>;

/**
 * Kanban badge feed for Phase-15 autonomous execution (kickoff §6): the
 * board itself has no notion of CEO plans or execution runs, so this hook
 * derives a small `childTaskId -> badge` lookup by listing active runs and
 * fetching each one's step executions — never a source of truth for task
 * status itself (`useKanbanTasks` remains that), purely an annotation
 * layer a card can consult to show it is under autonomous management.
 * Same poll cadence as `useKanbanTasks` (active/idle, paused while hidden)
 * so the two stay roughly in sync without opening a WebSocket of their own
 * — the Kanban board deliberately opens none (see `KanbanBoard`'s own
 * doc comment).
 */
export function useCeoPlanRunBadges(baseUrl: string): CeoPlanRunBadgeMap {
  const [badges, setBadges] = useState<CeoPlanRunBadgeMap>(new Map());

  const hasActiveRunRef = useRef(false);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const scheduleNext = useCallback(() => {
    clearPollTimer();
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    const delay = hasActiveRunRef.current ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
    pollTimerRef.current = setTimeout(() => {
      pollTimerRef.current = null;
      void loadRef.current();
    }, delay);
  }, [clearPollTimer]);

  const load = useCallback((): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const generation = ++generationRef.current;

    return listCeoPlanRuns(baseUrl, { signal: controller.signal })
      .then(async ({ runs }) => {
        const activeRuns = runs.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status));
        hasActiveRunRef.current = activeRuns.length > 0;
        if (activeRuns.length === 0) {
          if (generationRef.current !== generation) return;
          setBadges(new Map());
          return;
        }
        const details = await Promise.all(
          activeRuns.map((run) =>
            getCeoPlanRun(baseUrl, run.id, { signal: controller.signal }).catch(() => null),
          ),
        );
        if (generationRef.current !== generation) return;
        const next = new Map<string, CeoPlanRunBadge>();
        for (const detail of details) {
          if (!detail) continue;
          for (const step of detail.stepExecutions) {
            next.set(step.childTaskId, {
              runId: detail.run.id,
              planId: detail.run.planId,
              executionMode: detail.run.executionMode,
              stepStatus: step.status,
            });
          }
        }
        setBadges(next);
      })
      .catch(() => {
        // Never clears already-loaded badges on a transient failure — this
        // is an annotation layer, not a source of truth; a stale badge is
        // far less harmful than one flickering away on every failed poll.
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
    void load();

    function handleVisibilityOrFocus(): void {
      if (document.visibilityState === "hidden") {
        clearPollTimer();
        return;
      }
      void loadRef.current();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl]);

  return badges;
}
