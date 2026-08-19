"use client";

import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  classifyAttachmentKind,
  isAllowedAttachmentMimeType,
} from "@hall-of-wisdom/protocol";

export { ALLOWED_ATTACHMENT_MIME_TYPES, MAX_ATTACHMENTS_PER_MESSAGE };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function createLocalId(): string {
  return `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export type FileValidationResult =
  | { readonly ok: true; readonly kind: "image" | "file" }
  | { readonly ok: false; readonly errorMessage: string };

/** The exact same limits Hall Core itself enforces (see `@hall-of-wisdom/protocol`), checked here only so a doomed upload never starts. Returns the classified kind on success so the caller never needs its own separately-typed re-check of `file.type`. */
export function validateFile(file: File, attachedOrPendingCount: number): FileValidationResult {
  if (attachedOrPendingCount >= MAX_ATTACHMENTS_PER_MESSAGE) {
    return {
      ok: false,
      errorMessage: `You can attach at most ${String(MAX_ATTACHMENTS_PER_MESSAGE)} files per message.`,
    };
  }
  if (!isAllowedAttachmentMimeType(file.type)) {
    return { ok: false, errorMessage: `"${file.name}" is not a supported file type.` };
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      errorMessage: `"${file.name}" exceeds the ${formatBytes(MAX_ATTACHMENT_BYTES)} limit.`,
    };
  }
  if (file.size === 0) {
    return { ok: false, errorMessage: `"${file.name}" is empty.` };
  }
  return { ok: true, kind: classifyAttachmentKind(file.type) };
}

export function PaperclipIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21.44 11.05 12.25 20.24a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

export function FileIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 text-stone-500 dark:text-stone-400"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

/**
 * Generalized preview card for one picked/pending file — shared by
 * `MessageComposer` (which uploads immediately, so `statusText` reflects
 * live upload state) and `WisdomGateway` (which stages files client-side
 * and only uploads at submit time, so `statusText` is always just the
 * file size). Callers own their own upload/status bookkeeping; this
 * component only renders it.
 */
export function AttachmentPreviewCard({
  file,
  kind,
  previewUrl,
  statusText,
  errored,
  errorMessage,
  onRemove,
}: {
  readonly file: File;
  readonly kind: "image" | "file";
  readonly previewUrl: string | undefined;
  readonly statusText: string;
  readonly errored: boolean;
  readonly errorMessage: string | undefined;
  readonly onRemove: () => void;
}) {
  return (
    <li className="relative flex items-center gap-2 rounded border border-stone-300 bg-stone-50 p-1.5 pr-2 text-xs dark:border-stone-700 dark:bg-stone-900">
      {kind === "image" && previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- local blob: URL, not a remote/optimizable image
        <img
          src={previewUrl}
          alt={`Preview of ${file.name}`}
          className="h-10 w-10 rounded object-cover"
        />
      ) : (
        <div className="flex h-10 w-10 items-center justify-center rounded bg-stone-200 dark:bg-stone-800">
          <FileIcon />
        </div>
      )}
      <div className="flex min-w-0 flex-col">
        <span className="max-w-[10rem] truncate font-medium text-stone-800 dark:text-stone-200">
          {file.name}
        </span>
        <span className="text-stone-500 dark:text-stone-400">{statusText}</span>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${file.name}`}
        className="ml-1 shrink-0 rounded p-1 text-stone-500 hover:bg-stone-200 hover:text-stone-800 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100"
      >
        ×
      </button>
      {errored ? (
        <p
          role="alert"
          className="absolute -bottom-4 left-0 whitespace-nowrap text-red-600 dark:text-red-400"
        >
          {errorMessage}
        </p>
      ) : null}
    </li>
  );
}
