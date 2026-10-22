import type { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import type { Journey } from "./journey";
import type { Place, RouteLeg, Trip } from "./trip";

// How the traveller gets around each city: the public transport app to open, and the card they pay with and what they
// put on it. Kept by city on the journey, like the journal, so it never makes an itinerary stale.
const appUrl = z.string().trim().max(500).refine((value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}, "Use an https link for the transport app.");
export const transitAppSchema = z.object({ name: z.string().trim().max(60), url: appUrl }).strict();
export type TransitApp = z.infer<typeof transitAppSchema>;

// Tickets loaded on a card, money on a card (Paris, counted in euros), or a bank card tapped in and out with a daily
// cap (Amsterdam, Brussels). Prices are for one traveller; everything counts for all of them.
const money = z.number().min(0).max(10_000);
const currency = z.string().regex(/^[A-Z]{3}$/, "Use a three-letter currency code, such as EUR.");
export const cardKinds = ["tickets", "balance", "tap"] as const;
export const transportCardSchema = z.object({
  kind: z.enum(cardKinds),
  name: z.string().trim().max(60),
  currency,
  travellers: z.number().int().min(1).max(9),
  // One ticket's price, or the fare before distance when Google has none for the ride.
  ridePrice: money,
  perKm: money.optional(),
  dailyCap: money.optional(),
  dayPass: money.optional(),
  // A ride to or from the airport has its own fare, outside the card, its cap and day passes.
  airportPrice: money.optional(),
}).strict();
export type TransportCard = z.infer<typeof transportCardSchema>;

// What the traveller did with the card. `topup` adds tickets or money (`amount`) for `paid`; `ride` is a ride the plan
// doesn't know of (`amount` rides, -1 for one not taken), or one with its own fare (`paid`, an airport ride); `set` is
// what the card shows, and everything before it is in that; `pass` makes rides free until `validUntil`; `fare` is what
// one of the plan's rides (`ride`, its rideKey) cost each traveller, in place of Google's fare or the card's. Removing
// one marks it `voided`, so a late retry can't bring it back. Checked for shape only, like the journal.
export const rideKeyPattern = /^\d{4}-\d{2}-\d{2}\|(back|[0-9a-f-]{36})$/;
export const transportEntrySchema = z.object({
  id: z.uuid(),
  at: z.number().int().min(0),
  kind: z.enum(["topup", "ride", "set", "pass", "fare"]),
  ride: z.string().regex(rideKeyPattern).optional(),
  amount: z.number().min(-10_000).max(10_000).optional(),
  paid: money.optional(),
  validUntil: z.number().int().min(0).optional(),
  voided: z.literal(true).optional(),
}).strict();
export type TransportEntry = z.infer<typeof transportEntrySchema>;
export const maxTransportEntries = 300;

// What Google said one traveller's ride costs, looked up ahead for each ride the card counts (by its rideKey), with the
// route it was for: it only counts while the ride still goes that way. No `amount` when Google has no fare for it.
export const rideFareSchema = z.object({
  from: z.string().max(300), to: z.string().max(300), lines: z.string().max(300),
  amount: money.optional(), currency: currency.optional(), at: z.number().int().min(0),
}).strict();
export type RideFare = z.infer<typeof rideFareSchema>;
export const maxRideFares = 200;

export const cityTransportSchema = z.object({
  app: transitAppSchema.optional(),
  card: transportCardSchema.optional(),
  entries: z.array(transportEntrySchema).max(maxTransportEntries).optional(),
  fares: z.record(z.string().regex(rideKeyPattern), rideFareSchema).refine((fares) => Object.keys(fares).length <= maxRideFares, "Too many fares.").optional(),
}).strict();
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

// The setting with one city's replaced; an empty city and an empty setting are left out.
export function withCity(transport: Transport | undefined, cityId: string, city: CityTransport): Transport | undefined {
  const next = { ...transport };
  if (Object.keys(city).length) next[cityId] = city; else delete next[cityId];
  return Object.keys(next).length ? next : undefined;
}

// The setting with the city's app replaced; an empty app and an empty city are left out.
export function withTransitApp(transport: Transport | undefined, cityId: string, app: TransitApp): Transport | undefined {
  const city: CityTransport = { ...transport?.[cityId] };
  if (app.name.trim() || app.url.trim()) city.app = app; else delete city.app;
  return withCity(transport, cityId, city);
}

// How each city charges, to start a card from. Checked October 2026; the traveller can change any of it.
export const suggestedCards: { cities: string[]; card: TransportCard }[] = [
  { cities: ["paris"], card: { kind: "balance", name: "Navigo Easy", currency: "EUR", travellers: 1, ridePrice: 2.55, dayPass: 12.3, airportPrice: 14 } },
  { cities: ["amsterdam"], card: { kind: "tap", name: "Bank card (OVpay)", currency: "EUR", travellers: 1, ridePrice: 1.16, perKm: 0.217, dailyCap: 10.5, airportPrice: 5.5 } },
  { cities: ["brussels", "bruxelles", "brussel"], card: { kind: "tap", name: "Bank card", currency: "EUR", travellers: 1, ridePrice: 2.4, dailyCap: 8.5, airportPrice: 11 } },
];

export function suggestedCard(city: string): TransportCard {
  const name = cityName(city);
  return { ...suggestedCards.find((candidate) => candidate.cities.includes(name))?.card ?? { kind: "tickets", name: "", currency: "EUR", travellers: 1, ridePrice: 0 } };
}

// The setting with the city's card replaced or removed. Removing the card drops what was recorded and looked up with it.
export function withTransportCard(transport: Transport | undefined, cityId: string, card: TransportCard | undefined): Transport | undefined {
  const city: CityTransport = { ...transport?.[cityId] };
  if (card) city.card = card; else { delete city.card; delete city.entries; delete city.fares; }
  return withCity(transport, cityId, city);
}

// Adding to the card or taking back what was added, from trip mode, the iPhone app or the progress route.
export const transportActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("transport-entry"), cityId: z.uuid(), entry: transportEntrySchema }).strict(),
  z.object({ kind: z.literal("transport-void"), cityId: z.uuid(), entryId: z.uuid() }).strict(),
]);
export type TransportAction = z.infer<typeof transportActionSchema>;

