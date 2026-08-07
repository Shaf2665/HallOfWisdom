/**
 * Classifies the effective Git checkout-filter configuration (`filter.<name>.<clean|smudge|
 * process|required>`) visible to a candidate agent worktree, replacing a blanket "any configured
 * filter is rejected" rule with a narrow allowlist for exactly the standard Git LFS profile.
 *
 * Only inspects key NAMES and VALUES already read by the caller (via `git config --null
 * --get-regexp`) — this module never spawns a process itself. Every recognized value is an exact,
 * fixed string comparison against Git LFS's own documented standard output (`git lfs install`);
 * nothing here pattern-matches, globs, or otherwise tries to "look like" a safe command. A value
 * that doesn't exactly match a recognized form is rejected, never coerced or partially accepted.
 */

export type CheckoutFilterClassification =
  | { readonly kind: "none" }
  | { readonly kind: "recognized_lfs" }
  | { readonly kind: "rejected"; readonly code: CheckoutFilterRejectionCode };

export type CheckoutFilterRejectionCode =
  | "GIT_CHECKOUT_FILTER_UNSUPPORTED"
  | "GIT_CHECKOUT_FILTER_MALFORMED"
  | "GIT_LFS_CONFIGURATION_UNSUPPORTED"
  | "GIT_LFS_NOT_AVAILABLE";

interface ParsedFilterConfigEntry {
  readonly filterName: string;
  readonly subkey: string;
  readonly value: string;
  readonly isBooleanShorthand: boolean;
}

const FILTER_CONFIG_KEY_PATTERN = /^filter\.(.+)\.([^.]+)$/;

/**
 * Exact strings Git LFS's own installer (`git lfs install`) writes. `smudge`/`process` each have
 * two recognized forms — the plain form and the `--skip` form some operator setups configure
 * (`git lfs install --skip-smudge`) — both are equally standard, unmodified Git LFS output. `clean`
 * has one recognized form; Hall never needs a "skip" variant of `clean` since Hall never invokes it.
 */
const RECOGNIZED_LFS_CLEAN = new Set(["git-lfs clean -- %f"]);
const RECOGNIZED_LFS_SMUDGE = new Set(["git-lfs smudge -- %f", "git-lfs smudge --skip -- %f"]);
const RECOGNIZED_LFS_PROCESS = new Set(["git-lfs filter-process", "git-lfs filter-process --skip"]);
/** Git's own recognized "true" boolean spellings for a config value — not general boolean
 * normalization, just this fixed four-element set. `false`, an empty string, and anything else
 * are all rejected; `required` must be affirmatively true, never merely absent. */
const GIT_TRUE_SPELLINGS = new Set(["true", "1", "yes", "on"]);
const RECOGNIZED_LFS_SUBKEYS = new Set(["clean", "smudge", "process", "required"]);

/**
 * Parses `git config --null --get-regexp` output (already read into a string by the caller).
 * Each record is `<key>\n<value>` (or, for Git's own valueless boolean-shorthand config entries,
 * `<key>` with no embedded newline at all) terminated by a NUL byte; the buffer itself ends with a
 * trailing NUL. Returns `undefined` for anything that doesn't exactly match that byte structure —
 * a missing trailing NUL (truncated output), an unparseable key shape, or any other deviation —
 * rather than guessing at a partial parse.
 */
export function parseCheckoutFilterConfig(
  stdout: string,
): readonly ParsedFilterConfigEntry[] | undefined {
  if (stdout === "") return [];
  const segments = stdout.split("\0");
  const last = segments[segments.length - 1];
  if (last !== "") return undefined;
  const records = segments.slice(0, -1);
  const entries: ParsedFilterConfigEntry[] = [];
  for (const record of records) {
    if (record === "") return undefined;
    const newlineIndex = record.indexOf("\n");
    const isBooleanShorthand = newlineIndex === -1;
    const rawKey = isBooleanShorthand ? record : record.slice(0, newlineIndex);
    const value = isBooleanShorthand ? "" : record.slice(newlineIndex + 1);
    const match = FILTER_CONFIG_KEY_PATTERN.exec(rawKey);
    if (match === null) return undefined;
    const [, filterName, subkeyRaw] = match;
    if (filterName === undefined || subkeyRaw === undefined) return undefined;
    entries.push({ filterName, subkey: subkeyRaw.toLowerCase(), value, isBooleanShorthand });
  }
  return entries;
}

