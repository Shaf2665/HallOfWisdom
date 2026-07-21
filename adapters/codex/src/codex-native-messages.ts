import { z } from "zod";

/**
 * Classification of one piece of a parsed Codex JSONL line, already
 * reduced to exactly what this adapter needs to build a
 * `NormalizedAgentEvent` from — never a raw provider payload.
 *
 * Confirmed live against the installed CLI (`codex-cli 0.144.4`) during
 * Phase 10 reconnaissance: `thread.started` (carries a real `thread_id`,
 * never forwarded), `turn.started` (no fields), `item.completed` with
 * `item.type: "agent_message"` (a single, complete `text` field — no
 * `item.started`/partial variant was observed for a plain message turn),
 * and `turn.completed` (carries a `usage` token-count block, never
 * forwarded). `command_execution` and `file_change` item shapes were
 * *not* observed live (the reconnaissance probe used a message-only
 * prompt) — the shapes assumed below are a best-effort reading of the
 * publicly documented event families and are deliberately tolerant: an
 * unrecognized shape classifies as `"ignored"` rather than failing the
 * line, and the real isolated smoke test (which performs an actual file
 * edit) is expected to confirm or correct them — see
 * `docs/architecture/0009-codex-adapter.md`, "Native JSONL mapping", for
 * the disclosed verification status of each event family.
 */
export type ParsedNativeMessage =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool-started"; readonly itemId: string }
  | { readonly kind: "tool-completed"; readonly itemId: string; readonly success: boolean }
  | {
      readonly kind: "file-change";
      readonly itemId: string;
      readonly rawPath: string;
      readonly changeKind: "created" | "modified" | "deleted";
    }
  | { readonly kind: "result-success"; readonly summary?: string | undefined }
  | { readonly kind: "result-error"; readonly failureMessage: string }
  | { readonly kind: "ignored" };

export interface ClassifiedLine {
  readonly valid: true;
  readonly messages: readonly ParsedNativeMessage[];
}

export interface InvalidLine {
  readonly valid: false;
  readonly reason: string;
}

const MAX_TEXT_LENGTH = 20000;

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

const envelopeSchema = z.object({ type: z.unknown() }).passthrough();
const itemSchema = z.object({ id: z.unknown(), type: z.unknown() }).passthrough();

const CHANGE_KIND_MAP: Record<string, "created" | "modified" | "deleted"> = {
  add: "created",
  added: "created",
  create: "created",
  created: "created",
  modify: "modified",
  modified: "modified",
  update: "modified",
  updated: "modified",
  delete: "deleted",
  deleted: "deleted",
  remove: "deleted",
  removed: "deleted",
};

function classifyFileChangeItem(item: Record<string, unknown>): ParsedNativeMessage[] {
  const itemId = boundedString(item.id, 200);
  if (itemId === undefined) return [];
  const status = boundedString(item.status, 100);
  // Only a positively-confirmed successful/completed status is treated as
  // evidence of a real file change — anything else (denied, failed,
  // unrecognized, or simply absent) never produces a `file-change`
  // message. See the module doc comment on unverified shapes.
  if (status !== undefined && status !== "completed" && status !== "success") return [];

  const changes = item.changes;
  if (!Array.isArray(changes)) return [];

  const results: ParsedNativeMessage[] = [];
  for (const rawChange of changes) {
    if (rawChange === null || typeof rawChange !== "object") continue;
    const change = rawChange as Record<string, unknown>;
    const rawPath = boundedString(change.path, 4000);
    if (rawPath === undefined || rawPath.length === 0) continue;
    const kindLabel = boundedString(change.kind, 50)?.toLowerCase();
    const changeKind =
      (kindLabel !== undefined ? CHANGE_KIND_MAP[kindLabel] : undefined) ?? "modified";
    results.push({ kind: "file-change", itemId, rawPath, changeKind });
  }
  return results;
}

