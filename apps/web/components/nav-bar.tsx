"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAttentionItems } from "../hooks/use-attention-items";
import { resolveHallCoreUrl } from "../lib/hall-core-url";

const { httpUrl: BASE_URL } = resolveHallCoreUrl();

const LINKS = [
  { href: "/", label: "Wisdom Gateway" },
  { href: "/tasks", label: "Task Console" },
  { href: "/board", label: "Kanban Board" },
  { href: "/boards", label: "Communication Boards" },
  { href: "/agents", label: "Agents" },
  { href: "/providers", label: "Providers" },
  { href: "/comparisons", label: "Comparisons" },
  { href: "/ceo", label: "CEO Plans" },
  { href: "/attention", label: "Attention" },
  { href: "/system", label: "System" },
] as const;

/**
 * Plain `next/link` navigation — no full page reload between routes. The
 * only reason this is a Client Component (unlike
 * `ApplicationShell`, which stays server-rendered): `usePathname()` is
 * needed to mark the current page for both sighted users (visual
 * emphasis) and assistive technology (`aria-current="page"`), and that
 * hook only works client-side.
 */
export function NavBar() {
  const pathname = usePathname();
  const attentionItems = useAttentionItems(BASE_URL);

  return (
    <nav aria-label="Main" className="flex flex-wrap gap-1">
      {LINKS.map((link) => {
        const isCurrent = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={isCurrent ? "page" : undefined}
            className={`rounded px-3 py-1.5 text-sm font-medium ${
              isCurrent
                ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
                : "text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"
            }`}
          >
            {link.label}
            {link.href === "/attention" && attentionItems.length > 0 ? (
              <span className="ml-1.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-amber-700 px-1.5 py-0.5 text-xs font-semibold text-white dark:bg-amber-600">
                {attentionItems.length}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
