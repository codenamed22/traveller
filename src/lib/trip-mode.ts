import { Temporal } from "@js-temporal/polyfill";
import { dayProgressSchema, newDayProgress, recoveryMinute, type DayProgress } from "./day-recovery";
import { routineGaps, type RoutineGap } from "./gaps";
import type { Journey } from "./journey";
import { meters } from "./nearby";
import { legEnd } from "./transport";
import { planningKey, plannedStopIds, tripDate, type DayPlan, type Place, type RouteLeg, type SavedPlan, type Stop, type Trip, type Visit } from "./trip";

// One day of an accepted itinerary as trip mode shows it. `trip` and `places` belong to the plan being shown (the accepted
// snapshot, or today's replan); `cityTrip` is the city as it is now, which keys and validates day progress like the planner.
// `started` is today or a day gone by.
export type TripModeDay = {
  key: string; cityId: string; city: string; cityTrip: Trip; day: number; date: string; label: string; isToday: boolean; started: boolean;
  trip: Trip; places: Record<string, Place>; plan: DayPlan; stopIds: string[]; stale: boolean; replanned: boolean; progress?: DayProgress;
};

export const dayLabel = (date: string) => Temporal.PlainDate.from(date).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short" });

function cityToday(trip: Trip, now: Temporal.Instant) {
  try { return now.toZonedDateTimeISO(trip.timeZone).toPlainDate().toString(); } catch { return ""; }
}

export function tripModeDays(cities: Trip[], plans: Record<string, SavedPlan>, execution: Journey["execution"], now: Temporal.Instant): TripModeDay[] {
  return cities.flatMap((city) => {
    const snapshot = plans[city.id]?.snapshot;
    if (!snapshot) return [];
    const today = cityToday(city, now);
    const planned = plannedStopIds(snapshot.schedule.days);
    const stale = planningKey(snapshot.trip, planned) !== planningKey(city, planned);
    return snapshot.schedule.days.map((planned) => {
      let date: string;
      try { date = tripDate(city, planned.day); } catch { date = planned.date; }
      const progress = execution?.[city.id]?.[date];
      const replan = progress?.remaining?.snapshot;
      const stopIds = plans[city.id].days.find((entry) => entry.day === planned.day)?.stopIds ?? planned.visits.map((visit) => visit.stopId);
      return {
        key: `${city.id}:${planned.day}`, cityId: city.id, city: city.city, cityTrip: city, day: planned.day, date, label: `Day ${planned.day + 1} · ${dayLabel(date)}`,
        isToday: date === today, started: Boolean(today) && date <= today, trip: replan?.trip ?? snapshot.trip, places: replan?.places ?? snapshot.places, plan: replan?.day ?? planned,
        stopIds, stale, replanned: Boolean(replan), ...(progress ? { progress } : {}),
      };
    });
  });
}

export function startingDay(days: TripModeDay[], preferred?: { cityId: string; day: number }) {
  return days.find((entry) => entry.isToday) ?? days.find((entry) => entry.cityId === preferred?.cityId && entry.day === preferred.day) ?? days[0];
}

export type VisitStatus = "done" | "skipped" | "pending";
export function visitStatus(progress: DayProgress | undefined, stopId: string): VisitStatus {
  if (!progress) return "pending";
  if (progress.completed.some((visit) => visit.stopId === stopId)) return "done";
  return progress.skipped.includes(stopId) || progress.remaining?.skipped.includes(stopId) ? "skipped" : "pending";
}

export function nextVisit(entry: TripModeDay): Visit | undefined {
  return entry.plan.visits.find((visit) => visitStatus(entry.progress, visit.stopId) === "pending");
}

export const leaveBy = (visit: Visit) => visit.start - visit.leg.minutes;

export function daySummary(plan: DayPlan) {
  const travel = plan.visits.reduce((sum, visit) => sum + visit.leg.minutes, 0) + (plan.returnLeg?.minutes ?? 0);
  const first = plan.visits[0];
  const last = plan.visits.at(-1);
  return { stops: plan.visits.length, leave: first ? leaveBy(first) : undefined, back: last && plan.returnLeg ? last.end + plan.returnLeg.minutes : last?.end, travel: Math.round(travel) };
}

// Meals the day's plan leaves out, as the planner shows them, from the city as it is now so a meal place added since
// fills its gap; a day replanned since it began has had its breakfast.
export function dayMeals(entry: TripModeDay): RoutineGap[] {
  return routineGaps(entry.cityTrip, { days: [entry.plan] }, entry.places).filter((gap) => !(entry.replanned && gap.meal === "breakfast"));
}

// Shown on the day from half an hour before the meal until it would end.
export const mealSoon = (gap: { start: number; end: number }, nowMinute: number) => nowMinute >= gap.start - 30 && nowMinute < gap.end;

