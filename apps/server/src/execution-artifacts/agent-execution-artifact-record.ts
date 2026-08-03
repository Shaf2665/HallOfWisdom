import { Buffer } from "node:buffer";
import {
  AgentExecutionArtifactCorruptRecordError,
  AgentExecutionArtifactValidationError,
} from "./agent-execution-artifact-errors.js";

export const AGENT_EXECUTION_ARTIFACT_OUTCOMES = [
  "completed",
  "failed",
  "cancelled",
  "abandoned",
] as const;

export type AgentExecutionArtifactOutcome = (typeof AGENT_EXECUTION_ARTIFACT_OUTCOMES)[number];

export interface AgentExecutionArtifactDiffSummary {
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface AgentExecutionArtifactRecord {
  readonly artifactId: string;
  readonly hallTaskId: string;
  readonly hallAgentRunId: string;
  readonly adapterId: string;
  readonly worktreeId: string | undefined;
  readonly providerExecutionRef: string | undefined;
  readonly outcome: AgentExecutionArtifactOutcome;
  readonly terminalReasonCode: string | undefined;
  readonly safeTerminalSummary: string | undefined;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode: number | undefined;
  readonly baseCommit: string | undefined;
  readonly finalCommit: string | undefined;
  readonly changedFiles: readonly string[];
  readonly changedFilesTruncated: boolean;
  readonly diffSummary: AgentExecutionArtifactDiffSummary;
  readonly finalSummary: string | undefined;
  readonly finalSummaryTruncated: boolean;
  readonly createdAt: string;
}

export interface CreateAgentExecutionArtifactInput {
  readonly artifactId: string;
  readonly hallTaskId: string;
  readonly hallAgentRunId: string;
  readonly adapterId: string;
  readonly worktreeId?: string | undefined;
  readonly providerExecutionRef?: string | undefined;
  readonly outcome: AgentExecutionArtifactOutcome;
  readonly terminalReasonCode?: string | undefined;
  readonly safeTerminalSummary?: string | undefined;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode?: number | undefined;
  readonly baseCommit?: string | undefined;
  readonly finalCommit?: string | undefined;
  readonly changedFiles: readonly string[];
  readonly diffSummary: AgentExecutionArtifactDiffSummary;
  readonly finalSummary?: string | undefined;
  readonly createdAt: string;
}

export interface PublicAgentExecutionArtifact {
  readonly artifactId: string;
  readonly hallTaskId: string;
  readonly hallAgentRunId: string;
  readonly adapterId: string;
  readonly outcome: AgentExecutionArtifactOutcome;
  readonly terminalReasonCode: string | undefined;
  readonly safeTerminalSummary: string | undefined;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode: number | undefined;
  readonly baseCommit: string | undefined;
  readonly finalCommit: string | undefined;
  readonly changedFiles: readonly string[];
  readonly changedFilesTruncated: boolean;
  readonly diffSummary: AgentExecutionArtifactDiffSummary;
  readonly finalSummary: string | undefined;
  readonly finalSummaryTruncated: boolean;
  readonly createdAt: string;
}

export const AGENT_EXECUTION_ARTIFACT_LIMITS = {
  generalId: 200,
  adapterId: 120,
  providerExecutionRef: 256,
  terminalReasonCode: 80,
  safeTerminalSummary: 500,
  finalSummary: 8_000,
  changedFiles: 2_000,
  changedPath: 512,
  diffCounter: 1_000_000_000,
  signedInt32Min: -2_147_483_648,
  signedInt32Max: 2_147_483_647,
} as const;

const SAFE_CODE_PATTERN = /^[A-Z0-9_:-]+$/u;
const FULL_GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const DRIVE_PREFIX_PATTERN = /^[A-Za-z]:/u;
const WINDOWS_DRIVE_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/u;
const UNC_PATH_PATTERN = /^[\\/]{2}/u;

type ErrorFactory = (message: string) => Error;

function validationError(message: string): Error {
  return new AgentExecutionArtifactValidationError(message);
}

function corruptError(artifactId: string): ErrorFactory {
  return (message: string) => new AgentExecutionArtifactCorruptRecordError(artifactId, message);
}

export function compareArtifactStrings(a: string, b: string): number {
  if (a === b) return 0;
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function createAgentExecutionArtifactRecord(
  input: CreateAgentExecutionArtifactInput,
): AgentExecutionArtifactRecord {
  const record: AgentExecutionArtifactRecord = {
    artifactId: normalizeIdentifier(
      input.artifactId,
      "artifactId",
      AGENT_EXECUTION_ARTIFACT_LIMITS.generalId,
      validationError,
    ),
    hallTaskId: normalizeIdentifier(
      input.hallTaskId,
      "hallTaskId",
      AGENT_EXECUTION_ARTIFACT_LIMITS.generalId,
      validationError,
    ),
    hallAgentRunId: normalizeIdentifier(
      input.hallAgentRunId,
      "hallAgentRunId",
      AGENT_EXECUTION_ARTIFACT_LIMITS.generalId,
      validationError,
    ),
    adapterId: normalizeIdentifier(
      input.adapterId,
      "adapterId",
      AGENT_EXECUTION_ARTIFACT_LIMITS.adapterId,
      validationError,
    ),
    worktreeId:
      input.worktreeId === undefined
        ? undefined
        : normalizeIdentifier(
            input.worktreeId,
            "worktreeId",
            AGENT_EXECUTION_ARTIFACT_LIMITS.generalId,
            validationError,
          ),
    providerExecutionRef:
      input.providerExecutionRef === undefined
        ? undefined
        : normalizeIdentifier(
            input.providerExecutionRef,
            "providerExecutionRef",
            AGENT_EXECUTION_ARTIFACT_LIMITS.providerExecutionRef,
            validationError,
          ),
    outcome: normalizeOutcome(input.outcome, validationError),
    terminalReasonCode:
      input.terminalReasonCode === undefined
        ? undefined
        : normalizeTerminalReasonCode(input.terminalReasonCode, validationError),
    safeTerminalSummary:
      input.safeTerminalSummary === undefined
        ? undefined
        : normalizeSafeTerminalSummary(input.safeTerminalSummary),
    startedAt: normalizeIsoTimestamp(input.startedAt, "startedAt", validationError),
    finishedAt: normalizeIsoTimestamp(input.finishedAt, "finishedAt", validationError),
    durationMs: normalizeNonnegativeSafeInteger(
      input.durationMs,
      "durationMs",
      Number.MAX_SAFE_INTEGER,
      validationError,
    ),
    exitCode:
      input.exitCode === undefined ? undefined : normalizeExitCode(input.exitCode, validationError),
    baseCommit:
      input.baseCommit === undefined
        ? undefined
        : normalizeCommit(input.baseCommit, "baseCommit", validationError),
    finalCommit:
      input.finalCommit === undefined
        ? undefined
        : normalizeCommit(input.finalCommit, "finalCommit", validationError),
    ...normalizeChangedFiles(input.changedFiles, validationError),
    diffSummary: normalizeDiffSummary(input.diffSummary, validationError),
    ...normalizeFinalSummary(input.finalSummary),
    createdAt: normalizeIsoTimestamp(input.createdAt, "createdAt", validationError),
  };
  assertArtifactInvariants(record, validationError);
  return cloneArtifact(record);
}

export function parseStoredAgentExecutionArtifactRecord(
  value: unknown,
): AgentExecutionArtifactRecord {
  const unknownCorruptError = (message: string) =>
    new AgentExecutionArtifactCorruptRecordError("unknown", message);
  const raw = requireObject(value, "record", unknownCorruptError);
  const rawArtifactId = requireUnknown(raw, "artifactId", unknownCorruptError);
  if (typeof rawArtifactId !== "string") {
    throw new AgentExecutionArtifactCorruptRecordError(
      rawArtifactId,
      "artifactId must be a string",
    );
  }
  const artifactId = normalizeIdentifier(
    rawArtifactId,
    "artifactId",
    AGENT_EXECUTION_ARTIFACT_LIMITS.generalId,
    (message) => new AgentExecutionArtifactCorruptRecordError(rawArtifactId, message),
  );
  const fail = corruptError(artifactId);

  const record: AgentExecutionArtifactRecord = {
    artifactId,
    hallTaskId: normalizeIdentifier(
      requireString(raw, "hallTaskId", fail),
      "hallTaskId",
      AGENT_EXECUTION_ARTIFACT_LIMITS.generalId,
      fail,
    ),
    hallAgentRunId: normalizeIdentifier(
      requireString(raw, "hallAgentRunId", fail),
      "hallAgentRunId",
      AGENT_EXECUTION_ARTIFACT_LIMITS.generalId,
      fail,
    ),
    adapterId: normalizeIdentifier(
      requireString(raw, "adapterId", fail),
      "adapterId",
      AGENT_EXECUTION_ARTIFACT_LIMITS.adapterId,
      fail,
    ),
    worktreeId: optionalString(raw, "worktreeId", fail, (stored) =>
      normalizeIdentifier(stored, "worktreeId", AGENT_EXECUTION_ARTIFACT_LIMITS.generalId, fail),
    ),
    providerExecutionRef: optionalString(raw, "providerExecutionRef", fail, (stored) =>
      normalizeIdentifier(
        stored,
        "providerExecutionRef",
        AGENT_EXECUTION_ARTIFACT_LIMITS.providerExecutionRef,
        fail,
      ),
    ),
    outcome: normalizeOutcome(requireString(raw, "outcome", fail), fail),
    terminalReasonCode: optionalString(raw, "terminalReasonCode", fail, (stored) =>
      normalizeTerminalReasonCode(stored, fail),
    ),
    safeTerminalSummary: optionalString(raw, "safeTerminalSummary", fail, (stored) =>
      normalizeStoredSafeTerminalSummary(stored, fail),
    ),
    startedAt: normalizeIsoTimestamp(requireString(raw, "startedAt", fail), "startedAt", fail),
    finishedAt: normalizeIsoTimestamp(requireString(raw, "finishedAt", fail), "finishedAt", fail),
    durationMs: normalizeNonnegativeSafeInteger(
      requireNumber(raw, "durationMs", fail),
      "durationMs",
      Number.MAX_SAFE_INTEGER,
      fail,
    ),
    exitCode: optionalNumber(raw, "exitCode", fail, (stored) => normalizeExitCode(stored, fail)),
    baseCommit: optionalString(raw, "baseCommit", fail, (stored) =>
      normalizeCommit(stored, "baseCommit", fail),
    ),
    finalCommit: optionalString(raw, "finalCommit", fail, (stored) =>
      normalizeCommit(stored, "finalCommit", fail),
    ),
    changedFiles: parseStoredChangedFiles(requireUnknown(raw, "changedFiles", fail), fail),
    changedFilesTruncated: requireBoolean(raw, "changedFilesTruncated", fail),
    diffSummary: normalizeDiffSummary(requireUnknown(raw, "diffSummary", fail), fail),
    finalSummary: optionalString(raw, "finalSummary", fail, (stored) =>
      normalizeStoredFinalSummary(stored, fail),
    ),
    finalSummaryTruncated: requireBoolean(raw, "finalSummaryTruncated", fail),
    createdAt: normalizeIsoTimestamp(requireString(raw, "createdAt", fail), "createdAt", fail),
  };
  assertArtifactInvariants(record, fail);
  if (
    record.changedFilesTruncated &&
    record.changedFiles.length < AGENT_EXECUTION_ARTIFACT_LIMITS.changedFiles
  ) {
    throw fail("changedFilesTruncated cannot be true below the retained file limit");
  }
  if (record.finalSummary === undefined && record.finalSummaryTruncated) {
    throw fail("finalSummaryTruncated cannot be true when finalSummary is absent");
  }
  return cloneArtifact(record);
}

export function toPublicAgentExecutionArtifact(
  record: AgentExecutionArtifactRecord,
): PublicAgentExecutionArtifact {
  return {
    artifactId: record.artifactId,
    hallTaskId: record.hallTaskId,
    hallAgentRunId: record.hallAgentRunId,
    adapterId: record.adapterId,
    outcome: record.outcome,
    terminalReasonCode: record.terminalReasonCode,
    safeTerminalSummary: record.safeTerminalSummary,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    durationMs: record.durationMs,
    exitCode: record.exitCode,
    baseCommit: record.baseCommit,
    finalCommit: record.finalCommit,
    changedFiles: [...record.changedFiles],
    changedFilesTruncated: record.changedFilesTruncated,
    diffSummary: { ...record.diffSummary },
    finalSummary: record.finalSummary,
    finalSummaryTruncated: record.finalSummaryTruncated,
    createdAt: record.createdAt,
  };
}

export function cloneArtifact(record: AgentExecutionArtifactRecord): AgentExecutionArtifactRecord {
  return {
    ...record,
    changedFiles: [...record.changedFiles],
    diffSummary: { ...record.diffSummary },
  };
}

function normalizeIdentifier(
  value: string,
  field: string,
  maxLength: number,
  fail: ErrorFactory,
): string {
  if (typeof value !== "string") throw fail(`${field} must be a string`);
  assertValidUnicodeScalars(value, field, fail);
  if (value.length === 0) throw fail(`${field} is required`);
  if (value.length > maxLength) throw fail(`${field} exceeds ${String(maxLength)} characters`);
  if (containsUnsafeControl(value))
    throw fail(`${field} contains an unsupported control character`);
  return value;
}

function normalizeOutcome(value: string, fail: ErrorFactory): AgentExecutionArtifactOutcome {
  assertValidUnicodeScalars(value, "outcome", fail);
  if (AGENT_EXECUTION_ARTIFACT_OUTCOMES.includes(value as AgentExecutionArtifactOutcome)) {
    return value as AgentExecutionArtifactOutcome;
  }
  throw fail("terminal outcome is not supported");
}

function normalizeTerminalReasonCode(value: string, fail: ErrorFactory): string {
  const code = normalizeIdentifier(
    value,
    "terminalReasonCode",
    AGENT_EXECUTION_ARTIFACT_LIMITS.terminalReasonCode,
    fail,
  );
  if (!SAFE_CODE_PATTERN.test(code)) {
    throw fail("terminalReasonCode must use only A-Z, 0-9, underscore, colon, or hyphen");
  }
  return code;
}

function normalizeSafeTerminalSummary(value: string): string {
  assertValidUnicodeScalars(value, "safeTerminalSummary", validationError);
  const normalized = normalizeUnsupportedControls(value).replace(/\s+/gu, " ").trim();
  return truncateUtf16(normalized, AGENT_EXECUTION_ARTIFACT_LIMITS.safeTerminalSummary);
}

function normalizeStoredSafeTerminalSummary(value: string, fail: ErrorFactory): string {
  assertValidUnicodeScalars(value, "safeTerminalSummary", fail);
  const normalized = normalizeSafeTerminalSummary(value);
  if (normalized !== value) {
    throw fail("safeTerminalSummary is not normalized");
  }
  return normalized;
}

function normalizeFinalSummary(value: string | undefined): {
  readonly finalSummary: string | undefined;
  readonly finalSummaryTruncated: boolean;
} {
  if (value === undefined) {
    return { finalSummary: undefined, finalSummaryTruncated: false };
  }
  assertValidUnicodeScalars(value, "finalSummary", validationError);
  const normalized = normalizeUnsupportedControls(value).replace(/\r\n?/gu, "\n");
  const truncated = normalized.length > AGENT_EXECUTION_ARTIFACT_LIMITS.finalSummary;
  return {
    finalSummary: truncateUtf16(normalized, AGENT_EXECUTION_ARTIFACT_LIMITS.finalSummary),
    finalSummaryTruncated: truncated,
  };
}

function normalizeStoredFinalSummary(value: string, fail: ErrorFactory): string {
  assertValidUnicodeScalars(value, "finalSummary", fail);
  if (value.length > AGENT_EXECUTION_ARTIFACT_LIMITS.finalSummary) {
    throw fail("finalSummary exceeds maximum length");
  }
  const normalized = normalizeUnsupportedControls(value).replace(/\r\n?/gu, "\n");
  if (normalized !== value) {
    throw fail("finalSummary is not normalized");
  }
  return normalized;
}

function normalizeIsoTimestamp(value: string, field: string, fail: ErrorFactory): string {
  if (typeof value !== "string") throw fail(`${field} must be a string`);
  assertValidUnicodeScalars(value, field, fail);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw fail(`${field} must be a canonical ISO-8601 UTC timestamp`);
  }
  return value;
}

function normalizeCommit(value: string, field: string, fail: ErrorFactory): string {
  assertValidUnicodeScalars(value, field, fail);
  if (!FULL_GIT_OBJECT_ID_PATTERN.test(value)) {
    throw fail(`${field} must be a full Git object ID`);
  }
  return value.toLowerCase();
}

function normalizeExitCode(value: number, fail: ErrorFactory): number {
  if (
    !Number.isInteger(value) ||
    value < AGENT_EXECUTION_ARTIFACT_LIMITS.signedInt32Min ||
    value > AGENT_EXECUTION_ARTIFACT_LIMITS.signedInt32Max
  ) {
    throw fail("exitCode must be a signed 32-bit integer");
  }
  return value;
}

function normalizeDiffSummary(
  value: unknown,
  fail: ErrorFactory,
): AgentExecutionArtifactDiffSummary {
  const object = requireObject(value, "diffSummary", fail);
  return {
    filesChanged: normalizeNonnegativeSafeInteger(
      requireNumber(object, "filesChanged", fail),
      "diffSummary.filesChanged",
      AGENT_EXECUTION_ARTIFACT_LIMITS.diffCounter,
      fail,
    ),
    insertions: normalizeNonnegativeSafeInteger(
      requireNumber(object, "insertions", fail),
      "diffSummary.insertions",
      AGENT_EXECUTION_ARTIFACT_LIMITS.diffCounter,
      fail,
    ),
    deletions: normalizeNonnegativeSafeInteger(
      requireNumber(object, "deletions", fail),
      "diffSummary.deletions",
      AGENT_EXECUTION_ARTIFACT_LIMITS.diffCounter,
      fail,
    ),
  };
}

function normalizeNonnegativeSafeInteger(
  value: number,
  field: string,
  max: number,
  fail: ErrorFactory,
): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw fail(`${field} must be a nonnegative safe integer no greater than ${String(max)}`);
  }
  return value;
}

