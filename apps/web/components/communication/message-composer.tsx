"use client";

import { useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  MAX_COMMUNICATION_MESSAGE_TEXT_LENGTH,
  classifyAttachmentKind,
  isAllowedAttachmentMimeType,
} from "@hall-of-wisdom/protocol";
import { ApiClientError, createBoardMessage, uploadBoardAttachment } from "../../lib/api-client";

const MAX_MESSAGE_LENGTH = MAX_COMMUNICATION_MESSAGE_TEXT_LENGTH;
const NUL_CHARACTER = String.fromCharCode(0);

type SubmitState = "idle" | "submitting" | "error";
type AttachmentUploadState = "uploading" | "done" | "error";

interface PendingAttachment {
  /** Client-only identifier for React keys/removal — never sent to the server. */
  readonly localId: string;
  readonly file: File;
  /** Only set for `kind === "image"` — a local `URL.createObjectURL` handle, never a server round-trip. */
  readonly previewUrl: string | undefined;
  readonly kind: "image" | "file";
  readonly uploadState: AttachmentUploadState;
  readonly attachmentId: string | undefined;
  readonly errorMessage: string | undefined;
}

function safeMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "The message could not be sent.";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function createLocalId(): string {
  return `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

type FileValidationResult =
  | { readonly ok: true; readonly kind: "image" | "file" }
  | { readonly ok: false; readonly errorMessage: string };

/** The exact same limits Hall Core itself enforces (see `@hall-of-wisdom/protocol`), checked here only so a doomed upload never starts. Returns the classified kind on success so the caller never needs its own separately-typed re-check of `file.type`. */
function validateFile(file: File, attachedOrPendingCount: number): FileValidationResult {
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

function PaperclipIcon() {
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

function FileIcon() {
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

function AttachmentPreview({
  attachment,
  onRemove,
}: {
  readonly attachment: PendingAttachment;
  readonly onRemove: () => void;
}) {
  const busy = attachment.uploadState === "uploading";
  const errored = attachment.uploadState === "error";
  return (
    <li className="relative flex items-center gap-2 rounded border border-stone-300 bg-stone-50 p-1.5 pr-2 text-xs dark:border-stone-700 dark:bg-stone-900">
      {attachment.kind === "image" && attachment.previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- local blob: URL, not a remote/optimizable image
        <img
          src={attachment.previewUrl}
          alt={`Preview of ${attachment.file.name}`}
          className="h-10 w-10 rounded object-cover"
        />
      ) : (
        <div className="flex h-10 w-10 items-center justify-center rounded bg-stone-200 dark:bg-stone-800">
          <FileIcon />
        </div>
      )}
      <div className="flex min-w-0 flex-col">
        <span className="max-w-[10rem] truncate font-medium text-stone-800 dark:text-stone-200">
          {attachment.file.name}
        </span>
        <span className="text-stone-500 dark:text-stone-400">
          {busy ? "Uploading…" : errored ? "Upload failed" : formatBytes(attachment.file.size)}
        </span>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${attachment.file.name}`}
        className="ml-1 shrink-0 rounded p-1 text-stone-500 hover:bg-stone-200 hover:text-stone-800 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100"
      >
        ×
      </button>
      {errored ? (
        <p role="alert" className="absolute -bottom-4 left-0 whitespace-nowrap text-red-600 dark:text-red-400">
          {attachment.errorMessage}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Deliberately never adds the message it sends to any local list — the
 * board's message history (`MessageList`, driven by `useBoardMessages`) is
 * the single source of truth, and it already receives this exact message
 * back over the already-subscribed live WebSocket moments after this POST
 * resolves (or via replay on the next reconnect if the stream happened to
 * be briefly down). This is what keeps the composer from ever displaying
 * an unsaved message as though it were confirmed, and needs no separate
 * reconciliation/dedup logic here — the hook's own sequence-based dedup
 * already covers it.
 *
 * Attachments follow the same "no local echo" discipline: once uploaded,
 * only their server-issued `attachmentId` is sent with the message — the
 * confirmed message (with resolved filename/mime/size) comes back the same
 * way text always has.
 */
export function MessageComposer({
  baseUrl,
  boardId,
}: {
  readonly baseUrl: string;
  readonly boardId: string;
}) {
  const [text, setText] = useState("");
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<readonly PendingAttachment[]>([]);
  const [attachmentValidationError, setAttachmentValidationError] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const trimmed = text.trim();
  const isBlank = trimmed.length === 0;
  const isOversized = text.length > MAX_MESSAGE_LENGTH;
  const hasNul = text.includes(NUL_CHARACTER);
  const submitting = submitState === "submitting";
  const doneAttachments = pendingAttachments.filter((a) => a.uploadState === "done");
  const attachmentsBusyOrErrored = pendingAttachments.some((a) => a.uploadState !== "done");
  const canSubmit =
    !submitting &&
    (!isBlank || doneAttachments.length > 0) &&
    !isOversized &&
    !hasNul &&
    !attachmentsBusyOrErrored;

  function updateAttachment(localId: string, patch: Partial<PendingAttachment>): void {
    setPendingAttachments((current) =>
      current.map((a) => (a.localId === localId ? { ...a, ...patch } : a)),
    );
  }

  async function uploadOne(localId: string, file: File): Promise<void> {
    try {
      const uploaded = await uploadBoardAttachment(baseUrl, boardId, file);
      updateAttachment(localId, { uploadState: "done", attachmentId: uploaded.attachmentId });
    } catch (error) {
      updateAttachment(localId, { uploadState: "error", errorMessage: safeMessage(error) });
    }
  }

  function addFiles(files: readonly File[]): void {
    if (files.length === 0) return;
    setAttachmentValidationError(null);
    let currentCount = pendingAttachments.length;
    const accepted: PendingAttachment[] = [];
    for (const file of files) {
      const result = validateFile(file, currentCount);
      if (!result.ok) {
        setAttachmentValidationError(result.errorMessage);
        continue;
      }
      currentCount += 1;
      accepted.push({
        localId: createLocalId(),
        file,
        previewUrl: result.kind === "image" ? URL.createObjectURL(file) : undefined,
        kind: result.kind,
        uploadState: "uploading",
        attachmentId: undefined,
        errorMessage: undefined,
      });
    }
    if (accepted.length === 0) return;
    setPendingAttachments((current) => [...current, ...accepted]);
    for (const attachment of accepted) {
      void uploadOne(attachment.localId, attachment.file);
    }
  }

  function removeAttachment(localId: string): void {
    setPendingAttachments((current) => {
      const target = current.find((a) => a.localId === localId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return current.filter((a) => a.localId !== localId);
    });
  }

  function clearAttachments(): void {
    for (const attachment of pendingAttachments) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    setPendingAttachments([]);
  }

  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return;
    setSubmitState("submitting");
    setErrorMessage(null);
    try {
      const attachmentIds = doneAttachments
        .map((a) => a.attachmentId)
        .filter((id): id is string => id !== undefined);
      await createBoardMessage(baseUrl, boardId, text, attachmentIds);
      setText("");
      clearAttachments();
      setSubmitState("idle");
      setAnnouncement("Message sent.");
    } catch (error) {
      setErrorMessage(safeMessage(error));
      setSubmitState("error");
      setAnnouncement("Message could not be sent.");
      // Text and attachments are deliberately preserved (not cleared) on failure.
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void handleSubmit();
    }
    // A plain Enter keypress is left untouched — the textarea's native
    // behavior (insert a newline) applies.
  }

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>): void {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const files: File[] = [];
    for (const item of event.clipboardData.items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      // Prevents also pasting the OS's filename/placeholder text alongside
      // the image — plain text paste is untouched (this branch never runs
      // for it, since clipboardData.items has no "file" kind entries then).
      event.preventDefault();
      addFiles(files);
    }
  }

  function handleDragOver(event: DragEvent<HTMLFormElement>): void {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setIsDraggingOver(true);
  }

  function handleDragLeave(event: DragEvent<HTMLFormElement>): void {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDraggingOver(false);
  }

  function handleDrop(event: DragEvent<HTMLFormElement>): void {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setIsDraggingOver(false);
    addFiles(Array.from(event.dataTransfer.files));
  }

  return (
    <form
      className={`flex flex-col gap-2 border-t pt-3 transition-colors ${
        isDraggingOver
          ? "border-amber-500 bg-amber-50 dark:border-amber-500 dark:bg-amber-950/20"
          : "border-stone-200 dark:border-stone-800"
      }`}
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <label htmlFor="message-composer-text" className="text-sm font-medium">
        Write a message
      </label>
      <textarea
        id="message-composer-text"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        disabled={submitting}
        rows={3}
        aria-describedby="message-composer-hint message-composer-error"
        aria-invalid={errorMessage !== null || isOversized || hasNul ? true : undefined}
        placeholder="Type a message… (Enter for a new line, Ctrl+Enter to send, or drop/paste files)"
        className="w-full resize-y rounded border border-stone-300 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100"
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ALLOWED_ATTACHMENT_MIME_TYPES.join(",")}
        onChange={handleFileInputChange}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />
      {pendingAttachments.length > 0 ? (
        <ul className="flex flex-wrap gap-3 pb-2">
          {pendingAttachments.map((attachment) => (
            <AttachmentPreview
              key={attachment.localId}
              attachment={attachment}
              onRemove={() => {
                removeAttachment(attachment.localId);
              }}
            />
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={submitting}
            aria-label="Attach files"
            title="Attach files"
            className="flex items-center justify-center rounded border border-stone-300 p-1.5 text-stone-600 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
          >
            <PaperclipIcon />
          </button>
          <p id="message-composer-hint" className="text-xs text-stone-500 dark:text-stone-400">
            {text.length}/{MAX_MESSAGE_LENGTH} characters — Enter for a new line, Ctrl+Enter (or
            Cmd+Enter) to send.
          </p>
        </div>
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600"
        >
          {submitting ? "Sending…" : "Send"}
        </button>
      </div>
      {isOversized ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          Message is too long ({text.length}/{MAX_MESSAGE_LENGTH} characters).
        </p>
      ) : null}
      {hasNul ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          Message contains an unsupported character.
        </p>
      ) : null}
      {attachmentValidationError ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {attachmentValidationError}
        </p>
      ) : null}
      {errorMessage ? (
        <p
          id="message-composer-error"
          role="alert"
          className="text-xs text-red-600 dark:text-red-400"
        >
          {errorMessage}
        </p>
      ) : null}
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </form>
  );
}