export function entryLabel(entry: TransportEntry) {
  if (entry.kind === "ride") return entry.paid !== undefined ? "Airport ride" : (entry.amount ?? 1) < 0 ? "Ride not taken" : "Ride";
  return { topup: "Top-up", set: "Card balance", pass: "Day pass", fare: "Fare" }[entry.kind];
}

// The journey with the entry added, or marked removed. The same entry twice changes nothing, so a retry is harmless.
// Throws when the city has no card or the entry doesn't make sense for it.
export function applyTransportAction(journey: Journey, action: TransportAction, now: Temporal.Instant): { journey: Journey; changed: boolean; message: string } {
  const city = journey.transport?.[action.cityId];
  const card = city?.card;
  if (!journey.cities.some((candidate) => candidate.id === action.cityId) || !card) throw new Error("Set up a transport card for this city first.");
  const entries = city.entries ?? [];
  const save = (next: TransportEntry[]) => ({ ...journey, transport: withCity(journey.transport, action.cityId, { ...city, entries: next }) });
  if (action.kind === "transport-void") {
    const entry = entries.find((candidate) => candidate.id === action.entryId);
    if (!entry) throw new Error("That entry isn't on this card.");
    const message = `${entryLabel(entry)} removed`;
    if (entry.voided) return { journey, changed: false, message };
    return { journey: save(entries.map((candidate) => candidate === entry ? { ...candidate, voided: true as const } : candidate)), changed: true, message };
  }
  const { entry } = action;
  const message = { topup: "Topped up", ride: `${entryLabel(entry)} added`, set: "Balance updated", pass: "Day pass added", fare: "Fare updated" }[entry.kind];
  if (entries.some((candidate) => candidate.id === entry.id)) return { journey, changed: false, message };
  if (entry.at > now.epochMilliseconds + 60_000) throw new Error("An entry can't be ahead of time.");
  if (entry.voided) throw new Error("That entry isn't valid.");
  if ((entry.kind === "topup" || entry.kind === "set") && card.kind === "tap") throw new Error("A bank card has no balance.");
  if (entry.kind === "topup" && !(entry.amount && entry.amount > 0)) throw new Error("Enter how much was added.");
  if (entry.kind === "set" && !(entry.amount !== undefined && entry.amount >= 0)) throw new Error("Enter what the card shows.");
  if (entry.kind === "ride" && entry.amount !== undefined && (!Number.isInteger(entry.amount) || entry.amount === 0 || Math.abs(entry.amount) > 20)) throw new Error("That ride isn't valid.");
  if (entry.kind === "pass" && !(entry.validUntil && entry.validUntil > entry.at)) throw new Error("A pass needs the time it ends.");
  if (entry.kind === "fare" && !(entry.ride && entry.amount !== undefined && entry.amount >= 0 && (card.kind !== "tickets" || (Number.isInteger(entry.amount) && entry.amount <= 20)))) throw new Error("Enter what the ride cost.");
  // Full: room is made by letting go of the oldest removed entries.
  const dropped = new Set(entries.filter((candidate) => candidate.voided).slice(0, Math.max(0, entries.length + 1 - maxTransportEntries)));
  const kept = entries.filter((candidate) => !dropped.has(candidate));
  if (kept.length >= maxTransportEntries) throw new Error("This card has too many entries.");
  return { journey: save([...kept, entry]), changed: true, message };
}

