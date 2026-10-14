import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

export const maxStopsPerCity = 60;
export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time such as 09:30.");
export const modeSchema = z.enum(["AUTO", "WALK", "TRANSIT"]);
export const planningPreferencesSchema = z.object({
  mode: modeSchema.default("AUTO"),
  goal: z.enum(["TRAVEL", "BALANCED"]).default("TRAVEL"),
  maxWalkMinutes: z.number().int().min(5).max(180).nullable().default(null),
  maxStopsPerDay: z.number().int().min(1).max(25).default(25),
  transitPreference: z.enum(["DEFAULT", "LESS_WALKING", "FEWER_TRANSFERS"]).default("DEFAULT"),
}).strict();
export type PlanningPreferences = z.infer<typeof planningPreferencesSchema>;
const defaultPlanningPreferences = planningPreferencesSchema.parse({});
export const visitSlotSchema = z.enum(["breakfast", "morning", "lunch", "afternoon", "dinner", "evening", "any"]);
export type VisitSlot = z.infer<typeof visitSlotSchema>;
export const visitKindSchema = z.enum(["meal", "snack", "coffee", "sight", "walk", "activity", "nightlife"]);
export type VisitKind = z.infer<typeof visitKindSchema>;
export const sourceUrlSchema = z.url().max(3000).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}, "Source links must use HTTPS without credentials.");
export const stopSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(200),
  placeId: z.string().max(300).nullable(),
  location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict().optional(),
  duration: z.number().int().min(5).max(480),
  durationOptions: z.array(z.number().int().min(5).max(480)).min(1).max(3).optional(),
  day: z.number().int().min(0).max(6).nullable(),
  fixedTime: timeSchema.nullable(),
  buffer: z.number().int().min(0).max(120),
  optional: z.boolean(),
  priority: z.number().int().min(1).max(5),
  mode: modeSchema,
  source: z.string().max(1000),
  sourceUrl: sourceUrlSchema.optional(),
  kind: visitKindSchema.optional(),
  slot: visitSlotSchema.optional(),
  plannedTime: timeSchema.optional(),
  alternativeGroup: z.string().trim().min(1).max(64).nullable().optional(),
  preferredTimeWindow: z.object({
    start: timeSchema,
    end: timeSchema,
    sources: z.array(sourceUrlSchema).min(1).max(5),
  }).strict().superRefine((window, context) => {
    if (window.end <= window.start) context.addIssue({ code: "custom", message: "A preferred time window must end after it starts.", path: ["end"] });
  }).optional(),
}).strict().superRefine((stop, context) => {
  if (stop.fixedTime && stop.day === null) {
    context.addIssue({ code: "custom", message: "Assign a day to a fixed booking.", path: ["day"] });
  }
  if (stop.fixedTime && stop.optional) {
    context.addIssue({ code: "custom", message: "A fixed booking cannot be optional.", path: ["optional"] });
  }
  if (stop.durationOptions) {
    const allowed = new Set([stop.duration, Math.max(5, Math.ceil(stop.duration * 0.9)), Math.max(5, Math.ceil(stop.duration * 0.8)), ...(stop.duration === 15 ? [10] : [])]);
    if (stop.durationOptions[0] !== stop.duration || stop.durationOptions.some((value, index, values) => !allowed.has(value) || (index > 0 && value >= values[index - 1])) || (stop.fixedTime && stop.durationOptions.some((value) => value !== stop.duration))) {
      context.addIssue({ code: "custom", message: "Duration choices must start at the original duration and stay within approved reductions; fixed reservations cannot be shortened.", path: ["durationOptions"] });
    }
  }
});

export const dayGroupSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  stopIds: z.array(z.uuid()).min(1).max(maxStopsPerCity),
  allowedDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  exclusive: z.boolean(),
  assumedTravelMinutes: z.number().int().min(5).max(240).optional(),
}).strict();
export type DayGroup = z.infer<typeof dayGroupSchema>;

