import { clearExpiredDailyHooks, addDailyHook } from "../hook-store";
import { fetchWeatherForecast } from "../weather/weather-collector";
import { weatherToDailyHooks, UserWeatherContext } from "../weather/weather-to-hook";
import { travelWeatherToDailyHook, TravelContext } from "../weather/travel-weather-to-hook";
import { fetchHolidays } from "../holidays/holiday-collector";
import { holidayToDailyHook } from "../holidays/holiday-to-hook";
import { shouldAskWeeklyPlanning, buildWeeklyPlanningHook } from "../weekly-planning/weekly-probe";
import { getUserContextBank } from "../../presence/context-bank";
import { readMemoryStoreAsync } from "../../memory-store";
import { config } from "../../config";
import { loadHealthProfile, buildHealthProtectionHook, buildDietAwarenessHook } from "../health-to-hook";

export interface BriefingJobResult {
  created: number;
  skipped: number;
}

export async function runDailyBriefingForUser(userId: string, now: string): Promise<BriefingJobResult> {
  let created = 0;

  // 1. Limpa hooks expirados
  await clearExpiredDailyHooks(userId, now);

  const memoryStore = await readMemoryStoreAsync();
  const memory = memoryStore[userId] as Record<string, any>;
  if (!memory) return { created: 0, skipped: 1 };

  // 2. Verifica Weekly Planning
  const shouldAsk = await shouldAskWeeklyPlanning(userId, now);
  if (shouldAsk) {
    const hook = await buildWeeklyPlanningHook(userId, now);
    await addDailyHook(userId, hook);
    created++;
  }

  // Obter Context Bank ativo para viagem
  const bank = await getUserContextBank(userId);
  const activeTravels = bank.filter(i => 
    i.state === "active" && 
    (i.meta.kind === "travel" || (i.type === "future_event" && i.meta.destinationCity))
  );

  // Se não tem coordenadas base, pula clima atual e feriado (precisa de cidade/país na real)
  if (memory.lat && memory.lon) {
    // 3. Busca clima atual
    const weatherData = await fetchWeatherForecast({ lat: memory.lat, lon: memory.lon });
    if (weatherData) {
      const userContext: UserWeatherContext = {
        trainingLocation: memory.trainingLocation as string | undefined,
        city: memory.city as string | undefined,
        country: memory.country as string | undefined,
        likesOutdoor: memory.likesOutdoor as boolean | undefined,
      };

      const weatherHooks = weatherToDailyHooks(userId, weatherData, userContext, now);
      for (const hook of weatherHooks) {
        await addDailyHook(userId, hook);
        created++;
      }
    }
  }

  // 4. Busca clima de viagem
  for (const travel of activeTravels) {
    const destCity = travel.meta.destinationCity as string | undefined;
    const startDate = travel.meta.travelStartDate as string | undefined;
    
    if (destCity && startDate) {
      const travelData = await fetchWeatherForecast({ q: destCity });
      if (travelData) {
        const tCtx: TravelContext = {
          destinationCity: destCity,
          travelStartDate: startDate,
        };
        const hook = travelWeatherToDailyHook(userId, travelData, tCtx, now);
        if (hook) {
          await addDailyHook(userId, hook);
          created++;
        }
      }
    }
  }

  // 5. Busca feriados
  // Use user's country code if available. Default to BR or omit.
  const countryCode = memory.country ?? "BR";
  const year = new Date(now).getFullYear();
  const holidays = await fetchHolidays(year, countryCode as string);
  if (holidays.length > 0) {
    const holidayHook = holidayToDailyHook(userId, holidays, now);
    if (holidayHook) {
      await addDailyHook(userId, holidayHook);
      created++;
    }
  }

  // 6. Hooks proativos de saúde e dieta (semânticos, sem palavras-chave)
  const healthProfile = await loadHealthProfile(userId);
  
  // Health protection hook (patologia) — só gera se tiver limitação ativa
  const healthHook = buildHealthProtectionHook(userId, healthProfile, now);
  if (healthHook) {
    await addDailyHook(userId, healthHook);
    created++;
  }

  // Diet awareness hook (restrição alimentar) — só gera se tiver restrição ativa
  const dietHook = buildDietAwarenessHook(userId, healthProfile, now);
  if (dietHook) {
    await addDailyHook(userId, dietHook);
    created++;
  }

  return { created, skipped: 0 };
}

export async function runDailyBriefingForAllUsers(now: string = new Date().toISOString()): Promise<void> {
  if (!config.enableDailyBriefing) {
    console.log("[DailyBriefing] Disabled by ENABLE_DAILY_BRIEFING feature flag.");
    return;
  }

  const memoryStore = await readMemoryStoreAsync();
  const userIds = Object.keys(memoryStore);

  console.log(`[DailyBriefing] Starting job for ${userIds.length} users at ${now}`);

  let totalCreated = 0;
  let totalSkipped = 0;

  for (const userId of userIds) {
    try {
      const res = await runDailyBriefingForUser(userId, now);
      totalCreated += res.created;
      totalSkipped += res.skipped;
    } catch (error) {
      console.error(`[DailyBriefing] Failed for user ${userId}:`, error);
    }
  }

  console.log(`[DailyBriefing] Job finished. Hooks created: ${totalCreated}, Skipped users: ${totalSkipped}`);
}
