import { Temporal } from "@js-temporal/polyfill";
import { exportNote } from "./export";
import { asJourney, journeySchema, type Journey, type StoredTrip } from "./journey";
import { transferAt, transferLeaveAt, transferLineText } from "./transfers";
import { endpointKey, formatMinute, instantForMinute, isMustSee, tripDate, type Place, type SavedPlan, type TravelEdge, type Trip } from "./trip";
import { dayLabel, daySummary, directionsUrl, durationLabel, leaveBy, startingDay, tripModeDays, visitStatus, type TripModeDay, type VisitStatus } from "./trip-mode";

// What the iPhone app's native trip mode draws. The rules stay here, in the same trip-mode helpers the web trip mode
// uses; the app only shows the result and keeps the clock.
// `version` stays 1 so apps built before `level` 2 still open the snapshot; newer fields are optional to the app. Level 2
// adds epoch times (`startAt`, `leaveAt`, the transfer lines' `at` and the departure's `leaveAt`), so the app needs no
// time zone rules for its countdowns and reminders.
type LatLng = { lat: number; lng: number };
export type NativeLeg = {
  mode: TravelEdge["mode"]; minutes: number; label: string; detail: string; polyline?: string; from?: LatLng; to?: LatLng;
  steps: string[]; fare?: string; directions: string; directionsFromHere: string;
};
export type NativeVisit = {
  stopId: string; name: string; placeId?: string; location?: LatLng; start: number; end: number; startLabel: string; endLabel: string;
  leaveBy: number; leaveLabel: string; booked: boolean; status: VisitStatus; doneLabel?: string; note?: string; sourceNote?: string; mustSee?: boolean;
  alternatives: string[]; leg: NativeLeg; startAt?: number; endAt?: number; leaveAt?: number; doneStartAt?: number; doneEndAt?: number;
};
type Line = { title: string; detail: string; at?: number; leaveAt?: number };
export type NativeDay = {
  key: string; cityId: string; city: string; day: number; date: string; label: string; timeZone: string; startsAt: number; endsAt: number;
  stale: boolean; replanned: boolean; hotel: { name: string; location?: LatLng }; end: { title: string; short: string; location?: LatLng };
  summary: { stops: number; travel: string; leaveLabel?: string; backLabel?: string }; visits: NativeVisit[]; returnLeg?: NativeLeg;
  arrival?: Line; departure?: Line; doneElsewhere: Line[]; omitted: string[];
};
export type NativeTripMode = {
  version: 1; level: 2; journeyId: string; title: string; generatedAt: string; startKey: string | null; canTrack: boolean; photos: boolean;
  cities: { id: string; name: string; dates: string }[]; days: NativeDay[];
};

function clock(trip: Trip, day: number, minute: number) {
  try { return formatMinute(trip, day, minute); } catch { return ""; }
}

// The same minute as an instant, for the app's countdowns and reminders.
function epoch(trip: Trip, day: number, minute: number) {
  try { return instantForMinute(trip, day, minute).epochMilliseconds; } catch { return undefined; }
}

function leg(edge: TravelEdge, places: Record<string, Place>, toDeparture = false): NativeLeg {
  const destination = toDeparture && edge.to === "hotel" && places.departure ? places.departure : places[edge.to];
  const from = places[edge.from]?.location;
  return {
    mode: edge.mode, minutes: Math.round(edge.minutes), label: `${durationLabel(edge.minutes)} ${edge.mode === "WALK" ? "walk" : "by transit"}`,
    // As the web timeline's leg summary.
    detail: `${edge.mode === "WALK" ? "Walk" : "Public transit"} · ${Math.round(edge.minutes)} min${edge.assumed ? " (assumed, not checked with Google)" : ""}${edge.timetableDate ? ` (timetable of ${edge.timetableDate})` : ""}${edge.mode === "WALK" ? ` · ${(edge.meters / 1000).toFixed(1)} km` : ""}`,
    ...(edge.polyline ? { polyline: edge.polyline } : {}), ...(from ? { from } : {}), ...(destination ? { to: destination.location } : {}),
    steps: edge.steps?.map((step) => `${step.line ? `${step.line} ` : ""}${step.from && step.to ? `${step.from} to ${step.to}` : step.instruction}`) ?? [],
    ...(edge.fare ? { fare: edge.fare } : {}),
    directions: directionsUrl(edge, places, { toDeparture }), directionsFromHere: directionsUrl(edge, places, { fromHere: true, toDeparture }),
  };
}

