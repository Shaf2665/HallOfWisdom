/** Case-insensitive environment variable lookup (Windows env var names are case-insensitive). */
export function getEnvValueCaseInsensitive(
  env: Readonly<NodeJS.ProcessEnv>,
  key: string,
): string | undefined {
  const lowerKey = key.toLowerCase();
  for (const [entryKey, entryValue] of Object.entries(env)) {
    if (entryKey.toLowerCase() === lowerKey) return entryValue;
  }
  return undefined;
}
