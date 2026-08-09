"use client";

import { useState } from "react";
import { ApiClientError, getAdapter } from "../../lib/api-client";
import type { AdapterSummary } from "../../lib/api-schemas";
import { connectCommandFor, deriveConnectionState, deriveGuidanceText } from "./provider-status";

function safeMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "Could not recheck this provider.";
}

export function ProviderCard({
  baseUrl,
  adapter,
  onUpdated,
}: {
  readonly baseUrl: string;
  readonly adapter: AdapterSummary;
  readonly onUpdated: (updated: AdapterSummary) => void;
}) {
  const [showConnect, setShowConnect] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [recheckError, setRecheckError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [copied, setCopied] = useState(false);

  const state = deriveConnectionState(adapter);
  const guidance = deriveGuidanceText(adapter);
  const command = connectCommandFor(adapter.adapterId);

  async function handleRecheck() {
    setRechecking(true);
    setRecheckError(null);
    try {
      const response = await getAdapter(baseUrl, adapter.adapterId, {});
      onUpdated(response.adapter);
      setShowConnect(false);
    } catch (error) {
      setRecheckError(safeMessage(error));
    } finally {
      setRechecking(false);
    }
  }

  async function handleCopyCommand() {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      // Clipboard access can fail (permissions, non-secure context) — the
      // command is still visible as plain text either way, so this is a
      // convenience feature only and needs no user-facing error.
    }
  }

  return (
    <li className="flex flex-col gap-2 rounded border border-stone-200 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <div className="flex items-center justify-between gap-2">
        <span className="text-base font-semibold">{adapter.displayName}</span>
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
            state === "connected"
              ? "bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-200"
              : "bg-stone-200 text-stone-800 dark:bg-stone-800 dark:text-stone-200"
          }`}
        >
          {state === "connected" ? "Connected" : "Not connected"}
        </span>
      </div>

      <p className="text-sm text-stone-600 dark:text-stone-300">{guidance}</p>

      {adapter.executionTrust === "trusted_local" ? (
        <p className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          Trusted-local mode: this provider&apos;s sandbox and approval protections are bypassed —
          it is not OS-sandboxed and runs with your own filesystem permissions.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {command ? (
          <button
            type="button"
            onClick={() => {
              setShowConnect((value) => !value);
            }}
            className="rounded bg-amber-100 px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-200 dark:hover:bg-amber-900/60"
          >
            Connect
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void handleRecheck()}
          disabled={rechecking}
          className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
        >
          {rechecking ? "Rechecking…" : "Recheck"}
        </button>
      </div>

      {recheckError ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {recheckError}
        </p>
      ) : null}

      {showConnect && command ? (
        <div className="flex flex-col gap-2 rounded border border-stone-200 bg-stone-50 p-3 text-sm dark:border-stone-800 dark:bg-stone-950/40">
          <p>Run this command in your own terminal, then click Recheck above:</p>
          <div className="flex items-center gap-2">
            <code className="rounded bg-stone-200 px-2 py-1 text-xs dark:bg-stone-800">
              {command}
            </code>
            <button
              type="button"
              onClick={() => void handleCopyCommand()}
              className="rounded border border-stone-300 px-2 py-1 text-xs font-medium hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-xs text-stone-500 dark:text-stone-400">
            This opens {adapter.displayName}&apos;s own official sign-in flow. Hall never sees or
            stores your password, API key, or login session.
          </p>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => {
          setShowDetails((value) => !value);
        }}
        className="self-start text-xs text-stone-500 underline hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
      >
        {showDetails ? "Hide technical details" : "Show technical details"}
      </button>
      {showDetails ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
          <dt>Adapter ID</dt>
          <dd>{adapter.adapterId}</dd>
          <dt>Integration level</dt>
          <dd>{adapter.integrationLevel}</dd>
          <dt>Adapter package version</dt>
          <dd>{adapter.adapterVersion}</dd>
          <dt>Detected CLI version</dt>
          <dd>{adapter.detectedVersion ?? "Unknown"}</dd>
          <dt>Raw availability</dt>
          <dd>{adapter.availability}</dd>
          <dt>Declared capabilities</dt>
          <dd>{adapter.declaredCapabilities.join(", ") || "None"}</dd>
        </dl>
      ) : null}
    </li>
  );
}
