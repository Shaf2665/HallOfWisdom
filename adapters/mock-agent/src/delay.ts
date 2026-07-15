/**
 * Resolves after `ms` milliseconds, or immediately if `signal` aborts
 * first — whichever happens first. Cleans up its timer and listener in
 * every exit path so neither a pending `setTimeout` nor an `abort`
 * listener can outlive the promise it belongs to, regardless of which
 * path wins the race.
 */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