export function groupAllowedDays(trip: { days: number; stops: z.infer<typeof stopSchema>[] }, group: DayGroup): number[] {
  const required = trip.stops.filter((stop) => group.stopIds.includes(stop.id) && !stop.optional);
  return group.allowedDays.filter((day) => day < trip.days
    && required.every((stop) => stop.day === null || stop.day === day)
    && (!group.exclusive || !trip.stops.some((stop) => !stop.optional && !group.stopIds.includes(stop.id) && stop.day === day)));
}

export const tripSchema = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1).max(150),
  city: z.string().trim().min(1, "Enter a city.").max(150),
  hotel: z.string().trim().min(1, "Enter your hotel or starting point.").max(200),
  hotelPlaceId: z.string().max(300).nullable(),
  hotelLocation: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict().optional(),
  startDate: z.iso.date(),
  days: z.number().int().min(1).max(7),
  timeZone: z.string().min(1).max(100).refine((zone) => {
    try { Temporal.Now.zonedDateTimeISO(zone); return true; } catch { return false; }
  }, "Choose a valid IANA timezone."),
  dailyStart: timeSchema,
  dailyEnd: timeSchema,
  returnToHotel: z.boolean(),
  planning: planningPreferencesSchema.optional(),
  stops: z.array(stopSchema).max(maxStopsPerCity),
  dayGroups: z.array(dayGroupSchema).max(maxStopsPerCity).optional(),
}).strict().superRefine((trip, context) => {
  if (trip.dailyEnd <= trip.dailyStart) {
    context.addIssue({ code: "custom", message: "End the sightseeing day after it starts.", path: ["dailyEnd"] });
  }
  if (new Set(trip.stops.map((stop) => stop.id)).size !== trip.stops.length) {
    context.addIssue({ code: "custom", message: "Stop identifiers must be unique.", path: ["stops"] });
  }
  trip.stops.forEach((stop, index) => {
    if (stop.day !== null && stop.day >= trip.days) {
      context.addIssue({ code: "custom", message: `${stop.name} is assigned outside this trip.`, path: ["stops", index, "day"] });
    }
  });
  const groupIds = new Set<string>();
  const members = new Set<string>();
  for (const [index, group] of (trip.dayGroups ?? []).entries()) {
    const invalid = groupIds.has(group.id) || new Set(group.stopIds).size !== group.stopIds.length
      || new Set(group.allowedDays).size !== group.allowedDays.length || group.allowedDays.some((day) => day >= trip.days)
      || group.stopIds.some((id) => members.has(id) || !trip.stops.some((stop) => stop.id === id));
    if (invalid) context.addIssue({ code: "custom", message: `${group.name}: groups need unique, existing visits and valid days; visits cannot belong to multiple groups.`, path: ["dayGroups", index] });
    if (!groupAllowedDays(trip, group).length) context.addIssue({ code: "custom", message: `${group.name}: no allowed day remains with the retained day assignments and exclusive-day requirement.`, path: ["dayGroups", index, "allowedDays"] });
    groupIds.add(group.id);
    group.stopIds.forEach((id) => members.add(id));
  }
});

export type Trip = z.infer<typeof tripSchema>;
export type Stop = z.infer<typeof stopSchema>;
export function stopAllowedOnDay(trip: Trip, stop: Stop, day: number): boolean {
  const group = trip.dayGroups?.find((candidate) => candidate.stopIds.includes(stop.id));
  return (stop.day === null || stop.day === day) && (!group || groupAllowedDays(trip, group).includes(day));
}
export function allowsVisitPair(trip: Trip, from: string, to: string): boolean {
  return from === "hotel" || to === "hotel" || !(trip.dayGroups ?? []).some((group) => group.exclusive && group.stopIds.includes(from) !== group.stopIds.includes(to));
}
export function assumedGroupEdge(trip: Trip, day: number, from: string, to: string): TravelEdge | null {
  if ((from === "hotel") === (to === "hotel")) return null;
  const stopId = from === "hotel" ? to : from;
  const group = trip.dayGroups?.find((candidate) => candidate.assumedTravelMinutes && candidate.stopIds.includes(stopId));
  const stop = trip.stops.find((candidate) => candidate.id === stopId);
  if (!group || !stop || !travelModes(trip, to === "hotel" ? undefined : stop).includes("TRANSIT")) return null;
  return { day, from, to, mode: "TRANSIT", minutes: group.assumedTravelMinutes!, meters: 0, assumed: true };
}
export type TravelMode = "WALK" | "TRANSIT";
export type OpeningPoint = { day: number; hour: number; minute: number };
export type OpeningPeriod = { open: OpeningPoint; close?: OpeningPoint };
export type Place = { id: string; name: string; address: string; location: { lat: number; lng: number }; timeZone?: string; primaryType?: string; types?: string[]; hours?: OpeningPeriod[] };

