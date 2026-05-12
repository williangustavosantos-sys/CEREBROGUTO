import test from "node:test";
import assert from "node:assert";
import { travelWeatherToDailyHook } from "../travel-weather-to-hook";
import type { RawForecastData } from "../weather-collector";

function makeForecast(overrides: Partial<RawForecastData> = {}): RawForecastData {
  return {
    list: [
      {
        dt: new Date("2026-05-13T12:00:00Z").getTime() / 1000,
        main: {
          temp: 20,
          feels_like: 19,
          temp_min: 18,
          temp_max: 22,
          humidity: 90,
        },
        weather: [{ id: 502, main: "Rain", description: "heavy intensity rain", icon: "10d" }],
        wind: { speed: 5, deg: 200 },
        pop: 0.9,
      },
    ],
    city: { name: "São Paulo", country: "BR", timezone: -10800 },
    ...overrides,
  };
}

test("Travel Weather Hooks", async (t) => {
  await t.test("returns null if travel is outside 5 day window", () => {
    const data = makeForecast();
    const hook = travelWeatherToDailyHook(
      "user1", 
      data, 
      { destinationCity: "São Paulo", travelStartDate: "2026-05-20" }, 
      "2026-05-11T10:00:00.000Z"
    );
    assert.strictEqual(hook, null);
  });

  await t.test("returns adapt_training hook if heavy rain at destination", () => {
    const data = makeForecast();
    const hook = travelWeatherToDailyHook(
      "user1", 
      data, 
      { destinationCity: "São Paulo", travelStartDate: "2026-05-13" }, 
      "2026-05-11T10:00:00.000Z"
    );
    assert.ok(hook);
    assert.strictEqual(hook?.objective, "adapt_training");
    assert.ok(hook?.content.includes("Previsão ruim em São Paulo"));
  });

  await t.test("returns use_good_weather if good weather at destination", () => {
    const data = makeForecast({
      list: [{
        dt: new Date("2026-05-13T12:00:00Z").getTime() / 1000,
        main: { temp: 25, feels_like: 25, temp_min: 22, temp_max: 28, humidity: 50 },
        weather: [{ id: 800, main: "Clear", description: "clear sky", icon: "01d" }],
        wind: { speed: 2, deg: 100 },
        pop: 0.1,
      }]
    });
    const hook = travelWeatherToDailyHook(
      "user1", 
      data, 
      { destinationCity: "São Paulo", travelStartDate: "2026-05-13" }, 
      "2026-05-11T10:00:00.000Z"
    );
    assert.ok(hook);
    assert.strictEqual(hook?.objective, "use_good_weather");
    assert.ok(hook?.content.includes("Tempo bom em São Paulo"));
  });

  await t.test("returns null if normal weather at destination", () => {
    const data = makeForecast({
      list: [{
        dt: new Date("2026-05-13T12:00:00Z").getTime() / 1000,
        main: { temp: 15, feels_like: 15, temp_min: 12, temp_max: 18, humidity: 50 },
        weather: [{ id: 801, main: "Clouds", description: "few clouds", icon: "02d" }],
        wind: { speed: 2, deg: 100 },
        pop: 0.1,
      }]
    });
    const hook = travelWeatherToDailyHook(
      "user1", 
      data, 
      { destinationCity: "São Paulo", travelStartDate: "2026-05-13" }, 
      "2026-05-11T10:00:00.000Z"
    );
    assert.strictEqual(hook, null);
  });
});
