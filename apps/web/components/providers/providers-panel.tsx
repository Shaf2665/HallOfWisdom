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
 * Phase 17.2 — onboarding/troubleshooting view for the two providers with
 * a real login flow (Claude Code, Codex). Distinct from the `/agents`
 * capability-comparison page (unmodified by this phase): this page never
 * shows Mock Agent, shows a two-state Connected/Not-connected headline
 * instead of a technical availability table, and adds mutating Connect
 * (client-only guidance, no server call)/Recheck actions that `/agents`
 * deliberately never has.
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
        setAdapters(response.adapters.filter((adapter) => isKnownProviderAdapter(adapter.adapterId)));
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
          Claude Code is the recommended default provider. Hall never collects your password, API
          key, or login session — sign-in always happens through each provider&apos;s own official
          command in your own terminal.
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