export type DayTripSuggestion = { name: string; stopIds: string[]; distanceKm: number; from: "hotel" | "places" };

export function suggestDayTrips(trip: Trip, places: Record<string, Pick<Place, "location"> & Partial<Pick<Place, "address">>> = {}, minDistanceKm = 15, linkKm = 5): DayTripSuggestion[] {
  const located = trip.stops.flatMap((stop) => { const location = places[stop.id]?.location ?? stop.location; return location ? [location] : []; });
  const median = (values: number[]) => values.sort((left, right) => left - right)[Math.floor(values.length / 2)];
  const known = places.hotel?.location ?? trip.hotelLocation;
  const hotel = known ?? (located.length >= 3 ? { lat: median(located.map((point) => point.lat)), lng: median(located.map((point) => point.lng)) } : undefined);
  if (!hotel) return [];
  const km = (from: { lat: number; lng: number }, to: { lat: number; lng: number }) => Math.hypot((from.lat - to.lat) * 111.2, (from.lng - to.lng) * 111.2 * Math.cos(((from.lat + to.lat) / 2) * Math.PI / 180));
  const grouped = new Set(trip.dayGroups?.flatMap((group) => group.stopIds));
  const far = trip.stops.flatMap((stop) => {
    const location = places[stop.id]?.location ?? stop.location;
    return location && !grouped.has(stop.id) && km(hotel, location) >= minDistanceKm ? [{ stop, location }] : [];
  });
  const clusters: (typeof far)[] = [];
  for (const entry of far) {
    const linked = clusters.filter((cluster) => cluster.some((member) => km(member.location, entry.location) <= linkKm));
    clusters.splice(0, clusters.length, ...clusters.filter((cluster) => !linked.includes(cluster)), [...linked.flat(), entry]);
  }
  return clusters.filter((cluster) => cluster.length >= 2).map((cluster) => {
    const localities = cluster.flatMap(({ stop }) => {
      const parts = places[stop.id]?.address?.split(",").map((part) => part.trim()) ?? [];
      const locality = parts.at(-2)?.split(/\s+/).filter((token) => !/\d/.test(token) && !/^[A-Z]{1,3}$/.test(token)).join(" ");
      return locality ? [locality] : [];
    });
    const counts = new Map<string, number>();
    localities.forEach((locality) => counts.set(locality, (counts.get(locality) ?? 0) + 1));
    const name = [...counts].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "Day trip";
    return { name, stopIds: cluster.map(({ stop }) => stop.id), distanceKm: Math.round(Math.min(...cluster.map(({ location }) => km(hotel, location)))), from: known ? "hotel" as const : "places" as const };
  });
}
export type TravelStep = { instruction: string; mode: string; line?: string; from?: string; to?: string; departure?: string; arrival?: string };
export type TravelEdge = {
  day: number; from: string; to: string; mode: TravelMode;
  minutes: number; meters: number; polyline?: string; steps?: TravelStep[]; fare?: string;
  sampledDeparture?: number;
  assumed?: boolean;
  estimated?: boolean;
  timetableDate?: string;
  alternatives?: TravelEdge[];
};
export type Visit = { stopId: string; start: number; end: number; leg: TravelEdge };
export type DayPlan = { day: number; date: string; visits: Visit[]; returnLeg?: TravelEdge };
export type Schedule = { days: DayPlan[]; omitted: string[]; warnings: string[]; generatedAt: string; optimization?: { weightedDurationLoss: number; durationOptimal: boolean; optionalOptimal: boolean; travelOptimal: boolean } };
const routeFieldsSchema = z.object({
  day: z.number().int().min(0).max(6), from: z.string().min(1).max(300), to: z.string().min(1).max(300),
  mode: z.enum(["WALK", "TRANSIT"]), minutes: z.number().min(0).max(2880), meters: z.number().min(0).max(40_000_000),
  polyline: z.string().max(100_000).optional(),
  steps: z.array(z.object({
    instruction: z.string().max(4000), mode: z.string().max(100), line: z.string().max(500).optional(),
    from: z.string().max(500).optional(), to: z.string().max(500).optional(),
    departure: z.string().max(100).optional(), arrival: z.string().max(100).optional(),
  }).strict()).max(200).optional(),
  fare: z.string().max(500).optional(), sampledDeparture: z.number().min(0).max(2880).optional(),
  assumed: z.boolean().optional(), estimated: z.boolean().optional(), timetableDate: z.iso.date().optional(),
}).strict();
const travelEdgeSchema = routeFieldsSchema.extend({ alternatives: z.array(routeFieldsSchema).max(8).optional() });
export const dayPlanSchema = z.object({
  day: z.number().int().min(0).max(6), date: z.iso.date(),
  visits: z.array(z.object({
    stopId: z.uuid(), start: z.number().min(0).max(2880), end: z.number().min(0).max(2880), leg: travelEdgeSchema,
  }).strict().refine((visit) => visit.end > visit.start, "A visit must end after it starts.")).max(maxStopsPerCity),
  returnLeg: travelEdgeSchema.optional(),
}).strict();
export const scheduleSchema = z.object({
  days: z.array(dayPlanSchema).max(7),
  omitted: z.array(z.uuid()).max(maxStopsPerCity), warnings: z.array(z.string().max(4000)).max(200),
  generatedAt: z.iso.datetime({ offset: true }),
  optimization: z.object({ weightedDurationLoss: z.number().min(0), durationOptimal: z.boolean(), optionalOptimal: z.boolean(), travelOptimal: z.boolean() }).strict().optional(),
}).strict();
const openingPointSchema = z.object({ day: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(24), minute: z.number().int().min(0).max(59) }).strict();
export const placeSchema = z.object({
  id: z.string().max(300), name: z.string().max(500), address: z.string().max(2000),
  location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict(),
  timeZone: z.string().max(100).optional(),
  primaryType: z.string().max(100).optional(),
  types: z.array(z.string().max(100)).max(50).optional(),
  hours: z.array(z.object({ open: openingPointSchema, close: openingPointSchema.optional() }).strict()).max(50).optional(),
}).strict();
export const savedPlanSchema = z.object({
  days: z.array(z.object({ day: z.number().int().min(0).max(6), stopIds: z.array(z.uuid()).max(maxStopsPerCity) }).strict()).max(7),
  omitted: z.array(z.uuid()).max(maxStopsPerCity),
  snapshot: z.object({
    trip: tripSchema, schedule: scheduleSchema,
    places: z.record(z.string().max(300), placeSchema).refine((places) => Object.keys(places).length <= maxStopsPerCity + 1, "Too many saved places."),
  }).strict().optional(),
}).strict().superRefine((plan, context) => {
  if (!plan.snapshot) return;
  const order = plan.snapshot.schedule.days.map(({ day, visits }) => ({ day, stopIds: visits.map((visit) => visit.stopId) }));
  if (JSON.stringify(order) !== JSON.stringify(plan.days) || JSON.stringify(plan.snapshot.schedule.omitted) !== JSON.stringify(plan.omitted)) {
    context.addIssue({ code: "custom", message: "Saved visit order must match its timed itinerary.", path: ["snapshot"] });
  }
});
export type SavedPlan = z.infer<typeof savedPlanSchema>;
export type PlanResult = { status?: "verified"; schedule: Schedule; places: Record<string, Place>; verified: boolean };
export const planningFailureCodeSchema = z.enum(["hard-input-conflict", "sampled-model-conflict", "missing-data", "search-incomplete", "provider-error", "budget-exhausted", "verification-failed"]);
export type PlanningFailureCode = z.infer<typeof planningFailureCodeSchema>;
// A one-click change that resolves a planning failure for one visit; never touches bookings.
export const planningFixSchema = z.object({ stopId: z.string(), stopName: z.string(), issue: z.string(), action: z.enum(["optimize-day", "make-optional"]) });
export type PlanningFix = z.infer<typeof planningFixSchema>;

