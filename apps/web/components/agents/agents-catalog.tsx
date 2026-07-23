"use client";

import { useEffect, useState } from "react";
import { ApiClientError, listAdapters } from "../../lib/api-client";
import type { AdapterSummary } from "../../lib/api-schemas";

function safeMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "Could not load agents.";
}

function TrustBadge({ trust }: { readonly trust: AdapterSummary["executionTrust"] }) {
  const classNameByTrust: Record<AdapterSummary["executionTrust"], string> = {
    isolated: "bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-200",
    trusted_local: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
    simulated: "bg-stone-200 text-stone-800 dark:bg-stone-800 dark:text-stone-200",
    unavailable: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200",
  };
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${classNameByTrust[trust]}`}
    >
      {trust}
    </span>
  );
}

/**
 * Phase 11 — read-only agent capability/trust comparison. Fetches the
 * (now Phase-11-extended) `GET /api/v1/adapters` exactly like `AssignDialog`
 * already does, but never mutates anything and never lets an operator
 * assign/start from here — this page is comparison only. Renders an
 * allowlist of known-safe fields only: it never renders `executablePath`,
 * account info, auth details, sandbox usernames, environment variables,
 * raw diagnostics, costs, or token limits, none of which the server ever
 * sends to this endpoint in the first place.
 */
export function AgentsCatalog({ baseUrl }: { readonly baseUrl: string }) {
  const [adapters, setAdapters] = useState<readonly AdapterSummary[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listAdapters(baseUrl, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setAdapters(response.adapters);
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

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700 dark:border-stone-800 dark:bg-stone-950/40 dark:text-stone-300">
        <ul className="list-disc pl-5">
          <li>Installed does not mean executable.</li>
          <li>Authenticated does not mean isolated.</li>
          <li>A verified capability is required for automatic routing.</li>
          <li>Trusted-local means the provider runs with the Hall Core user&apos;s permissions.</li>
          <li>Mock Agent is simulation only — never a real filesystem-editing coding agent.</li>
        </ul>
      </div>

      {state === "loading" ? (
        <p role="status" className="text-sm text-stone-500">
          Loading agents…
        </p>
      ) : state === "error" ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {errorMessage}
        </p>
      ) : (
        <>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-stone-200 dark:border-stone-800">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Agent
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Provider
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Version
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Availability
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Assignable
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Execution trust
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Verified capabilities
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Last detection
                  </th>
                </tr>
              </thead>
              <tbody>
                {adapters.map((adapter) => (
                  <tr
                    key={adapter.adapterId}
                    className="border-b border-stone-100 dark:border-stone-900"
                  >
                    <td className="py-2 pr-3 font-medium">{adapter.displayName}</td>
                    <td className="py-2 pr-3 text-stone-600 dark:text-stone-300">
                      {adapter.provider ?? "—"}
                    </td>
                    <td className="py-2 pr-3 text-stone-600 dark:text-stone-300">
                      {adapter.adapterVersion}
                    </td>
                    <td className="py-2 pr-3">{adapter.availability}</td>
                    <td className="py-2 pr-3">{adapter.assignable ? "Yes" : "No"}</td>
                    <td className="py-2 pr-3">
                      <TrustBadge trust={adapter.executionTrust} />
                    </td>
                    <td className="py-2 pr-3 text-stone-600 dark:text-stone-300">
                      {adapter.capabilityObservations.filter((o) => o.status === "verified")
                        .length === 0
                        ? "None"
                        : adapter.capabilityObservations
                            .filter((o) => o.status === "verified")
                            .map((o) => o.capability)
                            .join(", ")}
                    </td>
                    <td className="py-2 pr-3 text-stone-500 dark:text-stone-400">
                      {new Date(adapter.detectedAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="flex flex-col gap-3 md:hidden">
            {adapters.map((adapter) => (
              <li
                key={adapter.adapterId}
                className="flex flex-col gap-1 rounded border border-stone-200 bg-white p-3 text-sm shadow-sm dark:border-stone-800 dark:bg-stone-900"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{adapter.displayName}</span>
                  <TrustBadge trust={adapter.executionTrust} />
                </div>
                <p className="text-xs text-stone-500 dark:text-stone-400">
                  {adapter.provider ?? "No provider"} · v{adapter.adapterVersion}
                </p>
                <p className="text-xs">
                  Availability: {adapter.availability} · Assignable:{" "}
                  {adapter.assignable ? "Yes" : "No"}
                </p>
                <p className="text-xs text-stone-600 dark:text-stone-300">
                  Verified:{" "}
                  {adapter.capabilityObservations.filter((o) => o.status === "verified").length ===
                  0
                    ? "None"
                    : adapter.capabilityObservations
                        .filter((o) => o.status === "verified")
                        .map((o) => o.capability)
                        .join(", ")}
                </p>
                {adapter.limitations.length > 0 ? (
                  <ul className="list-disc pl-4 text-xs text-amber-700 dark:text-amber-400">
                    {adapter.limitations.map((limitation) => (
                      <li key={limitation}>{limitation}</li>
                    ))}
                  </ul>
                ) : null}
                <p className="text-xs text-stone-400 dark:text-stone-500">
                  Last detection: {new Date(adapter.detectedAt).toLocaleString()}
                </p>
              </li>
            ))}
          </ul>

          <div className="hidden flex-col gap-2 md:flex">
            {adapters.some((a) => a.limitations.length > 0) ? (
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                <ul className="list-disc pl-4">
                  {adapters.flatMap((adapter) =>
                    adapter.limitations.map((limitation) => (
                      <li key={`${adapter.adapterId}-${limitation}`}>
                        {adapter.displayName}: {limitation}
                      </li>
                    )),
                  )}
                </ul>
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
