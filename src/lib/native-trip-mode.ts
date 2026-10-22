import { Temporal } from "@js-temporal/polyfill";
import { exportNote } from "./export";
import { journalEntry } from "./journal";
import { asJourney, journeySchema, type Journey, type StoredTrip } from "./journey";
import type { Ticket } from "./tickets";
import { transferAt, transferLeaveAt, transferLineText } from "./transfers";
import { aboutLines, endpointKey, formatMinute, instantForMinute, isMustSee, tripDate, type Place, type RouteLeg, type SavedPlan, type Transfer, type Trip } from "./trip";
import { dayLabel, daySummary, directionsUrl, durationLabel, leaveBy, startingDay, tripModeDays, visitStatus, type TripModeDay, type VisitStatus } from "./trip-mode";
import { tripRecap, type RecapTravel } from "./recap";
import { legEnd, transitApp, uberUrl, type TransitApp, type TransportCard, type TransportEntry } from "./transport";
import { transportStatus, type TransportStatus } from "./transport-status";
import { rainWarningFor, type DayWeather, type Forecast } from "./weather";

// What the iPhone app's native trip mode draws. The rules stay here, in the same trip-mode helpers the web trip mode
// uses; the app only shows the result and keeps the clock.
// `version` stays 1 so apps built before `level` 2 still open the snapshot; newer fields are optional to the app. Level 2
// adds epoch times (`startAt`, `leaveAt`, the transfer lines' `at` and the departure's `leaveAt`), so the app needs no
// time zone rules for its countdowns and reminders. `tickets` lists the trip's tickets without their files; the app
// fetches and keeps each one so it opens without a connection. `weather` is the day's forecast and `rain` the chance of
// rain during an outdoor visit, when it's worth a warning; `swap` says the page can ask the agent to swap such a visit
// (`travellerNative.swap`). `journal` says the traveller can keep a note for each day (`note`) and mark visits as
// favourites (`favourite`), through `travellerNative.journal` or the progress route. `travel` is how far the traveller
// walked and rode on a day that has started, on the planned routes to the visits made (as the recap counts it).
// Each city's `app` is its public transport app, and each leg's `taxi` an Uber link from the phone's location. A visit's
// `about` is what a guide says about the place, as labelled lines. `transport` is each city's card, for the owner: its
// balance, what was spent, and each entry's part in them (`effect` on the balance, `spent`, and a ride's `cost` before a
// cap, or how far a fare moved its ride's price). A visit's `ride` and a day's `returnRide` are what that ride takes off
// the card and whether the balance has it (`counted`), what it costs (`price`, a pass or what the card showed after it
// aside) and its `key` for a fare entered for it, and `transportDay` the day's rides and a bank card's spend, so the app
// can count a Done tapped without a connection: the balance less each ride's cost where it should now count and isn't
// counted.
type LatLng = { lat: number; lng: number };
export type NativeLeg = {
  mode: RouteLeg["mode"]; minutes: number; label: string; detail: string; polyline?: string; from?: LatLng; to?: LatLng;
  steps: string[]; fare?: string; directions: string; directionsFromHere: string; taxi?: string;
};
export type NativeVisit = {
  stopId: string; name: string; placeId?: string; location?: LatLng; start: number; end: number; startLabel: string; endLabel: string;
  leaveBy: number; leaveLabel: string; booked: boolean; status: VisitStatus; doneLabel?: string; note?: string; sourceNote?: string; mustSee?: boolean;
  alternatives: string[]; leg: NativeLeg; about?: { label: string; text: string }[]; startAt?: number; endAt?: number; leaveAt?: number; doneStartAt?: number; doneEndAt?: number; rain?: number; favourite?: boolean;
  ride?: NativeRide;
};
export type NativeRide = { cost: number; counted: boolean; price: number; key: string };
export type NativeTransport = {
  cityId: string; card: TransportCard; balance?: number; spent: number; toAdd?: number;
  entries: (Omit<TransportEntry, "voided"> & { voided?: true; effect: number; spent: number; cost?: number })[];
};
// `mode` (flight, train…) picks the arrival or departure line's icon; `leg` is the route between the airport or station
// and the hotel, when the plan found one.
type Line = { title: string; detail: string; mode?: Transfer["mode"]; at?: number; leaveAt?: number; leg?: NativeLeg };
export type NativeDay = {
  key: string; cityId: string; city: string; day: number; date: string; label: string; timeZone: string; startsAt: number; endsAt: number;
  stale: boolean; replanned: boolean; hotel: { name: string; location?: LatLng }; end: { title: string; short: string; location?: LatLng };
  summary: { stops: number; travel: string; leaveLabel?: string; backLabel?: string }; visits: NativeVisit[]; returnLeg?: NativeLeg;
  arrival?: Line; departure?: Line; doneElsewhere: Line[]; omitted: string[]; weather?: DayWeather; note?: string; travel?: RecapTravel;
  returnRide?: NativeRide; transportDay?: { rides: number; planned: number; spent: number; spentUncapped: number; fares: number };
};
export type NativeTripMode = {
  version: 1; level: 2; journeyId: string; title: string; generatedAt: string; startKey: string | null; canTrack: boolean; photos: boolean;
  cities: { id: string; name: string; dates: string; app?: TransitApp }[]; days: NativeDay[]; tickets?: NativeTicket[]; swap?: boolean; journal?: boolean;
  transport?: NativeTransport[];
};
export type NativeTicket = Omit<Ticket, "tripId" | "stopId"> & { stopId?: string };

