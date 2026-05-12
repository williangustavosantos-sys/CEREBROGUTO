import { getUserContextBank } from "../../presence/context-bank";
import { DailyHook } from "../types";

export async function shouldAskWeeklyPlanning(userId: string, now: string): Promise<boolean> {
  const bank = await getUserContextBank(userId);
  
  // Find start of the current week (Monday)
  const d = new Date(now);
  const day = d.getUTCDay() || 7; // 1-7
  d.setUTCDate(d.getUTCDate() - day + 1);
  d.setUTCHours(0, 0, 0, 0);
  const startOfWeek = d.toISOString();

  // Check if we already have a weekly plan marker for this week
  const hasAnswered = bank.some(
    (item) => 
      item.type === "routine_signal" && 
      item.meta.kind === "weekly_plan_completed" &&
      item.createdAt >= startOfWeek
  );

  return !hasAnswered;
}

/**
 * Find pending future events (travel, busy days) that were mentioned in previous weeks
 * but haven't been resolved yet. These are events with kind "travel" or "busy_day"
 * that are still active and whose date hasn't passed.
 */
export async function findPendingFutureEvents(
  userId: string,
  now: string
): Promise<Array<{ kind: string; value: string; destinationCity?: string; dateText?: string }>> {
  const bank = await getUserContextBank(userId);
  const nowDate = new Date(now);

  return bank
    .filter(item => {
      if (item.state !== "active") return false;
      if (item.type !== "future_event") return false;
      const kind = item.meta.kind;
      if (kind !== "travel" && kind !== "busy_day") return false;
      
      // If it has a date, check if it's still in the future or recent past (last 2 days)
      if (item.meta.dateText) {
        const eventDate = new Date(item.meta.dateText);
        const diffDays = (eventDate.getTime() - nowDate.getTime()) / (1000 * 60 * 60 * 24);
        // Only consider events from up to 2 days ago (recent) to 7 days in future
        if (diffDays < -2 || diffDays > 7) return false;
      }

      return true;
    })
    .map(item => ({
      kind: item.meta.kind as string,
      value: item.value,
      destinationCity: item.meta.destinationCity as string | undefined,
      dateText: item.meta.dateText as string | undefined,
    }));
}

export async function buildWeeklyPlanningHook(userId: string, now: string): Promise<DailyHook> {
  // Hook expires at the end of the current day so we can re-evaluate or just keep trying until answered
  const d = new Date(now);
  d.setUTCHours(23, 59, 59, 999);
  const endOfDay = d.toISOString();

  // Check if there are pending future events from previous weeks
  const pendingEvents = await findPendingFutureEvents(userId, now);
  const pendingTravel = pendingEvents.find(e => e.kind === "travel");

  let content: string;
  let mustMention: string[];
  let mustAvoid: string[];

  if (pendingTravel) {
    // Smart hook: GUTO remembers the pending travel and asks about it
    const dest = pendingTravel.destinationCity || "esse destino";
    content = `Você mencionou uma viagem para ${dest} recentemente. Vai rolar essa semana? Como organizamos a rotina?`;
    mustMention = [`confirmar viagem para ${dest}`, "perguntar sobre a semana", "organizar rotina"];
    mustAvoid = ["assumir que a viagem foi cancelada", "assumir que a semana é normal"];
  } else if (pendingEvents.length > 0) {
    // There are other pending events (busy days)
    const events = pendingEvents.map(e => e.value).join(", ");
    content = `Você mencionou alguns compromissos: ${events}. Eles vão rolar essa semana? Como fica nosso plano?`;
    mustMention = ["confirmar compromissos", "perguntar sobre a semana", "organizar rotina"];
    mustAvoid = ["assumir que a semana é normal"];
  } else {
    // Standard weekly probe
    content = "Antes da gente sair atropelando a semana: como ela vem? Viagem, compromisso pesado, dia sem treino ou rotina normal?";
    mustMention = ["perguntar sobre a semana", "viagem", "compromissos"];
    mustAvoid = ["assumir que a semana é normal"];
  }

  return {
    id: `hook_weekly_plan_${userId}_${now.slice(0, 10)}`,
    userId,
    category: "weekly_plan",
    title: "Weekly Planning",
    content,
    actionImpact: "critical",
    objective: "plan_week",
    mustMention,
    mustAvoid,
    source: {
      type: "user_weekly_probe",
      checkedAt: now
    },
    createdAt: now,
    peakUntil: endOfDay,
    staleAfter: endOfDay,
    meta: {
      pendingEvents: pendingEvents.length > 0 ? pendingEvents : undefined
    }
  };
}
