import { describe, it } from "node:test";
import assert from "node:assert";
import { weatherToDailyHooks } from "../weather-to-hook";
import type { RawForecastData } from "../weather-collector";

function makeForecast(overrides: Partial<RawForecastData> = {}): RawForecastData {
  return {
    list: [
      {
        dt: 1672531200,
        main: {
          temp: 25,
          feels_like: 24,
          temp_min: 20,
          temp_max: 28,
          humidity: 60,
        },
        weather: [{ id: 800, main: "Clear", description: "clear sky", icon: "01d" }],
        wind: { speed: 3, deg: 180 },
        pop: 0.1,
      },
    ],
    city: { name: "Milan", country: "IT", timezone: 3600 },
    ...overrides,
  };
}

describe("weatherToDailyHooks", () => {
  it("returns empty array for normal weather and any location", () => {
    const data = makeForecast();
    const hooks = weatherToDailyHooks("user1", data, { trainingLocation: "park" });
    assert.strictEqual(hooks.length, 0);
  });

  it("returns high impact hook when severe rain + outdoor", () => {
    const data = makeForecast({
      list: [
        {
          dt: 1672531200,
          main: { temp: 20, feels_like: 19, temp_min: 18, temp_max: 22, humidity: 90 },
          weather: [{ id: 502, main: "Rain", description: "heavy intensity rain", icon: "10d" }],
          wind: { speed: 5, deg: 200 },
          pop: 0.9,
        },
      ],
    });
    const hooks = weatherToDailyHooks("user1", data, { trainingLocation: "park" });
    assert.strictEqual(hooks.length, 1);
    assert.strictEqual(hooks[0].actionImpact, "high");
    assert.strictEqual(hooks[0].changesAction, true);
  });

  it("returns hook for extreme heat", () => {
    const data = makeForecast({
      list: [
        {
          dt: 1672531200,
          main: { temp: 35, feels_like: 38, temp_min: 30, temp_max: 38, humidity: 40 },
          weather: [{ id: 800, main: "Clear", description: "clear sky", icon: "01d" }],
          wind: { speed: 2, deg: 90 },
          pop: 0,
        },
      ],
    });
    const hooks = weatherToDailyHooks("user1", data, { trainingLocation: "home" });
    assert.strictEqual(hooks.length, 1);
    assert.strictEqual(hooks[0].actionImpact, "high");
    assert.ok(hooks[0].content.includes("38°C"));
  });

  it("returns nothing for extreme cold when indoor", () => {
    const data = makeForecast({
      list: [
        {
          dt: 1672531200,
          main: { temp: 1, feels_like: -2, temp_min: -3, temp_max: 4, humidity: 85 },
          weather: [{ id: 600, main: "Snow", description: "snow", icon: "13d" }],
          wind: { speed: 2, deg: 0 },
          pop: 0.5,
        },
      ],
    });
    const hooks = weatherToDailyHooks("user1", data, { trainingLocation: "academia" });
    assert.strictEqual(hooks.length, 0);
  });
});
