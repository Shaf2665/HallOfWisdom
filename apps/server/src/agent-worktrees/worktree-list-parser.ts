import path from "node:path";
import { AgentWorktreeGitOperationError } from "./agent-worktree-errors.js";
import { samePath } from "./path-safety.js";

/** Machine-safe args for every call site that needs a registration list — NUL-delimited fields and NUL-delimited records, immune to embedded newlines or unusual path characters. See this module's own doc comment for the exact byte structure. */
export const WORKTREE_LIST_PORCELAIN_Z_ARGS: readonly string[] = [
  "worktree",
  "list",
  "--porcelain",
  "-z",
];

const WORKTREE_ATTRIBUTE_PREFIX = "worktree ";
export const GIT_WORKTREE_LIST_MALFORMED_CODE = "GIT_WORKTREE_LIST_MALFORMED";

/** Every non-`worktree` attribute label documented by `git-worktree(1)` for `list --porcelain` — anything else fails closed rather than being silently ignored, so a future Git format addition cannot silently pass through unsupported. */
const KNOWN_NON_WORKTREE_LABELS: ReadonlySet<string> = new Set([
  "HEAD",
  "branch",
  "bare",
  "detached",
  "locked",
  "prunable",
]);

/** Git object ids are 40 hex characters (SHA-1) or 64 hex characters (SHA-256) — never hard-code just one length. */
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * Strict parser for `git worktree list --porcelain -z` output — the one
 * parser every registration-inspecting call site in
 * `agent-worktree-manager.ts` uses (never a second, more permissive one).
 *
 * Byte structure, confirmed directly against a real `git worktree list
 * --porcelain -z` invocation (Git 2.54): each attribute line (`worktree
 * <path>`, `HEAD <object-id>`, `branch <ref>`, `bare`, `detached`, `locked
 * [<reason>]`, `prunable [<reason>]`) is terminated by a single NUL
 * instead of a newline, and each worktree record is terminated by one
 * additional NUL beyond its last attribute's own terminator — i.e. two
 * consecutive NULs mark a record boundary, and the whole output always
 * ends immediately after the final record's boundary NUL. This is what
 * makes the format safe for paths containing spaces, newlines, or
 * non-ASCII characters: there is no line-oriented ambiguity to exploit,
 * unlike the plain (non-`-z`) porcelain format the previous parser used.
 *
 * A successful `git worktree list --porcelain -z` invocation against a
 * validated repository always reports at least one record (the primary
 * checkout or, for a bare repository, the bare record itself) — so
 * genuinely empty stdout with a `0` exit code is never proof that no
 * registration exists. It always means either this parser was invoked
 * against something other than real `worktree list -z` output, or a
 * future Git behavior change; either way it fails closed exactly like any
 * other malformed structure, never silently returned as an empty list.
 *
 * Every record's complete attribute set is validated, not merely its
 * first line: only the documented labels above are ever accepted (an
 * unrecognized label fails closed rather than being silently skipped —
 * this parser deliberately does not "future-proof" itself by ignoring
 * fields it doesn't understand); no label may appear more than once
 * (including a second `worktree` attribute — irreconcilable with valid
 * Git output, and also what a corrupted or single-NUL-instead-of-double
 * record separator would look like once misparsed); `HEAD` and `branch`
 * require a non-empty value, `bare`/`detached` must carry no value at
 * all, `locked`/`prunable` may carry an optional (possibly empty) reason;
 * a record must be either a bare record (`worktree` + `bare` and nothing
 * else) or a non-bare record with `HEAD` and exactly one of
 * `branch`/`detached` (`locked`/`prunable` optional on top); the same
 * worktree path may not be registered twice, compared with
 * platform-correct case sensitivity (`samePath`, matching every other
 * path comparison in this package); output that does not end on a record
 * boundary (an incomplete final record) fails closed the same way.
 *
 * Never trims or reinterprets the extracted path, branch ref, or
 * lock/prune reason — the byte range between an attribute's label and its
 * terminating NUL is preserved exactly, including leading/trailing spaces
 * and non-ASCII characters — and never exposes any raw parsed content in
 * its own error messages (the caller's bounded `safeFailureCode` is the
 * only thing that ever surfaces).
 */
export function parseWorktreeListPorcelainZ(stdout: string): readonly string[] {
  if (stdout.length === 0) {
    throw malformed();
  }

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
  const seenPaths: string[] = [];
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

interface ParsedAttribute {
  readonly label: string;
  readonly hasValue: boolean;
  readonly value: string;
}

function parseAttribute(raw: string): ParsedAttribute {
  const spaceIndex = raw.indexOf(" ");
  if (spaceIndex === -1) {
    return { label: raw, hasValue: false, value: "" };
  }
  return { label: raw.slice(0, spaceIndex), hasValue: true, value: raw.slice(spaceIndex + 1) };
}

function validateRecord(attributes: readonly string[], seenPaths: string[]): string {
  const first = attributes[0];
  if (!first?.startsWith(WORKTREE_ATTRIBUTE_PREFIX)) {
    // A valid record's first attribute is always exactly one `worktree `
    // line — a missing or non-`worktree` first attribute is not structure
    // real Git ever produces.
    throw malformed();
  }
  const rawPath = first.slice(WORKTREE_ATTRIBUTE_PREFIX.length);
  if (rawPath.length === 0 || !path.isAbsolute(rawPath)) {
    throw malformed();
  }
  const normalizedPath = path.resolve(rawPath);
  if (seenPaths.some((seen) => samePath(seen, normalizedPath))) {
    throw malformed();
  }

  const rest = attributes.slice(1);
  if (rest.some((attribute) => attribute.startsWith(WORKTREE_ATTRIBUTE_PREFIX))) {
    // A second `worktree` attribute within one record is what a
    // corrupted or single-NUL (instead of double-NUL) record separator
    // would look like once misparsed — never valid, real Git structure.
    throw malformed();
  }

  const seenLabels = new Set<string>();
  let head: string | undefined;
  let branch: string | undefined;
  let bare = false;
  let detached = false;
  let locked = false;
  let prunable = false;

  for (const attribute of rest) {
    const parsed = parseAttribute(attribute);
    if (!KNOWN_NON_WORKTREE_LABELS.has(parsed.label)) {
      throw malformed();
    }
    if (seenLabels.has(parsed.label)) {
      throw malformed();
    }
    seenLabels.add(parsed.label);

    switch (parsed.label) {
      case "HEAD": {
        if (!parsed.hasValue || !OBJECT_ID_PATTERN.test(parsed.value)) {
          throw malformed();
        }
        head = parsed.value;
        break;
      }
      case "branch": {
        if (!parsed.hasValue || parsed.value.length === 0) {
          throw malformed();
        }
        branch = parsed.value;
        break;
      }
      case "bare": {
        if (parsed.hasValue) throw malformed();
        bare = true;
        break;
      }
      case "detached": {
        if (parsed.hasValue) throw malformed();
        detached = true;
        break;
      }
      case "locked": {
        // A reason is optional and, when present, may be any text
        // (including one that happens to be empty) — never validated or
        // altered beyond being accepted.
        locked = true;
        break;
      }
      case "prunable": {
        prunable = true;
        break;
      }
      default:
        throw malformed();
    }
  }

  if (bare) {
    // A bare record's only defined structure is `worktree` + `bare` —
    // Hall has no defined semantics for a bare record additionally
    // carrying HEAD/branch/detached, or even locked/prunable (real Git
    // does not emit these for a bare primary repository record), so any
    // of them appearing alongside `bare` fails closed rather than being
    // silently accepted as some new, unanticipated combination.
    if (head !== undefined || branch !== undefined || detached || locked || prunable) {
      throw malformed();
    }
  } else {
    if (head === undefined) throw malformed();
    const hasBranch = branch !== undefined;
    if (hasBranch === detached) {
      // Exactly one of branch/detached is required — both present or
      // both absent are equally invalid.
      throw malformed();
    }
  }

  seenPaths.push(normalizedPath);
  return normalizedPath;
}

function malformed(): AgentWorktreeGitOperationError {
  return new AgentWorktreeGitOperationError(
    GIT_WORKTREE_LIST_MALFORMED_CODE,
    "Git worktree list output was malformed.",
  );
}
