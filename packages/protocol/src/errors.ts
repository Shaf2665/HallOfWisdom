import { z } from "zod";

/**
 * A single validation failure, reduced to a path and a message. This
 * shape is safe to log or return to a caller because it never contains
 * the offending value itself.
 */
export interface ProtocolValidationIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Thrown by every `parse*` helper in this package when input fails schema
 * validation. Carries structured issues instead of the raw Zod error so
 * callers get a stable shape regardless of the Zod version in use.
 */
export class ProtocolValidationError extends Error {
  readonly subject: string;
  readonly issues: readonly ProtocolValidationIssue[];

  constructor(subject: string, issues: readonly ProtocolValidationIssue[]) {
    const detail = issues
      .map((issue) => `${issue.path.length > 0 ? issue.path : "(root)"}: ${issue.message}`)
      .join("; ");
    super(`${subject} failed validation: ${detail}`);
    this.name = "ProtocolValidationError";
    this.subject = subject;
    this.issues = issues;
  }
}

/**
 * Generic over the schema itself (`S extends z.ZodTypeAny`), returning
 * `z.output<S>`, rather than pinning a single `T` via `z.ZodType<T>`. This
 * matters for schemas using `.default()`: their input and output types
 * differ (a field can be omitted on input but is always present on
 * output), and `z.ZodType<T>`'s input parameter defaults to `T` too,
 * which such a schema does not structurally satisfy. Inferring from the
 * schema and projecting only its output type sidesteps that mismatch.
 */
export function parseWithSchema<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  subject: string,
): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    throw new ProtocolValidationError(subject, issues);
  }
  // `S` being a bare type parameter loses precision through `.safeParse`;
  // this assertion restates what `z.output<S>` already guarantees.
  return result.data as z.output<S>;
}

/**
 * Failure detail values are restricted to flat primitives with bounded
 * length, and the object itself is capped in key count. This bounds
 * *shape and size* only: an unbounded nested object or an oversized blob
 * cannot be smuggled through `details`.
 *
 * This schema has no way to know whether a given string happens to be a
 * secret (a token, password, or raw environment variable value) — it only
 * sees a length-bounded string, not its meaning. Redacting secrets is the
 * caller's responsibility and must happen *before* a `StructuredFailure`
 * is constructed. Real adapters and the Hall Runner must run captured
 * output through a dedicated redaction layer (not built in this package)
 * prior to populating `details`, `message`, or any other failure field.
 */
export const safeDetailsSchema = z
  .record(
    z.string().max(100, "detail key must not exceed 100 characters"),
    z.union([
      z.string().max(1000, "detail value must not exceed 1000 characters"),
      z.number(),
      z.boolean(),
      z.null(),
    ]),
  )
  .refine((details) => Object.keys(details).length <= 25, "details must not exceed 25 keys");

export type SafeDetails = z.infer<typeof safeDetailsSchema>;

/**
 * A structured, safe-to-transmit failure. `code` is a stable machine
 * identifier (for programmatic handling); `message` is for humans.
 */
export const structuredFailureSchema = z
  .object({
    code: z
      .string()
      .max(64, "code must not exceed 64 characters")
      .regex(/^[A-Z][A-Z0-9_]*$/, "code must be UPPER_SNAKE_CASE"),
    message: z
      .string()
      .min(1, "message must not be empty")
      .max(2000, "message must not exceed 2000 characters"),
    retryable: z.boolean().optional(),
    details: safeDetailsSchema.optional(),
  })
  .strict();

export type StructuredFailure = z.infer<typeof structuredFailureSchema>;
