"use client";

import Link from "next/link";
import { useAttentionItems } from "../hooks/use-attention-items";

/**
 * Feature 5 — reads the shared `useAttentionItems` derivation (durable
 * tasks/plans/runs only, no separate attention persistence). The nav count
 * and the Gateway overview card read the same hook, so all three can never
 * disagree about what needs a look.
 */
export function AttentionInbox({ baseUrl }: { readonly baseUrl: string }) {
  const items = useAttentionItems(baseUrl);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-stone-900 dark:text-stone-100">
          Needs your attention
        </h1>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
          Plans awaiting approval, blocked or failed work, and execution that needs your review.
        </p>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-stone-500 dark:text-stone-400">
          Nothing needs your attention right now.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-900/70 dark:bg-amber-950/20"
            >
              <div>
                <p className="font-semibold text-stone-900 dark:text-stone-100">{item.reason}</p>
                <p className="text-sm text-stone-600 dark:text-stone-300">
                  {item.projectLabel} · {item.taskLabel}
                </p>
                <p className="text-sm text-stone-600 dark:text-stone-300">
                  {item.recommendedAction}
                </p>
              </div>
              <Link
                href={item.href}
                className="rounded-lg bg-amber-700 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-800 dark:bg-amber-600 dark:hover:bg-amber-500"
              >
                Review
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
