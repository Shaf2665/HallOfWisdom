import path from "node:path";

const WINDOWS_DRIVE_OR_UNC_PATH = /^[A-Za-z]:|^\\\\/u;

export function parseHermesRelativeFilePath(rawPath: string): string | undefined {
  if (
    rawPath.length === 0 ||
    rawPath.length > 1024 ||
    rawPath.includes("\0") ||
    path.posix.isAbsolute(rawPath) ||
    path.win32.isAbsolute(rawPath) ||
    WINDOWS_DRIVE_OR_UNC_PATH.test(rawPath)
  ) {
    return undefined;
  }

  const segments = rawPath.split(/[\\/]/u);
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.toLowerCase() === ".git",
    )
  ) {
    return undefined;
  }
  return segments.join("/");
}
