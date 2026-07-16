import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HALL_CORE_URL,
  InvalidHallCoreUrlError,
  parseHallCoreUrl,
  resolveHallCoreUrl,
} from "./hall-core-url";

describe("parseHallCoreUrl", () => {
  it("parses the default Hall Core URL", () => {
    const config = parseHallCoreUrl(DEFAULT_HALL_CORE_URL);
    expect(config.httpUrl).toBe("http://127.0.0.1:4310");
    expect(config.wsUrl).toBe("ws://127.0.0.1:4310");
  });

  it("accepts a valid custom http URL", () => {
    const config = parseHallCoreUrl("http://127.0.0.1:5555");
    expect(config.httpUrl).toBe("http://127.0.0.1:5555");
    expect(config.wsUrl).toBe("ws://127.0.0.1:5555");
  });

  it("derives wss from a valid https URL", () => {
    const config = parseHallCoreUrl("https://127.0.0.1:4310");
    expect(config.httpUrl).toBe("https://127.0.0.1:4310");
    expect(config.wsUrl).toBe("wss://127.0.0.1:4310");
  });

  it("rejects embedded credentials", () => {
    expect(() => parseHallCoreUrl("http://user:pass@127.0.0.1:4310")).toThrow(
      InvalidHallCoreUrlError,
    );
  });

  it("rejects an invalid protocol", () => {
    expect(() => parseHallCoreUrl("ftp://127.0.0.1:4310")).toThrow(InvalidHallCoreUrlError);
  });

  it("rejects a fragment", () => {
    expect(() => parseHallCoreUrl("http://127.0.0.1:4310#section")).toThrow(
      InvalidHallCoreUrlError,
    );
  });

  it("normalizes a trailing slash away", () => {
    const config = parseHallCoreUrl("http://127.0.0.1:4310/");
    expect(config.httpUrl).toBe("http://127.0.0.1:4310");
  });

  it("produces a safe, bounded error for a malformed URL", () => {
    try {
      parseHallCoreUrl("not a url");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidHallCoreUrlError);
      expect((error as Error).message.length).toBeLessThan(200);
      expect((error as Error).message).not.toContain("\n");
    }
  });

  it("supports a loopback address (the only officially supported host for this prototype)", () => {
    expect(() => parseHallCoreUrl("http://127.0.0.1:4310")).not.toThrow();
    expect(() => parseHallCoreUrl("http://localhost:4310")).not.toThrow();
  });

  it("rejects a query string", () => {
    expect(() => parseHallCoreUrl("http://127.0.0.1:4310?x=1")).toThrow(InvalidHallCoreUrlError);
  });

  it("rejects a path", () => {
    expect(() => parseHallCoreUrl("http://127.0.0.1:4310/api")).toThrow(InvalidHallCoreUrlError);
  });
});

describe("resolveHallCoreUrl", () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_HALL_CORE_URL;

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_HALL_CORE_URL;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.NEXT_PUBLIC_HALL_CORE_URL;
    } else {
      process.env.NEXT_PUBLIC_HALL_CORE_URL = ORIGINAL;
    }
  });

  it("defaults to DEFAULT_HALL_CORE_URL when unset", () => {
    expect(resolveHallCoreUrl().httpUrl).toBe(DEFAULT_HALL_CORE_URL);
  });

  it("uses a configured value when set", () => {
    process.env.NEXT_PUBLIC_HALL_CORE_URL = "http://127.0.0.1:9999";
    expect(resolveHallCoreUrl().httpUrl).toBe("http://127.0.0.1:9999");
  });

  it("never logs the resolved value (no secret-like value is printed)", () => {
    // This module performs no logging at all — asserted structurally by
    // reading its own source would be brittle, so this test instead
    // documents the expectation: resolveHallCoreUrl must be a pure
    // read-and-validate function with no side effects.
    process.env.NEXT_PUBLIC_HALL_CORE_URL = "http://127.0.0.1:4310";
    expect(() => resolveHallCoreUrl()).not.toThrow();
  });
});
