import type { Writable } from "node:stream";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";

/**
 * One complete JSON object per line — no decorative text mixed in — so a
 * future Hall Core can parse this stream reliably. Every normalized event
 * has already passed `parseNormalizedAgentEvent` before reaching here, so
 * this never serializes an unvalidated object.
 */
export function writeJsonLine(stdout: Writable, event: NormalizedAgentEvent): void {
  stdout.write(`${JSON.stringify(event)}\n`);
}

/** Human-readable diagnostics go to stderr, never stdout, so the two streams stay cleanly separable. */
export function writeDiagnostic(stderr: Writable, message: string): void {
  stderr.write(`${message}\n`);
}

export function formatErrorForDiagnostic(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
