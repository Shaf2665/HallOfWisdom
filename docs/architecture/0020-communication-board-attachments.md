# 0020 — Communication Board Attachments

Status: Accepted.

## Context

GitHub issue #23 asked for image/file attachments in "the CEO/agent chat UI." Phase 8
(`0007-communication-boards.md`) deliberately deferred this: "Reactions, nested replies, and
attachments each add their own schema, storage, and UI surface for a flat local-discussion
prototype that has no requirement for any of them yet." This ADR is that deferred work arriving —
extending Communication Boards, the one existing human↔Hall Core text surface, rather than
inventing a second "chat" architecture. `MessageComposer`, `MessageList`, and `CommunicationMessage`
are extended in place; no new message type, no new communication channel.

## Protocol (`packages/protocol/src/attachment.ts`, `communication.ts`)

`MessageAttachment` — `attachmentId`, `filename` (display metadata only, never a filesystem path;
rejects control characters and path separators — see "Path safety" below), `mimeType`, `byteSize`,
`kind` (`"image" | "file"`, always server-derived from the validated MIME type, never trusted from
the client). Constants (`MAX_ATTACHMENTS_PER_MESSAGE` = 4, `MAX_ATTACHMENT_BYTES` = 8 MiB,
`ALLOWED_ATTACHMENT_MIME_TYPES`) live here rather than `ServerLimits`, matching how
`MAX_COMMUNICATION_MESSAGE_TEXT_LENGTH` already isn't duplicated there — both the browser and Hall
Core need the same ceiling to validate against independently.

`communicationMessageSchema` gains an optional `attachments` array (never emitted as `[]` — always
omitted when a message has none, so every existing text-only payload stays byte-identical). The
text field's blank-rejection moved from a field-level check to a `.superRefine()` cross-field
check — a message must have non-blank text **or** at least one attachment, never neither. This is
what makes an attachments-only message (blank text) valid, per the issue's "attachments without
text, if this fits cleanly" requirement.

## Storage

Metadata and bytes are owned separately. `AttachmentStorePort` (in-memory `AttachmentStore` +
durable `SqliteAttachmentStore`, selected exactly like `MessageStore`/`SqliteMessageStore` by
whether `--data-dir` is set) owns an attachment's lifecycle: **pending** (uploaded, not yet on a
message) → **linked** (attached to exactly one message) → swept away if never linked. A new SQLite
migration (`MIGRATION_11`) adds an `attachments` table plus a denormalized `messages.attachments_json`
snapshot column, following the same pattern `reference_json` used.

Bytes live on the local filesystem via a single `AttachmentBlobStore` class — not a dual
implementation, since only its root directory differs between modes: durable mode
`<dataDir>/attachments`; ephemeral mode a **fixed** (not per-PID) temp directory that is wiped and
recreated at every ephemeral-mode startup. No S3, no object storage, no new database.

**Path safety.** An `attachmentId` is always server-generated (`randomUUID()`) and regex-validated
against a UUID shape before it is ever used to build a filesystem path — a filename is metadata
only and is never used as a path component, even in principle (the validation makes a raw filename
structurally unable to match the id pattern).

## API

`POST /api/v1/boards/:boardId/attachments` (multipart, one file per request — matches per-file
upload-progress UX) uses `@fastify/multipart`, the official Fastify-org plugin (same publisher as
the already-installed `@fastify/cors`/`@fastify/websocket`), registered with its own `limits.fileSize`
so it never touches the global JSON `bodyLimit`. The handler buffers a part fully, checks
`truncated`/size/MIME type, and writes to disk **once**, only after every check passes — "nothing
is ever written to disk on a rejected upload" is true by construction, not by remembering to clean
up a partial file afterward.

`GET /api/v1/boards/:boardId/attachments/:attachmentId` serves content only for **linked**
attachments — pending, unknown, and wrong-board ids all collapse to the same 404, so the response
never discloses which case applied. Pre-send preview needs no server round-trip at all: the browser
already holds the `File` object in memory (`URL.createObjectURL` for image thumbnails).

