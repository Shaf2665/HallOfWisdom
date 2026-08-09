import { EventFactory, TerminalEventGuard } from "@hall-of-wisdom/agent-adapter-sdk";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { z } from "zod";
import { buildHermesFailure, HERMES_EXECUTION_FAILED } from "./failure-codes.js";
import { parseHermesRelativeFilePath } from "./file-path-safety.js";
import type { HermesRawEvent } from "./hermes-protocol.js";

const idSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0);
const toolNameSchema = z.enum([
  "project_read",
  "project_search",
  "project_apply_patch",
  "command_execute",
]);
const reasonSchema = z
  .string()
  .min(1)
  .max(2000)
  .refine((value) => value.trim().length > 0);

const payloadSchemas = {
  "run.started": z.object({}).strict(),
  "message.delta": z.object({ text: z.string().max(20_000) }).strict(),
  "tool.started": z.object({ tool_call_id: idSchema, tool_name: toolNameSchema }).strict(),
  "tool.completed": z
    .object({
      tool_call_id: idSchema,
      tool_name: toolNameSchema,
      success: z.boolean(),
      output: z.string().max(20_000).optional(),
    })
    .strict(),
  "file.changed": z
    .object({
      path: z.string().min(1).max(1024),
      operation: z.enum(["created", "modified"]),
    })
    .strict(),
  "run.completed": z.object({ summary: z.string().max(20_000).optional() }).strict(),
  "run.failed": z
    .object({
      code: z
        .string()
        .min(1)
        .max(100)
        .refine((value) => value.trim().length > 0),
      message: z
        .string()
        .min(1)
        .max(2000)
        .refine((value) => value.trim().length > 0),
    })
    .strict(),
  "run.cancelled": z
    .object({
      cancelled_by: z.enum(["user", "orchestrator", "system"]),
      reason: reasonSchema.optional(),
    })
    .strict(),
} as const;

export class HermesEventMappingError extends Error {
  constructor() {
    super("Hermes emitted an invalid event payload.");
    this.name = "HermesEventMappingError";
  }
}

export class HermesEventMapper {
  readonly #factory: EventFactory;
  readonly #guard: TerminalEventGuard;

  constructor(factory: EventFactory, guard: TerminalEventGuard) {
    this.#factory = factory;
    this.#guard = guard;
  }

  mapEvent(event: HermesRawEvent): NormalizedAgentEvent {
    switch (event.type) {
      case "run.started": {
        this.#parse("run.started", event.payload);
        return this.#guard.guardEvent(this.#factory.runStarted());
      }
      case "message.delta": {
        const payload = this.#parse("message.delta", event.payload);
        return this.#guard.guardEvent(this.#factory.messageDelta(payload.text));
      }
      case "tool.started": {
        const payload = this.#parse("tool.started", event.payload);
        return this.#guard.guardEvent(
          this.#factory.toolStarted(payload.tool_call_id, payload.tool_name),
        );
      }
      case "tool.completed": {
        const payload = this.#parse("tool.completed", event.payload);
        return this.#guard.guardEvent(
          this.#factory.toolCompleted(payload.tool_call_id, payload.tool_name, payload.success),
        );
      }
      case "file.changed": {
        const payload = this.#parse("file.changed", event.payload);
        const safePath = parseHermesRelativeFilePath(payload.path);
        if (safePath === undefined) throw new HermesEventMappingError();
        return this.#guard.guardEvent(this.#factory.fileChanged(safePath, payload.operation));
      }
      case "run.completed": {
        const payload = this.#parse("run.completed", event.payload);
        return this.#guard.guardEvent(this.#factory.runCompleted(payload.summary));
      }
      case "run.failed": {
        this.#parse("run.failed", event.payload);
        return this.#guard.guardEvent(
          this.#factory.runFailed(
            buildHermesFailure(HERMES_EXECUTION_FAILED, "Hermes execution failed."),
          ),
        );
      }
      case "run.cancelled": {
        const payload = this.#parse("run.cancelled", event.payload);
        return this.#guard.guardEvent(
          this.#factory.runCancelled(payload.cancelled_by, payload.reason),
        );
      }
    }
  }

  #parse<T extends keyof typeof payloadSchemas>(
    type: T,
    payload: HermesRawEvent["payload"],
  ): z.output<(typeof payloadSchemas)[T]> {
    const result = payloadSchemas[type].safeParse(payload);
    if (!result.success) throw new HermesEventMappingError();
    return result.data;
  }
}
