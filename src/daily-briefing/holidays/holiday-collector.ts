import { config } from "../../config";

export interface Holiday {
  date: string; // YYYY-MM-DD
  localName: string;
  name: string;
  countryCode: string;
  global: boolean;
  types: string[]; // e.g. ["Public"]
}

export async function fetchHolidays(year: number, countryCode: string): Promise<Holiday[]> {
  // Using Nager.Date API as suggested (it's free and doesn't require an API key for public endpoints, but we have a config key just in case we switch)
  // Example: https://date.nager.at/api/v3/PublicHolidays/2026/BR
  const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[GUTO][daily-briefing] Nager.Date returned ${response.status}`);
      return [];
    }

    const data: Holiday[] = await response.json();
    return data;
  } catch (error) {
    console.warn("[GUTO][daily-briefing] Holiday fetch failed:", error);
    return [];
  }
}
