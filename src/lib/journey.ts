import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { newTrip, savedPlanSchema, tripDate, tripSchema, type SavedPlan, type Trip } from "./trip";
import { dayProgressSchema } from "./day-recovery";
import { journalSchema } from "./journal";

export { savedPlanSchema } from "./trip";

export const popularCities = [
  { name: "Paris", country: "France", timeZone: "Europe/Paris", days: 3 },
  { name: "Amsterdam", country: "Netherlands", timeZone: "Europe/Amsterdam", days: 3 },
  { name: "Brussels", country: "Belgium", timeZone: "Europe/Brussels", days: 2 },
  { name: "London", country: "United Kingdom", timeZone: "Europe/London", days: 4 },
  { name: "Rome", country: "Italy", timeZone: "Europe/Rome", days: 3 },
  { name: "Barcelona", country: "Spain", timeZone: "Europe/Madrid", days: 3 },
  { name: "Berlin", country: "Germany", timeZone: "Europe/Berlin", days: 3 },
  { name: "Prague", country: "Czechia", timeZone: "Europe/Prague", days: 2 },
  { name: "Lisbon", country: "Portugal", timeZone: "Europe/Lisbon", days: 3 },
  { name: "Vienna", country: "Austria", timeZone: "Europe/Vienna", days: 2 },
  { name: "Tokyo", country: "Japan", timeZone: "Asia/Tokyo", days: 5 },
  { name: "New York", country: "United States", timeZone: "America/New_York", days: 4 },
] as const;

export function cityPreset(value: string) {
  const name = value.trim().toLowerCase();
  return popularCities.find((city) => city.name.toLowerCase() === name || `${city.name}, ${city.country}`.toLowerCase() === name);
}

// A city in a trip may not have its hotel yet; planning asks for one.
export const cityTripSchema = tripSchema.safeExtend({ hotel: z.string().trim().max(200) });
export const journeySchema = z.object({
  id: z.uuid(), title: z.string().trim().min(1).max(150),
  cities: z.array(cityTripSchema).min(1).max(10),
  plans: z.record(z.uuid(), savedPlanSchema).default({}),
  execution: z.record(z.uuid(), z.record(z.iso.date(), dayProgressSchema)).optional(),
  journal: journalSchema.optional(),
}).strict().superRefine((journey, context) => {
  if (new Set(journey.cities.map((city) => city.id)).size !== journey.cities.length) context.addIssue({ code: "custom", message: "City visit identifiers must be unique.", path: ["cities"] });
  journey.cities.forEach((city, index) => {
    const previous = journey.cities[index - 1];
    if (!previous || !cityTripSchema.shape.startDate.safeParse(previous.startDate).success || !cityTripSchema.shape.days.safeParse(previous.days).success) return;
    if (city.startDate < tripDate(previous, previous.days - 1)) context.addIssue({ code: "custom", message: `${city.city} starts before the previous city visit ends.`, path: ["cities", index, "startDate"] });
  });
  for (const cityId of Object.keys(journey.plans)) {
    if (!journey.cities.some((city) => city.id === cityId)) context.addIssue({ code: "custom", message: "A saved plan belongs to an unknown city.", path: ["plans", cityId] });
    if (journey.plans[cityId].snapshot && journey.plans[cityId].snapshot.trip.id !== cityId) context.addIssue({ code: "custom", message: "The itinerary snapshot belongs to another city.", path: ["plans", cityId, "snapshot"] });
  }
  for (const [cityId, days] of Object.entries(journey.execution ?? {})) {
    if (!journey.cities.some((city) => city.id === cityId) || Object.entries(days).some(([date, progress]) => date !== progress.date)) context.addIssue({ code: "custom", message: "Progress belongs to an unknown city or mismatched date.", path: ["execution", cityId] });
    for (const [date, progress] of Object.entries(days)) {
      for (const remainder of [progress.remaining, progress.previousRemaining]) {
        const snapshot = remainder?.snapshot;
        if (snapshot && (snapshot.trip.id !== cityId || snapshot.day.date !== date || JSON.stringify(snapshot.day.visits.map((visit) => visit.stopId)) !== JSON.stringify(remainder!.stopIds))) {
          context.addIssue({ code: "custom", message: "Saved recovery must match its city, date and remaining visit order.", path: ["execution", cityId, date] });
        }
      }
    }
  }
});
export type Journey = z.infer<typeof journeySchema>;
export type StoredTrip = Trip | Journey;

export function asJourney(data: StoredTrip, plan: SavedPlan | null = null): Journey {
  return "cities" in data ? data : { id: data.id, title: data.title, cities: [data], plans: plan ? { [data.id]: plan } : {} };
}

export const cityStaySchema = z.object({
  city: z.string().trim().min(1, "Enter a city for every visit.").max(150),
  days: z.number().int().min(1).max(7),
  startDate: z.iso.date().nullable(),
  timeZone: tripSchema.shape.timeZone,
}).strict();
export type CityStay = z.infer<typeof cityStaySchema>;

export function stayDates(startDate: string, stays: Pick<CityStay, "startDate" | "days">[]) {
  let next = Temporal.PlainDate.from(startDate);
  return stays.map((stay) => {
    const days = z.number().int().min(1).max(7).parse(stay.days);
    const arrival = stay.startDate ? Temporal.PlainDate.from(stay.startDate) : next;
    const end = arrival.add({ days: days - 1 });
    next = end.add({ days: 1 });
    return { startDate: arrival.toString(), endDate: end.toString() };
  });
}

export function createJourney(title: string, startDate: string, input: CityStay[]): Journey {
  const stays = z.array(cityStaySchema).min(1, "Add at least one city.").max(10).parse(input);
  const dates = stayDates(startDate, stays);
  return journeySchema.parse({
    id: crypto.randomUUID(), title: title.trim() || stays.map((stay) => cityPreset(stay.city)?.name ?? stay.city).join(" / ").slice(0, 150), plans: {},
    cities: stays.map((stay, index) => ({ ...newTrip(), title: stay.city, city: stay.city, timeZone: stay.timeZone, startDate: dates[index].startDate, days: stay.days })),
  });
}

export function restoreJourney(value: unknown): Journey {
  const backup = z.union([
    z.object({ journey: journeySchema }),
    z.object({ trip: tripSchema, plan: savedPlanSchema.nullable().optional() }),
  ]).parse(value);
  const journey = "journey" in backup ? backup.journey : asJourney(backup.trip, backup.plan ?? null);
  return { ...journey, id: crypto.randomUUID() };
}

// A copy to plan another version of a trip: the same cities, places and itineraries, without what was done or written on
// the way. City ids stay, as in a restored backup, so each itinerary still belongs to its city.
export function duplicateJourney(journey: Journey): Journey {
  const { execution: _execution, journal: _journal, ...rest } = journey;
  void _execution; void _journal;
  return journeySchema.parse({ ...rest, id: crypto.randomUUID(), title: `${journey.title.slice(0, 143)} (copy)` });
}