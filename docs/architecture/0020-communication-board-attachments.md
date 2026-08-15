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

## Agent integration — the attachment → task execution bridge

An earlier revision of this document described a gap: board content of any kind never reached
CEO/worker task execution. `MessageStorePort.append()` has exactly three call sites (the human POST
route, the CEO Agent's own audit-summary posts, execution-status system posts); `.list()` has
exactly two, both purely for rendering to the browser (REST GET, WebSocket replay); no adapter and
no code in `task-orchestrator.ts` ever called `.list()` on a message store. A follow-up phase closed
that gap for attachments specifically — this section documents what actually reaches an agent today,
and what still does not.

### The semantic: what "this task's attachments" means

A board is attached to *at most one* task, at the deterministic id `taskBoardId(taskId)` (`task:<taskId>`)
— boards are never the reverse (a task is never created from a board message). So "the attachments
for a task" is defined as: **at each execution attempt (a fresh start, or a retry), snapshot every
attachment currently linked to a human-authored message on that task's own board.** That snapshot is
immutable for the attempt it was taken for, and is re-created fresh on retry — a board can accumulate
messages across a task's lifetime, including after assignment, and each execution attempt picks up
whatever is linked at that moment. Only human messages are considered: per the upload/link flow
described above, `attachmentIds` only ever reaches `MessageStorePort.append()` through the
human-POST route today, so a system-authored message (a CEO audit post, an execution-status post)
structurally cannot carry one — `TaskAttachmentMaterializer.snapshotAttachments` still filters on
`author.kind === "human"` explicitly, as defense in depth, not because it currently needs to.

### Materialization

`TaskAttachmentMaterializer` (`apps/server/src/agent-execution/task-attachment-materializer.ts`) is
called from `TaskOrchestrator#execute`, immediately after a worktree is prepared and before the
adapter is started. For a task whose snapshot is non-empty, each attachment's bytes are copied from
`AttachmentBlobStore` into `<worktree>/.hall-attachments/<attachmentId>/<filename>` — a Hall-owned,
bounded directory inside the agent's own isolated working directory, never a second, adapter-external
temp-storage location. Both path segments are already-validated-safe (a server-generated UUID, and a
filename rejected at upload time for control characters, path separators, and quotes), so no new
sanitization boundary is introduced. `GitArtifactCollector` excludes this exact directory from its
collected diff evidence — the files are Hall-injected input, never agent-produced output — and no
separate cleanup step exists: the directory lives inside the worktree, so the existing
`git worktree remove --force` cleanup (Phase 16.5) removes it along with everything else.

**Isolation is required.** Materialization only happens for an execution that resolved to a real,
Hall-owned worktree (`isolation: "worktree"`) — there is no other Hall-owned bounded directory to
write into safely, and Hall deliberately does not invent a second, non-worktree temp-storage
architecture to work around that. If a task has linked attachments but its assigned adapter is not
running isolated, execution fails clearly with `ATTACHMENT_REQUIRES_ISOLATED_EXECUTION` rather than
silently running text-only. In this server's default durable composition, `hall.codex` and
`hall.hermes-router` are isolated by default and `hall.claude-code` is not (a pre-existing default,
unrelated to this feature) — so Claude Code only receives attachments when isolation is explicitly
enabled for it, an already-supported configuration.

**Limits fail clearly, never silently.** A single execution's attachments are capped at 20 files and
64 MiB combined (`MAX_TASK_ATTACHMENTS`/`MAX_TASK_ATTACHMENTS_TOTAL_BYTES`,
`@hall-of-wisdom/agent-adapter-sdk`) — exceeding either bound throws
`ATTACHMENT_MATERIALIZATION_LIMIT_EXCEEDED` before any blob is read or file written, never a silent
drop of the excess. A missing or unreadable blob throws `ATTACHMENT_BLOB_UNAVAILABLE`. Both failure
paths reach the task through the same infrastructure-failure path every other orchestration error
already uses (a normalized `run.failed` event with a stable, safe code), and — because the failure is
thrown only after the worktree is already known to `TaskOrchestrator#execute`, not before — the
prepared worktree is still cleaned up normally.

### `AgentTaskInput.attachments`

`agentTaskInputSchema` (`packages/agent-adapter-sdk/src/task-input.ts`) gained one new optional
field: `attachments`, an array of `{ relativePath, filename, mimeType, kind }` (never an absolute
host path — `relativePath` is always relative to `AgentTaskInput.workingDirectory`), omitted
entirely (never an empty array) for a text-only task, matching the same convention
`CommunicationMessage.attachments` already established. This *does* depart from the earlier revision
of this document, which deliberately avoided adding an unused field to `AgentTaskInput` to avoid
replicating the `metadata` anti-pattern (schema-legal but inert — `task-orchestrator.ts` never
populates it, and `claude-code-adapter.test.ts` proves the one adapter that reads it ignores it
regardless). `attachments` is different in kind, not just in name: it is populated by trusted
server code from files Hall itself materialized (never client-controlled shape or content), and it
is actually read by every adapter below — an inert extension point would have repeated the mistake;
a consumed one does not.

### Adapter propagation

- **Claude Code / Codex** — both already receive the task prompt as a single bounded string (one
  argv element, or stdin). Their `prompt-builder.ts` accepts an optional `attachments` list and,
  when present, appends a fixed "Attached files" section (relative path, filename, MIME type) ahead
  of the task description — built as non-truncatable content, like the rest of the header, so a
  truncated description never silently drops which files are attached. Every attachment, image or
  not, always gets this text-line reference. `Read` is already in Claude Code's fixed
  `--allowedTools` list, and Codex's sandbox already permits reading any file inside its own working
  directory — both can open one of these paths with the tools they already have, independent of
  whatever vision capability (below) they do or don't have.
- **Hermes Router** — its stdin JSON payload gains an additive `attachments` array (`relative_path`,
  `filename`, `mime_type`, `kind` per entry), the same additive, backward-compatible pattern already
  used for `task_intent`.
- A text-only task's `AgentTaskInput`/prompt/payload is byte-identical to before this field
  existed — every adapter's own attachment handling short-circuits to a no-op when `attachments` is
  absent.

## Vision / image capability (Session 2)

Session 1 (above) carried attachments through as file-path context only, with no adapter told to
treat an image as multimodal input. This session adds a provider-neutral `vision.image` capability
id (`packages/protocol/src/capability.ts`) and wires each real adapter to it — verified only where
genuinely proven, declared-only or fail-closed everywhere else.

### Capability model

`vision.image` slots into the existing capability/routing system unchanged: an adapter's `detect()`
reports a `CapabilityObservation` with `status: "verified" | "declared" | "unsupported"`, and
routing's `evaluateCandidateEligibility` (`apps/server/src/routing/routing-policy.ts`) only ever
treats `"verified"` as satisfying a required capability — the same rule already governing every
other capability id, unchanged by this session.

### Per-adapter behavior

- **Codex** — `codex exec --help` genuinely exposes `-i, --image <FILE>...` (confirmed live against
  the installed CLI). `adapters/codex/src/cli-compatibility.ts` probes for the literal `--image`
  marker independently of the existing isolation-flag markers, so an older CLI missing only this
  flag still passes isolation and simply never reports `vision.image` verified. When verified,
  `codex-adapter.ts` passes every image attachment's absolute materialized path via
  `--image <paths...> --` (the trailing `--` — confirmed live via the same zero-model-usage
  `--strict-config` probe technique already used elsewhere in this adapter — stops the variadic
  flag from swallowing the `-` stdin-prompt sentinel).
- **Claude Code** — `claude --help` exposes no image/multimodal-input flag. `vision.image` is
  **declared** (plausible: Claude models are multimodal and an attached image is reachable through
  the already-permitted `Read` tool) but `detect()` never reports it `verified` — no real
  local-image mechanism has been proven end-to-end, and proving one would cost real subscription
  usage this session deliberately did not spend. Routing's verified-only rule means required vision
  work can never auto-route here.
- **Hermes Router** — real end-to-end multimodal support. `hermes_agent` (in the separate
  `Shaf2665/Hermes-router` repository) reads a `kind == "image"` attachment straight off its own
  worktree (the same materialized path Hall already wrote), base64-encodes it, and builds an
  OpenAI-format `image_url` content block alongside the text prompt — reaching `router.py`'s
  pre-existing (untouched by this session) vision-aware model gating and Anthropic content
  translation. Hall's `deriveTaskIntent` (`adapters/hermes-router/src/task-intent.ts`) derives
  `task_intent: "vision"` only from a real image attachment, never merely from a `vision.image`
  capability requirement — a `vision` intent with no image content must never be treated as
  multimodal. `router.py`'s `/v1/status` reports `supports_vision` per model (reusing its existing,
  non-hardcoded model-family pattern list); `hermes_agent detect` surfaces that as an additive
  `vision_available` boolean, and `detectHermesRouter` reports `vision.image` verified only when
  it's `true` — never a hard requirement for the adapter's own overall availability, so normal
  coding/review/general routing is unaffected either way.

