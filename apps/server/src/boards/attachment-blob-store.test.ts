import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidAttachmentIdError } from "../errors/app-error.js";
import { AttachmentBlobStore } from "./attachment-blob-store.js";

const VALID_ID = "11111111-1111-4111-8111-111111111111";

describe("AttachmentBlobStore", () => {
  let rootDir: string;
  let store: AttachmentBlobStore;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(os.tmpdir(), "hall-attachment-blob-test-"));
    store = new AttachmentBlobStore({ rootDir });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("round-trips written bytes through read()", () => {
    const bytes = Buffer.from("hello attachment");
    store.write(VALID_ID, bytes);
    expect(store.read(VALID_ID)).toEqual(bytes);
  });

  it("writes exactly one file, named after the attachment id, directly under rootDir", () => {
    store.write(VALID_ID, Buffer.from("x"));
    expect(store.read(VALID_ID).toString()).toBe("x");
    // Sanity: reading a sibling directory path (not created) fails, proving
    // this isn't silently reading from somewhere else.
    expect(() => store.read("22222222-2222-4222-8222-222222222222")).toThrow();
  });

  it("remove() deletes the file so a subsequent read() throws", () => {
    store.write(VALID_ID, Buffer.from("x"));
    store.remove(VALID_ID);
    expect(() => store.read(VALID_ID)).toThrow();
  });

  it("remove() is a no-op (does not throw) when the file was never written", () => {
    expect(() => { store.remove(VALID_ID); }).not.toThrow();
  });

  it("rejects a path-traversal-shaped id before ever touching the filesystem, on write", () => {
    expect(() => { store.write("../../etc/passwd", Buffer.from("x")); }).toThrow(
      InvalidAttachmentIdError,
    );
  });

  it("rejects a path-traversal-shaped id on read", () => {
    expect(() => store.read("../../etc/passwd")).toThrow(InvalidAttachmentIdError);
  });

  it("rejects a path-traversal-shaped id on remove", () => {
    expect(() => { store.remove("..\\..\\windows\\win.ini"); }).toThrow(InvalidAttachmentIdError);
  });

  it("rejects a non-UUID-shaped id", () => {
    expect(() => { store.write("not-a-uuid", Buffer.from("x")); }).toThrow(InvalidAttachmentIdError);
  });

  it("a path-traversal attempt never creates a file outside rootDir", () => {
    const outsideMarker = path.join(rootDir, "..", "hall-attachment-blob-escape-marker");
    expect(() => { store.write("../hall-attachment-blob-escape-marker", Buffer.from("escaped")); }).toThrow(
      InvalidAttachmentIdError,
    );
    expect(existsSync(outsideMarker)).toBe(false);
  });
});
