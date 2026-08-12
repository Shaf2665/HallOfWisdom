import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { InvalidAttachmentIdError } from "../errors/app-error.js";

const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AttachmentBlobStoreOptions {
  /**
   * Must already exist — created by the caller at startup (see
   * `server.ts`'s durable-vs-ephemeral resolution). This class only ever
   * reads/writes files directly inside it, one per attachment, and never
   * creates the directory itself.
   */
  readonly rootDir: string;
}

/**
 * Owns attachment *bytes* on the local filesystem — a single concrete
 * class, not a port with dual implementations, because only the root
 * directory ever varies between durable mode (`<dataDir>/attachments`) and
 * ephemeral mode (a fixed, wiped-at-startup temp directory) — see
 * `docs/architecture/0020-communication-board-attachments.md`. Every method
 * takes only an `attachmentId`, never a filename: content is always
 * addressed by the server-generated id, and the id is regex-validated as a
 * `randomUUID()` shape before it is ever used to build a path — this is
 * what makes "never trust a filename as a filesystem path" true even in
 * the hypothetical case a caller passed one in by mistake, since a raw
 * filename could never match this pattern.
 */
export class AttachmentBlobStore {
  readonly #rootDir: string;

  constructor(options: AttachmentBlobStoreOptions) {
    this.#rootDir = options.rootDir;
  }

  write(attachmentId: string, bytes: Buffer): void {
    writeFileSync(this.#pathFor(attachmentId), bytes);
  }

  read(attachmentId: string): Buffer {
    return readFileSync(this.#pathFor(attachmentId));
  }

  /** A no-op if the blob is already absent — the sweep path calls this after already deciding (via the metadata store) that the row is gone, so a missing file is an acceptable, non-error outcome, not a bug to report. */
  remove(attachmentId: string): void {
    const target = this.#pathFor(attachmentId);
    if (existsSync(target)) rmSync(target, { force: true });
  }

  #pathFor(attachmentId: string): string {
    if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) {
      throw new InvalidAttachmentIdError(attachmentId);
    }
    return path.join(this.#rootDir, attachmentId);
  }
}
