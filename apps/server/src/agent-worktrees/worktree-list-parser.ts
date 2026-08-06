import path from "node:path";
import { AgentWorktreeGitOperationError } from "./agent-worktree-errors.js";

/** Machine-safe args for every call site that needs a registration list — NUL-delimited fields and NUL-delimited records, immune to embedded newlines or unusual path characters. See this module's own doc comment for the exact byte structure. */
export const WORKTREE_LIST_PORCELAIN_Z_ARGS: readonly string[] = [
  "worktree",
  "list",
  "--porcelain",
  "-z",
];

const WORKTREE_ATTRIBUTE_PREFIX = "worktree ";
export const GIT_WORKTREE_LIST_MALFORMED_CODE = "GIT_WORKTREE_LIST_MALFORMED";

/**
 * Strict parser for `git worktree list --porcelain -z` output — the one
 * parser every registration-inspecting call site in
 * `agent-worktree-manager.ts` uses (never a second, more permissive one).
 *
 * Byte structure, confirmed directly against a real `git worktree list
 * --porcelain -z` invocation (Git 2.54): each attribute line (`worktree
 * <path>`, `HEAD <sha>`, `branch <ref>`, `bare`, `detached`, `locked
 * [<reason>]`, `prunable [<reason>]`) is terminated by a single NUL
 * instead of a newline, and each worktree record is terminated by one
 * additional NUL beyond its last attribute's own terminator — i.e. two
 * consecutive NULs mark a record boundary, and the whole output always
 * ends immediately after the final record's boundary NUL. This is what
 * makes the format safe for paths containing spaces, newlines, or
 * non-ASCII characters: there is no line-oriented ambiguity to exploit,
 * unlike the plain (non-`-z`) porcelain format the previous parser used.
 *
 * Fails closed (throws `AgentWorktreeGitOperationError` with code
 * `GIT_WORKTREE_LIST_MALFORMED`) rather than silently returning an empty
 * or partial list whenever the byte structure does not exactly match what
 * real Git produces: a record whose first attribute is not a
 * non-empty, absolute `worktree ` path; a record with more than one
 * `worktree ` attribute (irreconcilable with valid Git output, and also
 * what a corrupted or concatenated single-NUL record separator would look
 * like once misparsed); the same worktree path appearing in more than one
 * record; output that does not end on a record boundary (an incomplete
 * final record). Genuinely empty output (zero bytes) is not itself
 * malformed — it parses to an empty list — but is never returned as the
 * silent result of anything that *looked* malformed.
 *
 * Never trims or reinterprets the extracted path — the byte range between
 * the `worktree ` prefix and its terminating NUL is preserved exactly,
 * including leading/trailing spaces and non-ASCII characters — and never
 * exposes the raw parsed content in its own error messages (the caller's
 * bounded `safeFailureCode` is the only thing that ever surfaces).
 */
export function parseWorktreeListPorcelainZ(stdout: string): readonly string[] {
  if (stdout.length === 0) return [];

  const segments = stdout.split("\0");
  // Real output always ends exactly on a record-boundary NUL, so the final
  // split segment is always an empty string. Anything else means the
  // output was cut off mid-record (or never had a boundary NUL at all) —
  // an incomplete record, not a valid empty tail.
  if (segments[segments.length - 1] !== "") {
    throw malformed();
  }
  segments.pop();

  const paths: string[] = [];
  const seenPaths = new Set<string>();
  let currentRecord: string[] = [];
  for (const segment of segments) {
    if (segment === "") {
      paths.push(validateRecord(currentRecord, seenPaths));
      currentRecord = [];
      continue;
    }
    currentRecord.push(segment);
  }
  if (currentRecord.length > 0) {
    // Leftover attributes with no closing record-separator NUL — the
    // output stopped mid-record.
    throw malformed();
  }
  return paths;
}

function validateRecord(attributes: readonly string[], seenPaths: Set<string>): string {
  const first = attributes[0];
  if (!first?.startsWith(WORKTREE_ATTRIBUTE_PREFIX)) {
    // A valid record's first attribute is always exactly one `worktree `
    // line — a missing or non-`worktree` first attribute is not structure
    // real Git ever produces.
    throw malformed();
  }
  const worktreeAttributeCount = attributes.filter((attribute) =>
    attribute.startsWith(WORKTREE_ATTRIBUTE_PREFIX),
  ).length;
  if (worktreeAttributeCount !== 1) {
    // More than one `worktree ` attribute within a single record is what
    // a corrupted or improperly single-NUL-joined record separator would
    // look like once parsed — never valid, real Git output.
    throw malformed();
  }
  const rawPath = first.slice(WORKTREE_ATTRIBUTE_PREFIX.length);
  if (rawPath.length === 0 || !path.isAbsolute(rawPath)) {
    throw malformed();
  }
  const normalized = path.resolve(rawPath);
  if (seenPaths.has(normalized)) {
    throw malformed();
  }
  seenPaths.add(normalized);
  return normalized;
}

function malformed(): AgentWorktreeGitOperationError {
  return new AgentWorktreeGitOperationError(
    GIT_WORKTREE_LIST_MALFORMED_CODE,
    "Git worktree list output was malformed.",
  );
}