### Fail-closed, not fail-soft: image preparation

A real image attachment on a task means vision was required — not an optional decoration. Two
independent layers enforce this:

- **Routing time** — `TaskOrchestrator#requirementsWithVisionIfImageAttached` best-effort injects
  `vision.image` into the requirements `routingAnalysis()`/`routeAndAssign()` evaluate against for
  an image-attached task, so an ineligible adapter is filtered from the candidate list before ever
  being assigned. This is never persisted onto the task record — a synthetic, attachment-derived
  requirement must not outlive the attachment it came from (delete the image later, and a text-only
  task must not stay permanently gated on a capability it no longer needs).
- **Execution time** — `TaskOrchestrator#withMaterializedAttachments` re-checks the actually-resolved
  adapter's fresh `detect()` result (from this same execution's preflight, never a second spawn)
  immediately before materializing: an image attachment with no `verified` `vision.image` observation
  throws `ImageAttachmentRequiresVisionCapabilityError` (`IMAGE_ATTACHMENT_REQUIRES_VISION_CAPABILITY`)
  before any file is written — this is the authoritative, fail-closed backstop, applying identically
  whether the adapter was auto-routed or manually assigned.

On the Hermes side, preparing the actual image bytes is equally fail-closed:
`hermes_agent.__main__.build_image_content_parts` raises
`AgentError(IMAGE_ATTACHMENT_UNAVAILABLE_CODE, ...)` — never returns a partial list, never
degrades to text-only — the moment any single required image is missing, unreadable (an `OSError`
opening it), oversized (per-image or total budget), or an unsupported MIME type; one bad image
among several fails the whole request, not just that one image. This check runs strictly before
`AgentRuntime.run()` is ever called, so a preparation failure never reaches the router — no
model/provider request is made. A valid image (and a task with no image attachment at all) is
completely unaffected.

### What remains

No real end-to-end run against a live vision-capable model has been executed by either repository
this session — Codex's `--image` flow is verified at the CLI-contract level (flag presence, argv
shape) but never task-run; Hermes's flow is proven by unit tests up to the point `router.py`'s
already-tested vision gating takes over. Claude Code is intentionally excluded from ever claiming
verified support. No UI-facing "vision" requirement profile was added to `apps/web`.
