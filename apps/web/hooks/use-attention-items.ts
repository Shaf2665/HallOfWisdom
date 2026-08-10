"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { listCeoPlanRuns, listCeoPlans, listTasks } from "../lib/api-client";
import { deriveAttentionItems, type AttentionItem } from "../lib/attention";

const ACTIVE_POLL_INTERVAL_MS = 3000;
const IDLE_POLL_INTERVAL_MS = 15000;

/**
 * Same visibility-aware active/idle poll skeleton as `useCeoPlanRunBadges` —
 * no new polling mechanism. "Active" here means at least one item currently
 * needs attention, so a just-resolved item disappears promptly.
 */
export function useAttentionItems(baseUrl: string): readonly AttentionItem[] {
  const [items, setItems] = useState<readonly AttentionItem[]>([]);

  const hasItemsRef = useRef(false);
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
    const delay = hasItemsRef.current ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
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

    return Promise.all([
      listTasks(baseUrl, { signal: controller.signal }),
      listCeoPlans(baseUrl, { signal: controller.signal }),
      listCeoPlanRuns(baseUrl, { signal: controller.signal }),
    ])
      .then(([{ tasks }, { plans }, { runs }]) => {
        if (generationRef.current !== generation) return;
        const next = deriveAttentionItems(tasks, plans, runs);
        hasItemsRef.current = next.length > 0;
        setItems(next);
      })
      .catch(() => {
        // Annotation layer, not a source of truth — keep the last-known list on a transient failure.
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

  return items;
}
