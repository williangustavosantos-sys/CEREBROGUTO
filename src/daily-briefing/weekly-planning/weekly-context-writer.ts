import { addContextItem } from "../../presence/context-bank";
import { ExtractedSignal } from "../../presence/types";

export async function writeWeeklySignalsToContextBank(
  userId: string,
  signals: ExtractedSignal[],
  now: string
): Promise<void> {
  const d = new Date(now);
  // Weekly items usually expire at the end of the current week (Sunday night)
  const day = d.getUTCDay() || 7;
  const daysUntilSunday = 7 - day;
  d.setUTCDate(d.getUTCDate() + daysUntilSunday);
  d.setUTCHours(23, 59, 59, 999);
  const expiresAt = d.toISOString();

  // 1. Mark that we received the weekly planning so we don't ask again
  //    This marker expires at end of week so we can ask again next week
  await addContextItem(userId, {
    type: "routine_signal",
    value: "weekly planning completed",
    state: "active",
    confidence: 1.0,
    source: "extractor",
    rawPhrase: "system_generated",
    meta: {
      originalType: "routine_signal",
      language: "mixed",
      dateText: null,
      bodyPart: null,
      needsUserValidation: false,
      extractor: "weekly-probe",
      kind: "weekly_plan_completed"
    },
    expiresAt,
  });

  // 2. Save all the extracted signals
  for (const signal of signals) {
    let kind = "routine";
    if (signal.type === "future_event") {
      kind = signal.raw_phrase.toLowerCase().includes("viaj") || 
             signal.raw_phrase.toLowerCase().includes("travel") ? "travel" : "busy_day";
    }

    // Future events (travel, busy days) get a longer lifespan — 14 days default
    // They should NOT expire at end of week so GUTO can remember them next week
    const isFutureEvent = signal.type === "future_event";
    let itemExpiresAt: string | undefined;
    if (isFutureEvent) {
      const longLived = new Date(now);
      longLived.setUTCDate(longLived.getUTCDate() + 14);
      longLived.setUTCHours(23, 59, 59, 999);
      itemExpiresAt = longLived.toISOString();
    } else {
      itemExpiresAt = expiresAt;
    }

    await addContextItem(userId, {
      type: signal.type === "future_event" ? "future_event" : "routine_signal",
      value: signal.value,
      state: "active",
      confidence: signal.confidence,
      source: "extractor",
      rawPhrase: signal.raw_phrase,
      meta: {
        originalType: signal.type,
        language: signal.language_detected,
        dateText: signal.date_text ?? null,
        bodyPart: signal.body_part ?? null,
        needsUserValidation: signal.needs_user_validation,
        extractor: "weekly-extractor",
        kind,
        destinationCity: signal.meta?.destinationCity ?? null,
        travelStartDate: signal.meta?.travelStartDate ?? signal.date_text ?? null,
        affectsTraining: true,
      },
      expiresAt: itemExpiresAt,
    });
  }
}