// Where to look for somewhere to eat, and for when: near you while you're in the city, otherwise where the plan has you;
// from now once the meal's time has come, for as long as the meal takes, before midnight.
export function mealSearch(gap: Pick<RoutineGap, "start" | "end" | "location">, nowMinute: number, here?: { lat: number; lng: number }) {
  const location = here && (!gap.location || meters(here, gap.location) < 25_000) ? here : gap.location;
  const start = Math.max(gap.start, Math.ceil(nowMinute));
  return { location, here: Boolean(location && location === here), start, end: Math.min(start + gap.end - gap.start, 24 * 60 - 1) };
}

// Walking directions to a place from the phone's location.
export function walkingUrl(place: { id: string; name: string }) {
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("destination", place.name);
  url.searchParams.set("destination_place_id", place.id);
  url.searchParams.set("travelmode", "walking");
  return url.toString();
}

export function durationLabel(minutes: number) {
  const rounded = Math.max(0, Math.round(minutes));
  if (rounded < 60) return `${rounded} min`;
  return rounded % 60 ? `${Math.floor(rounded / 60)} h ${rounded % 60} min` : `${rounded / 60} h`;
}

function baseProgress(entry: TripModeDay) {
  return entry.progress ?? newDayProgress(entry.cityTrip, entry.day, entry.stopIds);
}

export function minuteNow(entry: TripModeDay, now: Temporal.Instant) {
  return recoveryMinute(entry.cityTrip, entry.day, now.toString());
}

// Done from trip mode: the visit ends now and is assumed to have lasted its planned time, never overlapping the last one.
export function markDone(entry: TripModeDay, stopId: string, nowMinute: number): DayProgress {
  const progress = baseProgress(entry);
  const visit = entry.plan.visits.find((candidate) => candidate.stopId === stopId);
  const end = Math.min(1500, Math.max(0, Math.floor(nowMinute)));
  const previousEnd = progress.completed.filter((done) => done.stopId !== stopId).reduce((latest, done) => Math.max(latest, done.end), 0);
  const start = Math.min(end, Math.max(previousEnd, end - (visit ? visit.end - visit.start : 0)));
  return dayProgressSchema.parse({
    ...progress, version: progress.version + 1, originId: stopId, readyAt: Math.max(end, progress.readyAt ?? 0),
    skipped: progress.skipped.filter((id) => id !== stopId),
    completed: [...progress.completed.filter((done) => done.stopId !== stopId), { stopId, start, end }].sort((left, right) => left.start - right.start),
  });
}

// Skipping a booked visit records a missed booking, as the Today dialog does.
export function markSkipped(entry: TripModeDay, stop: Stop): DayProgress {
  const progress = baseProgress(entry);
  return dayProgressSchema.parse({
    ...progress, version: progress.version + 1,
    skipped: [...progress.skipped.filter((id) => id !== stop.id), stop.id],
    missedBookings: stop.fixedTime ? [...progress.missedBookings.filter((id) => id !== stop.id), stop.id] : progress.missedBookings,
  });
}

// Undo for one visit at any time that day: back to not done, as if Done or Skip was never tapped for it. Where the day
// carries on from goes back to the latest visit still done, or the hotel.
export function markPending(entry: TripModeDay, stopId: string): DayProgress {
  const progress = baseProgress(entry);
  const removed = progress.completed.find((done) => done.stopId === stopId);
  const completed = progress.completed.filter((done) => done.stopId !== stopId);
  const latest = completed.reduce<(typeof completed)[number] | undefined>((last, done) => !last || done.end >= last.end ? done : last, undefined);
  return dayProgressSchema.parse({
    ...progress, version: progress.version + 1, completed,
    skipped: progress.skipped.filter((id) => id !== stopId),
    missedBookings: progress.missedBookings.filter((id) => id !== stopId),
    originId: progress.originId === stopId ? latest?.stopId ?? "hotel" : progress.originId,
    readyAt: removed && progress.readyAt === removed.end ? latest?.end ?? null : progress.readyAt,
  });
}

// Google Maps directions for one leg. From here leaves out the origin, so Google Maps starts from the phone's location.
export function directionsUrl(edge: RouteLeg, places: Record<string, Place>, options: { fromHere?: boolean; toDeparture?: boolean } = {}) {
  const origin = places[edge.from];
  const destination = legEnd(edge, places, options.toDeparture);
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  if (!options.fromHere) {
    url.searchParams.set("origin", origin?.name ?? edge.from);
    if (origin?.id) url.searchParams.set("origin_place_id", origin.id);
  }
  url.searchParams.set("destination", destination?.name ?? edge.to);
  if (destination) url.searchParams.set("destination_place_id", destination.id);
  url.searchParams.set("travelmode", { WALK: "walking", TRANSIT: "transit", DRIVE: "driving" }[edge.mode]);
  return url.toString();
}
