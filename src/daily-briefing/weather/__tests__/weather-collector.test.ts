import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

// Mock global.fetch
const mockFetch = mock.method(globalThis, "fetch");

import { fetchWeatherForecast } from "../weather-collector";

describe("fetchWeatherForecast", () => {
  beforeEach(() => {
    mockFetch.mock.resetCalls();
    process.env.OPENWEATHER_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.OPENWEATHER_API_KEY;
  });

  it("returns null when API key is missing", async () => {
    delete process.env.OPENWEATHER_API_KEY;
    const result = await fetchWeatherForecast({ lat: 45, lon: 9 });
    assert.strictEqual(result, null);
    assert.strictEqual(mockFetch.mock.calls.length, 0);
  });

  it("returns null when fetch fails (network error)", async () => {
    mockFetch.mock.mockImplementationOnce(async () => { throw new Error("Network error"); });
    const result = await fetchWeatherForecast({ lat: 45, lon: 9 });
    assert.strictEqual(result, null);
  });

  it("returns null when API returns non-ok status", async () => {
    mockFetch.mock.mockImplementationOnce(async () => ({ ok: false, status: 401 } as unknown as Response));
    const result = await fetchWeatherForecast({ lat: 45, lon: 9 });
    assert.strictEqual(result, null);
  });

  it("returns parsed data on success", async () => {
    const fakeData = {
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
    mockFetch.mock.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => fakeData,
    } as unknown as Response));
    const result = await fetchWeatherForecast({ lat: 45, lon: 9 });
    assert.deepStrictEqual(result, fakeData);
  });
});