function normalizeChangedFiles(
  files: readonly string[],
  fail: ErrorFactory,
): {
  readonly changedFiles: readonly string[];
  readonly changedFilesTruncated: boolean;
} {
  const candidate: unknown = files;
  if (!Array.isArray(candidate)) throw fail("changedFiles must be an array");
  const normalized = candidate.map((file) => {
    if (typeof file !== "string") throw fail("changedFiles must contain only strings");
    return normalizeChangedPath(file, fail);
  });
  const sorted = Array.from(new Set(normalized)).sort(compareArtifactStrings);
  const changedFilesTruncated = sorted.length > AGENT_EXECUTION_ARTIFACT_LIMITS.changedFiles;
  return {
    changedFiles: sorted.slice(0, AGENT_EXECUTION_ARTIFACT_LIMITS.changedFiles),
    changedFilesTruncated,
  };
}

function parseStoredChangedFiles(value: unknown, fail: ErrorFactory): readonly string[] {
  if (!Array.isArray(value)) throw fail("changedFiles must be an array");
  if (value.length > AGENT_EXECUTION_ARTIFACT_LIMITS.changedFiles) {
    throw fail("changedFiles exceeds the retained file limit");
  }
  const entries = value.map((entry) => {
    if (typeof entry !== "string") throw fail("changedFiles must contain only strings");
    const normalized = normalizeChangedPath(entry, fail);
    if (normalized !== entry) throw fail("changedFiles must already be slash-normalized");
    return normalized;
  });
  const sorted = [...entries].sort(compareArtifactStrings);
  if (new Set(entries).size !== entries.length) {
    throw fail("changedFiles must not contain duplicates");
  }
  if (entries.some((entry, index) => entry !== sorted[index])) {
    throw fail("changedFiles must be sorted deterministically");
  }
  return entries;
}

