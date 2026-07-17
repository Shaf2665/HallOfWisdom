import {
  ProtocolValidationError,
  parseCommunicationMessage,
  type CommunicationMessage,
} from "@hall-of-wisdom/protocol";

export type MessageValidationOutcome =
  | { readonly kind: "accepted"; readonly message: CommunicationMessage }
  | { readonly kind: "duplicate"; readonly message: CommunicationMessage }
  | { readonly kind: "conflict"; readonly message: CommunicationMessage }
  | { readonly kind: "gap"; readonly message: CommunicationMessage }
  | { readonly kind: "board-mismatch"; readonly message: CommunicationMessage }
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * Parses raw WebSocket message text into a schema-validated
 * `CommunicationMessage`, then classifies it against everything already
 * accepted for this board — the same defense-in-depth discipline
 * `lib/task-events.ts`'s `parseAndClassifyIncomingEvent` applies to
 * `NormalizedAgentEvent`s, kept as a wholly separate function (not a
 * shared generic) so the two domains never blur.
 *
 * `acceptedMessages` must be exactly the messages this same function has
 * previously returned as `"accepted"`, in order — classification relies on
 * `acceptedMessages.length` being the next expected sequence number and
 * `acceptedMessages[sequence]` being the message stored at that slot.
 */
export function parseAndClassifyIncomingMessage(
  raw: string,
  acceptedMessages: readonly CommunicationMessage[],
  boardId: string,
): MessageValidationOutcome {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { kind: "invalid", reason: "message was not valid JSON" };
  }

  let message: CommunicationMessage;
  try {
    message = parseCommunicationMessage(parsedJson);
  } catch (error) {
    const reason =
      error instanceof ProtocolValidationError
        ? "message did not match the communication message schema"
        : "message could not be validated";
    return { kind: "invalid", reason };
  }

  if (message.boardId !== boardId) {
    return { kind: "board-mismatch", message };
  }

  const nextExpectedSequence = acceptedMessages.length;
  if (message.sequence < nextExpectedSequence) {
    const existing = acceptedMessages[message.sequence];
    if (existing?.messageId === message.messageId) {
      return { kind: "duplicate", message };
    }
    return { kind: "conflict", message };
  }
  if (message.sequence > nextExpectedSequence) {
    return { kind: "gap", message };
  }
  return { kind: "accepted", message };
}
