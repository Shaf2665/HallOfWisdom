import { describe, expect, it } from "vitest";
import type { TaskRequirements } from "@hall-of-wisdom/protocol";
import { DEFAULT_TASK_INTENT, deriveTaskIntent, TASK_INTENTS } from "./task-intent.js";

function requirements(capabilities: TaskRequirements["requiredCapabilities"]): TaskRequirements {
  return { requiredCapabilities: capabilities, allowedExecutionTrust: ["trusted_local"] };
}

describe("TASK_INTENTS", () => {
  it("is the fixed six-value provider-neutral vocabulary", () => {
    expect(TASK_INTENTS).toEqual(["planning", "coding", "review", "debug", "vision", "general"]);
  });
});

describe("deriveTaskIntent", () => {
  it("maps project.edit to coding", () => {
    expect(deriveTaskIntent(requirements(["project.edit"]))).toBe("coding");
  });

  it("maps command.execute to coding", () => {
    expect(deriveTaskIntent(requirements(["command.execute"]))).toBe("coding");
  });

  it("maps project.read (no edit/execute) to review", () => {
    expect(deriveTaskIntent(requirements(["project.read"]))).toBe("review");
  });

  it("maps git.inspect (no edit/execute) to review", () => {
    expect(deriveTaskIntent(requirements(["git.inspect"]))).toBe("review");
  });

  it("prefers coding when both edit and read-only capabilities are present", () => {
    expect(deriveTaskIntent(requirements(["project.read", "project.edit"]))).toBe("coding");
  });

  it("falls back to general for capabilities with no coding/review signal", () => {
    expect(deriveTaskIntent(requirements(["structured.events", "cancellation"]))).toBe("general");
  });

  it("falls back to general (the safe default) when requirements are undefined", () => {
    expect(deriveTaskIntent(undefined)).toBe(DEFAULT_TASK_INTENT);
  });

  it("falls back to general when requiredCapabilities is empty", () => {
    expect(deriveTaskIntent(requirements([]))).toBe("general");
  });

  it("never derives planning or debug — they are not reachable from today's data", () => {
    const allCapabilities: TaskRequirements["requiredCapabilities"] = [
      "project.read",
      "project.edit",
      "command.execute",
      "git.inspect",
      "structured.events",
      "cancellation",
      "session.resume",
      "network.access",
    ];
    const result = deriveTaskIntent(requirements(allCapabilities));
    expect(["planning", "debug"]).not.toContain(result);
  });

  it("derives vision when a real image attachment is present, regardless of other requirements", () => {
    expect(deriveTaskIntent(requirements(["project.edit"]), true)).toBe("vision");
    expect(deriveTaskIntent(undefined, true)).toBe("vision");
  });

  it("never derives vision from a vision.image requirement alone — only from a real image attachment", () => {
    // A `vision.image` capability requirement with no `hasImageAttachment`
    // argument (default false) must never fabricate multimodal intent —
    // this is the same discipline `hermes_agent` enforces on the actual
    // message content.
    expect(deriveTaskIntent(requirements(["vision.image"]))).not.toBe("vision");
    expect(deriveTaskIntent(requirements(["vision.image"]), false)).not.toBe("vision");
  });
});
