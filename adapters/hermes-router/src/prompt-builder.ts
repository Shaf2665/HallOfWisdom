const NUL_CHARACTER = String.fromCharCode(0);
export const MAX_HERMES_PROMPT_LENGTH = 8000;
const TRUNCATION_MARKER = "\n[... description truncated for length ...]";

export interface HermesPromptInput {
  readonly title: string;
  readonly description: string;
}

export function buildHermesTaskPrompt(input: HermesPromptInput): string {
  if (input.title.includes(NUL_CHARACTER) || input.description.includes(NUL_CHARACTER)) {
    throw new Error("Hermes task fields must not contain a NUL character.");
  }

  const header = `Task title: ${input.title}\n\nTask description:\n`;
  const remaining = MAX_HERMES_PROMPT_LENGTH - header.length;
  if (remaining <= 0) return header.slice(0, MAX_HERMES_PROMPT_LENGTH);
  if (input.description.length <= remaining) return header + input.description;

  const descriptionLength = Math.max(0, remaining - TRUNCATION_MARKER.length);
  return header + input.description.slice(0, descriptionLength) + TRUNCATION_MARKER;
}
