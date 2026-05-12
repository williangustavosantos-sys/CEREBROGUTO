import { extractSignals } from "../../presence/signal-extractor";
import { ExtractedSignal } from "../../presence/types";

export async function extractWeeklyPlanningSignals(userMessage: string): Promise<ExtractedSignal[]> {
  const result = await extractSignals(userMessage);
  
  // We care mainly about routine_signal and future_event for weekly planning
  return result.signals.filter(
    (s) => s.type === "routine_signal" || s.type === "future_event"
  );
}
