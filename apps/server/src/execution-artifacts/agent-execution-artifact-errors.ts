export abstract class AgentExecutionArtifactError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class AgentExecutionArtifactNotFoundError extends AgentExecutionArtifactError {
  constructor(artifactId: string) {
    super(`Agent execution artifact "${artifactId}" was not found.`);
  }
}

export class AgentExecutionArtifactRunNotFoundError extends AgentExecutionArtifactError {
  constructor(hallAgentRunId: string) {
    super(`Agent execution artifact for run "${hallAgentRunId}" was not found.`);
  }
}

export class AgentExecutionArtifactConflictError extends AgentExecutionArtifactError {
  constructor(message: string) {
    super(`Agent execution artifact conflict: ${message}`);
  }
}

export class AgentExecutionArtifactValidationError extends AgentExecutionArtifactError {
  constructor(message: string) {
    super(`Agent execution artifact is invalid: ${message}`);
  }
}

export class AgentExecutionArtifactCorruptRecordError extends AgentExecutionArtifactError {
  constructor(artifactId: unknown, detail: string) {
    super(
      `Agent execution artifact "${safeArtifactCorruptionLabel(
        artifactId,
      )}" is corrupt: ${safeCorruptionDetail(detail)}`,
    );
  }
}

const MAX_CORRUPTION_LABEL_LENGTH = 80;
const MAX_CORRUPTION_DETAIL_LENGTH = 160;

export function safeArtifactCorruptionLabel(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const normalized = normalizeErrorText(value);
  if (normalized.length === 0) return "unknown";
  if (looksLikeAbsolutePath(normalized)) return "redacted-path";
  return truncateUtf16(normalized, MAX_CORRUPTION_LABEL_LENGTH);
}

function safeCorruptionDetail(value: string): string {
  const normalized = normalizeErrorText(value);
  return truncateUtf16(
    normalized.length === 0 ? "stored record is malformed" : normalized,
    MAX_CORRUPTION_DETAIL_LENGTH,
  );
}

function normalizeErrorText(value: string): string {
  let normalized = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (isControlCodeUnit(code)) {
      normalized += " ";
    } else if (isHighSurrogate(code)) {
      const next = value.charCodeAt(index + 1);
      if (isLowSurrogate(next)) {
        normalized += `${value[index] ?? ""}${value[index + 1] ?? ""}`;
        index += 1;
      } else {
        normalized += "\uFFFD";
      }
    } else if (isLowSurrogate(code)) {
      normalized += "\uFFFD";
    } else {
      normalized += value[index] ?? "";
    }
  }
  return normalized.replace(/\s+/gu, " ").trim();
}

function looksLikeAbsolutePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    /^[\\/]{2}/u.test(value)
  );
}

function truncateUtf16(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  let end = maxLength;
  const last = value.charCodeAt(end - 1);
  if (isHighSurrogate(last)) end -= 1;
  return value.slice(0, end);
}

function isControlCodeUnit(code: number): boolean {
  return (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
