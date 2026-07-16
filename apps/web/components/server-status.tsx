"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getHealth } from "../lib/api-client";

type Status = "checking" | "online" | "offline";

/** Deliberately infrequent — this is a presence check, not a monitoring dashboard. */
const POLL_INTERVAL_MS = 30000;
const HEALTH_TIMEOUT_MS = 4000;

export function ServerStatus({ baseUrl }: { readonly baseUrl: string }) {
  const [status, setStatus] = useState<Status>("checking");
  const [protocolVersion, setProtocolVersion] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const check = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus((current) => (current === "online" ? current : "checking"));

    getHealth(baseUrl, { signal: controller.signal, timeoutMs: HEALTH_TIMEOUT_MS })
      .then((health) => {
        if (controller.signal.aborted) return;
        setStatus("online");
        setProtocolVersion(health.protocolVersion);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setStatus("offline");
        setProtocolVersion(null);
      });
  }, [baseUrl]);

  // Checks Hall Core's health on mount and on a low-frequency interval —
  // synchronizing with an external system, not deriving render state.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    check();
    const interval = setInterval(check, POLL_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
    };
  }, [check]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <div className="flex items-center gap-3" aria-live="polite">
      <span className="flex items-center gap-2 text-sm font-medium">
        <span
          aria-hidden="true"
          className={`inline-block h-2.5 w-2.5 rounded-full ${
            status === "online"
              ? "bg-emerald-500"
              : status === "offline"
                ? "bg-red-500"
                : "bg-amber-400"
          }`}
        />
        Hall Core:{" "}
        {status === "checking" ? "Checking…" : status === "online" ? "Online" : "Offline"}
      </span>
      {status === "online" && protocolVersion ? (
        <span className="text-xs text-stone-500 dark:text-stone-400">
          protocol v{protocolVersion}
        </span>
      ) : null}
      {status === "offline" ? (
        <button
          type="button"
          onClick={check}
          className="rounded border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
