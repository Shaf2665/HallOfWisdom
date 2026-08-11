import { describe, expect, it } from "vitest";
import {
  classifyCheckoutFilterEntries,
  parseCheckoutFilterConfig,
  checkoutFilterRejectionMessage,
} from "./checkout-filter-policy.js";

const NUL = "\0";

/** Builds the exact `git config --null --get-regexp` byte shape: `key\nvalue` per record, each
 * terminated by NUL, buffer itself ending in a trailing NUL. */
function nullRecords(entries: readonly (readonly [string, string])[]): string {
  return (
    entries.map(([key, value]) => `${key}\n${value}`).join(NUL) + (entries.length > 0 ? NUL : "")
  );
}

/** A record with no `=` at all (Git's own boolean-shorthand config syntax) — no embedded newline. */
function booleanShorthandRecord(key: string): string {
  return `${key}${NUL}`;
}

const STANDARD_LFS = [
  ["filter.lfs.clean", "git-lfs clean -- %f"],
  ["filter.lfs.smudge", "git-lfs smudge -- %f"],
  ["filter.lfs.process", "git-lfs filter-process"],
  ["filter.lfs.required", "true"],
] as const;

describe("parseCheckoutFilterConfig", () => {
  it("parses empty output as zero entries", () => {
    expect(parseCheckoutFilterConfig("")).toEqual([]);
  });

  it("parses the standard Git LFS profile", () => {
    const entries = parseCheckoutFilterConfig(nullRecords(STANDARD_LFS));
    expect(entries).toEqual([
      {
        filterName: "lfs",
        subkey: "clean",
        value: "git-lfs clean -- %f",
        isBooleanShorthand: false,
      },
      {
        filterName: "lfs",
        subkey: "smudge",
        value: "git-lfs smudge -- %f",
        isBooleanShorthand: false,
      },
      {
        filterName: "lfs",
        subkey: "process",
        value: "git-lfs filter-process",
        isBooleanShorthand: false,
      },
      { filterName: "lfs", subkey: "required", value: "true", isBooleanShorthand: false },
    ]);
  });

  it("parses a valueless boolean-shorthand entry distinctly from an explicit empty value", () => {
    const shorthand = parseCheckoutFilterConfig(booleanShorthandRecord("filter.lfs.required"));
    expect(shorthand).toEqual([
      { filterName: "lfs", subkey: "required", value: "", isBooleanShorthand: true },
    ]);
    const explicitEmpty = parseCheckoutFilterConfig(nullRecords([["filter.lfs.required", ""]]));
    expect(explicitEmpty).toEqual([
      { filterName: "lfs", subkey: "required", value: "", isBooleanShorthand: false },
    ]);
  });

  it("preserves a filter name containing dots, treating only the final segment as the subkey", () => {
    const entries = parseCheckoutFilterConfig(nullRecords([["filter.my.custom.clean", "cmd"]]));
    expect(entries).toEqual([
      { filterName: "my.custom", subkey: "clean", value: "cmd", isBooleanShorthand: false },
    ]);
  });

  it("lowercases the subkey but preserves filter-name case exactly", () => {
    const entries = parseCheckoutFilterConfig(nullRecords([["filter.LFS.CLEAN", "cmd"]]));
    expect(entries).toEqual([
      { filterName: "LFS", subkey: "clean", value: "cmd", isBooleanShorthand: false },
    ]);
  });

  it("returns undefined for output missing the trailing NUL (truncated)", () => {
    const truncated = nullRecords(STANDARD_LFS).slice(0, -1);
    expect(parseCheckoutFilterConfig(truncated)).toBeUndefined();
  });

  it("returns undefined for a key that does not match the filter.<name>.<subkey> shape", () => {
    expect(parseCheckoutFilterConfig(nullRecords([["not-a-filter-key", "value"]]))).toBeUndefined();
  });

  it("returns undefined for an empty record between two NULs", () => {
    expect(parseCheckoutFilterConfig(`${NUL}${NUL}`)).toBeUndefined();
  });
});