export function normalizeChangedPath(
  pathValue: string,
  fail: ErrorFactory = validationError,
): string {
  if (typeof pathValue !== "string") throw fail("changed path must be a string");
  assertValidUnicodeScalars(pathValue, "changed path", fail);
  if (pathValue.length === 0) throw fail("changed path is required");
  if (pathValue.length > AGENT_EXECUTION_ARTIFACT_LIMITS.changedPath) {
    throw fail("changed path exceeds maximum length");
  }
  if (containsUnsafeControl(pathValue))
    throw fail("changed path contains an unsupported control character");
  if (pathValue.startsWith("/") || pathValue.startsWith("\\")) {
    throw fail("changed path must be repository-relative");
  }
  if (UNC_PATH_PATTERN.test(pathValue)) throw fail("changed path must not be a UNC path");
  if (WINDOWS_DRIVE_ABSOLUTE_PATTERN.test(pathValue) || DRIVE_PREFIX_PATTERN.test(pathValue)) {
    throw fail("changed path must not include a Windows drive prefix");
  }
  const normalized = pathValue.replace(/\\/gu, "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    throw fail("changed path must not contain empty segments");
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..")
      throw fail("changed path must not contain dot segments");
  }
  if ((segments[0] ?? "").toLowerCase() === ".git")
    throw fail("changed path must not target the Git internals directory");
  return normalized;
}

