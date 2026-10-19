import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import type { Place, Stop, Trip } from "./trip";
import { visitTiming } from "./visit-slots";

// Each city's 16-day forecast from Open-Meteo (free, no key; credited as "Weather: Open-Meteo" wherever it shows), and
// the rain chance during outdoor visits. Fetched by the browser, so the server never calls it.
type LatLng = { lat: number; lng: number };
export type WeatherIcon = "clear" | "partly" | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "storm";
export type DayWeather = { label: string; icon: WeatherIcon; max: number; min: number; rain: number };
export type Forecast = { fetchedAt: number; days: Record<string, DayWeather>; hours: { at: number[]; rain: number[] } };

export const forecastDays = 16;
// Rain at least this likely during an outdoor visit gets a warning.
export const rainWarning = 50;
export const weatherCredit = { label: "Weather: Open-Meteo", url: "https://open-meteo.com/" };

// The WMO weather codes Open-Meteo reports.
export function describeWeather(code: number): { label: string; icon: WeatherIcon } {
  if (code === 0) return { label: "Clear", icon: "clear" };
  if (code === 1) return { label: "Mostly clear", icon: "clear" };
  if (code === 2) return { label: "Partly cloudy", icon: "partly" };
  if (code === 3) return { label: "Cloudy", icon: "cloudy" };
  if (code === 45 || code === 48) return { label: "Fog", icon: "fog" };
  if (code >= 51 && code <= 57) return { label: "Drizzle", icon: "drizzle" };
  if (code === 65 || code === 82) return { label: "Heavy rain", icon: "rain" };
  if (code >= 80 && code <= 81) return { label: "Showers", icon: "rain" };
  if (code >= 61 && code <= 67) return { label: "Rain", icon: "rain" };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { label: "Snow", icon: "snow" };
  if (code >= 95) return { label: "Thunderstorm", icon: "storm" };
  return { label: "Cloudy", icon: "cloudy" };
}

// Where to ask about: the hotel, or else the middle of the city's places.
export function forecastPoint(trip: Trip, places: Record<string, Place> = {}): LatLng | undefined {
  const hotel = places.hotel?.location ?? trip.hotelLocation;
  if (hotel) return hotel;
  const located = trip.stops.flatMap((stop) => { const location = places[stop.id]?.location ?? stop.location; return location ? [location] : []; });
  if (!located.length) return undefined;
  return { lat: located.reduce((sum, point) => sum + point.lat, 0) / located.length, lng: located.reduce((sum, point) => sum + point.lng, 0) / located.length };
}

// Whether any of the city's days falls in the forecast range, so a trip months away asks nothing.
export function needsForecast(trip: Trip, today: string) {
  if (!trip.startDate) return false;
  const first = Temporal.PlainDate.from(trip.startDate);
  const last = first.add({ days: trip.days - 1 });
  const from = Temporal.PlainDate.from(today);
  return Temporal.PlainDate.compare(last, from) >= 0 && Temporal.PlainDate.compare(first, from.add({ days: forecastDays - 1 })) <= 0;
}

export function forecastUrl(point: LatLng, timeZone: string) {
  const query = new URLSearchParams({
    latitude: point.lat.toFixed(3), longitude: point.lng.toFixed(3), timezone: timeZone, forecast_days: String(forecastDays),
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max", hourly: "precipitation_probability",
  });
  return `https://api.open-meteo.com/v1/forecast?${query}`;
}

const series = z.array(z.number().nullable());
const responseSchema = z.object({
  daily: z.object({ time: z.array(z.string()), weather_code: series, temperature_2m_max: series, temperature_2m_min: series, precipitation_probability_max: series }),
  hourly: z.object({ time: z.array(z.string()), precipitation_probability: series }),
});

