import { DailyHook, ActionImpact } from "../types";
import { RawForecastData } from "./weather-collector";

export interface TravelContext {
  destinationCity: string;
  travelStartDate: string; // YYYY-MM-DD
  travelEndDate?: string | null;
}

function generateId(userId: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `twh_${userId.slice(0, 6)}_${ts}_${rand}`;
}

function isSevereRain(description: string, pop: number): boolean {
  const keywords = ["thunderstorm", "heavy rain", "rain heavy", "torrential", "storm"];
  const matchesKeyword = keywords.some((k) => description.toLowerCase().includes(k));
  return matchesKeyword || (pop >= 0.7 && description.toLowerCase().includes("rain"));
}

function isGoodWeather(description: string, pop: number, temp: number): boolean {
  return (
    description.toLowerCase().includes("clear") &&
    pop < 0.2 &&
    temp >= 18 &&
    temp <= 26
  );
}

export function travelWeatherToDailyHook(
  userId: string,
  weatherData: RawForecastData,
  travel: TravelContext,
  now: string
): DailyHook | null {
  // We need to find the forecast closest to the travel start date.
  // The free OpenWeather forecast only goes up to 5 days (120 hours) with 3h intervals.
  
  const startTs = new Date(travel.travelStartDate).getTime();
  const nowTs = new Date(now).getTime();
  
  // If travel is more than 5 days away, we don't have accurate free forecast
  if (startTs - nowTs > 5 * 24 * 60 * 60 * 1000) {
    return null;
  }

  // Find the forecast item that matches the travel date (or the closest one to noon on that day)
  const targetDateStr = travel.travelStartDate.slice(0, 10);
  const relevantForecasts = weatherData.list.filter(f => {
    // f.dt is in seconds.
    const fDateStr = new Date(f.dt * 1000).toISOString().slice(0, 10);
    return fDateStr === targetDateStr;
  });

  if (relevantForecasts.length === 0) {
    return null;
  }

  // Pick the one closest to 12:00 UTC (middle of the day)
  const midDayForecast = relevantForecasts.reduce((prev, curr) => {
    const prevHour = new Date(prev.dt * 1000).getUTCHours();
    const currHour = new Date(curr.dt * 1000).getUTCHours();
    return Math.abs(currHour - 12) < Math.abs(prevHour - 12) ? curr : prev;
  });

  const temp = midDayForecast.main.temp;
  const description = midDayForecast.weather[0]?.description ?? "";
  const pop = midDayForecast.pop ?? 0;

  const d = new Date(now);
  d.setUTCHours(23, 59, 59, 999);
  const endOfDay = d.toISOString();

  function createHook(
    actionImpact: ActionImpact,
    objective: DailyHook["objective"],
    title: string,
    content: string,
    mustMention: string[]
  ): DailyHook {
    return {
      id: generateId(userId),
      userId,
      category: "travel_weather",
      title,
      content,
      actionImpact,
      objective,
      mustMention,
      mustAvoid: ["assumir que a viagem foi cancelada"],
      source: {
        type: "weather_api",
        checkedAt: now
      },
      createdAt: now,
      peakUntil: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
      staleAfter: endOfDay,
      meta: {
        destinationCity: travel.destinationCity,
        travelStartDate: travel.travelStartDate,
        temp,
        description,
        pop,
      },
    };
  }

  if (isSevereRain(description, pop)) {
    return createHook(
      "high",
      "adapt_training",
      "Chuva no destino",
      `Previsão ruim em ${travel.destinationCity} no dia da viagem. Garanta o treino principal antes de ir.`,
      ["viagem", travel.destinationCity, "antecipar treino forte", "chuva no destino"]
    );
  }

  if (isGoodWeather(description, pop, temp)) {
    return createHook(
      "medium",
      "use_good_weather",
      "Tempo bom no destino",
      `Tempo bom em ${travel.destinationCity}. Pode deixar para treinar lá ao ar livre se der tempo.`,
      ["viagem", travel.destinationCity, "tempo bom", "treino lá fora"]
    );
  }

  return null;
}
