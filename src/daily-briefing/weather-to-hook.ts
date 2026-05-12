import type { DailyHook, ActionImpact, DailyHookCategory } from "./types";
import type { RawForecastData } from "./weather-collector";

export interface UserWeatherContext {
  trainingLocation?: string | null;
  preferredWorkoutTime?: string | null;
  city?: string | null;
  country?: string | null;
}

function generateId(userId: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `wth_${userId.slice(0, 6)}_${ts}_${rand}`;
}

function isSevereRain(description: string, pop: number): boolean {
  const keywords = ["thunderstorm", "heavy rain", "rain heavy", "torrential", "storm"];
  const matchesKeyword = keywords.some((k) => description.toLowerCase().includes(k));
  return matchesKeyword || (pop >= 0.7 && description.toLowerCase().includes("rain"));
}

function isExtremeHeat(temp: number, feelsLike: number): boolean {
  const effective = Math.max(temp, feelsLike);
  return effective >= 32;
}

function isExtremeCold(temp: number, feelsLike: number): boolean {
  const effective = Math.min(temp, feelsLike);
  return effective <= 3;
}

/**
 * Converte dados brutos do clima em DailyHook[].
 * Só gera hook se impactar a ação do usuário.
 */
export function weatherToDailyHooks(
  userId: string,
  weatherData: RawForecastData,
  userContext: UserWeatherContext
): DailyHook[] {
  const hooks: DailyHook[] = [];

  // Usar o primeiro período da previsão (próximas 3 horas)
  const first = weatherData.list[0];
  if (!first) return [];

  const temp = first.main.temp;
  const feelsLike = first.main.feels_like;
  const description = first.weather[0]?.description ?? "";
  const pop = first.pop ?? 0;
  const windSpeed = first.wind?.speed ?? 0;

  const trainingLocation = (userContext.trainingLocation ?? "").toLowerCase();
  const isOutdoor =
    trainingLocation.includes("park") ||
    trainingLocation.includes("outdoor") ||
    trainingLocation.includes("running") ||
    trainingLocation.includes("street") ||
    trainingLocation.includes("pista") ||
    trainingLocation.includes("quadra") ||
    trainingLocation.includes("rua");

  const nowISO = new Date().toISOString();

  // Helper para criar hook
  function createHook(
    actionImpact: ActionImpact,
    changesAction: boolean,
    title: string,
    content: string
  ): DailyHook {
    return {
      id: generateId(userId),
      userId,
      category: "weather",
      title,
      content,
      actionImpact,
      changesAction,
      source: "weather_api",
      createdAt: nowISO,
      peakUntil: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(), // 6h
      staleAfter: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h
      usedAt: null,
      cooldownUntil: null,
      meta: {
        temp,
        feelsLike,
        description,
        pop,
        windSpeed,
      },
    };
  }

  // Regras de produto

  // 1. Chuva severa + treino ao ar livre => high impact
  if (isSevereRain(description, pop) && isOutdoor) {
    hooks.push(
      createHook(
        "high",
        true,
        "Chuva forte para hoje",
        `Previsão de ${description} com ${Math.round(pop * 100)}% de chance. Se treina ao ar livre, melhor adaptar para casa ou academia.`
      )
    );
  }

  // 2. Calor extremo (>= 32°C) + qualquer treino => medium/high
  if (isExtremeHeat(temp, feelsLike)) {
    const impact: ActionImpact = temp >= 38 ? "high" : "medium";
    hooks.push(
      createHook(
        impact,
        true,
        "Calor extremo hoje",
        `Temperatura pode chegar a ${Math.round(temp)}°C (sensação ${Math.round(feelsLike)}°C). Reduza intensidade, hidrate-se bem e evite horários de pico.`
      )
    );
  }

  // 3. Frio extremo (<= 3°C) + outdoor => medium
  if (isExtremeCold(temp, feelsLike) && isOutdoor) {
    hooks.push(
      createHook(
        "medium",
        true,
        "Frio intenso hoje",
        `Mínima de ${Math.round(temp)}°C (sensação ${Math.round(feelsLike)}°C). Se for treinar fora, alongue bem e proteja as articulações.`
      )
    );
  }

  // 4. Vento forte (> 30 km/h ~ 8.33 m/s) + outdoor => medium
  if (windSpeed > 8.33 && isOutdoor) {
    hooks.push(
      createHook(
        "medium",
        true,
        "Vento forte hoje",
        `Ventos de ${Math.round(windSpeed * 3.6)} km/h podem atrapalhar corrida/ciclismo. Prefira treino indoor ou reduza velocidade.`
      )
    );
  }

  // Se nenhum hook foi gerado, retorna array vazio
  return hooks;
}
