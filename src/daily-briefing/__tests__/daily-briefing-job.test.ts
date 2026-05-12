import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert";
import { runDailyBriefingForUser } from "../daily-briefing-job";
import * as weatherCollector from "../weather-collector";
import * as hookStore from "../hook-store";
import * as memoryStore from "../../memory-store";

const mockFetchWeather = mock.method(weatherCollector, "fetchWeatherForecast");
const mockAddHook = mock.method(hookStore, "addDailyHook");
const mockClearExpired = mock.method(hookStore, "clearExpiredDailyHooks");
const mockReadMemory = mock.method(memoryStore, "readMemoryStoreAsync");

describe("runDailyBriefingForUser", () => {
  beforeEach(() => {
    mockFetchWeather.mock.resetCalls();
    mockAddHook.mock.resetCalls();
    mockClearExpired.mock.resetCalls();
    mockReadMemory.mock.resetCalls();
  });

  it("skips user without lat/lon", async () => {
    mockReadMemory.mock.mockImplementationOnce(async () => ({ user1: { city: "Milan" } }));
    const result = await runDailyBriefingForUser("user1");
    assert.deepStrictEqual(result, { created: 0, skipped: 1 });
    assert.strictEqual(mockFetchWeather.mock.calls.length, 0);
  });

  it("skips user when weather fetch returns null", async () => {
    mockReadMemory.mock.mockImplementationOnce(async () => ({
      user1: { lat: 45, lon: 9, trainingLocation: "park" },
    }));
    mockFetchWeather.mock.mockImplementationOnce(async () => null);
    const result = await runDailyBriefingForUser("user1");
    assert.deepStrictEqual(result, { created: 0, skipped: 1 });
  });

  it("creates hooks when weather is impactful", async () => {
    mockReadMemory.mock.mockImplementationOnce(async () => ({
      user1: { lat: 45, lon: 9, trainingLocation: "park" },
    }));
    const fakeWeatherData = {
      list: [
        {
          dt: 1672531200,
          main: { temp: 20, feels_like: 19, temp_min: 18, temp_max: 22, humidity: 90 },
          weather: [{ id: 502, main: "Rain", description: "heavy intensity rain", icon: "10d" }],
          wind: { speed: 5, deg: 200 },
          pop: 0.9,
        },
      ],
      city: { name: "Milan", country: "IT", timezone: 3600 },
    };
    mockFetchWeather.mock.mockImplementationOnce(async () => fakeWeatherData);
    const result = await runDailyBriefingForUser("user1");
    assert.strictEqual(result.created, 1);
    assert.strictEqual(mockAddHook.mock.calls.length, 1);
    assert.strictEqual(mockClearExpired.mock.calls.length, 1);
  });

  it("returns zero hooks for normal weather", async () => {
    mockReadMemory.mock.mockImplementationOnce(async () => ({
      user1: { lat: 45, lon: 9, trainingLocation: "park" },
    }));
    const fakeWeatherData = {
      list: [
        {
          dt: 1672531200,
          main: { temp: 25, feels_like: 24, temp_min: 20, temp_max: 28, humidity: 60 },
          weather: [{ id: 800, main: "Clear", description: "clear sky", icon: "01d" }],
          wind: { speed: 3, deg: 180 },
          pop: 0.1,
        },
      ],
      city: { name: "Milan", country: "IT", timezone: 3600 },
    };
    mockFetchWeather.mock.mockImplementationOnce(async () => fakeWeatherData);
    const result = await runDailyBriefingForUser("user1");
    assert.strictEqual(result.created, 0);
    assert.strictEqual(mockAddHook.mock.calls.length, 0);
  });
});
