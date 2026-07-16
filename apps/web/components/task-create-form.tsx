"use client";

import { useEffect, useId, useState } from "react";
import type { SubmitEvent } from "react";
import { ApiClientError, createTask, listAdapters } from "../lib/api-client";
import type { AdapterSummary, CreateTaskResponse } from "../lib/api-schemas";

type Priority = "low" | "normal" | "high" | "critical";

interface FormValues {
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly priority: Priority;
  readonly adapterId: string;
  readonly workingDirectory: string;
}

const EMPTY_FORM: FormValues = {
  projectId: "",
  title: "",
  description: "",
  priority: "normal",
  adapterId: "",
  workingDirectory: "",
};

function isWindowsDriveAbsolute(value: string): boolean {
  const second = value[1];
  const third = value[2];
  return /^[a-zA-Z]$/.test(value[0] ?? "") && second === ":" && (third === "\\" || third === "/");
}

function isAbsolutePathLike(value: string): boolean {
  // POSIX absolute path, Windows drive-letter absolute path, or a UNC path.
  return value.startsWith("/") || isWindowsDriveAbsolute(value) || value.startsWith("\\\\");
}

interface FieldErrors {
  projectId?: string;
  title?: string;
  description?: string;
  workingDirectory?: string;
  adapterId?: string;
}

function validate(values: FormValues, adaptersAvailable: boolean): FieldErrors {
  const errors: FieldErrors = {};
  const projectId = values.projectId.trim();
  const title = values.title.trim();
  const workingDirectory = values.workingDirectory.trim();

  if (projectId.length === 0) {
    errors.projectId = "Project ID is required.";
  } else if (projectId.length > 128) {
    errors.projectId = "Project ID must not exceed 128 characters.";
  }

  if (title.length === 0) {
    errors.title = "Title is required.";
  } else if (title.length > 200) {
    errors.title = "Title must not exceed 200 characters.";
  }

  if (values.description.length > 20000) {
    errors.description = "Description must not exceed 20000 characters.";
  }

  if (workingDirectory.length > 0) {
    if (workingDirectory.includes("\0")) {
      errors.workingDirectory = "Working directory must not contain a NUL character.";
    } else if (isAbsolutePathLike(workingDirectory)) {
      errors.workingDirectory = "Working directory must be relative, not absolute.";
    } else if (workingDirectory.length > 4096) {
      errors.workingDirectory = "Working directory must not exceed 4096 characters.";
    }
  }

  if (!adaptersAvailable) {
    errors.adapterId = "No adapter is currently available.";
  } else if (values.adapterId.trim().length === 0) {
    errors.adapterId = "Choose an adapter.";
  }

  return errors;
}

