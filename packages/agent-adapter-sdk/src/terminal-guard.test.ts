import { describe, expect, it } from "vitest";
import { EventFactory } from "./event-factory.js";
import { TerminalEventGuard } from "./terminal-guard.js";
import { EventAfterTerminationError } from "./errors.js";

function createFactory(): EventFactory {
  return new EventFactory({ runId: "run-1", taskId: "task-1", agentId: "agent-1" });
}

describe("TerminalEventGuard", () => {
  it("accepts non-terminal events before termination", () => {
    const guard = new TerminalEventGuard();
    const factory = createFactory();
    expect(() => guard.guardEvent(factory.runStarted())).not.toThrow();
    expect(() => guard.guardEvent(factory.messageDelta("hi"))).not.toThrow();
    expect(guard.isTerminated).toBe(false);
  });

  it("accepts the first terminal event", () => {
    const guard = new TerminalEventGuard();
    const factory = createFactory();
    const completed = factory.runCompleted();
    expect(guard.guardEvent(completed)).toBe(completed);
    expect(guard.isTerminated).toBe(true);
    expect(guard.terminalEvent).toBe(completed);
  });

  it("rejects a second terminal event", () => {
    const guard = new TerminalEventGuard();
    const factory = createFactory();
    guard.guardEvent(factory.runCompleted());
    expect(() => guard.guardEvent(factory.runFailed({ code: "X", message: "boom" }))).toThrow(
      EventAfterTerminationError,
    );
  });

  it("rejects a non-terminal event submitted after termination", () => {
    const guard = new TerminalEventGuard();
    const factory = createFactory();
    guard.guardEvent(factory.runCompleted());
    expect(() => guard.guardEvent(factory.messageDelta("too late"))).toThrow(
      EventAfterTerminationError,
    );
  });

  it("is idempotent for repeated cancellation attempts (second call throws, first result stands)", () => {
    const guard = new TerminalEventGuard();
    const factory = createFactory();
    const firstCancel = factory.runCancelled("user");
    guard.guardEvent(firstCancel);
    expect(() => guard.guardEvent(factory.runCancelled("user"))).toThrow(
      EventAfterTerminationError,
    );
    expect(guard.terminalEvent).toBe(firstCancel);
  });

  it("does not allow completion to replace cancellation", () => {
    const guard = new TerminalEventGuard();
    const factory = createFactory();
    const cancelled = factory.runCancelled("orchestrator");
    guard.guardEvent(cancelled);
    expect(() => guard.guardEvent(factory.runCompleted())).toThrow(EventAfterTerminationError);
    expect(guard.terminalEvent).toBe(cancelled);
  });

  it("does not allow cancellation to replace failure", () => {
    const guard = new TerminalEventGuard();
    const factory = createFactory();
    const failed = factory.runFailed({ code: "X", message: "boom" });
    guard.guardEvent(failed);
    expect(() => guard.guardEvent(factory.runCancelled("system"))).toThrow(
      EventAfterTerminationError,
    );
    expect(guard.terminalEvent).toBe(failed);
  });

  it("does not allow failure to replace cancellation", () => {
    const guard = new TerminalEventGuard();
    const factory = createFactory();
    const cancelled = factory.runCancelled("system");
    guard.guardEvent(cancelled);
    expect(() => guard.guardEvent(factory.runFailed({ code: "X", message: "boom" }))).toThrow(
      EventAfterTerminationError,
    );
    expect(guard.terminalEvent).toBe(cancelled);
  });

  it("carries the attempted and terminal event types on the thrown error", () => {
    expect.assertions(4);
    const guard = new TerminalEventGuard();
    const factory = createFactory();
    guard.guardEvent(factory.runCompleted());
    try {
      guard.guardEvent(factory.messageDelta("late"));
    } catch (error) {
      expect(error).toBeInstanceOf(EventAfterTerminationError);
      const typed = error as EventAfterTerminationError;
      expect(typed.attemptedEventType).toBe("message.delta");
      expect(typed.terminalEventType).toBe("run.completed");
      expect(typed.code).toBe("EVENT_AFTER_TERMINATION");
    }
  });
});
