import type { Temporal } from "@js-temporal/polyfill";
import { journalEntry } from "./journal";
import type { Journey } from "./journey";
import { formatMinute, isMustSee, type DayPlan, type TravelEdge, type Trip, type Visit } from "./trip";
import { tripModeDays, visitStatus, type TripModeDay } from "./trip-mode";

// How the trip went, day by day: each visit's planned time against when it was done, what was skipped or never reached,
// the traveller's notes and favourites, and how far they walked and rode on the planned routes to the visits they made.
export type RecapStatus = "done" | "skipped" | "missed" | "upcoming";
export type RecapVisit = { stopId: string; name: string; status: RecapStatus; planned?: string; actual?: string; favourite: boolean; mustSee: boolean };
export type RecapTravel = { walkKm: number; walkMinutes: number; transitMinutes: number };
export type RecapDay = { key: string; cityId: string; city: string; day: number; date: string; label: string; isToday: boolean; note?: string; visits: RecapVisit[]; travel: RecapTravel };
export type TripRecap = { days: RecapDay[]; totals: RecapTravel & { days: number; done: number; skipped: number; missed: number; favourites: number } };

function clock(trip: Trip, day: number, minute: number) {
  try { return formatMinute(trip, day, minute); } catch { return ""; }
}

function range(trip: Trip, day: number, start: number, end: number) {
  const from = clock(trip, day, start), to = clock(trip, day, end);
  return from && to ? `${from}–${to}` : undefined;
}

function addLeg(travel: RecapTravel, edge: TravelEdge) {
  if (edge.mode === "WALK") { travel.walkKm += edge.meters / 1000; travel.walkMinutes += edge.minutes; } else travel.transitMinutes += edge.minutes;
}

// Every visit a day had: as planned, as replanned, and done or skipped there.
function dayStopIds(entry: TripModeDay, original: DayPlan | undefined) {
  return [...new Set([
    ...(original?.visits ?? []).map((visit) => visit.stopId), ...entry.plan.visits.map((visit) => visit.stopId),
    ...(entry.progress?.completed ?? []).map((visit) => visit.stopId), ...(entry.progress?.skipped ?? []),
  ])];
}

// The planned legs a day's travel came to: into each visit made, on the plan as replanned or else as planned, set off
// on its planned time before the visit began; and back once the day is over (or nothing is left today) and something
// was visited, set off when the last visit ended. Minutes are the city's, as day progress keeps them.
export type TravelledLeg = { edge: TravelEdge; minute: number; stopId?: string; back?: true };
export function travelledLegs(entry: TripModeDay, original: DayPlan | undefined): TravelledLeg[] {
  const progress = entry.progress;
  const legs: TravelledLeg[] = [];
  let pending = false;
  for (const id of dayStopIds(entry, original)) {
    const status = visitStatus(progress, id);
    if (status === "pending") pending = true;
    if (status !== "done") continue;
    const edge = (entry.plan.visits.find((visit) => visit.stopId === id) ?? original?.visits.find((visit) => visit.stopId === id))?.leg;
    const completed = progress!.completed.find((visit) => visit.stopId === id)!;
    if (edge) legs.push({ edge, minute: completed.start - edge.minutes, stopId: id });
  }
  const back = entry.plan.returnLeg ?? original?.returnLeg;
  const done = progress?.completed ?? [];
  if (back && (!entry.isToday || !pending) && done.length) legs.push({ edge: back, minute: Math.max(...done.map((visit) => visit.end)), back: true });
  return legs;
}

// Every planned day that has started, in trip order. A visit still to come today isn't missed yet.
export function tripRecap(journey: Journey, now: Temporal.Instant): TripRecap {
  const days = tripModeDays(journey.cities, journey.plans, journey.execution, now).filter((entry) => entry.started).map((entry): RecapDay => {
    const snapshot = journey.plans[entry.cityId]?.snapshot;
    // Planned is the accepted itinerary; a replan of today only changed what was left of it.
    const original = snapshot?.schedule.days.find((planned) => planned.day === entry.day);
    const plannedTrip = snapshot?.trip ?? entry.trip;
    const journal = journalEntry(journey, entry.cityId, entry.date);
    const favourites = new Set(journal.favourites ?? []);
    const progress = entry.progress;
    const find = (visits: Visit[] | undefined, id: string) => visits?.find((visit) => visit.stopId === id);
    const name = (id: string) => entry.cityTrip.stops.find((stop) => stop.id === id)?.name ?? entry.trip.stops.find((stop) => stop.id === id)?.name ?? entry.places[id]?.name ?? "Removed place";
    const travel: RecapTravel = { walkKm: 0, walkMinutes: 0, transitMinutes: 0 };
    for (const leg of travelledLegs(entry, original)) addLeg(travel, leg.edge);
    const visits = dayStopIds(entry, original).map((id) => {
      const status = visitStatus(progress, id);
      const completed = progress?.completed.find((visit) => visit.stopId === id);
      const planned = find(original?.visits, id);
      const replanned = find(entry.plan.visits, id);
      const stop = entry.cityTrip.stops.find((candidate) => candidate.id === id);
      const visit: RecapVisit = {
        stopId: id, name: name(id), status: status === "pending" ? entry.isToday ? "upcoming" : "missed" : status,
        ...(planned ? { planned: range(plannedTrip, entry.day, planned.start, planned.end) } : replanned ? { planned: range(entry.trip, entry.day, replanned.start, replanned.end) } : {}),
        ...(completed ? { actual: range(entry.cityTrip, entry.day, completed.start, completed.end) } : {}),
        favourite: favourites.has(id), mustSee: Boolean(stop && isMustSee(stop)),
      };
      return { visit, order: completed?.start ?? planned?.start ?? replanned?.start ?? 1500 };
    }).sort((left, right) => left.order - right.order).map(({ visit }) => visit);
    return {
      key: entry.key, cityId: entry.cityId, city: entry.city, day: entry.day, date: entry.date, label: entry.label, isToday: entry.isToday,
      ...(journal.note ? { note: journal.note } : {}), visits,
      travel: { walkKm: Math.round(travel.walkKm * 10) / 10, walkMinutes: Math.round(travel.walkMinutes), transitMinutes: Math.round(travel.transitMinutes) },
    };
  });
  const count = (status: RecapStatus) => days.reduce((sum, day) => sum + day.visits.filter((visit) => visit.status === status).length, 0);
  return {
    days,
    totals: {
      days: days.length, done: count("done"), skipped: count("skipped"), missed: count("missed"),
      favourites: days.reduce((sum, day) => sum + day.visits.filter((visit) => visit.favourite).length, 0),
      walkKm: Math.round(days.reduce((sum, day) => sum + day.travel.walkKm, 0) * 10) / 10,
      walkMinutes: days.reduce((sum, day) => sum + day.travel.walkMinutes, 0), transitMinutes: days.reduce((sum, day) => sum + day.travel.transitMinutes, 0),
    },
  };
}

// Whether the trip has a planned day that has started, so there's something to recap.
export function hasRecap(journey: Pick<Journey, "cities" | "plans" | "execution">, now: Temporal.Instant) {
  return tripModeDays(journey.cities, journey.plans, journey.execution, now).some((entry) => entry.started);
}
