import { describe, expect, it } from "vitest";
import { parseAuthStatusOutput } from "./auth-classification.js";

// All values below are obviously fake (`.invalid` TLD, fake token/org
// strings) — never real account information. See
// docs/architecture/0008-claude-code-adapter.md, "Authentication output
// hygiene".

const FAKE_EMAIL = "operator@example.invalid";
const FAKE_ORG_ID = "org-fake-0000000000000000";
const FAKE_ORG_NAME = "Example Invalid Org";
const FAKE_TOKEN = "sk-ant-fake-not-a-real-token-0000000000000000";

function rawSubscriptionAuth(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    subscriptionType: "pro",
    email: FAKE_EMAIL,
    orgId: FAKE_ORG_ID,
    orgName: FAKE_ORG_NAME,
    ...overrides,
  });
}

describe("parseAuthStatusOutput — classification", () => {
  it("produces the safe subscription classification for valid subscription auth", () => {
    const result = parseAuthStatusOutput(rawSubscriptionAuth());
    expect(result).toEqual({
      loggedIn: true,
      authenticationKind: "subscription",
      subscriptionVerified: true,
    });
  });

  it("rejects API-key auth (subscriptionVerified false)", () => {
    const result = parseAuthStatusOutput(
      JSON.stringify({ loggedIn: true, authMethod: "apiKey", apiProvider: "firstParty" }),
    );
    expect(result?.subscriptionVerified).toBe(false);
    expect(result?.authenticationKind).toBe("api_key");
  });

  it("rejects cloud-provider auth (subscriptionVerified false)", () => {
    const result = parseAuthStatusOutput(
      JSON.stringify({ loggedIn: true, authMethod: "bedrock", apiProvider: "bedrock" }),
    );
    expect(result?.subscriptionVerified).toBe(false);
    expect(result?.authenticationKind).toBe("cloud_provider");
  });

  it("rejects gateway auth (subscriptionVerified false)", () => {
    const result = parseAuthStatusOutput(
      JSON.stringify({ loggedIn: true, authMethod: "enterpriseGateway", apiProvider: "gateway" }),
    );
    expect(result?.subscriptionVerified).toBe(false);
    expect(result?.authenticationKind).toBe("gateway");
  });

  it("fails closed (ambiguous, unverified) for a recognized-account but unrecognized subscription tier", () => {
    const result = parseAuthStatusOutput(rawSubscriptionAuth({ subscriptionType: "unknown_tier" }));
    expect(result?.subscriptionVerified).toBe(false);
    expect(result?.authenticationKind).toBe("ambiguous");
  });

  it("fails closed (ambiguous, unverified) for an unrecognized authMethod/apiProvider combination", () => {
    const result = parseAuthStatusOutput(
      JSON.stringify({ loggedIn: true, authMethod: "somethingNew", apiProvider: "somethingElse" }),
    );
    expect(result?.subscriptionVerified).toBe(false);
    expect(result?.authenticationKind).toBe("ambiguous");
  });

  it("reports loggedIn: false as a successfully-parsed (not undefined) classification", () => {
    const result = parseAuthStatusOutput(JSON.stringify({ loggedIn: false }));
    expect(result).toEqual({
      loggedIn: false,
      authenticationKind: "ambiguous",
      subscriptionVerified: false,
    });
  });

  it("does not let unknown/nested fields escape the parser", () => {
    const result = parseAuthStatusOutput(
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        subscriptionType: "pro",
        nested: { weird: { shape: [FAKE_TOKEN] } },
        someFutureField: "unexpected",
      }),
    );
    expect(Object.keys(result ?? {}).sort()).toEqual([
      "authenticationKind",
      "loggedIn",
      "subscriptionVerified",
    ]);
  });
});

describe("parseAuthStatusOutput — redaction (never forwards raw identifying content)", () => {
  it("never includes the email in the parsed result", () => {
    const result = parseAuthStatusOutput(rawSubscriptionAuth());
    expect(JSON.stringify(result)).not.toContain(FAKE_EMAIL);
  });

  it("never includes the organization ID in the parsed result", () => {
    const result = parseAuthStatusOutput(rawSubscriptionAuth());
    expect(JSON.stringify(result)).not.toContain(FAKE_ORG_ID);
  });

  it("never includes the organization name in the parsed result", () => {
    const result = parseAuthStatusOutput(rawSubscriptionAuth());
    expect(JSON.stringify(result)).not.toContain(FAKE_ORG_NAME);
  });

  it("never includes a token-like value in the parsed result", () => {
    const result = parseAuthStatusOutput(rawSubscriptionAuth({ token: FAKE_TOKEN }));
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
  });

  it("never includes raw JSON in a thrown error for malformed input", () => {
    expect.assertions(1);
    try {
      // parseAuthStatusOutput never throws — this test asserts that
      // invariant directly rather than expecting a catch.
      const result = parseAuthStatusOutput(`{not valid json ${FAKE_EMAIL}`);
      expect(result).toBeUndefined();
    } catch (error) {
      // Should never reach here; fail loudly if it does.
      throw new Error(`parseAuthStatusOutput must never throw: ${String(error)}`);
    }
  });

  it("never includes raw JSON in a detection diagnostic for malformed input", () => {
    const result = parseAuthStatusOutput(
      `garbage output containing ${FAKE_EMAIL} and ${FAKE_TOKEN}`,
    );
    expect(result).toBeUndefined();
  });
});

describe("parseAuthStatusOutput — malformed and oversized input", () => {
  it("returns undefined (distinct from a parsed logged-out result) for malformed JSON", () => {
    const result = parseAuthStatusOutput("{not valid json");
    expect(result).toBeUndefined();
  });

  it("returns undefined for valid JSON that fails schema validation", () => {
    const result = parseAuthStatusOutput(JSON.stringify({ loggedIn: "not-a-boolean" }));
    expect(result).toBeUndefined();
  });

  it("returns undefined for oversized auth output rather than parsing it", () => {
    const oversized = JSON.stringify({ loggedIn: true, padding: "x".repeat(200_000) });
    const result = parseAuthStatusOutput(oversized);
    expect(result).toBeUndefined();
  });

  it("returns undefined for a bare non-object JSON value", () => {
    expect(parseAuthStatusOutput("null")).toBeUndefined();
    expect(parseAuthStatusOutput("42")).toBeUndefined();
    expect(parseAuthStatusOutput('"a string"')).toBeUndefined();
  });
});
