import { clearExpiredDailyHooks, addDailyHook } from "./hook-store";
import { fetchWeatherForecast } from "./weather-collector";
import { weatherToDailyHooks } from "./weather-to-hook";
import { readMemoryStoreAsync } from "../memory-store";

export interface BriefingJobResult {
  created: number;
  skipped: number;
}

export async function runDailyBriefingForUser(userId: string): Promise<BriefingJobResult> {
  // Limpa hooks vencidos antes de rodar
  clearExpiredDailyHooks(userId);

  const memoryStore = await readMemoryStoreAsync();
  const memory = memoryStore[userId] as Record<string, any>;

  // Se não tem dados mínimos, skip
  if (!memory || !memory.lat || !memory.lon) {
    return { created: 0, skipped: 1 };
  }

  const lat = memory.lat as number;
  const lon = memory.lon as number;
  const trainingLocation = (memory.trainingLocation as string | undefined) ?? "gym";
  
  const weatherData = await fetchWeatherForecast({ lat, lon });
  
  if (!weatherData) {
    return { created: 0, skipped: 1 };
  }

  const userContext = {
    trainingLocation,
    city: memory.city as string | undefined,
    country: memory.country as string | undefined,
    preferredWorkoutTime: memory.preferredWorkoutTime as string | undefined,
  };

  const hooks = weatherToDailyHooks(userId, weatherData, userContext);

  for (const hook of hooks) {
    addDailyHook(userId, hook);
  }

  return { created: hooks.length, skipped: 0 };
}
