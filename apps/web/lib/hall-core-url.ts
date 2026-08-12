export class InvalidHallCoreUrlError extends Error {
  constructor(reason: string) {
    super(`NEXT_PUBLIC_HALL_CORE_URL is invalid: ${reason}`);
    this.name = "InvalidHallCoreUrlError";
  }
}

export interface HallCoreUrlConfig {
  /** Normalized `http(s)://host[:port]` base — no trailing slash, no path, query, fragment, or credentials. */
  readonly httpUrl: string;
  /** The same origin with `http` -> `ws` / `https` -> `wss`, for the WebSocket event stream. */
  readonly wsUrl: string;
}

export const DEFAULT_HALL_CORE_URL = "http://127.0.0.1:4310";

/**
 * Parses and validates the configured Hall Core base URL into a normalized
 * `{ httpUrl, wsUrl }` pair. Deliberately strict — this value seeds every
 * `fetch()` and WebSocket connection this app makes, so a malformed or
 * overly permissive value here would undermine every other safety check
 * built on top of it (see `lib/api-client.ts`, `hooks/use-task-events.ts`).
 *
 * Hall Core itself only ever binds to `127.0.0.1` (see
 * `docs/architecture/0004-hall-core-server.md`, "Local-only binding") — it is
 * never reachable directly from the network. A non-loopback
 * `NEXT_PUBLIC_HALL_CORE_URL` is still a supported value, though: it is how a
 * public HTTPS origin (e.g. a second Cloudflare Tunnel hostname that maps
 * internally back to `127.0.0.1:4310`) is configured for remote access — see
 * `docs/remote-access.md`. This function does not reject a non-loopback host
 * — only genuinely unsafe or malformed values are rejected.
 */
export function parseHallCoreUrl(raw: string): HallCoreUrlConfig {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidHallCoreUrlError(`"${raw}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidHallCoreUrlError(`protocol must be "http" or "https", got "${url.protocol}".`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new InvalidHallCoreUrlError("must not contain a username or password.");
  }
  if (url.hash !== "") {
    throw new InvalidHallCoreUrlError("must not contain a fragment.");
  }
  if (url.search !== "") {
    throw new InvalidHallCoreUrlError("must not contain a query string.");
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new InvalidHallCoreUrlError("must not contain a path.");
  }

  const httpUrl = url.origin;
  const wsUrl = url.protocol === "https:" ? `wss://${url.host}` : `ws://${url.host}`;
  return { httpUrl, wsUrl };
}

/**
 * Reads and validates `NEXT_PUBLIC_HALL_CORE_URL`, defaulting safely to
 * `DEFAULT_HALL_CORE_URL` when unset. Every `NEXT_PUBLIC_*` environment
 * variable is inlined into the client bundle at build time by Next.js —
 * this module must never be given anything secret to read.
 */
export function resolveHallCoreUrl(): HallCoreUrlConfig {
  const raw = process.env.NEXT_PUBLIC_HALL_CORE_URL;
  return parseHallCoreUrl(raw === undefined || raw === "" ? DEFAULT_HALL_CORE_URL : raw);
}
