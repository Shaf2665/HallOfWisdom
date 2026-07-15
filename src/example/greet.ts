/**
 * Sample module demonstrating the Phase 1 toolchain (strict TypeScript,
 * ESLint, Prettier, Vitest). Not part of the Hall of Wisdom architecture.
 */

export function createWelcomeMessage(agentName: string): string {
  const trimmedName = agentName.trim();
  if (trimmedName.length === 0) {
    throw new Error("agentName must not be empty");
  }
  return `Hall of Wisdom is ready to work with ${trimmedName}.`;
}
