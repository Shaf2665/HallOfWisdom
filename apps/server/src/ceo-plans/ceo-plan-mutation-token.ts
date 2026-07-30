import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Phase 14.1 — replaces the previously-public plan-level `revision`
 * integer. A token is `base64url(HMAC-SHA256(secret, "<planId>:<revision>"))`
 * — 32 raw bytes, 43 base64url characters with no padding. This is
 * deliberately NOT decoded back into a revision by the server: the
 * orchestrator always already knows the plan's current revision (it just
 * read it), and only needs to answer "does the client's token match what
 * I just read" — so there is no encryption/decryption step, no risk of
 * nonce reuse, and no way for the token's own bytes to reveal the
 * revision (an HMAC digest has no recoverable internal structure). The
 * secret is a fresh `randomBytes(32)` per process by default — held only
 * in memory, never persisted, never logged — so every server restart
 * invalidates every previously-issued token. This is safe and
 * self-healing: a stale token after a restart fails exactly like any
 * other stale token (409, "refetch and retry"), and the very next GET
 * mints a fresh valid one. See
 * `docs/architecture/0014-ceo-planning-approval-and-delegation.md`,
 * "Public concurrency contract."
 */
export interface CeoPlanMutationTokenIssuer {
  issue(planId: string, revision: number): string;
  verify(planId: string, revision: number, token: string): boolean;
}

export const MUTATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function signaturePayload(planId: string, revision: number): string {
  return `${planId}:${String(revision)}`;
}

export function createCeoPlanMutationTokenIssuer(
  secret: Buffer = randomBytes(32),
): CeoPlanMutationTokenIssuer {
  function computeDigest(planId: string, revision: number): Buffer {
    return createHmac("sha256", secret).update(signaturePayload(planId, revision)).digest();
  }

  return {
    issue(planId, revision) {
      return computeDigest(planId, revision).toString("base64url");
    },
    verify(planId, revision, token) {
      if (!MUTATION_TOKEN_PATTERN.test(token)) return false;
      const expected = computeDigest(planId, revision);
      const actual = Buffer.from(token, "base64url");
      if (actual.length !== expected.length) return false;
      return timingSafeEqual(expected, actual);
    },
  };
}