/**
 * Classifies already-parsed filter config entries. Supported: no entries at all, or exactly one
 * recognized standard Git LFS profile (case-sensitive subsection name `lfs`; `clean`/`smudge`/
 * `required` present with exact recognized values, `process` — the modern single-process protocol
 * — present-and-recognized or entirely absent, since older-but-standard Git LFS installs configure
 * only `clean`/`smudge`/`required`). Every other shape is rejected: any filter name other than
 * exactly `lfs`, more than one distinct filter name, a duplicated key (present more than once —
 * Hall does not attempt to re-derive Git's own multi-scope precedence order from unordered
 * `--get-regexp` output, so an ambiguous duplicate fails closed rather than guessing which
 * occurrence is effective), an unrecognized subkey under `filter.lfs.*`, or any recognized subkey
 * whose value does not exactly match one of the fixed recognized forms above.
 */
export function classifyCheckoutFilterEntries(
  entries: readonly ParsedFilterConfigEntry[],
): CheckoutFilterClassification {
  if (entries.length === 0) return { kind: "none" };

  const filterNames = new Set(entries.map((entry) => entry.filterName));
  if (filterNames.size > 1) return { kind: "rejected", code: "GIT_CHECKOUT_FILTER_UNSUPPORTED" };
  const [onlyFilterName] = filterNames;
  if (onlyFilterName !== "lfs") {
    return { kind: "rejected", code: "GIT_CHECKOUT_FILTER_UNSUPPORTED" };
  }

  const bySubkey = new Map<string, ParsedFilterConfigEntry[]>();
  for (const entry of entries) {
    const existing = bySubkey.get(entry.subkey);
    if (existing === undefined) {
      bySubkey.set(entry.subkey, [entry]);
    } else {
      existing.push(entry);
    }
  }
  for (const group of bySubkey.values()) {
    if (group.length > 1) return { kind: "rejected", code: "GIT_LFS_CONFIGURATION_UNSUPPORTED" };
  }
  for (const subkey of bySubkey.keys()) {
    if (!RECOGNIZED_LFS_SUBKEYS.has(subkey)) {
      return { kind: "rejected", code: "GIT_LFS_CONFIGURATION_UNSUPPORTED" };
    }
  }

  const clean = bySubkey.get("clean")?.[0];
  const smudge = bySubkey.get("smudge")?.[0];
  const processEntry = bySubkey.get("process")?.[0];
  const required = bySubkey.get("required")?.[0];

  if (clean === undefined || smudge === undefined || required === undefined) {
    return { kind: "rejected", code: "GIT_LFS_NOT_AVAILABLE" };
  }
  if (clean.isBooleanShorthand || !RECOGNIZED_LFS_CLEAN.has(clean.value)) {
    return { kind: "rejected", code: "GIT_LFS_CONFIGURATION_UNSUPPORTED" };
  }
  if (smudge.isBooleanShorthand || !RECOGNIZED_LFS_SMUDGE.has(smudge.value)) {
    return { kind: "rejected", code: "GIT_LFS_CONFIGURATION_UNSUPPORTED" };
  }
  if (
    processEntry !== undefined &&
    (processEntry.isBooleanShorthand || !RECOGNIZED_LFS_PROCESS.has(processEntry.value))
  ) {
    return { kind: "rejected", code: "GIT_LFS_CONFIGURATION_UNSUPPORTED" };
  }
  const requiredValue = required.isBooleanShorthand ? "true" : required.value.toLowerCase();
  if (!GIT_TRUE_SPELLINGS.has(requiredValue)) {
    return { kind: "rejected", code: "GIT_LFS_CONFIGURATION_UNSUPPORTED" };
  }

  return { kind: "recognized_lfs" };
}

const REJECTION_MESSAGES: Readonly<Record<CheckoutFilterRejectionCode, string>> = {
  GIT_CHECKOUT_FILTER_UNSUPPORTED: "Git checkout filters are not supported for agent worktrees.",
  GIT_CHECKOUT_FILTER_MALFORMED: "Git checkout filter configuration could not be safely read.",
  GIT_LFS_CONFIGURATION_UNSUPPORTED:
    "Git LFS filter configuration does not match the recognized standard profile.",
  GIT_LFS_NOT_AVAILABLE: "Git LFS filter configuration is incomplete.",
};

export function checkoutFilterRejectionMessage(code: CheckoutFilterRejectionCode): string {
  return REJECTION_MESSAGES[code];
}