export function applyPlanningFixes(trip: Trip, fixes: PlanningFix[]): Trip {
  return { ...trip, stops: trip.stops.map((stop) => {
    const fix = stop.fixedTime ? undefined : fixes.find((candidate) => candidate.stopId === stop.id);
    return fix?.action === "optimize-day" ? { ...stop, day: null } : fix?.action === "make-optional" ? { ...stop, optional: true } : stop;
  }) };
}
export const provisionalPlanSchema = z.object({
  status: z.literal("provisional"),
  verified: z.literal(false),
  code: planningFailureCodeSchema,
  message: z.string(),
  outline: z.array(z.object({ groupId: z.uuid().optional(), stopIds: z.array(z.uuid()), allowedDays: z.array(z.number().int().min(0).max(6)) })),
  unresolved: z.array(z.object({ groupId: z.uuid().optional(), day: z.number().int().min(0).max(6).optional(), direction: z.enum(["outbound", "return", "internal", "verification"]), outcome: z.enum(["unqueried", "noRoute", "providerError", "excluded", "outsideHorizon", "unverified"]) })),
  warnings: z.array(z.string()),
});
export type ProvisionalPlan = z.infer<typeof provisionalPlanSchema>;
export type PlanningPreview = PlanResult | ProvisionalPlan;

