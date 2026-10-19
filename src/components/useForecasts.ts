"use client";

import { useEffect, useMemo, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import type { SavedPlan, Trip } from "@/lib/trip";
import { forecastPoint, forecastSchema, forecastUrl, needsForecast, parseForecast, type Forecast } from "@/lib/weather";

const maxAge = 3_600_000;
const cachePrefix = "traveller.weather:";

function cached(url: string) {
  try {
    const raw = window.sessionStorage.getItem(cachePrefix + url);
    const forecast = raw ? forecastSchema.safeParse(JSON.parse(raw)).data : undefined;
    return forecast && Date.now() - forecast.fetchedAt < maxAge ? forecast : undefined;
  } catch { return undefined; }
}

const inFlight = new Map<string, Promise<Forecast | undefined>>();

// A city's forecast, when one of its days is within reach and it has somewhere to ask about. Kept for an hour; a failed
// request just means no weather.
export function loadForecast(city: Trip, plan?: SavedPlan): Promise<Forecast | undefined> {
  const point = forecastPoint(city, plan?.snapshot?.places);
  let today: string;
  try { today = Temporal.Now.plainDateISO(city.timeZone).toString(); } catch { return Promise.resolve(undefined); }
  if (!point || !needsForecast(city, today)) return Promise.resolve(undefined);
  const url = forecastUrl(point, city.timeZone);
  const hit = cached(url);
  if (hit) return Promise.resolve(hit);
  let request = inFlight.get(url);
  if (!request) {
    request = fetch(url).then(async (response) => {
      if (!response.ok) return undefined;
      const forecast = parseForecast(await response.json(), city.timeZone, Date.now());
      try { window.sessionStorage.setItem(cachePrefix + url, JSON.stringify(forecast)); } catch { /* Kept for this load only. */ }
      return forecast;
    }).catch(() => undefined).finally(() => inFlight.delete(url));
    inFlight.set(url, request);
  }
  return request;
}

// Every city's forecast, by city id.
export async function loadForecasts(cities: Trip[], plans: Record<string, SavedPlan>) {
  const entries = await Promise.all(cities.map(async (city) => [city.id, await loadForecast(city, plans[city.id])] as const));
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, Forecast] => Boolean(entry[1])));
}

export function useForecasts(cities: Trip[], plans: Record<string, SavedPlan>) {
  const [forecasts, setForecasts] = useState<Record<string, Forecast>>({});
  // Only what decides the request, so editing a visit doesn't ask again.
  const key = useMemo(() => JSON.stringify(cities.map((city) => [city.id, city.startDate, city.days, city.timeZone, forecastPoint(city, plans[city.id]?.snapshot?.places)])), [cities, plans]);
  useEffect(() => {
    let live = true;
    void loadForecasts(cities, plans).then((next) => { if (live) setForecasts(next); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return forecasts;
}