// The journey without what was recorded on the cards and the fares looked up for them, to tell whether that's all that
// changed.
export function withoutTransportEntries(journey: Journey): Journey {
  let transport = journey.transport;
  for (const [cityId, city] of Object.entries(journey.transport ?? {})) {
    if (!city.entries && !city.fares) continue;
    const { entries: _entries, fares: _fares, ...rest } = city;
    void _entries; void _fares;
    transport = withCity(transport, cityId, rest);
  }
  const { transport: _transport, ...rest } = journey;
  void _transport;
  return transport ? { ...rest, transport } : rest;
}

// `base` with the entries recorded in `local` added: every entry from both, and removed if either removed it; and the
// fares from both, the latest looked up for each ride. A city whose card is gone from `base` stays without one.
export function mergeTransportEntries(base: Journey, local: Journey): Journey {
  let transport = base.transport;
  for (const [cityId, city] of Object.entries(local.transport ?? {})) {
    const target = transport?.[cityId];
    if (!target?.card || (!city.entries?.length && !city.fares)) continue;
    const merged = new globalThis.Map((target.entries ?? []).map((entry) => [entry.id, entry]));
    for (const entry of city.entries ?? []) {
      const existing = merged.get(entry.id);
      merged.set(entry.id, existing ? entry.voided ? { ...existing, voided: true } : existing : entry);
    }
    const fares = { ...target.fares };
    for (const [key, fare] of Object.entries(city.fares ?? {})) if (!fares[key] || fares[key].at < fare.at) fares[key] = fare;
    for (const [key] of Object.entries(fares).sort((left, right) => right[1].at - left[1].at).slice(maxRideFares)) delete fares[key];
    const entries = [...merged.values()].slice(-maxTransportEntries);
    transport = withCity(transport, cityId, { ...target, ...(entries.length ? { entries } : {}), ...(Object.keys(fares).length ? { fares } : {}) });
  }
  return { ...base, ...(transport ? { transport } : {}) };
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
