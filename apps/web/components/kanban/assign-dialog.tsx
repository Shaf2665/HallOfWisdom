"use client";

import { useEffect, useId, useState } from "react";
import type { SubmitEvent } from "react";
import { ApiClientError, assignTask, listAdapters } from "../../lib/api-client";
import type { AdapterSummary, TaskRecord } from "../../lib/api-schemas";
import { isAbsolutePathLike } from "../../lib/working-directory";
import { Dialog } from "./dialog";

export function AssignDialog({
  baseUrl,
  record,
  onAssigned,
  onClose,
}: {
  readonly baseUrl: string;
  readonly record: TaskRecord;
  readonly onAssigned: (updated: TaskRecord) => void;
  readonly onClose: () => void;
}) {
  const titleId = useId();
  const [adapters, setAdapters] = useState<readonly AdapterSummary[]>([]);
  const [adaptersState, setAdaptersState] = useState<"loading" | "ready" | "error">("loading");
  const [adapterId, setAdapterId] = useState("");
  const [workingDirectory, setWorkingDirectory] = useState("");
  const [workingDirectoryError, setWorkingDirectoryError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    listAdapters(baseUrl, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setAdapters(response.adapters);
        setAdaptersState("ready");
        const firstAvailable = response.adapters.find((a) => a.availability === "available");
        if (firstAvailable) setAdapterId(firstAvailable.adapterId);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setAdaptersState("error");
      });
    return () => {
      controller.abort();
    };
  }, [baseUrl]);

  const hasAvailableAdapter = adapters.some((a) => a.availability === "available");

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;

    const trimmedDirectory = workingDirectory.trim();
    if (trimmedDirectory.length > 0) {
      if (trimmedDirectory.includes("\0")) {
        setWorkingDirectoryError("Working directory must not contain a NUL character.");
        return;
      }
      if (isAbsolutePathLike(trimmedDirectory)) {
        setWorkingDirectoryError("Working directory must be relative, not absolute.");
        return;
      }
    }
    setWorkingDirectoryError(null);

    if (adapterId.trim().length === 0) {
      setSubmitError("Choose an agent to assign.");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const updated = await assignTask(baseUrl, record.task.taskId, {
        adapterId,
        ...(trimmedDirectory.length > 0 ? { workingDirectory: trimmedDirectory } : {}),
      });
      onAssigned(updated);
    } catch (error) {
      setSubmitError(
        error instanceof ApiClientError ? error.message : "Assignment could not be completed.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog titleId={titleId} onClose={onClose}>
      <form
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
        noValidate
        className="flex flex-col gap-4"
      >
        <h2 id={titleId} className="text-lg font-semibold">
          Assign an agent
        </h2>
        <p className="text-sm text-stone-600 dark:text-stone-300">
          Assigning <span className="font-medium">{record.task.title}</span> does not start it — you
          will still need to click Start.
        </p>

        <div className="flex flex-col gap-1">
          <label htmlFor={`${titleId}-adapter`} className="text-sm font-medium">
            Agent
          </label>
          {adaptersState === "loading" ? (
            <p className="text-sm text-stone-500">Loading adapters…</p>
          ) : adaptersState === "error" ? (
            <p className="text-sm text-red-600 dark:text-red-400">Could not load adapters.</p>
          ) : (
            <select
              id={`${titleId}-adapter`}
              value={adapterId}
              onChange={(event) => {
                setAdapterId(event.target.value);
              }}
              className="rounded border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
            >
              <option value="" disabled>
                Select an agent…
              </option>
              {adapters.map((adapter) => (
                <option
                  key={adapter.adapterId}
                  value={adapter.adapterId}
                  disabled={adapter.availability !== "available"}
                >
                  {adapter.agentDisplayName}
                  {adapter.availability !== "available" ? ` (${adapter.availability})` : ""}
                </option>
              ))}
            </select>
          )}
          {adaptersState === "ready" && !hasAvailableAdapter ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              No adapter is currently available.
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={`${titleId}-workdir`} className="text-sm font-medium">
            Working directory{" "}
            <span className="font-normal text-stone-500">(optional, relative)</span>
          </label>
          <input
            id={`${titleId}-workdir`}
            type="text"
            placeholder="."
            value={workingDirectory}
            onChange={(event) => {
              setWorkingDirectory(event.target.value);
            }}
            aria-invalid={workingDirectoryError ? true : undefined}
            aria-describedby={workingDirectoryError ? `${titleId}-workdir-error` : undefined}
            className="rounded border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
          />
          {workingDirectoryError ? (
            <p
              id={`${titleId}-workdir-error`}
              role="alert"
              className="text-sm text-red-600 dark:text-red-400"
            >
              {workingDirectoryError}
            </p>
          ) : null}
        </div>

        {submitError ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {submitError}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !hasAvailableAdapter}
            className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600"
          >
            {submitting ? "Assigning…" : "Assign"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