function classifyCommandExecutionCompleted(item: Record<string, unknown>): ParsedNativeMessage[] {
  const itemId = boundedString(item.id, 200);
  if (itemId === undefined) return [];
  const status = boundedString(item.status, 100);
  const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
  // A shape this adapter cannot confidently read as a definite
  // success/failure is not guessed at — the tool-use pairing this item
  // belongs to (if any, matched by itemId) simply never receives a
  // tool.completed event. See event-mapper.ts's tolerant, unmatched-ID
  // handling.
  const success =
    exitCode !== undefined ? exitCode === 0 : status === "completed" || status === "success";
  if (status === undefined && exitCode === undefined) return [];
  return [{ kind: "tool-completed", itemId, success }];
}

function classifyItemStarted(rawItem: unknown): ParsedNativeMessage[] {
  const parsed = itemSchema.safeParse(rawItem);
  if (!parsed.success || typeof parsed.data.type !== "string") return [];
  const item = parsed.data as Record<string, unknown>;
  const itemId = boundedString(item.id, 200);
  if (itemId === undefined) return [];

  if (item.type === "command_execution") {
    return [{ kind: "tool-started", itemId }];
  }
  // agent_message, reasoning, mcp_tool_call, web_search, plan/plan_update,
  // file_change, and any unknown/future item type: no started-phase event
  // is emitted for any of these in Phase 10 — see the module doc comment.
  return [];
}

function classifyItemCompleted(rawItem: unknown): ParsedNativeMessage[] {
  const parsed = itemSchema.safeParse(rawItem);
  if (!parsed.success || typeof parsed.data.type !== "string") return [];
  const item = parsed.data as Record<string, unknown>;

  switch (item.type) {
    case "agent_message": {
      const text = boundedString(item.text, MAX_TEXT_LENGTH);
      return text !== undefined && text.length > 0 ? [{ kind: "text", text }] : [];
    }
    case "command_execution":
      return classifyCommandExecutionCompleted(item);
    case "file_change":
      return classifyFileChangeItem(item);
    default:
      // reasoning, mcp_tool_call, web_search, plan/plan_update, and any
      // unknown/future item type: real, safe, deliberately not surfaced
      // as a normalized event in Phase 10 — see the module doc comment.
      return [];
  }
}

/**
 * Classifies one already-JSON-parsed Codex JSONL line. `raw` is
 * `unknown` — never trusted as any specific provider shape until
 * validated here. Returns `{ valid: false }` only for lines that are
 * structurally unusable (not an object, or missing a string `type`
 * field) — everything else, including every event/item type this adapter
 * has never seen before, classifies successfully as `{ kind: "ignored" }`
 * entries rather than failing the whole run.
 */
export function classifyNativeLine(raw: unknown): ClassifiedLine | InvalidLine {
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success || typeof envelope.data.type !== "string") {
    return { valid: false, reason: "line is not an object with a string type field" };
  }
  const data = envelope.data as Record<string, unknown>;

  switch (data.type) {
    // thread_id is a real provider session identifier and is never
    // forwarded — see the module doc comment.
    case "thread.started":
      return { valid: true, messages: [{ kind: "ignored" }] };
    // run.started is already emitted by CodexRun the moment the process
    // successfully spawns (mirroring the Claude Code adapter's own
    // discipline), so the native turn.started event carries no
    // additional information this adapter needs.
    case "turn.started":
      return { valid: true, messages: [{ kind: "ignored" }] };
    case "item.started":
      return { valid: true, messages: classifyItemStarted(data.item) };
    case "item.updated":
      // Not reliably documented for the installed CLI version — tolerated
      // as a safe no-op rather than treated as an error.
      return { valid: true, messages: [{ kind: "ignored" }] };
    case "item.completed":
      return { valid: true, messages: classifyItemCompleted(data.item) };
    case "turn.completed": {
      // usage (token counts) is deliberately never read or forwarded.
      const summary = boundedString(data.summary, MAX_TEXT_LENGTH);
      return { valid: true, messages: [{ kind: "result-success", summary }] };
    }
    case "turn.failed": {
      const failureMessage = boundedString(data.message, 2000) ?? "Codex reported a turn failure.";
      return { valid: true, messages: [{ kind: "result-error", failureMessage }] };
    }
    case "error": {
      const failureMessage = boundedString(data.message, 2000) ?? "Codex reported an error.";
      return { valid: true, messages: [{ kind: "result-error", failureMessage }] };
    }
    default:
      // Any other/future type: safe, ignored.
      return { valid: true, messages: [{ kind: "ignored" }] };
  }
}
