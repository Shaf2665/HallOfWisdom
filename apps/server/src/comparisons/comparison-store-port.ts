import type { ExecutionTrust, StructuredFailure } from "@hall-of-wisdom/protocol";
import type { TerminalEventType } from "@hall-of-wisdom/hall-runner";
import type {
  AgentComparisonRecord,
  CandidateResultEvidence,
  ComparisonPreference,
} from "./comparison-record.js";

/**
 * Extracted, unchanged, from `ComparisonStore`'s own existing public
 * method signatures (Phase 13). `SqliteComparisonStore` is the
 * durable-mode sibling.
 */
export interface ComparisonStorePort {
  add(record: AgentComparisonRecord): void;
  get(comparisonId: string): AgentComparisonRecord;
  list(): AgentComparisonRecord[];
  getRevision(comparisonId: string): number;
  claimPreparing(comparisonId: string): AgentComparisonRecord;
  setReady(
    comparisonId: string,
    input: {
      readonly baseCommit: string;
      readonly candidates: readonly {
        readonly candidateId: string;
        readonly executionTrust: ExecutionTrust;
      }[];
    },
  ): AgentComparisonRecord;
  setPrepareFailed(
    comparisonId: string,
    failedCandidateId: string | undefined,
    code: string,
    safeReason: string,
  ): AgentComparisonRecord;
  claimCandidateStart(
    comparisonId: string,
    candidateId: string,
    runId: string,
    agentId: string,
  ): AgentComparisonRecord;
  clearCandidateStart(comparisonId: string, candidateId: string): void;
  recordCandidateEventMeta(comparisonId: string, candidateId: string, sequence: number): void;
  setCandidateCompleted(
    comparisonId: string,
    candidateId: string,
    input: {
      readonly completedAt: string;
      readonly terminalEventType: TerminalEventType;
      readonly failure?: StructuredFailure | undefined;
      readonly resultEvidence?: CandidateResultEvidence | undefined;
    },
  ): AgentComparisonRecord;
  setCandidateCancellationRequested(
    comparisonId: string,
    candidateId: string,
  ): { alreadyRequested: boolean };
  cancelUnstartedCandidate(comparisonId: string, candidateId: string): AgentComparisonRecord;
  claimCleanup(comparisonId: string): AgentComparisonRecord;
  markCleaning(comparisonId: string): void;
  setCleanupCompleted(comparisonId: string): AgentComparisonRecord;
  setCleanupFailed(comparisonId: string, safeError: string): AgentComparisonRecord;
  setPreference(
    comparisonId: string,
    preference: ComparisonPreference | undefined,
  ): AgentComparisonRecord;
}