describe("classifyCheckoutFilterEntries", () => {
  it("classifies zero entries as none", () => {
    expect(classifyCheckoutFilterEntries([])).toEqual({ kind: "none" });
  });

  it("classifies the exact standard Git LFS profile as recognized", () => {
    const entries = parseCheckoutFilterConfig(nullRecords(STANDARD_LFS));
    expect(entries).toBeDefined();
    expect(classifyCheckoutFilterEntries(entries ?? [])).toEqual({ kind: "recognized_lfs" });
  });

  it("recognizes the documented --skip smudge/process forms", () => {
    const entries = parseCheckoutFilterConfig(
      nullRecords([
        ["filter.lfs.clean", "git-lfs clean -- %f"],
        ["filter.lfs.smudge", "git-lfs smudge --skip -- %f"],
        ["filter.lfs.process", "git-lfs filter-process --skip"],
        ["filter.lfs.required", "true"],
      ]),
    );
    expect(classifyCheckoutFilterEntries(entries ?? [])).toEqual({ kind: "recognized_lfs" });
  });

  it("recognizes an older-style LFS profile with no process key at all", () => {
    const entries = parseCheckoutFilterConfig(
      nullRecords([
        ["filter.lfs.clean", "git-lfs clean -- %f"],
        ["filter.lfs.smudge", "git-lfs smudge -- %f"],
        ["filter.lfs.required", "true"],
      ]),
    );
    expect(classifyCheckoutFilterEntries(entries ?? [])).toEqual({ kind: "recognized_lfs" });
  });

  it.each(["1", "yes", "on", "TRUE", "On"])(
    "accepts git's true-spelling %s for required",
    (spelling) => {
      const entries = parseCheckoutFilterConfig(
        nullRecords([
          ["filter.lfs.clean", "git-lfs clean -- %f"],
          ["filter.lfs.smudge", "git-lfs smudge -- %f"],
          ["filter.lfs.required", spelling],
        ]),
      );
      expect(classifyCheckoutFilterEntries(entries ?? [])).toEqual({ kind: "recognized_lfs" });
    },
  );

  it("accepts a valueless boolean-shorthand required key as true", () => {
    const entries = [
      {
        filterName: "lfs",
        subkey: "clean",
        value: "git-lfs clean -- %f",
        isBooleanShorthand: false,
      },
      {
        filterName: "lfs",
        subkey: "smudge",
        value: "git-lfs smudge -- %f",
        isBooleanShorthand: false,
      },
      { filterName: "lfs", subkey: "required", value: "", isBooleanShorthand: true },
    ];
    expect(classifyCheckoutFilterEntries(entries)).toEqual({ kind: "recognized_lfs" });
  });

  it("rejects required=false", () => {
    const entries = parseCheckoutFilterConfig(
      nullRecords([
        ["filter.lfs.clean", "git-lfs clean -- %f"],
        ["filter.lfs.smudge", "git-lfs smudge -- %f"],
        ["filter.lfs.required", "false"],
      ]),
    );
    expect(classifyCheckoutFilterEntries(entries ?? [])).toEqual({
      kind: "rejected",
      code: "GIT_LFS_CONFIGURATION_UNSUPPORTED",
    });
  });

  it("rejects a missing required subkey as not available", () => {
    const entries = parseCheckoutFilterConfig(
      nullRecords([
        ["filter.lfs.clean", "git-lfs clean -- %f"],
        ["filter.lfs.smudge", "git-lfs smudge -- %f"],
      ]),
    );
    expect(classifyCheckoutFilterEntries(entries ?? [])).toEqual({
      kind: "rejected",
      code: "GIT_LFS_NOT_AVAILABLE",
    });
  });

  it("rejects a missing clean or smudge command", () => {
    const missingClean = parseCheckoutFilterConfig(
      nullRecords([
        ["filter.lfs.smudge", "git-lfs smudge -- %f"],
        ["filter.lfs.required", "true"],
      ]),
    );
    expect(classifyCheckoutFilterEntries(missingClean ?? [])).toEqual({
      kind: "rejected",
      code: "GIT_LFS_NOT_AVAILABLE",
    });
    const missingSmudge = parseCheckoutFilterConfig(
      nullRecords([
        ["filter.lfs.clean", "git-lfs clean -- %f"],
        ["filter.lfs.required", "true"],
      ]),
    );
    expect(classifyCheckoutFilterEntries(missingSmudge ?? [])).toEqual({
      kind: "rejected",
      code: "GIT_LFS_NOT_AVAILABLE",
    });
  });

  it("rejects a modified clean command", () => {
    const entries = parseCheckoutFilterConfig(
      nullRecords([
        ["filter.lfs.clean", "git-lfs clean --extra -- %f"],
        ["filter.lfs.smudge", "git-lfs smudge -- %f"],
        ["filter.lfs.required", "true"],
      ]),
    );
    expect(classifyCheckoutFilterEntries(entries ?? [])).toEqual({
      kind: "rejected",
      code: "GIT_LFS_CONFIGURATION_UNSUPPORTED",
    });
  });

  it("rejects a modified smudge command", () => {
    const entries = parseCheckoutFilterConfig(
      nullRecords([
        ["filter.lfs.clean", "git-lfs clean -- %f"],
        ["filter.lfs.smudge", "git-lfs smudge --evil -- %f"],
        ["filter.lfs.required", "true"],
      ]),
    );
    expect(classifyCheckoutFilterEntries(entries ?? [])).toEqual({
      kind: "rejected",
      code: "GIT_LFS_CONFIGURATION_UNSUPPORTED",
    });
  });

  it("rejects a modified process command", () => {
    const entries = parseCheckoutFilterConfig(
      nullRecords([
        ["filter.lfs.clean", "git-lfs clean -- %f"],
        ["filter.lfs.smudge", "git-lfs smudge -- %f"],
        ["filter.lfs.process", "git-lfs filter-process --extra"],
        ["filter.lfs.required", "true"],
      ]),
    );
    expect(classifyCheckoutFilterEntries(entries ?? [])).toEqual({
      kind: "rejected",
      code: "GIT_LFS_CONFIGURATION_UNSUPPORTED",
    });
  });

  it("rejects an unknown subkey under filter.lfs.*", () => {
    const entries = parseCheckoutFilterConfig(
      nullRecords([
        ["filter.lfs.clean", "git-lfs clean -- %f"],
        ["filter.lfs.smudge", "git-lfs smudge -- %f"],
        ["filter.lfs.required", "true"],
        ["filter.lfs.cache", "somevalue"],
      ]),
    );
    expect(classifyCheckoutFilterEntries(entries ?? [])).toEqual({
      kind: "rejected",
      code: "GIT_LFS_CONFIGURATION_UNSUPPORTED",
    });
  });

  it("rejects an unknown (non-lfs) filter name", () => {
    const entries = parseCheckoutFilterConfig(
      nullRecords([["filter.halltest.smudge", "sh -c evil"]]),
    );
    expect(classifyCheckoutFilterEntries(entries ?? [])).toEqual({
      kind: "rejected",
      code: "GIT_CHECKOUT_FILTER_UNSUPPORTED",
    });
  });

  it("rejects a case-mismatched filter subsection (LFS is a different name than lfs)", () => {
    const entries = parseCheckoutFilterConfig(
      nullRecords([["filter.LFS.clean", "git-lfs clean -- %f"]]),
    );
    expect(classifyCheckoutFilterEntries(entries ?? [])).toEqual({
      kind: "rejected",
      code: "GIT_CHECKOUT_FILTER_UNSUPPORTED",
    });
  });

  it("rejects multiple distinct filter names even if one is lfs", () => {
    const entries = parseCheckoutFilterConfig(
      nullRecords([
        ["filter.lfs.clean", "git-lfs clean -- %f"],
        ["filter.lfs.smudge", "git-lfs smudge -- %f"],
        ["filter.lfs.required", "true"],
        ["filter.halltest.smudge", "sh -c evil"],
      ]),
    );
    expect(classifyCheckoutFilterEntries(entries ?? [])).toEqual({
      kind: "rejected",
      code: "GIT_CHECKOUT_FILTER_UNSUPPORTED",
    });
  });

  it("rejects a duplicated key with conflicting values as ambiguous", () => {
    const entries = parseCheckoutFilterConfig(
      nullRecords([
        ["filter.lfs.clean", "git-lfs clean -- %f"],
        ["filter.lfs.clean", "git-lfs clean --tampered -- %f"],
        ["filter.lfs.smudge", "git-lfs smudge -- %f"],
        ["filter.lfs.required", "true"],
      ]),
    );
    expect(classifyCheckoutFilterEntries(entries ?? [])).toEqual({
      kind: "rejected",
      code: "GIT_LFS_CONFIGURATION_UNSUPPORTED",
    });
  });

  it("accepts duplicated keys when every occurrence carries the identical recognized value", () => {
    const entries = parseCheckoutFilterConfig(
      nullRecords([
        ["filter.lfs.clean", "git-lfs clean -- %f"],
        ["filter.lfs.clean", "git-lfs clean -- %f"],
        ["filter.lfs.smudge", "git-lfs smudge -- %f"],
        ["filter.lfs.required", "true"],
      ]),
    );
    expect(classifyCheckoutFilterEntries(entries ?? [])).toEqual({ kind: "recognized_lfs" });
  });

  it("rejects an absolute custom executable disguised as the lfs filter", () => {
    const entries = parseCheckoutFilterConfig(
      nullRecords([
        ["filter.lfs.clean", "C:\\evil\\backdoor.exe --clean %f"],
        ["filter.lfs.smudge", "git-lfs smudge -- %f"],
        ["filter.lfs.required", "true"],
      ]),
    );
    expect(classifyCheckoutFilterEntries(entries ?? [])).toEqual({
      kind: "rejected",
      code: "GIT_LFS_CONFIGURATION_UNSUPPORTED",
    });
  });

  it("rejects command chaining appended to an otherwise-recognized value", () => {
    const entries = parseCheckoutFilterConfig(
      nullRecords([
        ["filter.lfs.clean", "git-lfs clean -- %f; rm -rf /"],
        ["filter.lfs.smudge", "git-lfs smudge -- %f"],
        ["filter.lfs.required", "true"],
      ]),
    );
    expect(classifyCheckoutFilterEntries(entries ?? [])).toEqual({
      kind: "rejected",
      code: "GIT_LFS_CONFIGURATION_UNSUPPORTED",
    });
  });
});

describe("checkoutFilterRejectionMessage", () => {
  it("returns a bounded, fixed message for every rejection code with no configuration content", () => {
    for (const code of [
      "GIT_CHECKOUT_FILTER_UNSUPPORTED",
      "GIT_CHECKOUT_FILTER_MALFORMED",
      "GIT_LFS_CONFIGURATION_UNSUPPORTED",
      "GIT_LFS_NOT_AVAILABLE",
    ] as const) {
      const message = checkoutFilterRejectionMessage(code);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("git-lfs");
      expect(message).not.toContain("%f");
    }
  });
});