function assertArtifactInvariants(record: AgentExecutionArtifactRecord, fail: ErrorFactory): void {
  assertTerminalInvariants(record, fail);
  assertChangedFileDiffInvariants(record, fail);
}

function assertTerminalInvariants(record: AgentExecutionArtifactRecord, fail: ErrorFactory): void {
  if (Date.parse(record.finishedAt) < Date.parse(record.startedAt)) {
    throw fail("finishedAt must not precede startedAt");
  }
  if (record.outcome === "completed") {
    if (record.terminalReasonCode !== undefined) {
      throw fail("completed artifacts must not include terminalReasonCode");
    }
    if (record.safeTerminalSummary !== undefined) {
      throw fail("completed artifacts must not include safeTerminalSummary");
    }
    if (record.exitCode !== undefined && record.exitCode !== 0) {
      throw fail("completed artifacts must not include a nonzero exitCode");
    }
    return;
  }
  if (record.terminalReasonCode === undefined) {
    throw fail(`${record.outcome} artifacts require terminalReasonCode`);
  }
}

function assertChangedFileDiffInvariants(
  record: AgentExecutionArtifactRecord,
  fail: ErrorFactory,
): void {
  if (record.changedFilesTruncated) {
    if (record.diffSummary.filesChanged <= record.changedFiles.length) {
      throw fail(
        "truncated changed files require diffSummary.filesChanged to exceed retained files",
      );
    }
  } else if (record.diffSummary.filesChanged !== record.changedFiles.length) {
    throw fail("diffSummary.filesChanged must equal changedFiles length when not truncated");
  }
  if (
    record.diffSummary.filesChanged === 0 &&
    (record.diffSummary.insertions !== 0 || record.diffSummary.deletions !== 0)
  ) {
    throw fail("zero changed files require zero insertions and deletions");
  }
}

