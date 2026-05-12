import { getActiveDailyHooks } from "./hook-store";
import { shouldUseHook } from "./relevance-gate";
import type { DailyHook } from "./types";

export async function selectBestHook(
  userId: string,
  now: string = new Date().toISOString()
): Promise<DailyHook | null> {
  const active = await getActiveDailyHooks(userId, now);

  // Filter candidates where gate allows speak
  const candidates: DailyHook[] = [];
  for (const hook of active) {
    const decision = shouldUseHook(hook, { now });
    if (decision === "speak") {
      candidates.push(hook);
    }
  }

  if (candidates.length === 0) return null;

  // Sort by priority:
  // 1. actionImpact high > medium
  // 2. peakUntil closest (ascending -> nearer expiry)
  // 3. createdAt most recent
  candidates.sort((a, b) => {
    const impactOrder = (imp: string) => (imp === "high" ? 0 : imp === "medium" ? 1 : 2);
    const diffImpact = impactOrder(a.actionImpact) - impactOrder(b.actionImpact);
    if (diffImpact !== 0) return diffImpact;

    const peakA = a.peakUntil ? new Date(a.peakUntil).getTime() : 0;
    const peakB = b.peakUntil ? new Date(b.peakUntil).getTime() : 0;
    const diffPeak = peakA - peakB;
    if (diffPeak !== 0) return diffPeak;

    const createdAtA = new Date(a.createdAt).getTime();
    const createdAtB = new Date(b.createdAt).getTime();
    return createdAtB - createdAtA; // newer first
  });

  return candidates[0] ?? null;
}