export function TaskCreateForm({
  baseUrl,
  onCreated,
}: {
  readonly baseUrl: string;
  readonly onCreated: (task: CreateTaskResponse) => void;
}) {
  const [values, setValues] = useState<FormValues>(EMPTY_FORM);
  const [adapters, setAdapters] = useState<readonly AdapterSummary[]>([]);
  const [adaptersState, setAdaptersState] = useState<"loading" | "ready" | "error">("loading");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const formId = useId();

  useEffect(() => {
    const controller = new AbortController();
    listAdapters(baseUrl, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setAdapters(response.adapters);
        setAdaptersState("ready");
        const firstAvailable = response.adapters.find(
          (adapter) => adapter.availability === "available",
        );
        if (firstAvailable) {
          setValues((current) => ({ ...current, adapterId: firstAvailable.adapterId }));
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setAdaptersState("error");
      });
    return () => {
      controller.abort();
    };
  }, [baseUrl]);

  const hasAvailableAdapter = adapters.some((adapter) => adapter.availability === "available");

  function updateField<K extends keyof FormValues>(key: K, value: FormValues[K]): void {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;

    const errors = validate(values, hasAvailableAdapter);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await createTask(baseUrl, {
        projectId: values.projectId.trim(),
        title: values.title.trim(),
        ...(values.description.trim().length > 0 ? { description: values.description.trim() } : {}),
        priority: values.priority,
        adapterId: values.adapterId,
        ...(values.workingDirectory.trim().length > 0
          ? { workingDirectory: values.workingDirectory.trim() }
          : {}),
      });
      onCreated(created);
      setValues((current) => ({ ...EMPTY_FORM, adapterId: current.adapterId }));
      setFieldErrors({});
    } catch (error) {
      setSubmitError(
        error instanceof ApiClientError
          ? error.message
          : "Task could not be created. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      noValidate
      aria-labelledby={`${formId}-heading`}
      className="flex flex-col gap-4"
    >
      <h2 id={`${formId}-heading`} className="text-lg font-semibold">
        Create Task
      </h2>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-projectId`} className="text-sm font-medium">
          Project
        </label>
        <input
          id={`${formId}-projectId`}
          type="text"
          value={values.projectId}
          onChange={(event) => {
            updateField("projectId", event.target.value);
          }}
          aria-invalid={fieldErrors.projectId ? true : undefined}
          aria-describedby={fieldErrors.projectId ? `${formId}-projectId-error` : undefined}
          className="rounded border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
        />
        {fieldErrors.projectId ? (
          <p
            id={`${formId}-projectId-error`}
            role="alert"
            className="text-sm text-red-600 dark:text-red-400"
          >
            {fieldErrors.projectId}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-title`} className="text-sm font-medium">
          Title
        </label>
        <input
          id={`${formId}-title`}
          type="text"
          value={values.title}
          onChange={(event) => {
            updateField("title", event.target.value);
          }}
          aria-invalid={fieldErrors.title ? true : undefined}
          aria-describedby={fieldErrors.title ? `${formId}-title-error` : undefined}
          className="rounded border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
        />
        {fieldErrors.title ? (
          <p
            id={`${formId}-title-error`}
            role="alert"
            className="text-sm text-red-600 dark:text-red-400"
          >
            {fieldErrors.title}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-description`} className="text-sm font-medium">
          Description <span className="font-normal text-stone-500">(optional)</span>
        </label>
        <textarea
          id={`${formId}-description`}
          value={values.description}
          onChange={(event) => {
            updateField("description", event.target.value);
          }}
          rows={3}
          aria-invalid={fieldErrors.description ? true : undefined}
          aria-describedby={fieldErrors.description ? `${formId}-description-error` : undefined}
          className="rounded border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
        />
        {fieldErrors.description ? (
          <p
            id={`${formId}-description-error`}
            role="alert"
            className="text-sm text-red-600 dark:text-red-400"
          >
            {fieldErrors.description}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-priority`} className="text-sm font-medium">
          Priority
        </label>
        <select
          id={`${formId}-priority`}
          value={values.priority}
          onChange={(event) => {
            updateField("priority", event.target.value as Priority);
          }}
          className="rounded border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
        >
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-adapter`} className="text-sm font-medium">
          Agent
        </label>
        {adaptersState === "loading" ? (
          <p className="text-sm text-stone-500">Loading adapters…</p>
        ) : adaptersState === "error" ? (
          <p className="text-sm text-red-600 dark:text-red-400">Could not load adapters.</p>
        ) : (
          <select
            id={`${formId}-adapter`}
            value={values.adapterId}
            onChange={(event) => {
              updateField("adapterId", event.target.value);
            }}
            aria-invalid={fieldErrors.adapterId ? true : undefined}
            aria-describedby={fieldErrors.adapterId ? `${formId}-adapter-error` : undefined}
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
        {fieldErrors.adapterId ? (
          <p
            id={`${formId}-adapter-error`}
            role="alert"
            className="text-sm text-red-600 dark:text-red-400"
          >
            {fieldErrors.adapterId}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-workingDirectory`} className="text-sm font-medium">
          Working directory <span className="font-normal text-stone-500">(optional, relative)</span>
        </label>
        <input
          id={`${formId}-workingDirectory`}
          type="text"
          placeholder="."
          value={values.workingDirectory}
          onChange={(event) => {
            updateField("workingDirectory", event.target.value);
          }}
          aria-invalid={fieldErrors.workingDirectory ? true : undefined}
          aria-describedby={
            fieldErrors.workingDirectory ? `${formId}-workingDirectory-error` : undefined
          }
          className="rounded border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
        />
        {fieldErrors.workingDirectory ? (
          <p
            id={`${formId}-workingDirectory-error`}
            role="alert"
            className="text-sm text-red-600 dark:text-red-400"
          >
            {fieldErrors.workingDirectory}
          </p>
        ) : null}
      </div>

      {submitError ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {submitError}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={submitting}
        className="rounded bg-amber-700 px-4 py-2 text-sm font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600 dark:hover:bg-amber-700"
      >
        {submitting ? "Creating…" : "Submit"}
      </button>
    </form>
  );
}
