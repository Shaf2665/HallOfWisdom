import { describe, expect, it } from "vitest";
import { buildChildEnvironment, containsBlockedEnvironmentKey } from "./environment.js";

describe("buildChildEnvironment", () => {
  it("preserves safe platform fields", () => {
    const env = buildChildEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/operator",
      TEMP: "/tmp",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/operator");
    expect(env.TEMP).toBe("/tmp");
  });

  it("matches safe keys case-insensitively (Windows-style casing)", () => {
    const env = buildChildEnvironment({
      Path: "C:\\Windows\\System32",
      UserProfile: "C:\\Users\\operator",
    });
    expect(env.PATH).toBe("C:\\Windows\\System32");
    expect(env.USERPROFILE).toBe("C:\\Users\\operator");
  });

  it("drops ANTHROPIC_API_KEY", () => {
    const env = buildChildEnvironment({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-secret" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(containsBlockedEnvironmentKey(env)).toBe(false);
  });

  it("drops ANTHROPIC_AUTH_TOKEN", () => {
    const env = buildChildEnvironment({ ANTHROPIC_AUTH_TOKEN: "token-value" });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("drops ANTHROPIC_BASE_URL", () => {
    const env = buildChildEnvironment({ ANTHROPIC_BASE_URL: "https://evil.example" });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("drops CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX, CLAUDE_CODE_USE_FOUNDRY", () => {
    const env = buildChildEnvironment({
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
    });
    expect(Object.keys(env)).toHaveLength(0);
  });

  it("drops AWS Bedrock credential variables", () => {
    const env = buildChildEnvironment({
      AWS_ACCESS_KEY_ID: "AKIA...",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "token",
      AWS_PROFILE: "bedrock",
      AWS_REGION: "us-east-1",
    });
    expect(Object.keys(env)).toHaveLength(0);
  });

  it("drops Google/Vertex credential selectors", () => {
    const env = buildChildEnvironment({
      GOOGLE_APPLICATION_CREDENTIALS: "/path/to/creds.json",
      GOOGLE_CLOUD_PROJECT: "my-project",
      ANTHROPIC_VERTEX_PROJECT_ID: "my-project",
      CLOUD_ML_REGION: "us-central1",
    });
    expect(Object.keys(env)).toHaveLength(0);
  });

  it("drops Microsoft Foundry credential selectors", () => {
    const env = buildChildEnvironment({
      ANTHROPIC_FOUNDRY_API_KEY: "secret",
      AZURE_CLIENT_ID: "client-id",
    });
    expect(Object.keys(env)).toHaveLength(0);
  });

  it("drops CLAUDE_CODE_OAUTH_TOKEN (not supported in Phase 9)", () => {
    const env = buildChildEnvironment({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("preserves CLAUDE_CONFIG_DIR when present", () => {
    const env = buildChildEnvironment({ CLAUDE_CONFIG_DIR: "C:\\Users\\operator\\.claude-alt" });
    expect(env.CLAUDE_CONFIG_DIR).toBe("C:\\Users\\operator\\.claude-alt");
  });

  it("does not include an unrecognized/unlisted variable, even a harmless-looking one", () => {
    const env = buildChildEnvironment({ SOME_RANDOM_TOOL_FLAG: "true", PATH: "/usr/bin" });
    expect(env.SOME_RANDOM_TOOL_FLAG).toBeUndefined();
    expect(Object.keys(env)).toEqual(["PATH"]);
  });

  it("never mutates the input environment object", () => {
    const parentEnv = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "secret" };
    const frozenCopy = { ...parentEnv };
    buildChildEnvironment(parentEnv);
    expect(parentEnv).toEqual(frozenCopy);
  });

  it("returns a fresh object each call (not a shared reference)", () => {
    const parentEnv = { PATH: "/usr/bin" };
    const first = buildChildEnvironment(parentEnv);
    const second = buildChildEnvironment(parentEnv);
    expect(first).not.toBe(second);
  });

  it("drops undefined-valued parent entries rather than passing through the string 'undefined'", () => {
    const env = buildChildEnvironment({ PATH: undefined, HOME: "/home/operator" });
    expect(env.PATH).toBeUndefined();
    expect(env.HOME).toBe("/home/operator");
  });

  it("returns an empty object for an empty parent environment", () => {
    const env = buildChildEnvironment({});
    expect(env).toEqual({});
  });
});

describe("containsBlockedEnvironmentKey", () => {
  it("returns false for a clean environment", () => {
    expect(containsBlockedEnvironmentKey({ PATH: "/usr/bin" })).toBe(false);
  });

  it("returns true if a blocked key is somehow present", () => {
    expect(containsBlockedEnvironmentKey({ ANTHROPIC_API_KEY: "secret" })).toBe(true);
  });
});