export type BookingTravelCheck = { connections: { day: number; from: string; to: string; availableMinutes: number; minutes: number | null; mode: TravelMode | null }[]; warnings: string[] };
export type DurationRule = "original" | "eatery10" | "eatery20" | "short";
export type PlanningResolution = { keepTimeIds: string[]; movableDayIds: string[]; optionalIds: string[]; durationReductionPercent?: 0 | 10 | 20; durationRules?: Record<string, DurationRule> };

export function durationChoices(duration: number, rule: DurationRule): number[] {
  if (rule === "original") return [duration];
  if (rule === "short") {
    if (duration !== 15) throw new Error("The short-visit option applies only to a 15-minute visit.");
    return [15, 10];
  }
  if (rule !== "eatery10" && rule !== "eatery20") throw new Error("Choose a supported duration policy.");
  return [...new Set([duration, Math.max(5, Math.ceil(duration * 0.9)), ...(rule === "eatery20" ? [Math.max(5, Math.ceil(duration * 0.8))] : [])])];
}

export function applyScheduleDurations(trip: Trip, schedule: Schedule): Trip {
  const durations = new Map(schedule.days.flatMap((day) => day.visits.map((visit) => [visit.stopId, visit.end - visit.start] as const)));
  return { ...trip, stops: trip.stops.map((stop) => {
    const duration = durations.get(stop.id) ?? stop.duration;
    if (!(stop.fixedTime ? [stop.duration] : stop.durationOptions ?? [stop.duration]).includes(duration)) throw new Error(`${stop.name}: the proposed duration was not approved.`);
    const next = { ...stop, duration };
    delete next.durationOptions;
    return next;
  }) };
}

