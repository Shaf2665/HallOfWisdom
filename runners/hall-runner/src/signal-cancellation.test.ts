import { afterEach, describe, expect, it, vi } from "vitest";
import { installSignalCancellation } from "./signal-cancellation.js";

/**
 * These tests trigger the handler via `process.emit("SIGINT", "SIGINT")`
 * rather than sending a real OS signal. `process.emit` synchronously
 * invokes whatever listeners are already registered for that event name —
 * the same mechanism any EventEmitter uses — without engaging the
 * operating system's signal delivery at all, so it can never terminate
 * the Vitest worker process itself.
 */
function emitSigint(): void {
  process.emit("SIGINT", "SIGINT");
}

describe("installSignalCancellation", () => {
  const installedHandles: { uninstall: () => void }[] = [];

  afterEach(() => {
    for (const handle of installedHandles.splice(0)) {
      handle.uninstall();
    }
  });

  it("invokes onGracefulCancel on the first SIGINT", () => {
    const onGracefulCancel = vi.fn();
    const onForceExit = vi.fn();
    const handle = installSignalCancellation({ onGracefulCancel, onForceExit });
    installedHandles.push(handle);

    emitSigint();

    expect(onGracefulCancel).toHaveBeenCalledTimes(1);
    expect(onForceExit).not.toHaveBeenCalled();
  });

  it("invokes onForceExit on a second SIGINT after graceful cancellation was requested", () => {
    const onGracefulCancel = vi.fn();
    const onForceExit = vi.fn();
    const handle = installSignalCancellation({ onGracefulCancel, onForceExit });
    installedHandles.push(handle);

    emitSigint();
    emitSigint();

    expect(onGracefulCancel).toHaveBeenCalledTimes(1);
    expect(onForceExit).toHaveBeenCalledTimes(1);
  });

  it("a third SIGINT continues to invoke onForceExit, not onGracefulCancel again", () => {
    const onGracefulCancel = vi.fn();
    const onForceExit = vi.fn();
    const handle = installSignalCancellation({ onGracefulCancel, onForceExit });
    installedHandles.push(handle);

    emitSigint();
    emitSigint();
    emitSigint();

    expect(onGracefulCancel).toHaveBeenCalledTimes(1);
    expect(onForceExit).toHaveBeenCalledTimes(2);
  });

  it("removes the SIGINT listener on uninstall", () => {
    const before = process.listenerCount("SIGINT");
    const handle = installSignalCancellation({ onGracefulCancel: vi.fn(), onForceExit: vi.fn() });
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    handle.uninstall();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("uninstall is idempotent (safe to call more than once)", () => {
    const before = process.listenerCount("SIGINT");
    const handle = installSignalCancellation({ onGracefulCancel: vi.fn(), onForceExit: vi.fn() });
    handle.uninstall();
    handle.uninstall();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("does not accumulate listeners across sequential installs", () => {
    const before = process.listenerCount("SIGINT");
    for (let i = 0; i < 5; i += 1) {
      const handle = installSignalCancellation({ onGracefulCancel: vi.fn(), onForceExit: vi.fn() });
      handle.uninstall();
    }
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});
