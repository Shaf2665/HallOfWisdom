"use client";

import { useId, useState } from "react";
import type { SubmitEvent } from "react";
import { ApiClientError, createDeferredTask } from "../../lib/api-client";
import type { CreateTaskResponse } from "../../lib/api-schemas";
import { isAbsolutePathLike } from "../../lib/working-directory";

type Priority = "low" | "normal" | "high" | "critical";

interface FormValues {
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly priority: Priority;
  readonly workingDirectory: string;
}

const EMPTY_FORM: FormValues = {
  projectId: "",
  title: "",
  description: "",
  priority: "normal",
  workingDirectory: "",
};

interface FieldErrors {
  projectId?: string;
  title?: string;
  description?: string;
  workingDirectory?: string;
}

function validate(values: FormValues): FieldErrors {
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

  return errors;
}

/**
 * The Kanban board's own task-creation entry point: always
 * `executionMode: "deferred"`, no adapter field — a distinct component
 * from `TaskCreateForm` (immediate execution, Task Console), not a
 * variant of it, since the two forms have genuinely different required
 * fields and submit to different execution modes.
 */
export function BacklogTaskForm({
  baseUrl,
  onCreated,
}: {
  readonly baseUrl: string;
  readonly onCreated: (task: CreateTaskResponse) => void;
}) {
  const [values, setValues] = useState<FormValues>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const formId = useId();

  function updateField<K extends keyof FormValues>(key: K, value: FormValues[K]): void {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;

    const errors = validate(values);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await createDeferredTask(baseUrl, {
        projectId: values.projectId.trim(),
        title: values.title.trim(),
        ...(values.description.trim().length > 0 ? { description: values.description.trim() } : {}),
        priority: values.priority,
        ...(values.workingDirectory.trim().length > 0
          ? { workingDirectory: values.workingDirectory.trim() }
          : {}),
      });
      onCreated(created);
      setValues(EMPTY_FORM);
      setFieldErrors({});
      setExpanded(false);
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

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => {
          setExpanded(true);
        }}
        className="w-full rounded border border-dashed border-stone-300 px-3 py-2 text-sm font-medium text-stone-600 hover:border-amber-500 hover:text-amber-700 dark:border-stone-700 dark:text-stone-300 dark:hover:border-amber-500 dark:hover:text-amber-400"
      >
        + New backlog task
      </button>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      noValidate
      aria-labelledby={`${formId}-heading`}
      className="flex flex-col gap-3 rounded border border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-900"
    >
      <div className="flex items-center justify-between">
        <h3 id={`${formId}-heading`} className="text-sm font-semibold">
          New backlog task
        </h3>
        <button
          type="button"
          onClick={() => {
            setExpanded(false);
            setValues(EMPTY_FORM);
            setFieldErrors({});
            setSubmitError(null);
          }}
          className="text-xs font-medium text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
        >
          Close
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-projectId`} className="text-xs font-medium">
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
          className="rounded border border-stone-300 bg-white px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-900"
        />
        {fieldErrors.projectId ? (
          <p
            id={`${formId}-projectId-error`}
            role="alert"
            className="text-xs text-red-600 dark:text-red-400"
          >
            {fieldErrors.projectId}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-title`} className="text-xs font-medium">
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
          className="rounded border border-stone-300 bg-white px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-900"
        />
        {fieldErrors.title ? (
          <p
            id={`${formId}-title-error`}
            role="alert"
            className="text-xs text-red-600 dark:text-red-400"
          >
            {fieldErrors.title}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-description`} className="text-xs font-medium">
          Description <span className="font-normal text-stone-500">(optional)</span>
        </label>
        <textarea
          id={`${formId}-description`}
          value={values.description}
          onChange={(event) => {
            updateField("description", event.target.value);
          }}
          rows={2}
          aria-invalid={fieldErrors.description ? true : undefined}
          aria-describedby={fieldErrors.description ? `${formId}-description-error` : undefined}
          className="rounded border border-stone-300 bg-white px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-900"
        />
        {fieldErrors.description ? (
          <p
            id={`${formId}-description-error`}
            role="alert"
            className="text-xs text-red-600 dark:text-red-400"
          >
            {fieldErrors.description}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-priority`} className="text-xs font-medium">
          Priority
        </label>
        <select
          id={`${formId}-priority`}
          value={values.priority}
          onChange={(event) => {
            updateField("priority", event.target.value as Priority);
          }}
          className="rounded border border-stone-300 bg-white px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-900"
        >
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-workingDirectory`} className="text-xs font-medium">
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
          className="rounded border border-stone-300 bg-white px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-900"
        />
        {fieldErrors.workingDirectory ? (
          <p
            id={`${formId}-workingDirectory-error`}
            role="alert"
            className="text-xs text-red-600 dark:text-red-400"
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
        className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600"
      >
        {submitting ? "Creating…" : "Add to Backlog"}
      </button>
    </form>
  );
}
