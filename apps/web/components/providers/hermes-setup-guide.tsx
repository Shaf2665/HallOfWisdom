import Link from "next/link";

export function HermesSetupGuide() {
  return (
    <section
      aria-label="Hermes Router setup guide"
      className="flex flex-col gap-3 rounded border border-stone-200 bg-stone-50 p-3 text-sm dark:border-stone-800 dark:bg-stone-950/40"
    >
      <p>
        Hall can save and verify your local Hermes Router setup for you. You do not need to set
        environment variables.
      </p>
      <Link
        href="/settings"
        className="self-start rounded bg-amber-100 px-3 py-1.5 font-medium text-amber-900 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-200 dark:hover:bg-amber-900/60"
      >
        Open Hermes settings
      </Link>
      <details className="text-xs text-stone-500 dark:text-stone-400">
        <summary className="cursor-pointer underline">Environment overrides</summary>
        <p className="mt-2">
          Existing HALL_HERMES_ROUTER_ROOT, HERMES_ROUTER_BASE_URL, HERMES_ROUTER_API_KEY, and
          HALL_HERMES_PYTHON values still override saved settings for advanced setups.
        </p>
      </details>
    </section>
  );
}
