import { describe, expect, it } from "vitest";
import { newStop, newTrip, type Place, type Trip } from "./trip";
import { describeWeather, forecastPoint, forecastUrl, isOutdoor, needsForecast, parseForecast, rainChance, rainWarningFor, swapPrompt } from "./weather";

// Open-Meteo's answer for Amsterdam, asked for in its own time zone: two days, and hourly rain for the first morning.
const response = {
  daily: {
    time: ["2026-12-24", "2026-12-25"], weather_code: [61, 2], temperature_2m_max: [6.4, 4.6], temperature_2m_min: [1.5, null],
    precipitation_probability_max: [80, 10],
  },
  hourly: { time: ["2026-12-24T09:00", "2026-12-24T10:00", "2026-12-24T11:00", "2026-12-24T12:00"], precipitation_probability: [20, 70, null, 40] },
};
const at = (iso: string) => Date.parse(iso);

describe("weather", () => {
  it("reads the forecast, with local hours as instants and days with gaps left out", () => {
    const forecast = parseForecast(response, "Europe/Amsterdam", 1);
    expect(forecast.days).toEqual({ "2026-12-24": { label: "Rain", icon: "rain", max: 6, min: 2, rain: 80 } });
    // 09:00 in Amsterdam is 08:00 UTC.
    expect(forecast.hours).toEqual({ at: [at("2026-12-24T08:00Z"), at("2026-12-24T09:00Z"), at("2026-12-24T11:00Z")], rain: [20, 70, 40] });
    expect(() => parseForecast({ daily: {} }, "Europe/Amsterdam", 1)).toThrow();
  });

  it("names the weather codes", () => {
    expect([0, 2, 3, 45, 53, 63, 65, 80, 75, 95].map((code) => describeWeather(code).label))
      .toEqual(["Clear", "Partly cloudy", "Cloudy", "Fog", "Drizzle", "Rain", "Heavy rain", "Showers", "Snow", "Thunderstorm"]);
  });

  it("takes the highest chance over a visit, counting the hour it starts in", () => {
    const forecast = parseForecast(response, "Europe/Amsterdam", 1);
    // 09:30–10:15 local overlaps the 09:00 and 10:00 hours.
    expect(rainChance(forecast, at("2026-12-24T08:30Z"), at("2026-12-24T09:15Z"))).toBe(70);
    expect(rainChance(forecast, at("2026-12-24T08:00Z"), at("2026-12-24T08:59Z"))).toBe(20);
    expect(rainChance(forecast, at("2026-12-25T08:00Z"), at("2026-12-25T09:00Z"))).toBeUndefined();
  });

  it("asks only about cities with a day in the next 16, at the hotel or else the middle of the places", () => {
    const trip: Trip = { ...newTrip(), startDate: "2026-12-24", days: 3, timeZone: "Europe/Amsterdam" };
    expect(needsForecast(trip, "2026-12-09")).toBe(true);
    expect(needsForecast(trip, "2026-12-08")).toBe(false);
    expect(needsForecast(trip, "2026-12-26")).toBe(true);
    expect(needsForecast(trip, "2026-12-27")).toBe(false);
    const places = { a: { location: { lat: 52.3, lng: 4.8 } }, b: { location: { lat: 52.4, lng: 5 } } } as unknown as Record<string, Place>;
    const located = { ...trip, stops: [{ ...newStop("A"), id: "a" }, { ...newStop("B"), id: "b" }] } as Trip;
    expect(forecastPoint(located, places)).toEqual({ lat: 52.349999999999994, lng: 4.9 });
    expect(forecastPoint({ ...located, hotelLocation: { lat: 52.36, lng: 4.88 } }, places)).toEqual({ lat: 52.36, lng: 4.88 });
    expect(forecastPoint(trip)).toBeUndefined();
    expect(forecastUrl({ lat: 52.36, lng: 4.88 }, "Europe/Amsterdam")).toContain("latitude=52.360&longitude=4.880&timezone=Europe%2FAmsterdam&forecast_days=16");
  });

  it("warns only about outdoor visits", () => {
    const trip = { stops: [] };
    const park: Place = { id: "g", name: "Vondelpark", address: "", location: { lat: 0, lng: 0 }, types: ["park", "tourist_attraction"] };
    expect(isOutdoor(trip, newStop("Vondelpark"), park)).toBe(true);
    expect(isOutdoor(trip, { ...newStop("Canal stroll"), kind: "walk" }, undefined)).toBe(true);
    expect(isOutdoor(trip, newStop("Golconda Fort"), undefined)).toBe(true);
    expect(isOutdoor(trip, newStop("Vondelpark"), undefined)).toBe(true);
    expect(isOutdoor(trip, newStop("Parkhotel bar"), undefined)).toBe(false);
    expect(isOutdoor(trip, newStop("Rijksmuseum"), { ...park, types: ["museum"] })).toBe(false);
    // Lunch in a park is still lunch.
    expect(isOutdoor(trip, { ...newStop("Park café"), kind: "meal" }, park)).toBe(false);

    const forecast = parseForecast(response, "Europe/Amsterdam", 1);
    const wet = [at("2026-12-24T08:30Z"), at("2026-12-24T09:15Z")] as const;
    expect(rainWarningFor(forecast, trip, newStop("Vondelpark"), park, ...wet)).toBe(70);
    expect(rainWarningFor(forecast, trip, newStop("Vondelpark"), park, at("2026-12-24T08:00Z"), at("2026-12-24T08:59Z"))).toBeUndefined();
    expect(rainWarningFor(forecast, trip, newStop("Rijksmuseum"), undefined, ...wet)).toBeUndefined();
    expect(rainWarningFor(undefined, trip, newStop("Vondelpark"), park, ...wet)).toBeUndefined();
    expect(swapPrompt("Vondelpark", "Day 1", 70)).toBe("Rain is likely at Vondelpark on Day 1 (70%). Swap it for something indoors?");
  });
});