function clock(trip: Trip, day: number, minute: number) {
  try { return formatMinute(trip, day, minute); } catch { return ""; }
}

// The same minute as an instant, for the app's countdowns and reminders.
function epoch(trip: Trip, day: number, minute: number) {
  try { return instantForMinute(trip, day, minute).epochMilliseconds; } catch { return undefined; }
}

function leg(edge: RouteLeg, places: Record<string, Place>, toDeparture = false): NativeLeg {
  const destination = legEnd(edge, places, toDeparture);
  const from = places[edge.from]?.location;
  const taxi = uberUrl(edge, places, { fromHere: true, toDeparture });
  return {
    mode: edge.mode, minutes: Math.round(edge.minutes), label: `${durationLabel(edge.minutes)} ${{ WALK: "walk", TRANSIT: "by transit", DRIVE: "by car" }[edge.mode]}`,
    // As the web timeline's leg summary.
    detail: `${{ WALK: "Walk", TRANSIT: "Public transit", DRIVE: "Car or taxi" }[edge.mode]} · ${Math.round(edge.minutes)} min${edge.assumed ? " (assumed, not checked with Google)" : ""}${edge.timetableDate ? ` (timetable of ${edge.timetableDate})` : ""}${edge.mode !== "TRANSIT" ? ` · ${(edge.meters / 1000).toFixed(1)} km` : ""}`,
    ...(edge.polyline ? { polyline: edge.polyline } : {}), ...(from ? { from } : {}), ...(destination ? { to: destination.location } : {}),
    steps: edge.steps?.map((step) => `${step.line ? `${step.line} ` : ""}${step.from && step.to ? `${step.from} to ${step.to}` : step.instruction}`) ?? [],
    ...(edge.fare ? { fare: edge.fare } : {}),
    directions: directionsUrl(edge, places, { toDeparture }), directionsFromHere: directionsUrl(edge, places, { fromHere: true, toDeparture }),
    ...(taxi ? { taxi } : {}),
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

function nativeDay(entry: TripModeDay, journey: Journey, forecast?: Forecast, travel?: RecapTravel, card?: TransportStatus): NativeDay {
  const { trip, places, plan } = entry;
  const stopName = (id: string) => trip.stops.find((stop) => stop.id === id)?.name ?? places[id]?.name ?? "Removed place";
  const toDeparture = endpointKey(trip, entry.day, "hotel", "to") === "departure";
  const summary = daySummary(plan);
  const hotel = places.hotel?.location ?? trip.hotelLocation;
  const departureName = trip.departure?.place || "the station";
  const arrival = entry.day === 0 ? transferLineText(trip, "arrival") : null;
  const departure = entry.day === trip.days - 1 ? transferLineText(trip, "departure") : null;
  const line = (text: { title: string; detail: string; mode?: Transfer["mode"] }, times: { at?: number; leaveAt?: number }): Line => ({ title: text.title, detail: text.detail, ...(text.mode ? { mode: text.mode } : {}), ...defined(times) });
  const omitted = journey.plans[entry.cityId]?.snapshot?.schedule.omitted ?? [];
  const weather = forecast?.days[entry.date];
  const journal = journalEntry(journey, entry.cityId, entry.date);
  const transportDay = card?.days.find((day) => day.key === entry.key);
  const ride = (find: (candidate: { stopId?: string; back?: true }) => boolean) => {
    const found = transportDay?.rides.find(find);
    return found ? { ride: { cost: found.cost, counted: found.counted, price: found.price, key: found.key } } : {};
  };
  const returnRide = ride((candidate) => Boolean(candidate.back)).ride;
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
      const about = aboutLines(current?.about).map(({ label, text }) => ({ label, text }));
      // The original itinerary's line, until a guide's notes say what the place is.
      const sourceNote = stop?.source && !about.length ? exportNote(stop.source) : "";
      const startAt = epoch(trip, entry.day, visit.start), endAt = epoch(trip, entry.day, visit.end);
      const rain = rainWarningFor(forecast, trip, stop, places[visit.stopId], startAt, endAt);
      return {
        stopId: visit.stopId, name: stopName(visit.stopId), ...(placeId ? { placeId } : {}), ...(location ? { location } : {}),
        start: visit.start, end: visit.end, startLabel: clock(trip, entry.day, visit.start), endLabel: clock(trip, entry.day, visit.end),
        leaveBy: leaveBy(visit), leaveLabel: clock(trip, entry.day, leaveBy(visit)), booked: Boolean(stop?.fixedTime), status: visitStatus(entry.progress, visit.stopId),
        ...(completed ? { doneLabel: `${clock(entry.cityTrip, entry.day, completed.start)}–${clock(entry.cityTrip, entry.day, completed.end)}` } : {}),
        ...(note ? { note } : {}), ...(sourceNote ? { sourceNote } : {}), ...(current && isMustSee(current) ? { mustSee: true } : {}),
        ...(rain !== undefined ? { rain } : {}), ...(journal.favourites?.includes(visit.stopId) ? { favourite: true } : {}),
        alternatives: stop?.alternativeGroup ? plan.visits.filter((other) => other.stopId !== visit.stopId && trip.stops.find((candidate) => candidate.id === other.stopId)?.alternativeGroup === stop.alternativeGroup).map((other) => stopName(other.stopId)) : [],
        leg: leg(visit.leg, places), ...(about.length ? { about } : {}), ...ride((candidate) => candidate.stopId === visit.stopId),
        ...defined({
          startAt, endAt, leaveAt: epoch(trip, entry.day, leaveBy(visit)),
          ...(completed ? { doneStartAt: epoch(entry.cityTrip, entry.day, completed.start), doneEndAt: epoch(entry.cityTrip, entry.day, completed.end) } : {}),
        }),
      };
    }),
    ...(plan.returnLeg ? { returnLeg: leg(plan.returnLeg, places, toDeparture) } : {}),
    ...(arrival ? { arrival: { ...line(arrival, { at: transferAt(trip, "arrival") }), ...(plan.arrivalLeg ? { leg: leg(plan.arrivalLeg, places) } : {}) } } : {}),
    ...(departure ? { departure: { ...line(departure, { at: transferAt(trip, "departure"), leaveAt: transferLeaveAt(trip) }), ...(plan.departureLeg ? { leg: leg(plan.departureLeg, places) } : {}) } } : {}),
    doneElsewhere: entry.progress?.completed.filter((visit) => !plan.visits.some((planned) => planned.stopId === visit.stopId))
      .map((visit) => ({ title: stopName(visit.stopId), detail: `${clock(entry.cityTrip, entry.day, visit.start)}–${clock(entry.cityTrip, entry.day, visit.end)}` })) ?? [],
    omitted: omitted.map((id) => trip.stops.find((stop) => stop.id === id)?.name ?? "").filter(Boolean),
    ...(weather ? { weather } : {}), ...(journal.note ? { note: journal.note } : {}), ...(travel ? { travel } : {}),
    ...(returnRide ? { returnRide } : {}),
    ...(transportDay ? { transportDay: { rides: transportDay.count, planned: transportDay.planned, spent: transportDay.spent, spentUncapped: transportDay.spentUncapped, fares: transportDay.fares } } : {}),
  };
}

