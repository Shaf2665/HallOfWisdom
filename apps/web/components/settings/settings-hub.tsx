"use client";

import { useEffect, useState } from "react";
import { getSystemStorage, listAdapters } from "../../lib/api-client";
import type { AdapterSummary, SystemStorageResponse } from "../../lib/api-schemas";
import {
  deriveConnectionState,
  HERMES_ROUTER_ADAPTER_ID,
  isKnownProviderAdapter,
} from "../providers/provider-status";
import { ProvidersPanel } from "../providers/providers-panel";
import { StorageStatus } from "../system/storage-status";
import { HermesRouterSettings } from "./hermes-router-settings";

/**
 * Feature 8 — the simplified nav's "Settings" destination. Shows a
 * three-line beginner readiness summary per provider ("Claude Code —
 * Ready") derived from the same `deriveConnectionState` the full
 * `ProvidersPanel` already uses, and a one-line storage summary. The full
 * `ProvidersPanel` (onboarding/troubleshooting, itself already gating its
 * own per-adapter internals behind a "technical details" toggle) and
 * `StorageStatus` (recovery detail) stay reachable, just behind an
 * explicit "Technical details" disclosure — nothing here is removed.
 */
export function SettingsHub({ baseUrl }: { readonly baseUrl: string }) {
  const [adapters, setAdapters] = useState<readonly AdapterSummary[]>([]);
  const [adaptersState, setAdaptersState] = useState<"loading" | "ready" | "error">("loading");
  const [storage, setStorage] = useState<SystemStorageResponse | null>(null);
  const [showProviderDetails, setShowProviderDetails] = useState(false);
  const [showSystemDetails, setShowSystemDetails] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    listAdapters(baseUrl, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setAdapters(
          response.adapters.filter((adapter) => isKnownProviderAdapter(adapter.adapterId)),
        );
        setAdaptersState("ready");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setAdaptersState("error");
      });
    getSystemStorage(baseUrl, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setStorage(response);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [baseUrl]);

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold text-stone-900 dark:text-stone-100">Settings</h1>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
          Providers
        </h2>
        <HermesRouterSettings baseUrl={baseUrl} />
        {adaptersState === "loading" ? (
          <p role="status" className="text-sm text-stone-500">
            Loading providers…
          </p>
        ) : adaptersState === "error" ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            Could not load providers.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {adapters
              .filter((adapter) => adapter.adapterId !== HERMES_ROUTER_ADAPTER_ID)
              .map((adapter) => {
                const ready = deriveConnectionState(adapter) === "connected";
                return (
                  <li
                    key={adapter.adapterId}
                    className="flex items-center justify-between rounded border border-stone-200 bg-white px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900"
                  >
                    <span>{adapter.displayName}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        ready
                          ? "bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-200"
                          : "bg-stone-200 text-stone-800 dark:bg-stone-800 dark:text-stone-200"
                      }`}
                    >
                      {ready ? "Ready" : "Needs setup"}
                    </span>
                  </li>
                );
              })}
          </ul>
        )}
        <button
          type="button"
          onClick={() => {
            setShowProviderDetails((value) => !value);
          }}
          className="self-start text-xs text-stone-500 underline hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
        >
          {showProviderDetails ? "Hide technical details" : "Show technical details"}
        </button>
        {showProviderDetails ? <ProvidersPanel baseUrl={baseUrl} /> : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
          System
        </h2>
        <p className="text-sm text-stone-700 dark:text-stone-200">
          {storage
            ? `Storage: ${storage.mode === "durable" ? "Durable" : "In-memory"}`
            : "Loading system status…"}
        </p>
        <button
          type="button"
          onClick={() => {
            setShowSystemDetails((value) => !value);
          }}
          className="self-start text-xs text-stone-500 underline hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
        >
          {showSystemDetails ? "Hide technical details" : "Show technical details"}
        </button>
        {showSystemDetails ? <StorageStatus baseUrl={baseUrl} /> : null}
      </section>
    </div>
  );
}
