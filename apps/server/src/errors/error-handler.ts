import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ProtocolValidationError } from "@hall-of-wisdom/protocol";
import { HallCoreError, InvalidRequestError } from "./app-error.js";

interface ErrorResponseBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: readonly { path: string; message: string }[];
  };
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details?: readonly { path: string; message: string }[],
): void {
  const body: ErrorResponseBody = { error: { code, message, ...(details ? { details } : {}) } };
  void reply.status(statusCode).send(body);
}

/**
 * Centralized, safe error handling. Never serializes a raw `Error` object,
 * a stack trace, an absolute filesystem path, or environment data into an
 * HTTP response — every branch below constructs a bounded, structured body
 * from known-safe fields only. Unexpected errors are logged (server-side,
 * structured, via Fastify's logger) but returned to the client as a single
 * generic message.
 */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof InvalidRequestError) {
      sendError(reply, error.statusCode, error.code, error.message, error.details);
      return;
    }

    if (error instanceof HallCoreError) {
      sendError(reply, error.statusCode, error.code, error.message);
      return;
    }

    if (error instanceof ProtocolValidationError) {
      sendError(reply, 400, "INVALID_REQUEST", `${error.subject} failed validation.`, error.issues);
      return;
    }

    // Fastify's own errors (body-too-large, malformed JSON, etc.) already
    // carry a safe statusCode and a bounded, framework-authored message.
    if (isFastifyError(error)) {
      sendError(reply, error.statusCode ?? 400, error.code ?? "INVALID_REQUEST", error.message);
      return;
    }

    request.log.error({ err: error }, "unhandled error while processing request");
    sendError(reply, 500, "INTERNAL_ERROR", "An unexpected internal error occurred.");
  });
}

function isFastifyError(
  error: unknown,
): error is { statusCode?: number; code?: string; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    ("statusCode" in error || "code" in error)
  );
}

export function installNotFoundHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    sendError(reply, 404, "NOT_FOUND", `Route "${request.method} ${request.url}" was not found.`);
  });
}
