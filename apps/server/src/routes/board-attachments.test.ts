import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MessageAttachment } from "@hall-of-wisdom/protocol";
import { MAX_ATTACHMENT_BYTES } from "@hall-of-wisdom/protocol";
import { buildTestApp, type ErrorResponseJson } from "../test-support.js";
import { GENERAL_BOARD_ID } from "../boards/board-store.js";

const BOUNDARY = "hall-test-boundary-1234567890";

/**
 * Hand-built multipart/form-data body — no test dependency added for this
 * (the plan explicitly rejected pulling in a multipart-building library
 * just for tests). Mirrors exactly what a browser's `FormData` + `fetch`
 * would send for a single file field.
 */
function buildMultipartPayload(options: {
  readonly filename: string;
  readonly mimeType: string;
  readonly content: Buffer;
}): { readonly payload: Buffer; readonly contentType: string } {
  const preamble = Buffer.from(
    `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${options.filename}"\r\n` +
      `Content-Type: ${options.mimeType}\r\n\r\n`,
  );
  const epilogue = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  return {
    payload: Buffer.concat([preamble, options.content, epilogue]),
    contentType: `multipart/form-data; boundary=${BOUNDARY}`,
  };
}

function buildEmptyMultipartPayload(): { readonly payload: Buffer; readonly contentType: string } {
  return {
    payload: Buffer.from(`--${BOUNDARY}--\r\n`),
    contentType: `multipart/form-data; boundary=${BOUNDARY}`,
  };
}

