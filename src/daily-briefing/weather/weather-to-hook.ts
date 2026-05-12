import { DailyHook, ActionImpact } from "../types";
import { RawForecastData } from "./weather-collector";

export interface UserWeatherContext {
  trainingLocation?: string | null;
  city?: string | null;
  country?: string | null;
  likesOutdoor?: boolean;
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

function isGoodWeather(description: string, pop: number, temp: number): boolean {
  return (
    description.toLowerCase().includes("clear") &&
    pop < 0.2 &&
    temp >= 18 &&
    temp <= 26
  );
}

export function weatherToDailyHooks(
  userId: string,
  weatherData: RawForecastData,
  userContext: UserWeatherContext,
  now: string
): DailyHook[] {
  const hooks: DailyHook[] = [];

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
    trainingLocation.includes("rua");

  const likesOutdoor = userContext.likesOutdoor === true || isOutdoor;

  function createHook(
    actionImpact: ActionImpact,
    objective: DailyHook["objective"],
    title: string,
    content: string,
    mustMention: string[],
    mustAvoid: string[]
  ): DailyHook {
    const d = new Date(now);
    d.setUTCHours(23, 59, 59, 999);
    const endOfDay = d.toISOString();

    return {
      id: generateId(userId),
      userId,
      category: "weather",
      title,
      content,
      actionImpact,
      objective,
      mustMention,
      mustAvoid,
      source: {
        type: "weather_api",
        checkedAt: now
      },
      createdAt: now,
      peakUntil: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      staleAfter: endOfDay,
      meta: {
        temp,
        feelsLike,
        description,
        pop,
        windSpeed,
      },
    };
  }

  // 1. Chuva severa + outdoor => adapt_training
  if (isSevereRain(description, pop) && isOutdoor) {
    hooks.push(
      createHook(
        "high",
        "adapt_training",
        "Chuva forte",
        "Previsão de chuva forte hoje que atrapalha treino externo.",
        ["chuva forte", "adaptar para indoor"],
        ["mandar treinar na chuva"]
      )
    );
    return hooks; // Return early, severe weather takes precedence
  }

  // 2. Calor extremo => protect_consistency
  if (isExtremeHeat(temp, feelsLike)) {
    hooks.push(
      createHook(
        temp >= 38 ? "critical" : "high",
        "protect_consistency",
        "Calor extremo",
        `Temperatura muito alta (sensação de ${Math.round(feelsLike)}°C).`,
        ["calor extremo", "hidratação", "reduzir intensidade"],
        ["ignorar o calor"]
      )
    );
    return hooks;
  }

  // 3. Frio extremo + outdoor => adapt_training
  if (isExtremeCold(temp, feelsLike) && isOutdoor) {
    hooks.push(
      createHook(
        "medium",
        "adapt_training",
        "Frio intenso",
        `Frio intenso (sensação de ${Math.round(feelsLike)}°C).`,
        ["frio intenso", "aquecimento reforçado"],
        ["ignorar o frio"]
      )
    );
    return hooks;
  }

  // 4. Vento forte + outdoor => adapt_training
  if (windSpeed > 8.33 && isOutdoor) {
    hooks.push(
      createHook(
        "medium",
        "adapt_training",
        "Vento forte",
        "Ventos fortes podem dificultar corrida ou pedal.",
        ["vento forte", "adaptar treino"],
        []
      )
    );
    return hooks;
  }

  // 5. Clima bom + gosta de outdoor => use_good_weather
  if (isGoodWeather(description, pop, temp) && likesOutdoor) {
    hooks.push(
      createHook(
        "low",
        "use_good_weather",
        "Clima perfeito",
        "Tempo abriu, perfeito para treinar fora.",
        ["tempo bom", "aproveitar para ir lá fora"],
        ["assumir que vai chover"]
      )
    );
    return hooks;
  }

  // Se for clima normal ou chuva leve sem impacto outdoor, não gera hook.
  return [];
}
