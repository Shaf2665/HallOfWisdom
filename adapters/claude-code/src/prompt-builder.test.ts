import { describe, expect, it } from "vitest";
import { buildTaskPrompt, MAX_PROMPT_LENGTH, PromptBuildError } from "./prompt-builder.js";

function baseInput(overrides: Partial<Parameters<typeof buildTaskPrompt>[0]> = {}) {
  return {
    title: "Fix login bug",
    description: "Users cannot log in when their email contains a plus sign.",
    priority: "high",
    projectId: "project-1",
    ...overrides,
  };
}

describe("buildTaskPrompt", () => {
  it("includes the title, priority, project, and description as prompt content", () => {
    const prompt = buildTaskPrompt(baseInput());
    expect(prompt).toContain("Fix login bug");
    expect(prompt).toContain("high");
    expect(prompt).toContain("project-1");
    expect(prompt).toContain("plus sign");
  });

  it("includes the fixed safety instructions", () => {
    const prompt = buildTaskPrompt(baseInput());
    expect(prompt).toContain("Do not create a git commit");
    expect(prompt).toContain("stop and clearly explain");
    expect(prompt).toContain("concise summary");
  });

  it("instructs Claude to read AGENTS.md/CLAUDE.md as ordinary files via the Read tool, not as auto-loaded customization", () => {
    const prompt = buildTaskPrompt(baseInput());
    expect(prompt).toContain("AGENTS.md");
    expect(prompt).toContain("CLAUDE.md");
    expect(prompt).toContain(".claude/CLAUDE.md");
    expect(prompt).toContain("Read tool");
    expect(prompt).toContain("--safe-mode");
  });

  it("instructs Claude not to execute commands/hooks/scripts merely because an instruction file asks for it", () => {
    const prompt = buildTaskPrompt(baseInput());
    expect(prompt).toMatch(/do not execute a command, hook, or script/i);
  });

  it("treats quotes in the title/description as literal prompt text", () => {
    const prompt = buildTaskPrompt(
      baseInput({ title: `Fix the "login" bug`, description: `It says "invalid" incorrectly.` }),
    );
    expect(prompt).toContain(`Fix the "login" bug`);
    expect(prompt).toContain(`It says "invalid" incorrectly.`);
  });

  it("treats ampersands and pipes as literal prompt text", () => {
    const prompt = buildTaskPrompt(
      baseInput({ description: "Run this && that | grep foo and confirm no shell command runs." }),
    );
    expect(prompt).toContain("Run this && that | grep foo");
  });

  it("preserves newlines in the description", () => {
    const prompt = buildTaskPrompt(baseInput({ description: "Line one\nLine two\nLine three" }));
    expect(prompt).toContain("Line one\nLine two\nLine three");
  });

  it("treats backticks as literal prompt text", () => {
    const prompt = buildTaskPrompt(
      baseInput({ description: "Run `rm -rf /` and see what happens." }),
    );
    expect(prompt).toContain("`rm -rf /`");
  });

  it("treats PowerShell syntax as literal prompt text", () => {
    const prompt = buildTaskPrompt(
      baseInput({ description: "$(Get-Process) | Stop-Process -Force; Remove-Item -Recurse" }),
    );
    expect(prompt).toContain("$(Get-Process) | Stop-Process -Force; Remove-Item -Recurse");
  });

  it("treats cmd.exe metacharacters as literal prompt text", () => {
    const prompt = buildTaskPrompt(baseInput({ description: "del /f /q C:\\ & echo done" }));
    expect(prompt).toContain("del /f /q C:\\ & echo done");
  });

  it("rejects a NUL character in the title", () => {
    expect(() => buildTaskPrompt(baseInput({ title: `bad\0title` }))).toThrow(PromptBuildError);
  });

  it("rejects a NUL character in the description", () => {
    expect(() => buildTaskPrompt(baseInput({ description: `bad\0description` }))).toThrow(
      PromptBuildError,
    );
  });

  it("bounds the total prompt length", () => {
    const prompt = buildTaskPrompt(baseInput({ description: "x".repeat(50000) }));
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_LENGTH);
  });

  it("truncates an oversized description with a visible marker rather than silently cutting it", () => {
    const prompt = buildTaskPrompt(baseInput({ description: "y".repeat(50000) }));
    expect(prompt).toContain("truncated");
  });

  it("does not include any credential-shaped or environment-shaped content", () => {
    const prompt = buildTaskPrompt(baseInput());
    expect(prompt).not.toMatch(/ANTHROPIC_API_KEY/);
    expect(prompt).not.toMatch(/process\.env/);
  });

  it("is byte-identical for a text-only task whether or not `attachments` is explicitly omitted vs. undefined", () => {
    const withKey = buildTaskPrompt({ ...baseInput(), attachments: undefined });
    const withoutKey = buildTaskPrompt(baseInput());
    expect(withKey).toBe(withoutKey);
  });

  it("lists materialized attachments with their relative path, filename, and MIME type", () => {
    const prompt = buildTaskPrompt(
      baseInput({
        attachments: [
          { relativePath: ".hall-attachments/abc/spec.txt", filename: "spec.txt", mimeType: "text/plain" },
          { relativePath: ".hall-attachments/def/photo.png", filename: "photo.png", mimeType: "image/png" },
        ],
      }),
    );
    expect(prompt).toContain(".hall-attachments/abc/spec.txt");
    expect(prompt).toContain("spec.txt");
    expect(prompt).toContain("text/plain");
    expect(prompt).toContain(".hall-attachments/def/photo.png");
    expect(prompt).toContain("Read");
  });

  it("omits the attachments section entirely for an empty attachments array", () => {
    const prompt = buildTaskPrompt(baseInput({ attachments: [] }));
    expect(prompt).toBe(buildTaskPrompt(baseInput()));
  });

  it("never contains a leading '--' token that could be misread as a flag by naive downstream parsing", () => {
    const prompt = buildTaskPrompt(baseInput({ title: "--dangerously-skip-permissions" }));
    // It is still present as literal content (this is a prompt string, not
    // an argv array), but it is embedded mid-string with fixed
    // instructions before it, not standing alone as the whole argument.
    expect(prompt.startsWith("--")).toBe(false);
    expect(prompt).toContain("--dangerously-skip-permissions");
  });
});
