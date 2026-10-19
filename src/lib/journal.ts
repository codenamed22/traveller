import { z } from "zod";
import type { Journey } from "./journey";
import { tripDate } from "./trip";

// The traveller's own record of each day: a note, and the visits they loved. Kept by city and date like day progress,
// on the journey rather than on stops, so it never makes an itinerary stale. Checked for shape only: removing a stop
// later must not stop the trip saving.
export const journalEntrySchema = z.object({
  note: z.string().max(2000).optional(),
  favourites: z.array(z.uuid()).max(60).optional(),
}).strict();
export type JournalEntry = z.infer<typeof journalEntrySchema>;
export const journalSchema = z.record(z.uuid(), z.record(z.iso.date(), journalEntrySchema));

// A note for the day, or a visit marked as a favourite or not, from trip mode, the recap or the iPhone app.
export const journalActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("note"), cityId: z.uuid(), day: z.number().int().min(0).max(6), text: z.string().max(2000) }).strict(),
  z.object({ kind: z.literal("favourite"), cityId: z.uuid(), day: z.number().int().min(0).max(6), stopId: z.uuid(), on: z.boolean() }).strict(),
]);
export type JournalAction = z.infer<typeof journalActionSchema>;

export function journalEntry(journey: Pick<Journey, "journal">, cityId: string, date: string): JournalEntry {
  return journey.journal?.[cityId]?.[date] ?? {};
}

// The journey with one day's entry replaced; empty entries and cities are left out.
export function withJournal(journey: Journey, cityId: string, date: string, entry: JournalEntry): Journey {
  const note = entry.note?.trim() ? entry.note : undefined;
  const favourites = entry.favourites?.length ? entry.favourites : undefined;
  const city = { ...journey.journal?.[cityId] };
  if (note || favourites) city[date] = { ...(note ? { note } : {}), ...(favourites ? { favourites } : {}) }; else delete city[date];
  const journal = { ...journey.journal };
  if (Object.keys(city).length) journal[cityId] = city; else delete journal[cityId];
  const { journal: _journal, ...rest } = journey;
  void _journal;
  return Object.keys(journal).length ? { ...rest, journal } : rest;
}

// The day's entry after the action, with what to tell the traveller. Throws when the day or visit isn't in the trip.
export function applyJournalAction(journey: Journey, action: JournalAction): { cityId: string; date: string; entry: JournalEntry; message: string } {
  const city = journey.cities.find((candidate) => candidate.id === action.cityId);
  if (!city || action.day >= city.days) throw new Error("That day isn't in this trip.");
  const date = tripDate(city, action.day);
  const current = journalEntry(journey, city.id, date);
  if (action.kind === "note") return { cityId: city.id, date, entry: { ...current, note: action.text.slice(0, 2000) }, message: action.text.trim() ? "Note saved" : "Note removed" };
  const planned = journey.plans[city.id]?.snapshot?.trip.stops ?? [];
  const stop = city.stops.find((candidate) => candidate.id === action.stopId) ?? planned.find((candidate) => candidate.id === action.stopId);
  if (!stop) throw new Error("That visit isn't in this trip.");
  const favourites = (current.favourites ?? []).filter((id) => id !== stop.id);
  return { cityId: city.id, date, entry: { ...current, favourites: action.on ? [...favourites, stop.id].slice(-60) : favourites }, message: action.on ? `${stop.name} added to favourites` : `${stop.name} removed from favourites` };
}