export function resolvePlanningConstraints(trip: Trip, choices: PlanningResolution): Trip {
  const ids = new Set(trip.stops.map((stop) => stop.id));
  if ([...choices.keepTimeIds, ...choices.movableDayIds, ...choices.optionalIds, ...Object.keys(choices.durationRules ?? {})].some((id) => !ids.has(id))) throw new Error("A selected visit is no longer in this trip. Review your choices.");
  const reduction = choices.durationReductionPercent ?? 0;
  if (![0, 10, 20].includes(reduction)) throw new Error("Choose a duration reduction of 0%, 10%, or 20%.");
  return tripSchema.parse({ ...trip, stops: trip.stops.map((stop) => {
    if (stop.fixedTime && choices.keepTimeIds.includes(stop.id)) {
      if (choices.movableDayIds.includes(stop.id) || choices.optionalIds.includes(stop.id)) throw new Error(`${stop.name} is a fixed reservation and cannot move days or become optional.`);
      const locked = { ...stop };
      delete locked.durationOptions;
      return locked;
    }
    if (choices.durationRules) {
      const next = { ...stop, fixedTime: null, day: choices.movableDayIds.includes(stop.id) ? null : stop.day, optional: stop.optional || choices.optionalIds.includes(stop.id) };
      delete next.durationOptions;
      const options = durationChoices(stop.duration, choices.durationRules[stop.id] ?? "original");
      return options.length > 1 ? { ...next, durationOptions: options } : next;
    }
    return { ...stop, fixedTime: null, day: choices.movableDayIds.includes(stop.id) ? null : stop.day, optional: stop.optional || choices.optionalIds.includes(stop.id), duration: Math.max(5, Math.ceil(stop.duration * (100 - reduction) / 100)) };
  }) });
}

export function planningPreferences(trip: Trip): PlanningPreferences {
  return trip.planning ?? defaultPlanningPreferences;
}

export function travelModes(trip: Trip, stop?: Stop): TravelMode[] {
  const mode = stop && stop.mode !== "AUTO" ? stop.mode : planningPreferences(trip).mode;
  return mode === "AUTO" ? ["WALK", "TRANSIT"] : [mode];
}

export const maxWalkMeters = 1500;

export function allowsTravelEdge(trip: Trip, edge: TravelEdge) {
  const limit = planningPreferences(trip).maxWalkMinutes;
  return travelModes(trip, trip.stops.find((stop) => stop.id === edge.to)).includes(edge.mode)
    && (edge.mode !== "WALK" || ((limit === null || edge.minutes <= limit) && edge.meters <= maxWalkMeters));
}

export function newStop(name = ""): Stop {
  return { id: crypto.randomUUID(), name, placeId: null, duration: 45, day: null, fixedTime: null, buffer: 15, optional: false, priority: 1, mode: "AUTO", source: "" };
}

export function newTrip(): Trip {
  return {
    id: crypto.randomUUID(), title: "Untitled trip", city: "", hotel: "", hotelPlaceId: null,
    startDate: Temporal.Now.plainDateISO().add({ days: 1 }).toString(), days: 3,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    dailyStart: "09:00", dailyEnd: "18:00", returnToHotel: true, stops: [],
  };
}

export function tripDate(trip: Trip, day: number) {
  return Temporal.PlainDate.from(trip.startDate).add({ days: day }).toString();
}

export function instantAt(trip: Trip, day: number, time: string) {
  return Temporal.ZonedDateTime.from(`${tripDate(trip, day)}T${time}[${trip.timeZone}]`, { disambiguation: "reject" }).toInstant();
}

// "Sightseeing ends" bounds the last visit; the trip back to the hotel may follow, up to this many minutes later.
export const hotelReturnAllowance = 120;
export function returnDeadline(trip: Trip, day: number) {
  return minuteAt(trip, day, trip.dailyEnd) + hotelReturnAllowance;
}

export function minuteAt(trip: Trip, day: number, time: string) {
  return (instantAt(trip, day, time).epochMilliseconds - instantAt(trip, day, "00:00").epochMilliseconds) / 60_000;
}

