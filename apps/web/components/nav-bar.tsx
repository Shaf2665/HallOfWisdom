"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAttentionItems } from "../hooks/use-attention-items";
import { resolveHallCoreUrl } from "../lib/hall-core-url";
import { useHallAuth } from "./hall-auth-gate";

const { httpUrl: BASE_URL } = resolveHallCoreUrl();

/**
 * Feature 8 — the simplified primary nav. Every route this used to link
 * directly (`/board`, `/tasks`, `/ceo`, `/boards`, `/comparisons`,
 * `/agents`, `/providers`, `/system`) still exists and is still directly
 * reachable — by URL, and from within the Work/Team/Settings hub pages
 * these five entries lead to — nothing was deleted, only regrouped.
 * `isCurrent` matches by prefix (not exact) so, e.g., landing on `/board`
 * or `/ceo/abc` still highlights "Work" as the active section.
 */
const PRIMARY_LINKS = [
  { href: "/", label: "Home", prefixes: ["/"] },
  {
    href: "/work",
    label: "Work",
    prefixes: ["/work", "/board", "/tasks", "/ceo", "/boards", "/comparisons"],
  },
  { href: "/attention", label: "Attention", prefixes: ["/attention"] },
  { href: "/team", label: "Team", prefixes: ["/team", "/agents"] },
  { href: "/settings", label: "Settings", prefixes: ["/settings", "/providers", "/system"] },
] as const;

function isCurrentPath(pathname: string, link: (typeof PRIMARY_LINKS)[number]): boolean {
  if (link.href === "/") return pathname === "/";
  return link.prefixes.some((prefix) => pathname.startsWith(prefix));
}

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
  const { logout, loggingOut } = useHallAuth();

  return (
    <nav aria-label="Main" className="flex flex-wrap gap-1">
      {PRIMARY_LINKS.map((link) => {
        const isCurrent = isCurrentPath(pathname, link);
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
      <button
        type="button"
        disabled={loggingOut}
        onClick={() => {
          void logout();
        }}
        className="rounded px-3 py-1.5 text-sm font-medium text-stone-600 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-60 dark:text-stone-300 dark:hover:bg-stone-800"
      >
        {loggingOut ? "Signing out…" : "Logout"}
      </button>
    </nav>
  );
}