// Open-Meteo's local times (asked for in the city's time zone) become instants; days with gaps are left out.
export function parseForecast(json: unknown, timeZone: string, fetchedAt: number): Forecast {
  const { daily, hourly } = responseSchema.parse(json);
  const days: Record<string, DayWeather> = {};
  daily.time.forEach((date, index) => {
    const code = daily.weather_code[index], max = daily.temperature_2m_max[index], min = daily.temperature_2m_min[index];
    if (code === null || max === null || min === null) return;
    days[date] = { ...describeWeather(code), max: Math.round(max), min: Math.round(min), rain: daily.precipitation_probability_max[index] ?? 0 };
  });
  const hours: Forecast["hours"] = { at: [], rain: [] };
  hourly.time.forEach((time, index) => {
    const rain = hourly.precipitation_probability[index];
    if (rain === null) return;
    hours.at.push(Temporal.PlainDateTime.from(time).toZonedDateTime(timeZone).epochMilliseconds);
    hours.rain.push(rain);
  });
  return { fetchedAt, days, hours };
}

export const forecastSchema = z.object({
  fetchedAt: z.number(),
  days: z.record(z.string(), z.object({ label: z.string(), icon: z.enum(["clear", "partly", "cloudy", "fog", "drizzle", "rain", "snow", "storm"]), max: z.number(), min: z.number(), rain: z.number() })),
  hours: z.object({ at: z.array(z.number()), rain: z.array(z.number()) }),
});

// The highest hourly chance of rain over [startAt, endAt), counting the hour already under way at the start.
export function rainChance(forecast: Forecast, startAt: number, endAt: number) {
  let highest: number | undefined;
  forecast.hours.at.forEach((at, index) => {
    if (at + 3_600_000 > startAt && at < endAt) highest = Math.max(highest ?? 0, forecast.hours.rain[index]);
  });
  return highest;
}

const indoorKinds = new Set(["meal", "snack", "coffee", "nightlife"]);
const outdoorTypes = new Set([
  "park", "national_park", "state_park", "city_park", "garden", "botanical_garden", "zoo", "wildlife_park", "amusement_park", "water_park",
  "beach", "hiking_area", "campground", "marina", "market", "farmers_market", "observation_deck", "plaza", "dog_park", "picnic_ground",
]);
// Park and garden also end compound names, as in Vondelpark or Tiergarten.
const outdoorWords = /(park|gardens?|garten)\b|\b(zoo|market|bazaar|viewpoint|lookout|beach|lake|fort|trail|hike|boat|cruise|bike|cycling|walking tour|promenade|waterfront|ghats?)\b/i;

// Visits rain spoils: walks, and sights or activities in parks, gardens, markets, viewpoints, boats, bike or walking
// tours. Meals, coffee and nightlife never count.
export function isOutdoor(trip: Pick<Trip, "stops">, stop: Stop, place?: Place) {
  const kind = visitTiming(trip, stop, place).kind;
  if (kind === "walk") return true;
  if (kind && indoorKinds.has(kind)) return false;
  return [place?.primaryType, ...(place?.types ?? [])].some((type) => type && outdoorTypes.has(type)) || outdoorWords.test(stop.name);
}

// The rain chance to warn about for a visit, when it's outdoors and likely enough.
export function rainWarningFor(forecast: Forecast | undefined, trip: Pick<Trip, "stops">, stop: Stop | undefined, place: Place | undefined, startAt: number | undefined, endAt: number | undefined) {
  if (!forecast || !stop || startAt === undefined || endAt === undefined || !isOutdoor(trip, stop, place)) return undefined;
  const chance = rainChance(forecast, startAt, endAt);
  return chance !== undefined && chance >= rainWarning ? chance : undefined;
}

// What to put to the agent when rain threatens a visit; the traveller sends it or changes it first.
export function swapPrompt(name: string, dayLabel: string, chance?: number) {
  return `Rain is likely at ${name} on ${dayLabel}${chance !== undefined ? ` (${chance}%)` : ""}. Swap it for something indoors?`;
}
