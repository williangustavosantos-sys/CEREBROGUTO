import type { DailyHook, DailyHookSource } from "./types";

// Dados brutos retornados pela OpenWeather (apenas o essencial)
export interface RawForecastData {
  list: Array<{
    dt: number;
    main: {
      temp: number;
      feels_like: number;
      temp_min: number;
      temp_max: number;
      humidity: number;
    };
    weather: Array<{
      id: number;
      main: string;
      description: string;
      icon: string;
    }>;
    wind: {
      speed: number;
      deg: number;
    };
    pop: number; // probability of precipitation (0..1)
  }>;
  city: {
    name: string;
    country: string;
    timezone: number;
  };
}

export interface WeatherInput {
  lat: number;
  lon: number;
  units?: "metric" | "imperial";
}

/**
 * Busca previsão do tempo na OpenWeather.
 * Retorna null em caso de erro (rede, API key inválida, etc.) sem quebrar o app.
 */
export async function fetchWeatherForecast(
  input: WeatherInput
): Promise<RawForecastData | null> {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) {
    console.warn("[GUTO][daily-briefing] OPENWEATHER_API_KEY not set, skipping weather");
    return null;
  }

  const units = input.units ?? "metric";
  const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${input.lat}&lon=${input.lon}&units=${units}&appid=${apiKey}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[GUTO][daily-briefing] OpenWeather returned ${response.status}`);
      return null;
    }

    const data: RawForecastData = await response.json();
    if (!data.list || data.list.length === 0) {
      console.warn("[GUTO][daily-briefing] OpenWeather returned empty forecast list");
      return null;
    }

    return data;
  } catch (error) {
    console.warn("[GUTO][daily-briefing] OpenWeather fetch failed:", error);
    return null;
  }
}