export function nativeTripMode(journey: Journey, now: Temporal.Instant, options: { start?: { cityId: string; day: number }; canTrack: boolean; photos: boolean; tickets?: Ticket[]; forecasts?: Record<string, Forecast>; swap?: boolean }): NativeTripMode {
  const days = tripModeDays(journey.cities, journey.plans, journey.execution, now);
  const travel = Object.fromEntries(tripRecap(journey, now).days.map((day) => [day.key, day.travel]));
  // The cards are the owner's, like Done and notes.
  const cards = options.canTrack ? journey.cities.flatMap((city) => { const status = transportStatus(journey, city.id, now); return status ? [{ cityId: city.id, status }] : []; }) : [];
  const card = (cityId: string) => cards.find((candidate) => candidate.cityId === cityId)?.status;
  const tickets = (options.tickets ?? []).filter((ticket) => ticket.tripId === journey.id)
    .map(({ tripId: _tripId, stopId, ...ticket }) => { void _tripId; return { ...ticket, ...(stopId ? { stopId } : {}) }; });
  return {
    version: 1, level: 2, journeyId: journey.id, title: journey.title, generatedAt: now.toString(), startKey: startingDay(days, options.start)?.key ?? null,
    canTrack: options.canTrack, photos: options.photos,
    cities: journey.cities.map((city) => {
      const app = transitApp(city, journey.transport);
      return {
        id: city.id, name: city.city,
        dates: city.startDate ? city.days > 1 ? `${dayLabel(city.startDate)} – ${dayLabel(tripDate(city, city.days - 1))}` : dayLabel(city.startDate) : "",
        ...(app ? { app } : {}),
      };
    }),
    days: days.map((entry) => nativeDay(entry, journey, options.forecasts?.[entry.cityId], travel[entry.key], card(entry.cityId))),
    ...(tickets.length ? { tickets } : {}),
    ...(options.swap ? { swap: true } : {}), ...(options.canTrack ? { journal: true } : {}),
    ...(cards.length ? { transport: cards.map(({ cityId, status }) => ({
      cityId, card: status.card, ...(status.balance !== undefined ? { balance: status.balance } : {}), spent: status.spent, ...(status.toAdd !== undefined ? { toAdd: status.toAdd } : {}),
      entries: status.entries.map(({ entry, effect, spent, cost }) => ({ ...entry, effect, spent, ...(cost !== undefined ? { cost } : {}) })),
    })) } : {}),
  };
}

// Saved trips for the app to keep: a snapshot of each one planned and not over yet, or over in the last 60 days for its
// memories, except `held`, the trip the page has open, which it sends itself; and every saved trip's id, so the app can
// let go of deleted ones.
const keptAfterTrip = 60 * 86_400_000;

export function nativeStore(entries: { data: StoredTrip; plan: SavedPlan | null }[], held: string, now: Temporal.Instant, tickets: Ticket[] = [], forecasts: Record<string, Forecast> = {}) {
  const snapshots: NativeTripMode[] = [];
  const ids: string[] = [];
  for (const entry of entries) {
    const parsed = journeySchema.safeParse(asJourney(entry.data, entry.plan));
    const id = parsed.success ? parsed.data.id : (entry.data as { id?: unknown }).id;
    if (typeof id === "string") ids.push(id);
    if (!parsed.success || parsed.data.id === held) continue;
    try {
      const snapshot = nativeTripMode(parsed.data, now, { canTrack: true, photos: false, tickets, forecasts });
      if (snapshot.days.some((day) => day.endsAt > now.epochMilliseconds - keptAfterTrip)) snapshots.push(snapshot);
    } catch { /* A trip that can't be laid out stays on the site. */ }
  }
  return { snapshots, ids };
}