// Leaves out times that couldn't be worked out, so the JSON the app gets has no nulls.
function defined<T extends Record<string, number | undefined>>(values: T) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as { [K in keyof T]?: number };
}

function dayBounds(entry: TripModeDay) {
  try {
    const midnight = Temporal.PlainDate.from(entry.date).toZonedDateTime({ timeZone: entry.cityTrip.timeZone });
    return { startsAt: instantForMinute(entry.cityTrip, entry.day, 0).epochMilliseconds, endsAt: midnight.add({ days: 1 }).epochMilliseconds };
  } catch { return { startsAt: 0, endsAt: 0 }; }
}

function nativeDay(entry: TripModeDay, journey: Journey): NativeDay {
  const { trip, places, plan } = entry;
  const stopName = (id: string) => trip.stops.find((stop) => stop.id === id)?.name ?? places[id]?.name ?? "Removed place";
  const toDeparture = endpointKey(trip, entry.day, "hotel", "to") === "departure";
  const summary = daySummary(plan);
  const hotel = places.hotel?.location ?? trip.hotelLocation;
  const departureName = trip.departure?.place || "the station";
  const arrival = entry.day === 0 ? transferLineText(trip, "arrival") : null;
  const departure = entry.day === trip.days - 1 ? transferLineText(trip, "departure") : null;
  const line = (text: { title: string; detail: string }, times: { at?: number; leaveAt?: number }): Line => ({ title: text.title, detail: text.detail, ...defined(times) });
  const omitted = journey.plans[entry.cityId]?.snapshot?.schedule.omitted ?? [];
  return {
    key: entry.key, cityId: entry.cityId, city: entry.city, day: entry.day, date: entry.date, label: entry.label, timeZone: entry.cityTrip.timeZone,
    ...dayBounds(entry), stale: entry.stale, replanned: entry.replanned,
    hotel: { name: trip.hotel, ...(hotel ? { location: hotel } : {}) },
    end: {
      title: toDeparture ? `At ${departureName}` : `Back to ${trip.hotel}`, short: toDeparture ? `On to ${departureName}` : `Back to ${trip.hotel}`,
      ...(toDeparture ? places.departure ? { location: places.departure.location } : {} : hotel ? { location: hotel } : {}),
    },
    summary: {
      stops: summary.stops, travel: durationLabel(summary.travel),
      ...(summary.leave !== undefined ? { leaveLabel: clock(trip, entry.day, summary.leave) } : {}),
      ...(summary.back !== undefined ? { backLabel: clock(trip, entry.day, summary.back) } : {}),
    },
    visits: plan.visits.map((visit) => {
      const stop = trip.stops.find((candidate) => candidate.id === visit.stopId);
      const completed = entry.progress?.completed.find((done) => done.stopId === visit.stopId);
      const placeId = places[visit.stopId]?.id || stop?.placeId;
      const location = places[visit.stopId]?.location;
      // From the city as it is now, so a note or must-see set after planning shows.
      const current = entry.cityTrip.stops.find((candidate) => candidate.id === visit.stopId);
      const note = current?.note;
      const sourceNote = stop?.source ? exportNote(stop.source) : "";
      return {
        stopId: visit.stopId, name: stopName(visit.stopId), ...(placeId ? { placeId } : {}), ...(location ? { location } : {}),
        start: visit.start, end: visit.end, startLabel: clock(trip, entry.day, visit.start), endLabel: clock(trip, entry.day, visit.end),
        leaveBy: leaveBy(visit), leaveLabel: clock(trip, entry.day, leaveBy(visit)), booked: Boolean(stop?.fixedTime), status: visitStatus(entry.progress, visit.stopId),
        ...(completed ? { doneLabel: `${clock(entry.cityTrip, entry.day, completed.start)}–${clock(entry.cityTrip, entry.day, completed.end)}` } : {}),
        ...(note ? { note } : {}), ...(sourceNote ? { sourceNote } : {}), ...(current && isMustSee(current) ? { mustSee: true } : {}),
        alternatives: stop?.alternativeGroup ? plan.visits.filter((other) => other.stopId !== visit.stopId && trip.stops.find((candidate) => candidate.id === other.stopId)?.alternativeGroup === stop.alternativeGroup).map((other) => stopName(other.stopId)) : [],
        leg: leg(visit.leg, places),
        ...defined({
          startAt: epoch(trip, entry.day, visit.start), endAt: epoch(trip, entry.day, visit.end), leaveAt: epoch(trip, entry.day, leaveBy(visit)),
          ...(completed ? { doneStartAt: epoch(entry.cityTrip, entry.day, completed.start), doneEndAt: epoch(entry.cityTrip, entry.day, completed.end) } : {}),
        }),
      };
    }),
    ...(plan.returnLeg ? { returnLeg: leg(plan.returnLeg, places, toDeparture) } : {}),
    ...(arrival ? { arrival: line(arrival, { at: transferAt(trip, "arrival") }) } : {}),
    ...(departure ? { departure: line(departure, { at: transferAt(trip, "departure"), leaveAt: transferLeaveAt(trip) }) } : {}),
    doneElsewhere: entry.progress?.completed.filter((visit) => !plan.visits.some((planned) => planned.stopId === visit.stopId))
      .map((visit) => ({ title: stopName(visit.stopId), detail: `${clock(entry.cityTrip, entry.day, visit.start)}–${clock(entry.cityTrip, entry.day, visit.end)}` })) ?? [],
    omitted: omitted.map((id) => trip.stops.find((stop) => stop.id === id)?.name ?? "").filter(Boolean),
  };
}

