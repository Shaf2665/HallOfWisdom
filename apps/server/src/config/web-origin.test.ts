import { describe, expect, it } from "vitest";
import { InvalidWebOriginError, parseWebOrigin } from "./web-origin.js";

describe("parseWebOrigin", () => {
  it("accepts the default loopback origin", () => {
    expect(parseWebOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  });

  it("normalizes a trailing slash away", () => {
    expect(parseWebOrigin("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000");
  });

  it("accepts https", () => {
    expect(parseWebOrigin("https://127.0.0.1:3000")).toBe("https://127.0.0.1:3000");
  });

  it("rejects a non-http(s) protocol", () => {
    expect(() => parseWebOrigin("ftp://127.0.0.1:3000")).toThrow(InvalidWebOriginError);
  });

  it("rejects embedded credentials", () => {
    expect(() => parseWebOrigin("http://user:pass@127.0.0.1:3000")).toThrow(InvalidWebOriginError);
  });

  it("rejects a fragment", () => {
    expect(() => parseWebOrigin("http://127.0.0.1:3000#section")).toThrow(InvalidWebOriginError);
  });

  it("rejects a query string", () => {
    expect(() => parseWebOrigin("http://127.0.0.1:3000?x=1")).toThrow(InvalidWebOriginError);
  });

  it("rejects a path", () => {
    expect(() => parseWebOrigin("http://127.0.0.1:3000/app")).toThrow(InvalidWebOriginError);
  });

  it("rejects a malformed URL", () => {
    expect(() => parseWebOrigin("not a url")).toThrow(InvalidWebOriginError);
  });
});
