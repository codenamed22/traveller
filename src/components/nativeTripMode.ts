import { Temporal } from "@js-temporal/polyfill";
import { exportNote } from "@/lib/export";
import type { Journey } from "@/lib/journey";
import { endpointKey, formatMinute, instantForMinute, tripDate, type Place, type TravelEdge, type Trip } from "@/lib/trip";
import { dayLabel, daySummary, directionsUrl, durationLabel, leaveBy, startingDay, tripModeDays, visitStatus, type TripModeDay, type VisitStatus } from "@/lib/trip-mode";
import { transferLineText } from "./TransferFields";

// What the iPhone app's native trip mode draws. The rules stay here, in the same trip-mode helpers the web trip mode
// uses; the app only shows the result and keeps the clock (`startsAt` lets it count minutes as recoveryMinute does).
type LatLng = { lat: number; lng: number };
export type NativeLeg = {
  mode: TravelEdge["mode"]; minutes: number; label: string; detail: string; polyline?: string; from?: LatLng; to?: LatLng;
  steps: string[]; fare?: string; directions: string; directionsFromHere: string;
};
export type NativeVisit = {
  stopId: string; name: string; placeId?: string; location?: LatLng; start: number; end: number; startLabel: string; endLabel: string;
  leaveBy: number; leaveLabel: string; booked: boolean; status: VisitStatus; doneLabel?: string; note?: string; sourceNote?: string;
  alternatives: string[]; leg: NativeLeg;
};
type Line = { title: string; detail: string };
export type NativeDay = {
  key: string; cityId: string; city: string; day: number; date: string; label: string; timeZone: string; startsAt: number; endsAt: number;
  stale: boolean; replanned: boolean; hotel: { name: string; location?: LatLng }; end: { title: string; short: string; location?: LatLng };
  summary: { stops: number; travel: string; leaveLabel?: string; backLabel?: string }; visits: NativeVisit[]; returnLeg?: NativeLeg;
  arrival?: Line; departure?: Line; doneElsewhere: Line[]; omitted: string[];
};
export type NativeTripMode = {
  version: 1; journeyId: string; title: string; generatedAt: string; startKey: string | null; canTrack: boolean; photos: boolean;
  cities: { id: string; name: string; dates: string }[]; days: NativeDay[];
};

function clock(trip: Trip, day: number, minute: number) {
  try { return formatMinute(trip, day, minute); } catch { return ""; }
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
      // From the city as it is now, so a note written after planning shows.
      const note = entry.cityTrip.stops.find((candidate) => candidate.id === visit.stopId)?.note;
      const sourceNote = stop?.source ? exportNote(stop.source) : "";
      return {
        stopId: visit.stopId, name: stopName(visit.stopId), ...(placeId ? { placeId } : {}), ...(location ? { location } : {}),
        start: visit.start, end: visit.end, startLabel: clock(trip, entry.day, visit.start), endLabel: clock(trip, entry.day, visit.end),
        leaveBy: leaveBy(visit), leaveLabel: clock(trip, entry.day, leaveBy(visit)), booked: Boolean(stop?.fixedTime), status: visitStatus(entry.progress, visit.stopId),
        ...(completed ? { doneLabel: `${clock(entry.cityTrip, entry.day, completed.start)}–${clock(entry.cityTrip, entry.day, completed.end)}` } : {}),
        ...(note ? { note } : {}), ...(sourceNote ? { sourceNote } : {}),
        alternatives: stop?.alternativeGroup ? plan.visits.filter((other) => other.stopId !== visit.stopId && trip.stops.find((candidate) => candidate.id === other.stopId)?.alternativeGroup === stop.alternativeGroup).map((other) => stopName(other.stopId)) : [],
        leg: leg(visit.leg, places),
      };
    }),
    ...(plan.returnLeg ? { returnLeg: leg(plan.returnLeg, places, toDeparture) } : {}),
    ...(arrival ? { arrival: { title: arrival.title, detail: arrival.detail } } : {}),
    ...(departure ? { departure: { title: departure.title, detail: departure.detail } } : {}),
    doneElsewhere: entry.progress?.completed.filter((visit) => !plan.visits.some((planned) => planned.stopId === visit.stopId))
      .map((visit) => ({ title: stopName(visit.stopId), detail: `${clock(entry.cityTrip, entry.day, visit.start)}–${clock(entry.cityTrip, entry.day, visit.end)}` })) ?? [],
    omitted: omitted.map((id) => trip.stops.find((stop) => stop.id === id)?.name ?? "").filter(Boolean),
  };
}

export function nativeTripMode(journey: Journey, now: Temporal.Instant, options: { start?: { cityId: string; day: number }; canTrack: boolean; photos: boolean }): NativeTripMode {
  const days = tripModeDays(journey.cities, journey.plans, journey.execution, now);
  return {
    version: 1, journeyId: journey.id, title: journey.title, generatedAt: now.toString(), startKey: startingDay(days, options.start)?.key ?? null,
    canTrack: options.canTrack, photos: options.photos,
    cities: journey.cities.map((city) => ({
      id: city.id, name: city.city,
      dates: city.startDate ? city.days > 1 ? `${dayLabel(city.startDate)} – ${dayLabel(tripDate(city, city.days - 1))}` : dayLabel(city.startDate) : "",
    })),
    days: days.map((entry) => nativeDay(entry, journey)),
  };
}
