"use client";

import { useState } from "react";

const POWERSHELL_EXAMPLE = String.raw`$env:HALL_HERMES_ROUTER_ROOT="C:\path\to\Hermes-router"
$env:HERMES_ROUTER_BASE_URL="https://your-router.example/v1"
$env:HERMES_ROUTER_API_KEY="<hermes-proxy-key>"`;

const POSIX_EXAMPLE = `export HALL_HERMES_ROUTER_ROOT="/path/to/Hermes-router"
export HERMES_ROUTER_BASE_URL="https://your-router.example/v1"
export HERMES_ROUTER_API_KEY="<hermes-proxy-key>"`;

function SetupExample({ label, command }: { readonly label: string; readonly command: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      // The placeholder-only example remains visible when clipboard access is unavailable.
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-stone-700 dark:text-stone-200">{label}</h4>
        <button
          type="button"
          aria-label={`Copy ${label} setup example`}
          onClick={() => void handleCopy()}
          className="rounded border border-stone-300 px-2 py-1 text-xs font-medium hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto rounded bg-stone-200 p-2 text-xs dark:bg-stone-800">
        <code>{command}</code>
      </pre>
    </div>
  );
}

export function HermesSetupGuide() {
  return (
    <section
      aria-label="Hermes Router setup guide"
      className="flex flex-col gap-3 rounded border border-stone-200 bg-stone-50 p-3 text-sm dark:border-stone-800 dark:bg-stone-950/40"
    >
      <p>
        Configure these values in the environment that starts Hall Core. This page never reads or
        stores their current values.
      </p>

      <dl className="grid gap-2 text-xs sm:grid-cols-[max-content_1fr] sm:gap-x-3">
        <dt>
          <code>HALL_HERMES_ROUTER_ROOT</code>
        </dt>
        <dd>Required — local Hermes-router repository/runtime path.</dd>
        <dt>
          <code>HERMES_ROUTER_BASE_URL</code>
        </dt>
        <dd>Required — Hermes Router /v1 endpoint.</dd>
        <dt>
          <code>HERMES_ROUTER_API_KEY</code>
        </dt>
        <dd>Required — Hermes proxy/client key.</dd>
        <dt>
          <code>HALL_HERMES_PYTHON</code>
        </dt>
        <dd>Optional — Python executable override.</dd>
      </dl>

      <p className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
        Use the Hermes proxy key, never an upstream OpenRouter or provider key.
      </p>

      <SetupExample label="Windows PowerShell" command={POWERSHELL_EXAMPLE} />
      <SetupExample label="macOS/Linux" command={POSIX_EXAMPLE} />

      <p className="text-xs text-stone-500 dark:text-stone-400">
        Hermes also requires Hall durable isolated-worktree execution. Restart Hall after changing
        the environment, then click Recheck above.
      </p>
    </section>
  );
}
