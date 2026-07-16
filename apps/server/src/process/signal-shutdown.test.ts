import { afterEach, describe, expect, it, vi } from "vitest";
import { installShutdownSignals } from "./signal-shutdown.js";

/**
 * Triggered via `process.emit(signal, signal)` rather than a real OS
 * signal — the same, deliberately safe approach used by Hall Runner's
 * `signal-cancellation.test.ts` (`runners/hall-runner/src/signal-cancellation.test.ts`).
 * `process.emit` synchronously invokes already-registered listeners
 * without engaging the operating system's signal delivery, so it can
 * never terminate the Vitest worker process.
 */
function emit(signal: "SIGINT" | "SIGTERM"): void {
  process.emit(signal, signal);
}

describe("installShutdownSignals", () => {
  const installedHandles: { uninstall: () => void }[] = [];

  afterEach(() => {
    for (const handle of installedHandles.splice(0)) {
      handle.uninstall();
    }
  });

  it("invokes onGracefulShutdown on the first SIGINT", () => {
    const onGracefulShutdown = vi.fn();
    const onForceExit = vi.fn();
    const handle = installShutdownSignals({ onGracefulShutdown, onForceExit });
    installedHandles.push(handle);
    emit("SIGINT");
    expect(onGracefulShutdown).toHaveBeenCalledTimes(1);
    expect(onForceExit).not.toHaveBeenCalled();
  });

  it("invokes onGracefulShutdown on the first SIGTERM", () => {
    const onGracefulShutdown = vi.fn();
    const onForceExit = vi.fn();
    const handle = installShutdownSignals({ onGracefulShutdown, onForceExit });
    installedHandles.push(handle);
    emit("SIGTERM");
    expect(onGracefulShutdown).toHaveBeenCalledTimes(1);
    expect(onForceExit).not.toHaveBeenCalled();
  });

  it("invokes onForceExit on a second signal after graceful shutdown was requested", () => {
    const onGracefulShutdown = vi.fn();
    const onForceExit = vi.fn();
    const handle = installShutdownSignals({ onGracefulShutdown, onForceExit });
    installedHandles.push(handle);
    emit("SIGINT");
    emit("SIGTERM");
    expect(onGracefulShutdown).toHaveBeenCalledTimes(1);
    expect(onForceExit).toHaveBeenCalledTimes(1);
  });

  it("removes both signal listeners on uninstall", () => {
    const beforeInt = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    const handle = installShutdownSignals({ onGracefulShutdown: vi.fn(), onForceExit: vi.fn() });
    expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
    handle.uninstall();
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
  });

  it("uninstall is idempotent", () => {
    const before = process.listenerCount("SIGINT");
    const handle = installShutdownSignals({ onGracefulShutdown: vi.fn(), onForceExit: vi.fn() });
    handle.uninstall();
    handle.uninstall();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("does not accumulate listeners across repeated install/uninstall cycles", () => {
    const before = process.listenerCount("SIGINT");
    for (let i = 0; i < 5; i += 1) {
      const handle = installShutdownSignals({ onGracefulShutdown: vi.fn(), onForceExit: vi.fn() });
      handle.uninstall();
    }
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});
