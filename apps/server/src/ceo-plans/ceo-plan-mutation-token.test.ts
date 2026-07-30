import { describe, expect, it } from "vitest";
import {
  createCeoPlanMutationTokenIssuer,
  MUTATION_TOKEN_PATTERN,
} from "./ceo-plan-mutation-token.js";

const SECRET_A = Buffer.from("test-secret-32-bytes-long-fixed!");
const SECRET_B = Buffer.from("secret-b-32-bytes-long-exactly!!");

describe("CeoPlanMutationTokenIssuer", () => {
  it("issues a token matching the public format and verifies it against the same planId/revision", () => {
    const issuer = createCeoPlanMutationTokenIssuer(SECRET_A);
    const token = issuer.issue("plan-1", 0);
    expect(token).toMatch(MUTATION_TOKEN_PATTERN);
    expect(issuer.verify("plan-1", 0, token)).toBe(true);
  });

  it("rejects a token issued for a different planId", () => {
    const issuer = createCeoPlanMutationTokenIssuer(SECRET_A);
    const token = issuer.issue("plan-1", 0);
    expect(issuer.verify("plan-2", 0, token)).toBe(false);
  });

  it("rejects a token issued for a different revision — this is the stale-token case", () => {
    const issuer = createCeoPlanMutationTokenIssuer(SECRET_A);
    const token = issuer.issue("plan-1", 0);
    expect(issuer.verify("plan-1", 1, token)).toBe(false);
  });

  it("rejects a tampered token", () => {
    const issuer = createCeoPlanMutationTokenIssuer(SECRET_A);
    const token = issuer.issue("plan-1", 0);
    const tampered = token.slice(0, -1) + (token.at(-1) === "A" ? "B" : "A");
    expect(issuer.verify("plan-1", 0, tampered)).toBe(false);
  });

  it("rejects a malformed token without throwing", () => {
    const issuer = createCeoPlanMutationTokenIssuer(SECRET_A);
    expect(issuer.verify("plan-1", 0, "not-a-real-token")).toBe(false);
    expect(issuer.verify("plan-1", 0, "")).toBe(false);
    expect(issuer.verify("plan-1", 0, "../../etc/passwd")).toBe(false);
  });

  it("two issuers with different secrets never agree", () => {
    const a = createCeoPlanMutationTokenIssuer(SECRET_A);
    const b = createCeoPlanMutationTokenIssuer(SECRET_B);
    const token = a.issue("plan-1", 0);
    expect(b.verify("plan-1", 0, token)).toBe(false);
  });

  it("defaults to a fresh random secret per issuer instance when none is supplied", () => {
    const a = createCeoPlanMutationTokenIssuer();
    const b = createCeoPlanMutationTokenIssuer();
    const token = a.issue("plan-1", 0);
    expect(token).toMatch(MUTATION_TOKEN_PATTERN);
    expect(b.verify("plan-1", 0, token)).toBe(false);
  });

  it("issuing again for a later revision produces a different token — the token rotates on every mutation", () => {
    const issuer = createCeoPlanMutationTokenIssuer(SECRET_A);
    const tokenAtRevision0 = issuer.issue("plan-1", 0);
    const tokenAtRevision1 = issuer.issue("plan-1", 1);
    expect(tokenAtRevision0).not.toBe(tokenAtRevision1);
  });

  it("does not reveal the revision through the token's format — the token is a fixed-length opaque digest regardless of revision magnitude", () => {
    const issuer = createCeoPlanMutationTokenIssuer(SECRET_A);
    const small = issuer.issue("plan-1", 0);
    const large = issuer.issue("plan-1", 999_999);
    expect(small).toHaveLength(large.length);
    expect(small).toMatch(MUTATION_TOKEN_PATTERN);
    expect(large).toMatch(MUTATION_TOKEN_PATTERN);
  });
});
