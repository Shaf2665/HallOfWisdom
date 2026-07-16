export class InvalidWebOriginError extends Error {
  constructor(reason: string) {
    super(`--web-origin is invalid: ${reason}`);
    this.name = "InvalidWebOriginError";
  }
}

/**
 * Parses and validates a `--web-origin` CLI value into a normalized,
 * exact origin string (`protocol://host[:port]`, no trailing slash, no
 * path/query/fragment/credentials) suitable for both the HTTP CORS
 * allowlist and WebSocket `Origin` header comparison. Deliberately strict
 * — this value becomes the single entry in an exact-match allowlist, so a
 * malformed or overly permissive value here would weaken every other
 * check built on top of it.
 */
export function parseWebOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidWebOriginError(`"${raw}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidWebOriginError(`protocol must be "http" or "https", got "${url.protocol}".`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new InvalidWebOriginError("must not contain a username or password.");
  }
  if (url.hash !== "") {
    throw new InvalidWebOriginError("must not contain a fragment.");
  }
  if (url.search !== "") {
    throw new InvalidWebOriginError("must not contain a query string.");
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new InvalidWebOriginError("must not contain a path.");
  }
  return url.origin;
}
