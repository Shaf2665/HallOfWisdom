"use client";

import { useEffect, useState } from "react";
import { ApiClientError, listAdapters } from "../../lib/api-client";
import type { AdapterSummary } from "../../lib/api-schemas";
import { isKnownProviderAdapter } from "./provider-status";
import { ProviderCard } from "./provider-card";

function safeMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "Could not load providers.";
}

/**
 * Onboarding/troubleshooting view for Claude Code, Codex, and Hermes
 * Router. Distinct from the `/agents` capability-comparison page: this
 * page never shows Mock Agent, keeps connection status server-driven,
 * and offers only local guidance plus the existing Recheck action.
 */
export function ProvidersPanel({ baseUrl }: { readonly baseUrl: string }) {
  const [adapters, setAdapters] = useState<readonly AdapterSummary[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listAdapters(baseUrl, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setAdapters(
          response.adapters.filter((adapter) => isKnownProviderAdapter(adapter.adapterId)),
        );
        setState("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setErrorMessage(safeMessage(error));
        setState("error");
      });
    return () => {
      controller.abort();
    };
  }, [baseUrl]);

  function handleUpdated(updated: AdapterSummary) {
    setAdapters((current) =>
      current.map((adapter) => (adapter.adapterId === updated.adapterId ? updated : adapter)),
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700 dark:border-stone-800 dark:bg-stone-950/40 dark:text-stone-300">
        <p>
          Claude Code is the recommended default provider. Claude Code and Codex sign in through
          their official CLI flows. Hermes Router uses configuration from the environment that
          starts Hall Core. This page never asks for or stores your credentials.
        </p>
      </div>

      {state === "loading" ? (
        <p role="status" className="text-sm text-stone-500">
          Loading providers…
        </p>
      ) : state === "error" ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {errorMessage}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {adapters.map((adapter) => (
            <ProviderCard
              key={adapter.adapterId}
              baseUrl={baseUrl}
              adapter={adapter}
              onUpdated={handleUpdated}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
