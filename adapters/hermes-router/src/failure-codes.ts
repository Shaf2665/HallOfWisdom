import type { StructuredFailure } from "@hall-of-wisdom/protocol";

export const HERMES_TRANSPORT_FAILURE = "HERMES_TRANSPORT_FAILURE";
export const HERMES_INVALID_EVENT = "HERMES_INVALID_EVENT";
export const HERMES_EXECUTION_FAILED = "HERMES_EXECUTION_FAILED";

export function buildHermesFailure(code: string, message: string): StructuredFailure {
  return { code, message };
}