describe("Board attachment routes", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-attachments-routes-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("POST /api/v1/boards/:boardId/attachments", () => {
    it("uploads a valid image and returns 201 with the attachment metadata", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const { payload, contentType } = buildMultipartPayload({
        filename: "diagram.png",
        mimeType: "image/png",
        content: Buffer.from("fake-png-bytes"),
      });
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/attachments`,
        headers: { "content-type": contentType },
        payload,
      });
      expect(response.statusCode).toBe(201);
      const body = response.json<MessageAttachment>();
      expect(body.filename).toBe("diagram.png");
      expect(body.mimeType).toBe("image/png");
      expect(body.kind).toBe("image");
      expect(body.byteSize).toBe(Buffer.from("fake-png-bytes").length);
      expect(typeof body.attachmentId).toBe("string");
      expect(body.attachmentId.length).toBeGreaterThan(0);
      await app.close();
    });

    it("uploads a valid non-image file and classifies it as kind file", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const { payload, contentType } = buildMultipartPayload({
        filename: "notes.txt",
        mimeType: "text/plain",
        content: Buffer.from("hello world"),
      });
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/attachments`,
        headers: { "content-type": contentType },
        payload,
      });
      expect(response.statusCode).toBe(201);
      expect(response.json<MessageAttachment>().kind).toBe("file");
      await app.close();
    });

    it("returns 404 for an unknown board", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const { payload, contentType } = buildMultipartPayload({
        filename: "f.png",
        mimeType: "image/png",
        content: Buffer.from("x"),
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/boards/nonexistent/attachments",
        headers: { "content-type": contentType },
        payload,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json<ErrorResponseJson>().error.code).toBe("BOARD_NOT_FOUND");
      await app.close();
    });

    it("rejects an unsupported MIME type", async () => {
      const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
      const { payload, contentType } = buildMultipartPayload({
        filename: "app.exe",
        mimeType: "application/x-msdownload",
        content: Buffer.from("x"),
      });
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/attachments`,
        headers: { "content-type": contentType },
        payload,
      });
      expect(response.statusCode).toBe(400);
      // Nothing was ever written to disk for the rejected upload.
      expect(fs.readdirSync(harness.attachmentBlobRootDir)).toHaveLength(0);
      await app.close();
    });

    it("rejects an oversized file and writes nothing to disk", async () => {
      const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
      const { payload, contentType } = buildMultipartPayload({
        filename: "big.png",
        mimeType: "image/png",
        content: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1),
      });
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/attachments`,
        headers: { "content-type": contentType },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(fs.readdirSync(harness.attachmentBlobRootDir)).toHaveLength(0);
      await app.close();
    });

    it("accepts a file at exactly the maximum size", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const { payload, contentType } = buildMultipartPayload({
        filename: "max.png",
        mimeType: "image/png",
        content: Buffer.alloc(MAX_ATTACHMENT_BYTES, 1),
      });
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/attachments`,
        headers: { "content-type": contentType },
        payload,
      });
      expect(response.statusCode).toBe(201);
      await app.close();
    });

    it("rejects a request with no file part", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const { payload, contentType } = buildEmptyMultipartPayload();
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/attachments`,
        headers: { "content-type": contentType },
        payload,
      });
      expect(response.statusCode).toBe(400);
      await app.close();
    });

    it("rejects more than one file in a single request", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const part = (filename: string) =>
        `--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: image/png\r\n\r\n` +
        `bytes\r\n`;
      const payload = Buffer.from(`${part("a.png")}${part("b.png")}--${BOUNDARY}--\r\n`);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/attachments`,
        headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
        payload,
      });
      expect(response.statusCode).toBe(413);
      await app.close();
    });

    it("never discloses a stack trace or absolute path in an error response", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const { payload, contentType } = buildMultipartPayload({
        filename: "app.exe",
        mimeType: "application/x-msdownload",
        content: Buffer.from("x"),
      });
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/attachments`,
        headers: { "content-type": contentType },
        payload,
      });
      const serialized = JSON.stringify(response.json());
      expect(serialized).not.toMatch(/at .*\(.*:\d+:\d+\)/);
      expect(serialized).not.toContain(tempRoot);
      expect(serialized).not.toMatch(/[A-Za-z]:\\/);
      await app.close();
    });
  });

  describe("GET /api/v1/boards/:boardId/attachments/:attachmentId", () => {
    async function uploadAndLink(
      app: Awaited<ReturnType<typeof buildTestApp>>["app"],
    ): Promise<string> {
      const { payload, contentType } = buildMultipartPayload({
        filename: "diagram.png",
        mimeType: "image/png",
        content: Buffer.from("fake-png-bytes"),
      });
      const uploadResponse = await app.inject({
        method: "POST",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/attachments`,
        headers: { "content-type": contentType },
        payload,
      });
      const { attachmentId } = uploadResponse.json<MessageAttachment>();
      await app.inject({
        method: "POST",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/messages`,
        payload: { text: "", attachmentIds: [attachmentId] },
      });
      return attachmentId;
    }

    it("returns 404 for a still-pending (never linked) attachment", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const { payload, contentType } = buildMultipartPayload({
        filename: "f.png",
        mimeType: "image/png",
        content: Buffer.from("x"),
      });
      const uploadResponse = await app.inject({
        method: "POST",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/attachments`,
        headers: { "content-type": contentType },
        payload,
      });
      const { attachmentId } = uploadResponse.json<MessageAttachment>();
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/attachments/${attachmentId}`,
      });
      expect(response.statusCode).toBe(404);
      await app.close();
    });

    it("returns 404 for an unknown attachmentId", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/attachments/does-not-exist`,
      });
      expect(response.statusCode).toBe(404);
      await app.close();
    });

    it("serves the content with the correct Content-Type and inline disposition for an image, once linked", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const attachmentId = await uploadAndLink(app);
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/attachments/${attachmentId}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("image/png");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["content-disposition"]).toContain("inline");
      expect(response.rawPayload).toEqual(Buffer.from("fake-png-bytes"));
      await app.close();
    });

    it("uses an 'attachment' Content-Disposition for a non-image file", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const { payload, contentType } = buildMultipartPayload({
        filename: "notes.txt",
        mimeType: "text/plain",
        content: Buffer.from("hello"),
      });
      const uploadResponse = await app.inject({
        method: "POST",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/attachments`,
        headers: { "content-type": contentType },
        payload,
      });
      const { attachmentId } = uploadResponse.json<MessageAttachment>();
      await app.inject({
        method: "POST",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/messages`,
        payload: { text: "", attachmentIds: [attachmentId] },
      });
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/attachments/${attachmentId}`,
      });
      expect(response.headers["content-disposition"]).toContain("attachment");
      expect(response.headers["content-disposition"]).toContain("notes.txt");
      await app.close();
    });

    it("returns 404 for a path-traversal-shaped attachmentId in the URL", async () => {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/boards/${GENERAL_BOARD_ID}/attachments/${encodeURIComponent("../../etc/passwd")}`,
      });
      expect(response.statusCode).toBe(404);
      await app.close();
    });
  });
});