export function nativeTripMode(journey: Journey, now: Temporal.Instant, options: { start?: { cityId: string; day: number }; canTrack: boolean; photos: boolean }): NativeTripMode {
  const days = tripModeDays(journey.cities, journey.plans, journey.execution, now);
  return {
    version: 1, level: 2, journeyId: journey.id, title: journey.title, generatedAt: now.toString(), startKey: startingDay(days, options.start)?.key ?? null,
    canTrack: options.canTrack, photos: options.photos,
    cities: journey.cities.map((city) => ({
      id: city.id, name: city.city,
      dates: city.startDate ? city.days > 1 ? `${dayLabel(city.startDate)} – ${dayLabel(tripDate(city, city.days - 1))}` : dayLabel(city.startDate) : "",
    })),
    days: days.map((entry) => nativeDay(entry, journey)),
  };
}

// Saved trips for the app to keep: a snapshot of each one planned and not over yet, except `held`, the trip the page has
// open, which it sends itself; and every saved trip's id, so the app can let go of deleted ones.
export function nativeStore(entries: { data: StoredTrip; plan: SavedPlan | null }[], held: string, now: Temporal.Instant) {
  const snapshots: NativeTripMode[] = [];
  const ids: string[] = [];
  for (const entry of entries) {
    const parsed = journeySchema.safeParse(asJourney(entry.data, entry.plan));
    const id = parsed.success ? parsed.data.id : (entry.data as { id?: unknown }).id;
    if (typeof id === "string") ids.push(id);
    if (!parsed.success || parsed.data.id === held) continue;
    try {
      const snapshot = nativeTripMode(parsed.data, now, { canTrack: true, photos: false });
      if (snapshot.days.some((day) => day.endsAt > now.epochMilliseconds - 86_400_000)) snapshots.push(snapshot);
    } catch { /* A trip that can't be laid out stays on the site. */ }
  }
  return { snapshots, ids };
}