export function bookingConflictDetails(trip: Trip) {
  const issues: { day: number; stopIds: string[]; message: string }[] = [];
  for (let day = 0; day < trip.days; day++) {
    const start = minuteAt(trip, day, trip.dailyStart);
    const end = minuteAt(trip, day, trip.dailyEnd);
    const booked = trip.stops.filter((stop) => stop.day === day && stop.fixedTime).map((stop) => ({ stop, at: minuteAt(trip, day, stop.fixedTime!) })).sort((left, right) => left.at - right.at);
    for (const { stop, at } of booked) {
      if (at < start) issues.push({ day, stopIds: [stop.id], message: `Day ${day + 1}: ${stop.name} is booked at ${stop.fixedTime}, before the day starts.` });
      else if (at + stop.duration > end) issues.push({ day, stopIds: [stop.id], message: `Day ${day + 1}: ${stop.name} (${stop.fixedTime}, ${stop.duration} min) ends after the day ends.` });
    }
    booked.slice(1).forEach(({ stop, at }, index) => {
      const previous = booked[index];
      const needed = previous.stop.duration + stop.buffer;
      if (at - previous.at < needed) issues.push({ day, stopIds: [previous.stop.id, stop.id], message: `Day ${day + 1}: ${previous.stop.name} (${previous.stop.fixedTime}) and ${stop.name} (${stop.fixedTime}) are too close; ${needed} min needed, ${Math.round(at - previous.at)} available.` });
    });
  }
  return issues;
}

export function bookingConflicts(trip: Trip) {
  return bookingConflictDetails(trip).map((issue) => issue.message);
}

export function instantForMinute(trip: Trip, day: number, minute: number) {
  return instantAt(trip, day, "00:00").add({ milliseconds: Math.round(minute * 60_000) });
}

export function bookingTimeSuggestion(trip: Trip, stopId: string): string | null {
  const stop = trip.stops.find((item) => item.id === stopId);
  if (!stop?.fixedTime || stop.day === null) return null;
  const current = minuteAt(trip, stop.day, stop.fixedTime);
  const latest = minuteAt(trip, stop.day, trip.dailyEnd) - stop.duration;
  let earliest = minuteAt(trip, stop.day, trip.dailyStart) + stop.buffer;
  const booked = trip.stops.filter((other) => other.id !== stop.id && other.day === stop.day && other.fixedTime)
    .map((other) => ({ stop: other, at: minuteAt(trip, stop.day!, other.fixedTime!) })).sort((left, right) => left.at - right.at);
  const windows: { start: number; end: number }[] = [];
  for (const other of booked) {
    windows.push({ start: earliest, end: Math.min(latest, other.at - other.stop.buffer - stop.duration) });
    earliest = Math.max(earliest, other.at + other.stop.duration + stop.buffer);
  }
  windows.push({ start: earliest, end: latest });
  const candidates = windows.filter((window) => window.start <= window.end)
    .map((window) => Math.min(Math.max(current, window.start), window.end))
    .sort((left, right) => Math.abs(left - current) - Math.abs(right - current) || left - right);
  const suggested = candidates[0];
  return suggested === undefined || suggested === current ? null : formatMinute(trip, stop.day, suggested);
}

export function formatMinute(trip: Trip, day: number, minute: number) {
  return instantForMinute(trip, day, minute).toZonedDateTimeISO(trip.timeZone).toPlainTime().toString({ smallestUnit: "minute" });
}

export function persistedPlan(schedule: Schedule, trip?: Trip, places: Record<string, Place> = {}): SavedPlan {
  return savedPlanSchema.parse({
    days: schedule.days.map(({ day, visits }) => ({ day, stopIds: visits.map((visit) => visit.stopId) })), omitted: schedule.omitted,
    ...(trip ? { snapshot: { trip, schedule, places } } : {}),
  });
}

export function changeStartDate(trip: Trip, startDate: string): Trip {
  const offset = Temporal.PlainDate.from(startDate).until(Temporal.PlainDate.from(trip.startDate)).days;
  const stops = trip.stops.map((stop) => {
    if (stop.day === null) return stop;
    const day = stop.day + offset;
    if (day < 0 || day >= trip.days) throw new Error(`${stop.name} would fall outside the new dates. Adjust its assigned date explicitly first.`);
    return { ...stop, day };
  });
  return { ...trip, startDate, stops };
}