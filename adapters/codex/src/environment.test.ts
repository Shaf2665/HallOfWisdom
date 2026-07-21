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

  it("preserves CODEX_HOME when present (required for the operator's existing ChatGPT login)", () => {
    const env = buildChildEnvironment({ CODEX_HOME: "C:\\Users\\operator\\.codex" });
    expect(env.CODEX_HOME).toBe("C:\\Users\\operator\\.codex");
  });

  it("preserves PATHEXT when present", () => {
    const env = buildChildEnvironment({ PATHEXT: ".COM;.EXE;.BAT;.CMD" });
    expect(env.PATHEXT).toBe(".COM;.EXE;.BAT;.CMD");
  });

  it("drops OPENAI_API_KEY", () => {
    const env = buildChildEnvironment({ PATH: "/usr/bin", OPENAI_API_KEY: "sk-secret" });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(containsBlockedEnvironmentKey(env)).toBe(false);
  });

  it("drops CODEX_API_KEY", () => {
    const env = buildChildEnvironment({ CODEX_API_KEY: "sk-secret" });
    expect(env.CODEX_API_KEY).toBeUndefined();
  });

  it("drops CODEX_ACCESS_TOKEN", () => {
    const env = buildChildEnvironment({ CODEX_ACCESS_TOKEN: "token-value" });
    expect(env.CODEX_ACCESS_TOKEN).toBeUndefined();
  });

  it("drops OPENAI_BASE_URL, OPENAI_ORG_ID, OPENAI_PROJECT_ID", () => {
    const env = buildChildEnvironment({
      OPENAI_BASE_URL: "https://evil.example",
      OPENAI_ORG_ID: "org-evil",
      OPENAI_PROJECT_ID: "proj-evil",
    });
    expect(Object.keys(env)).toHaveLength(0);
  });

  it("drops Azure OpenAI variables", () => {
    const env = buildChildEnvironment({
      AZURE_OPENAI_API_KEY: "secret",
      AZURE_OPENAI_ENDPOINT: "https://evil.example",
    });
    expect(Object.keys(env)).toHaveLength(0);
  });

  it("drops proxy credential variables", () => {
    const env = buildChildEnvironment({
      HTTPS_PROXY: "http://evil.example:8080",
      HTTP_PROXY: "http://evil.example:8080",
      ALL_PROXY: "http://evil.example:8080",
    });
    expect(Object.keys(env)).toHaveLength(0);
  });

  it("drops local-provider/profile selectors", () => {
    const env = buildChildEnvironment({ CODEX_OSS: "1", CODEX_PROFILE: "untrusted-profile" });
    expect(Object.keys(env)).toHaveLength(0);
  });

  it("does not include an unrecognized/unlisted variable, even a harmless-looking one", () => {
    const env = buildChildEnvironment({ SOME_RANDOM_TOOL_FLAG: "true", PATH: "/usr/bin" });
    expect(env.SOME_RANDOM_TOOL_FLAG).toBeUndefined();
    expect(Object.keys(env)).toEqual(["PATH"]);
  });

  it("never mutates the input environment object", () => {
    const parentEnv = { PATH: "/usr/bin", OPENAI_API_KEY: "secret" };
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
    expect(buildChildEnvironment({})).toEqual({});
  });
});

describe("containsBlockedEnvironmentKey", () => {
  it("returns false for a clean environment", () => {
    expect(containsBlockedEnvironmentKey({ PATH: "/usr/bin" })).toBe(false);
  });

  it("returns true if a blocked key is somehow present", () => {
    expect(containsBlockedEnvironmentKey({ OPENAI_API_KEY: "secret" })).toBe(true);
  });
});
