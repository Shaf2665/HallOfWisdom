/**
 * Client-side working-directory validation helpers, shared by
 * `TaskCreateForm` (immediate tasks) and the Kanban assignment dialog
 * (deferred-task agent assignment). Hall Core remains the final authority
 * — this exists only to catch the obvious cases before a request round-trip.
 */

function isWindowsDriveAbsolute(value: string): boolean {
  const second = value[1];
  const third = value[2];
  return /^[a-zA-Z]$/.test(value[0] ?? "") && second === ":" && (third === "\\" || third === "/");
}

export function isAbsolutePathLike(value: string): boolean {
  // POSIX absolute path, Windows drive-letter absolute path, or a UNC path.
  return value.startsWith("/") || isWindowsDriveAbsolute(value) || value.startsWith("\\\\");
}