Message creation (`POST /api/v1/boards/:boardId/messages`) now accepts `attachmentIds: string[]` —
only ids of attachments already uploaded, never re-supplied filename/mime/size. The route resolves
each id against the attachment store (rejecting unknown/wrong-board/already-linked ids, all-or-
nothing, before anything is stored), embeds the resolved metadata into the stored message, then
links the attachments — mirroring the existing non-transactional-but-ordered discipline already
governing `messageStore.append()` → `boardStore.recordMessageAppended()` → `messageBus.publish()`.

## Lifecycle and cleanup

- **Rejected upload**: never written to disk (buffer-first, as above).
- **Uploaded but never sent** (user removes it client-side, or a message-creation request fails):
  both collapse into one mechanism — a pending attachment (`message_id IS NULL`) past
  `pendingAttachmentTtlMs` (1 hour, the one new field on `ServerLimits`) is swept lazily, checked
  opportunistically on the next upload or message-creation call. No background timer/scheduler.
- **Hall Core restart in ephemeral mode**: the fixed temp directory is wiped at startup, matching
  boards/messages already resetting on restart in that mode.
- **Hall Core restart in durable mode**: attachments persist under `dataDir`, like everything else.
- **Deletion**: no `DELETE` endpoint — matches messages' existing no-PATCH/no-DELETE posture.
  Cleanup is only ever the TTL sweep above.

## Frontend

`MessageComposer` gains a paperclip button + hidden file input, drag-and-drop on the form, clipboard
image paste on the textarea, and per-file immediate upload with inline preview/progress/error state
— all validated client-side against the same protocol constants Hall Core enforces. `MessageList`
renders `message.attachments`: an image renders as a clickable thumbnail pointing at the GET
endpoint (a plain `<img src>`/`<a href>` carries the session cookie without any CORS involvement,
since simple tag-based subresource GETs are never CORS-gated), a non-image file renders as a
filename/size card with a native download link. Neither ever receives raw bytes or base64 over the
WebSocket — a confirmed message's `attachments` array carries only metadata, enough to build a GET
request.

## Agent integration — the honest gap

Before wiring anything, the actual question was: does board content of any kind reach CEO/worker
task execution today? **No — and this predates and is independent of attachments.**
`MessageStorePort.append()` has exactly three call sites (the human POST route, the CEO Agent's own
audit-summary posts, execution-status system posts); `.list()` has exactly two, both purely for
rendering to the browser (REST GET, WebSocket replay). `CommunicationMessage.reference` is one-way
(a CEO plan links forward to its own audit post on a board) — nothing reads board content back into
a task. No adapter, and no code in `task-orchestrator.ts`, ever calls `.list()` on a message store.

Given that, **no changes were made to `packages/agent-adapter-sdk`, no new `CapabilityId` was added,
and `AgentTaskInput` gained no new field.** An unused `AgentTaskInput.attachments` field would
exactly replicate an anti-pattern already present in this codebase: `AgentTaskInput.metadata` is
schema-legal but "completely inert in practice" (`task-orchestrator.ts` never populates it, and
`claude-code-adapter.test.ts` has a dedicated test proving the one adapter that reads it ignores it
entirely). Building a second unused extension point on top of a documented one serves no one.

Separately and independently: of the three CLI-backed adapters, none accept a file path or image
bytes today. Claude Code and Codex each receive a single text prompt (one `--print <prompt>` argv
element, or stdin); Hermes Router sends `{prompt, run_id}` over stdin. So even if a board→task
bridge existed, **no adapter could consume an image attachment today**, and only Hermes Router's
JSON-over-stdin transport is structurally close to being extended for text/code context without a
larger redesign.

Bridging board content (attachments or otherwise) into task execution — deciding what "the CEO can
see this" even means, given boards are a many-message discussion stream and a task has one prompt —
is a separate, larger feature. It is exactly the "new chat architecture" / "larger adapter redesign"
this issue's own scope explicitly excludes. The attachment infrastructure and UI above are complete
and usable for human↔human (and human↔system-audit) discussion today; making an agent aware of an
attachment is future work with its own design questions, not a small addition to this one.
