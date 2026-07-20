import { z } from "zod";

/**
 * Classification of one piece of a parsed Claude Code stream-json line,
 * already reduced to exactly what this adapter needs to build a
 * `NormalizedAgentEvent` from — never a raw provider payload. A single
 * stream-json line can classify into zero, one, or several of these (an
 * `assistant` message's `content` array can mix text and tool-use blocks
 * in one line), which is why `classifyNativeLine` returns an array.
 *
 * `"ignored"` covers every real, safe-but-not-lifecycle-relevant shape
 * observed from the installed CLI (2.1.212) that this adapter does not
 * need: `system`/`hook_started`, `system`/`hook_response`,
 * `rate_limit_event`, and any future/unknown `type` this adapter has
 * never seen — tolerated, not fatal, per the "unknown message types are
 * safe unsupported provider messages" policy.
 */
export type ParsedNativeMessage =
  | { readonly kind: "system-init"; readonly cwd?: string | undefined }
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool-use";
      readonly toolUseId: string;
      readonly toolName: string;
      /**
       * Only populated for `Edit`/`Write` tool calls, extracted solely
       * from `input.file_path` — no other `input` field is ever read or
       * forwarded. Raw and unresolved; `event-mapper.ts` resolves it
       * against the working directory and rejects it if it escapes
       * before it ever becomes part of a `file.changed` event.
       */
      readonly rawFilePath?: string | undefined;
    }
  | {
      readonly kind: "tool-result";
      readonly toolUseId: string;
      readonly success: boolean;
    }
  | {
      readonly kind: "result-success";
      readonly summary?: string | undefined;
      readonly deniedToolNames: readonly string[];
    }
  | {
      readonly kind: "result-error";
      readonly failureMessage: string;
      readonly subtype?: string | undefined;
      readonly deniedToolNames: readonly string[];
    }
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

const envelopeSchema = z.object({ type: z.unknown() }).passthrough();

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

const contentBlockSchema = z.object({ type: z.unknown() }).passthrough();

const FILE_EDIT_TOOL_NAMES = new Set(["Edit", "Write"]);

/**
 * Reads only `input.file_path` for a known file-editing tool — no other
 * key of `input` is ever read. Returns `undefined` for every other tool
 * name, and for a file-editing tool whose `input` doesn't have a string
 * `file_path` (tolerated, not an error: `event-mapper.ts` simply won't
 * have a path to emit a `file.changed` event for).
 */
function extractRawFilePath(toolName: string, input: unknown): string | undefined {
  if (!FILE_EDIT_TOOL_NAMES.has(toolName)) return undefined;
  if (input === null || typeof input !== "object") return undefined;
  const filePath = (input as Record<string, unknown>).file_path;
  return typeof filePath === "string" && filePath.length > 0 ? filePath : undefined;
}

function classifyContentBlock(rawBlock: unknown): ParsedNativeMessage {
  const parsed = contentBlockSchema.safeParse(rawBlock);
  if (!parsed.success || typeof parsed.data.type !== "string") {
    return { kind: "ignored" };
  }
  const block = parsed.data;

  if (block.type === "text" && typeof block.text === "string") {
    const text = boundedString(block.text, MAX_TEXT_LENGTH);
    return text !== undefined && text.length > 0 ? { kind: "text", text } : { kind: "ignored" };
  }

  if (
    block.type === "tool_use" &&
    typeof block.id === "string" &&
    block.id.length > 0 &&
    typeof block.name === "string" &&
    block.name.length > 0
  ) {
    const rawFilePath = extractRawFilePath(block.name, block.input);
    return { kind: "tool-use", toolUseId: block.id, toolName: block.name, rawFilePath };
  }

  // Other block types (e.g. "thinking") are real, safe, and deliberately
  // not surfaced as a normalized event in Phase 9 — see the module doc
  // comment.
  return { kind: "ignored" };
}

