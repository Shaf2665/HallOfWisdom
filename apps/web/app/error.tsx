"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  useEffect(() => {
    // Logged locally for the developer running this prototype; never
    // rendered to the page (no stack trace, no raw error object).
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-stone-600 dark:text-stone-300">
        Hall of Wisdom ran into an unexpected problem. This is usually recoverable — try again.
      </p>
      <button
        type="button"
        onClick={reset}
        className="rounded bg-amber-700 px-4 py-2 text-sm font-medium text-white hover:bg-amber-800 dark:bg-amber-600 dark:hover:bg-amber-700"
      >
        Try again
      </button>
    </div>
  );
}
