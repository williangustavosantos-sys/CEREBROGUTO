/**
 * Pure utility functions extracted from server.ts.
 * No side effects — safe to import in tests without starting the server.
 */

export const PLACEHOLDER_NAMES = new Set(["Operador", "operador", "operator", "Operator"]);

/**
 * Returns the trimmed name if it is not a placeholder, or an empty string otherwise.
 */
export function sanitizeDisplayName(name: string): string {
  const raw = name?.trim() ?? "";
  return PLACEHOLDER_NAMES.has(raw) ? "" : raw;
}
