export interface SignalCancellationHandlers {
  /** First SIGINT: request graceful cancellation (e.g. abort a controller). */
  readonly onGracefulCancel: () => void;
  /** A second SIGINT while a graceful cancellation is already in flight: force an immediate exit. */
  readonly onForceExit: () => void;
}

export interface SignalCancellationHandle {
  /** Removes the SIGINT listener. Idempotent — safe to call more than once. */
  readonly uninstall: () => void;
}

/**
 * Wires `SIGINT` (Ctrl+C) to graceful-then-forced cancellation, kept
 * deliberately separate from `runner-service.ts`: the core execution
 * pipeline has no knowledge of process signals, so it stays usable by
 * anything that isn't a signal-driven CLI (a future Hall Core service, a
 * test). The listener is attached exactly once per call and must be
 * removed via the returned `uninstall()` once the run this instance was
 * guarding has reached a terminal state — otherwise listeners would
 * accumulate across sequential runs in a long-lived process.
 */
export function installSignalCancellation(
  handlers: SignalCancellationHandlers,
): SignalCancellationHandle {
  let cancellationRequested = false;
  let uninstalled = false;

  const onSigint = (): void => {
    if (cancellationRequested) {
      handlers.onForceExit();
      return;
    }
    cancellationRequested = true;
    handlers.onGracefulCancel();
  };

  process.on("SIGINT", onSigint);

  const uninstall = (): void => {
    if (uninstalled) return;
    uninstalled = true;
    process.removeListener("SIGINT", onSigint);
  };

  return { uninstall };
}