function normalizeUnsupportedControls(value: string): string {
  let normalized = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 13) {
      if (value.charCodeAt(index + 1) === 10) index += 1;
      normalized += "\n";
    } else if (code === 10) {
      normalized += "\n";
    } else if (isControlCodeUnit(code)) {
      normalized += " ";
    } else {
      normalized += value[index] ?? "";
    }
  }
  return normalized;
}

function containsUnsafeControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (isControlCodeUnit(code)) return true;
  }
  return false;
}

function assertValidUnicodeScalars(value: string, field: string, fail: ErrorFactory): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (isHighSurrogate(code)) {
      const next = value.charCodeAt(index + 1);
      if (!isLowSurrogate(next)) {
        throw fail(`${field} contains an invalid Unicode surrogate`);
      }
      index += 1;
    } else if (isLowSurrogate(code)) {
      throw fail(`${field} contains an invalid Unicode surrogate`);
    }
  }
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

function truncateUtf16(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  let end = maxLength;
  const last = value.charCodeAt(end - 1);
  if (isHighSurrogate(last)) end -= 1;
  return value.slice(0, end);
}

function requireObject(value: unknown, field: string, fail: ErrorFactory): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw fail(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireUnknown(
  object: Record<string, unknown>,
  field: string,
  fail: ErrorFactory,
): unknown {
  if (!Object.hasOwn(object, field)) throw fail(`${field} is required`);
  return object[field];
}

function requireString(object: Record<string, unknown>, field: string, fail: ErrorFactory): string {
  const value = requireUnknown(object, field, fail);
  if (typeof value !== "string") throw fail(`${field} must be a string`);
  return value;
}

function optionalString<T>(
  object: Record<string, unknown>,
  field: string,
  fail: ErrorFactory,
  normalize: (value: string) => T,
): T | undefined {
  const value = object[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw fail(`${field} must be a string when present`);
  return normalize(value);
}

function requireNumber(object: Record<string, unknown>, field: string, fail: ErrorFactory): number {
  const value = requireUnknown(object, field, fail);
  if (typeof value !== "number") throw fail(`${field} must be a number`);
  return value;
}

function optionalNumber<T>(
  object: Record<string, unknown>,
  field: string,
  fail: ErrorFactory,
  normalize: (value: number) => T,
): T | undefined {
  const value = object[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number") throw fail(`${field} must be a number when present`);
  return normalize(value);
}

function requireBoolean(
  object: Record<string, unknown>,
  field: string,
  fail: ErrorFactory,
): boolean {
  const value = requireUnknown(object, field, fail);
  if (typeof value !== "boolean") throw fail(`${field} must be a boolean`);
  return value;
}
