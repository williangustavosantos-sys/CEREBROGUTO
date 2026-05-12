import { DailyHook, ActionImpact } from "../types";
import { Holiday } from "./holiday-collector";

function generateId(userId: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `hol_${userId.slice(0, 6)}_${ts}_${rand}`;
}

export function holidayToDailyHook(
  userId: string,
  holidays: Holiday[],
  now: string
): DailyHook | null {
  const nowTs = new Date(now).getTime();
  
  // Look for a holiday in the next 1 to 5 days
  // We do not warn if the holiday is today (0 days) or already passed
  
  const upcomingHolidays = holidays.filter((h) => {
    const hTs = new Date(h.date + "T12:00:00Z").getTime();
    const diffDays = (hTs - nowTs) / (1000 * 60 * 60 * 24);
    return diffDays >= 0.5 && diffDays <= 5.5; // Roughly between tomorrow and 5 days from now
  });

  if (upcomingHolidays.length === 0) {
    return null;
  }

  // Pick the closest upcoming holiday
  const holiday = upcomingHolidays.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())[0];
  
  const d = new Date(now);
  d.setUTCHours(23, 59, 59, 999);
  const endOfDay = d.toISOString();

  // If it's 1-3 days away, impact is medium. If 4-5 days, impact is low.
  const hTs = new Date(holiday.date + "T12:00:00Z").getTime();
  const diffDays = (hTs - nowTs) / (1000 * 60 * 60 * 24);
  const actionImpact: ActionImpact = diffDays <= 3.5 ? "medium" : "low";

  return {
    id: generateId(userId),
    userId,
    category: "holiday",
    title: "Feriado se aproximando",
    content: `O feriado de ${holiday.localName} cai no dia ${holiday.date}. Vamos organizar os treinos para não furar.`,
    actionImpact,
    objective: "prepare_holiday",
    mustMention: ["feriado", holiday.localName, "antecipar ou ajustar treino"],
    mustAvoid: ["falar como se fosse hoje", "ignorar o impacto na rotina"],
    source: {
      type: "holiday_api",
      checkedAt: now
    },
    createdAt: now,
    peakUntil: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    staleAfter: endOfDay,
    meta: {
      holidayName: holiday.localName,
      holidayDate: holiday.date
    }
  };
}
