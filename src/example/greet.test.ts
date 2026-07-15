import { describe, expect, it } from "vitest";
import { createWelcomeMessage } from "./greet.js";

describe("createWelcomeMessage", () => {
  it("returns a welcome message containing the trimmed agent name", () => {
    expect(createWelcomeMessage("  Claude Code  ")).toBe(
      "Hall of Wisdom is ready to work with Claude Code.",
    );
  });

  it("throws when the agent name is empty or only whitespace", () => {
    expect(() => createWelcomeMessage("   ")).toThrow("agentName must not be empty");
  });
});
