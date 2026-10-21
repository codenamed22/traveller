import { z } from "zod";
import type { Place, RouteLeg, Trip } from "./trip";

// How the traveller gets around each city: the public transport app to open. Kept by city on the journey, like the
// journal, so it never makes an itinerary stale.
const appUrl = z.string().trim().max(500).refine((value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}, "Use an https link for the transport app.");
export const transitAppSchema = z.object({ name: z.string().trim().max(60), url: appUrl }).strict();
export type TransitApp = z.infer<typeof transitAppSchema>;
export const cityTransportSchema = z.object({ app: transitAppSchema.optional() }).strict();
export type CityTransport = z.infer<typeof cityTransportSchema>;
export const transportSchema = z.record(z.uuid(), cityTransportSchema);
export type Transport = z.infer<typeof transportSchema>;

// Each city's own public transport app, on the App Store, where an installed app shows Open. Checked October 2026.
export const transitApps: (TransitApp & { cities: string[] })[] = [
  { cities: ["paris"], name: "Bonjour RATP", url: "https://apps.apple.com/app/id507107090" },
  { cities: ["amsterdam"], name: "GVB", url: "https://apps.apple.com/app/id1544439867" },
  { cities: ["brussels", "bruxelles", "brussel"], name: "STIB-MIVB", url: "https://apps.apple.com/app/id1325048789" },
];

// "Paris, France" or "Bruxelles" to the name the list knows.
const cityName = (city: string) => city.split(",")[0].normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

export function suggestedTransitApp(city: string): TransitApp | null {
  const name = cityName(city);
  const app = transitApps.find((candidate) => candidate.cities.includes(name));
  return app ? { name: app.name, url: app.url } : null;
}

// The app the traveller chose for the city, or the city's own when they haven't.
export function transitApp(city: Pick<Trip, "id" | "city">, transport?: Transport): TransitApp | null {
  const chosen = transport?.[city.id]?.app;
  if (chosen?.url.trim()) return { name: chosen.name.trim() || "Transport app", url: chosen.url.trim() };
  return suggestedTransitApp(city.city);
}

// The setting with the city's app replaced; an empty app and an empty city are left out.
export function withTransitApp(transport: Transport | undefined, cityId: string, app: TransitApp): Transport | undefined {
  const city: CityTransport = { ...transport?.[cityId] };
  if (app.name.trim() || app.url.trim()) city.app = app; else delete city.app;
  const next = { ...transport };
  if (Object.keys(city).length) next[cityId] = city; else delete next[cityId];
  return Object.keys(next).length ? next : undefined;
}

// The place a leg ends at. "hotel" on the last leg of a direct departure day stands for the airport or station.
export function legEnd(edge: RouteLeg, places: Record<string, Place>, toDeparture = false) {
  return toDeparture && edge.to === "hotel" && places.departure ? places.departure : places[edge.to];
}

// Uber with the leg's end as the drop-off, picked up where the phone is or, as planned, at the leg's start.
export function uberUrl(edge: RouteLeg, places: Record<string, Place>, options: { fromHere?: boolean; toDeparture?: boolean } = {}) {
  const destination = legEnd(edge, places, options.toDeparture);
  if (!destination) return null;
  const origin = places[edge.from];
  const url = new URL("https://m.uber.com/ul/");
  url.searchParams.set("action", "setPickup");
  const point = (role: "pickup" | "dropoff", place: Place) => {
    url.searchParams.set(`${role}[latitude]`, String(place.location.lat));
    url.searchParams.set(`${role}[longitude]`, String(place.location.lng));
    url.searchParams.set(`${role}[nickname]`, place.name);
    if (place.address) url.searchParams.set(`${role}[formatted_address]`, place.address);
  };
  if (options.fromHere || !origin) url.searchParams.set("pickup", "my_location"); else point("pickup", origin);
  point("dropoff", destination);
  return url.toString();
}
