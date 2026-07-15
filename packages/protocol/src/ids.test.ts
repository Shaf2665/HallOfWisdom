import { describe, expect, it } from "vitest";
import { isoTimestampSchema, nonEmptyIdSchema, boundedNonBlankString } from "./ids.js";

describe("isoTimestampSchema", () => {
  it("accepts a valid canonical UTC timestamp", () => {
    expect(isoTimestampSchema.safeParse("2026-07-15T12:00:00.000Z").success).toBe(true);
  });

  it("accepts a valid leap-day timestamp", () => {
    expect(isoTimestampSchema.safeParse("2028-02-29T00:00:00.000Z").success).toBe(true);
  });

  it("accepts a valid timestamp with a numeric UTC offset", () => {
    expect(isoTimestampSchema.safeParse("2026-07-15T12:00:00.000+05:30").success).toBe(true);
  });

  it("rejects an impossible calendar date (2026-02-30, non-leap year)", () => {
    expect(isoTimestampSchema.safeParse("2026-02-30T10:00:00.000Z").success).toBe(false);
  });

  it("rejects February 29 in a non-leap year", () => {
    expect(isoTimestampSchema.safeParse("2026-02-29T00:00:00.000Z").success).toBe(false);
  });

  it("rejects an invalid month", () => {
    expect(isoTimestampSchema.safeParse("2026-13-01T10:00:00.000Z").success).toBe(false);
  });

  it("rejects an invalid hour", () => {
    expect(isoTimestampSchema.safeParse("2026-07-15T24:00:00.000Z").success).toBe(false);
  });

  it("rejects an invalid minute", () => {
    expect(isoTimestampSchema.safeParse("2026-07-15T12:60:00.000Z").success).toBe(false);
  });

  it("rejects a string that is not a timestamp at all", () => {
    expect(isoTimestampSchema.safeParse("not-a-timestamp").success).toBe(false);
  });

  it("rejects an out-of-range UTC offset", () => {
    expect(isoTimestampSchema.safeParse("2026-07-15T12:00:00.000+25:00").success).toBe(false);
  });
});

describe("nonEmptyIdSchema", () => {
  it("accepts a non-blank id", () => {
    expect(nonEmptyIdSchema.safeParse("task-1").success).toBe(true);
  });

  it("rejects a whitespace-only id", () => {
    expect(nonEmptyIdSchema.safeParse("   ").success).toBe(false);
  });

  it("rejects an id exceeding the length bound", () => {
    expect(nonEmptyIdSchema.safeParse("x".repeat(129)).success).toBe(false);
  });
});

describe("boundedNonBlankString", () => {
  it("rejects a value exceeding the caller-supplied bound", () => {
    expect(boundedNonBlankString(10).safeParse("x".repeat(11)).success).toBe(false);
  });

  it("rejects a whitespace-only value", () => {
    expect(boundedNonBlankString(10).safeParse("   ").success).toBe(false);
  });
});
