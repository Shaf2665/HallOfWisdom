"use client";

import { type SyntheticEvent, useEffect, useState } from "react";
import { ApiClientError, getHermesSettings, saveHermesSettings } from "../../lib/api-client";
import type { HermesSettingsResponse } from "../../lib/api-schemas";

const HERMES_CHECK_TIMEOUT_MS = 10_000;

function safeMessage(error: unknown): string {
  return error instanceof ApiClientError
    ? error.message
    : "Hall could not save or check Hermes Router. Try again.";
}

export function HermesRouterSettings({ baseUrl }: { readonly baseUrl: string }) {
  const [status, setStatus] = useState<HermesSettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [routerBaseUrl, setRouterBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [pythonPath, setPythonPath] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    getHermesSettings(baseUrl, {
      signal: controller.signal,
      timeoutMs: HERMES_CHECK_TIMEOUT_MS,
    })
      .then((response) => {
        if (controller.signal.aborted) return;
        setStatus(response);
        setRouterBaseUrl(response.routerBaseUrl ?? "");
        setPythonPath(response.pythonPath ?? "");
        setShowAdvanced(response.pythonPath !== undefined);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setErrorMessage(safeMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [baseUrl]);

  async function handleRecheck() {
    setWorking(true);
    setErrorMessage(null);
    try {
      setStatus(await getHermesSettings(baseUrl, { timeoutMs: HERMES_CHECK_TIMEOUT_MS }));
    } catch (error) {
      setErrorMessage(safeMessage(error));
    } finally {
      setWorking(false);
    }
  }

  async function handleSave(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorking(true);
    setErrorMessage(null);
    try {
      const response = await saveHermesSettings(
        baseUrl,
        {
          routerBaseUrl: routerBaseUrl.trim(),
          ...(apiKey.trim().length === 0 ? {} : { apiKey: apiKey.trim() }),
          ...(pythonPath.trim().length === 0 ? {} : { pythonPath: pythonPath.trim() }),
        },
        { timeoutMs: HERMES_CHECK_TIMEOUT_MS },
      );
      setStatus(response);
      setApiKey("");
      setEditing(false);
    } catch (error) {
      setErrorMessage(safeMessage(error));
    } finally {
      setWorking(false);
    }
  }

  const ready = status?.ready === true;

  return (
    <div className="flex flex-col gap-3 rounded border border-stone-200 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-stone-900 dark:text-stone-100">Hermes Router</h3>
          <p className="text-xs text-stone-500 dark:text-stone-400">
            Connect Hall&apos;s built-in Hermes runtime to your Hermes Router inference gateway.
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            ready
              ? "bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-200"
              : "bg-stone-200 text-stone-800 dark:bg-stone-800 dark:text-stone-200"
          }`}
        >
          {ready ? "Ready" : "Not configured"}
        </span>
      </div>

      {loading ? (
        <p role="status" className="text-sm text-stone-500">
          Checking Hermes Router…
        </p>
      ) : status ? (
        <p
          role="status"
          className={`text-sm ${
            ready ? "text-green-700 dark:text-green-300" : "text-stone-600 dark:text-stone-300"
          }`}
        >
          {status.message}
        </p>
      ) : null}

      {errorMessage ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {errorMessage}
        </p>
      ) : null}

      {!editing ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setEditing(true);
              setErrorMessage(null);
            }}
            disabled={loading || working}
            className="rounded bg-amber-100 px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-200 disabled:opacity-50 dark:bg-amber-900/40 dark:text-amber-200 dark:hover:bg-amber-900/60"
          >
            {status?.configured ? "Edit setup" : "Set up Hermes"}
          </button>
          <button
            type="button"
            onClick={() => void handleRecheck()}
            disabled={loading || working}
            className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
          >
            {working ? "Rechecking…" : "Recheck"}
          </button>
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSave(event)}>
          <label className="flex flex-col gap-1 text-sm font-medium">
            Router base URL
            <input
              required
              type="url"
              value={routerBaseUrl}
              onChange={(event) => {
                setRouterBaseUrl(event.target.value);
              }}
              placeholder="https://router.example/v1"
              className="rounded border border-stone-300 bg-white px-3 py-2 font-normal dark:border-stone-700 dark:bg-stone-950"
            />
            <span className="text-xs font-normal text-stone-500 dark:text-stone-400">
              The address Hermes uses for router requests.
            </span>
          </label>

          <label className="flex flex-col gap-1 text-sm font-medium">
            Router proxy/client API key
            <input
              type="password"
              required={status?.apiKeyConfigured !== true}
              autoComplete="new-password"
              spellCheck={false}
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
              }}
              placeholder={
                status?.apiKeyConfigured
                  ? "Leave blank to keep the current key"
                  : "Paste the Hermes proxy/client key"
              }
              className="rounded border border-stone-300 bg-white px-3 py-2 font-normal dark:border-stone-700 dark:bg-stone-950"
            />
            <span className="text-xs font-normal text-stone-500 dark:text-stone-400">
              Use only the key issued for this Hermes router client. Never paste an upstream
              provider or OpenRouter key here. A saved key is never shown again.
            </span>
          </label>

          <details
            open={showAdvanced}
            onToggle={(event) => {
              setShowAdvanced(event.currentTarget.open);
            }}
            className="rounded border border-stone-200 p-3 dark:border-stone-800"
          >
            <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
            <label className="mt-3 flex flex-col gap-1 text-sm font-medium">
              Python executable or path (optional)
              <input
                value={pythonPath}
                onChange={(event) => {
                  setPythonPath(event.target.value);
                }}
                placeholder="python"
                className="rounded border border-stone-300 bg-white px-3 py-2 font-normal dark:border-stone-700 dark:bg-stone-950"
              />
              <span className="text-xs font-normal text-stone-500 dark:text-stone-400">
                Leave blank to use Python from your system path.
              </span>
            </label>
          </details>

          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={working}
              className="rounded bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white"
            >
              {working ? "Saving and checking…" : "Save and check"}
            </button>
            <button
              type="button"
              disabled={working}
              onClick={() => {
                setEditing(false);
                setRouterBaseUrl(status?.routerBaseUrl ?? "");
                setPythonPath(status?.pythonPath ?? "");
                setApiKey("");
                setErrorMessage(null);
              }}
              className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:hover:bg-stone-800"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {status ? (
        <details className="text-xs text-stone-500 dark:text-stone-400">
          <summary className="cursor-pointer underline">Technical details</summary>
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
            <dt>Detected runtime</dt>
            <dd>{status.detectedVersion ?? "Not detected"}</dd>
            <dt>Environment overrides</dt>
            <dd>{status.environmentOverrideActive ? "Active" : "None"}</dd>
            {status.technicalMessage ? (
              <>
                <dt>Detection result</dt>
                <dd>{status.technicalMessage}</dd>
              </>
            ) : null}
          </dl>
        </details>
      ) : null}
    </div>
  );
}