function classifyAssistantMessage(raw: Record<string, unknown>): ParsedNativeMessage[] {
  const message = raw.message;
  if (message === null || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content.map(classifyContentBlock).filter((entry) => entry.kind !== "ignored");
}

function classifyUserMessage(raw: Record<string, unknown>): ParsedNativeMessage[] {
  const message = raw.message;
  if (message === null || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];

  const results: ParsedNativeMessage[] = [];
  for (const rawBlock of content) {
    const parsed = contentBlockSchema.safeParse(rawBlock);
    if (!parsed.success || parsed.data.type !== "tool_result") continue;
    const block = parsed.data;
    if (typeof block.tool_use_id !== "string" || block.tool_use_id.length === 0) continue;
    const isError = block.is_error === true;
    // block.content (the provider's raw tool output — file contents,
    // command stdout, anything a real tool produced) is deliberately
    // never read here. See docs/architecture/0008-claude-code-adapter.md,
    // "Provider-to-Hall event mapping": raw tool output must never reach
    // a Hall event, even truncated.
    results.push({ kind: "tool-result", toolUseId: block.tool_use_id, success: !isError });
  }
  return results;
}

function classifySystemMessage(raw: Record<string, unknown>): ParsedNativeMessage {
  if (raw.subtype === "init") {
    const cwd = typeof raw.cwd === "string" ? raw.cwd : undefined;
    return { kind: "system-init", cwd };
  }
  return { kind: "ignored" };
}

const MAX_PERMISSION_DENIALS = 10;

/**
 * Extracts only tool names from the result message's `permission_denials`
 * array — this shape was never observed non-empty by the real zero-tool
 * probe this adapter's fixtures were captured from (Phase 9's probe used
 * `--tools ""`, so no permission could ever be denied), so this
 * extraction is best-effort and documented as unverified in
 * `docs/architecture/0008-claude-code-adapter.md`, "Native stream
 * mapping". A shape mismatch here is tolerated, never fatal — it only
 * means Hall never emits an `approval.required` event it could have.
 */
function extractDeniedToolNames(raw: Record<string, unknown>): readonly string[] {
  const denials = raw.permission_denials;
  if (!Array.isArray(denials)) return [];
  const names: string[] = [];
  for (const denial of denials.slice(0, MAX_PERMISSION_DENIALS)) {
    if (denial === null || typeof denial !== "object") continue;
    const toolName = (denial as Record<string, unknown>).tool_name;
    if (typeof toolName === "string" && toolName.length > 0) {
      names.push(boundedString(toolName, 200) ?? toolName);
    }
  }
  return names;
}

function classifyResultMessage(raw: Record<string, unknown>): InvalidLine | ClassifiedLine {
  if (typeof raw.is_error !== "boolean") {
    return { valid: false, reason: "result message missing boolean is_error field" };
  }
  const deniedToolNames = extractDeniedToolNames(raw);
  if (raw.is_error) {
    const failureMessage =
      boundedString(raw.result, 2000) ??
      boundedString(raw.subtype, 200) ??
      "Claude Code reported a run failure.";
    const subtype = boundedString(raw.subtype, 200);
    return {
      valid: true,
      messages: [{ kind: "result-error", failureMessage, subtype, deniedToolNames }],
    };
  }
  const summary = boundedString(raw.result, MAX_TEXT_LENGTH);
  return { valid: true, messages: [{ kind: "result-success", summary, deniedToolNames }] };
}

/**
 * Classifies one already-JSON-parsed stream-json line. `raw` is `unknown`
 * — never trusted as any specific provider shape until validated here.
 * Returns `{ valid: false }` only for lines that are structurally
 * unusable (not an object, missing a string `type`, or a `result`
 * message missing its required `is_error` field) — everything else,
 * including every message type this adapter has never seen before,
 * classifies successfully as `{ kind: "ignored" }` entries rather than
 * failing the whole run.
 */
export function classifyNativeLine(raw: unknown): ClassifiedLine | InvalidLine {
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success || typeof envelope.data.type !== "string") {
    return { valid: false, reason: "line is not an object with a string type field" };
  }
  const data = envelope.data as Record<string, unknown>;

  switch (data.type) {
    case "system":
      return { valid: true, messages: [classifySystemMessage(data)] };
    case "assistant":
      return { valid: true, messages: classifyAssistantMessage(data) };
    case "user":
      return { valid: true, messages: classifyUserMessage(data) };
    case "result":
      return classifyResultMessage(data);
    default:
      // rate_limit_event and any other/future type: safe, ignored.
      return { valid: true, messages: [{ kind: "ignored" }] };
  }
}
