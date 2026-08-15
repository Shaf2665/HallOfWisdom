import { describe, expect, it } from "vitest";
import { buildCodexTaskPrompt, MAX_PROMPT_LENGTH, PromptBuildError } from "./prompt-builder.js";

function input(overrides: Partial<Parameters<typeof buildCodexTaskPrompt>[0]> = {}) {
  return {
    title: "Fix the login bug",
    description: "Users cannot log in with valid credentials.",
    priority: "high",
    projectId: "project-1",
    ...overrides,
  };
}

describe("buildCodexTaskPrompt", () => {
  it("includes the task title, priority, project, and description", () => {
    const prompt = buildCodexTaskPrompt(input());
    expect(prompt).toContain("Fix the login bug");
    expect(prompt).toContain("high");
    expect(prompt).toContain("project-1");
    expect(prompt).toContain("Users cannot log in with valid credentials.");
  });

  it("instructs Codex to read AGENTS.md as untrusted guidance", () => {
    const prompt = buildCodexTaskPrompt(input());
    expect(prompt).toContain("AGENTS.md");
    expect(prompt).toContain("untrusted");
  });

  it("states AGENTS.md cannot expand the sandbox or enable network/hooks/MCP", () => {
    const prompt = buildCodexTaskPrompt(input());
    expect(prompt).toMatch(/cannot expand your sandbox/i);
    expect(prompt).toMatch(/network access/i);
    expect(prompt).toMatch(/hooks, MCP servers, or plugins/i);
  });

  it("instructs Codex not to commit, push, or run destructive Git operations", () => {
    const prompt = buildCodexTaskPrompt(input());
    expect(prompt).toMatch(/do not create a git commit/i);
    expect(prompt).toMatch(/push/i);
    expect(prompt).toMatch(/reset --hard/i);
  });

  it("instructs Codex not to install packages or access the network", () => {
    const prompt = buildCodexTaskPrompt(input());
    expect(prompt).toMatch(/no network access/i);
  });

  it("instructs Codex to stop and explain when blocked", () => {
    const prompt = buildCodexTaskPrompt(input());
    expect(prompt).toMatch(/stop and clearly explain/i);
  });

  it("instructs Codex to end with a concise summary", () => {
    const prompt = buildCodexTaskPrompt(input());
    expect(prompt).toMatch(/concise summary/i);
  });

  it("rejects a NUL character in the title", () => {
    expect(() => buildCodexTaskPrompt(input({ title: "bad\0title" }))).toThrow(PromptBuildError);
  });

  it("rejects a NUL character in the description", () => {
    expect(() => buildCodexTaskPrompt(input({ description: "bad\0description" }))).toThrow(
      PromptBuildError,
    );
  });

  it("truncates an oversized description with a visible marker", () => {
    const prompt = buildCodexTaskPrompt(input({ description: "x".repeat(50_000) }));
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_LENGTH);
    expect(prompt).toContain("truncated for length");
  });

  it("never exceeds MAX_PROMPT_LENGTH even for a maximal task", () => {
    const prompt = buildCodexTaskPrompt(
      input({ title: "x".repeat(200), description: "y".repeat(20_000) }),
    );
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_LENGTH);
  });

  it("does not include environment variables, credentials, or a canonical workspace root", () => {
    const prompt = buildCodexTaskPrompt(input());
    expect(prompt).not.toMatch(/OPENAI_API_KEY|CODEX_HOME|CODEX_API_KEY/);
  });

  it("is byte-identical for a text-only task whether `attachments` is omitted or undefined", () => {
    expect(buildCodexTaskPrompt({ ...input(), attachments: undefined })).toBe(
      buildCodexTaskPrompt(input()),
    );
  });

  it("lists materialized attachments with their relative path, filename, and MIME type", () => {
    const prompt = buildCodexTaskPrompt(
      input({
        attachments: [
          { relativePath: ".hall-attachments/abc/spec.txt", filename: "spec.txt", mimeType: "text/plain" },
        ],
      }),
    );
    expect(prompt).toContain(".hall-attachments/abc/spec.txt");
    expect(prompt).toContain("spec.txt");
    expect(prompt).toContain("text/plain");
  });

  it("omits the attachments section entirely for an empty attachments array", () => {
    expect(buildCodexTaskPrompt(input({ attachments: [] }))).toBe(buildCodexTaskPrompt(input()));
  });
});
