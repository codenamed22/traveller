import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { cityTripSchema, journeySchema, type Journey } from "./journey";
import { bookingConflicts, changeStartDate, lateBookings, formatMinute, maxStopsPerCity, newStop, planningKey, squeezeInNote, timeSchema, tripDate, visitKindSchema, visitSlotSchema, type Stop, type Trip } from "./trip";
import { dayLabel, markDone, markSkipped, minuteNow, tripModeDays } from "./trip-mode";

// Small trip edits the assistant can propose. Nothing is applied until the traveller approves the proposal card, and the
// same function validates a proposal on the server and applies it in the browser. Day numbers are 1-based within a city
// (Day 1 is the city's first day), as people say them; null means flexible.
const day = z.number().int().min(1).max(7).nullable();
const id = z.string().min(1).max(100);
const location = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict();

// One flat object per change, rather than a union of shapes: small models fill a flat schema far more reliably. Field
// names match the trip data the model reads (day, booked, minutes, travel), and applyOperations checks which fields
// each type needs.
export const operationTypes = ["add_stop", "update_stop", "remove_stop", "update_city", "update_transfer", "mark_progress"] as const;
export const operationSchema = z.object({
  type: z.enum(operationTypes).describe("add_stop needs cityId and name; update_stop, remove_stop and mark_progress need stopId; update_city needs cityId; update_transfer needs cityId and transfer"),
  cityId: id.optional(), stopId: id.optional(),
  name: z.string().trim().min(1).max(200).optional().describe("add_stop: the place's name; update_stop: a new name"),
  place: z.object({ placeId: z.string().min(1).max(300), location }).strict().optional().describe("add_stop: placeId and location from find_place, so the place is on the map"),
  day: day.optional().describe("Day number within the city, 1 = its first day; null = flexible"),
  booked: timeSchema.nullable().optional().describe("Booking time HH:MM, which needs a day; null removes the booking"),
  minutes: z.number().int().min(5).max(480).optional().describe("How long the visit lasts; new places default to 45"),
  buffer: z.number().int().min(0).max(120).optional().describe("Minutes kept free before the visit"),
  optional: z.boolean().optional().describe("true = nice to have; the planner may leave it out"),
  travel: z.enum(["auto", "walk", "transit"]).optional().describe("How to get there"),
  slot: visitSlotSchema.nullable().optional().describe("Time of day it suits; null clears it"),
  kind: visitKindSchema.optional(),
  note: z.string().trim().max(500).optional().describe("add_stop or update_stop: the traveller's own note on the place, replacing any earlier one; empty removes it"),
  dailyStart: timeSchema.optional(), dailyEnd: timeSchema.optional(), returnToHotel: z.boolean().optional(),
  days: z.number().int().min(1).max(7).optional().describe("update_city: length of the stay"), startDate: z.iso.date().optional().describe("update_city: first day, YYYY-MM-DD"),
  transfer: z.enum(["arrival", "departure"]).optional(), time: timeSchema.optional().describe("update_transfer: arrival or departure time"),
  reference: z.string().trim().max(100).optional().describe("update_transfer: flight or train number; empty removes it"),
  status: z.enum(["done", "skipped"]).optional().describe("mark_progress"),
}).strict();
export type Operation = z.infer<typeof operationSchema>;

export const proposalSchema = z.object({
  summary: z.string().trim().min(1).max(200).describe("One short line for the card title, e.g. 'Fit Rum Baba into Day 3'"),
  operations: z.array(operationSchema).min(1).max(15),
});
export type Proposal = z.infer<typeof proposalSchema>;
// What propose_changes returns, and what the browser draws the card from.
export const proposalOutputSchema = proposalSchema.extend({ ok: z.boolean(), changes: z.array(z.string()), warnings: z.array(z.string()), errors: z.array(z.string()) });
export type ProposalOutput = z.infer<typeof proposalOutputSchema>;

export type KnownPlace = { placeId: string; location: { lat: number; lng: number } };

// The model copies place ids by hand and can get a character wrong, which Google only rejects later, at planning. A new
// place keeps its map link only when the assistant has seen it (in the trip, or in a find_place result): the same id,
// or failing that the same spot within about 30 m. Otherwise it is added by name, to confirm on the map.
export function checkedPlaces(operations: Operation[], known: KnownPlace[]): Operation[] {
  return operations.map((operation) => {
    if (operation.type !== "add_stop" || !operation.place) return operation;
    const { placeId, location: spot } = operation.place;
    const match = known.find((place) => place.placeId === placeId)
      ?? known.find((place) => Math.abs(place.location.lat - spot.lat) < 0.0003 && Math.abs(place.location.lng - spot.lng) < 0.0003);
    if (match) return { ...operation, place: { placeId: match.placeId, location: match.location } };
    const { place: _unchecked, ...rest } = operation;
    void _unchecked;
    return rest;
  });
}

export type ApplyResult = { journey: Journey; changes: string[]; warnings: string[]; staleCities: string[]; errors: string[] };

const dayText = (value: number | null) => value === null ? "Flexible" : `Day ${value + 1}`;
const modeText = { AUTO: "Auto", WALK: "Walk", TRANSIT: "Transit" } as const;
const modes = { auto: "AUTO", walk: "WALK", transit: "TRANSIT" } as const;

export function applyOperations(journey: Journey, operations: Operation[], now: Temporal.Instant = Temporal.Now.instant()): ApplyResult {
  const cities: Trip[] = structuredClone(journey.cities);
  const execution: NonNullable<Journey["execution"]> = structuredClone(journey.execution ?? {});
  const changes: string[] = []; const warnings: string[] = []; const errors: string[] = [];
  const touched = new Set<string>();

  const city = (cityId: string) => {
    const found = cities.find((candidate) => candidate.id === cityId);
    if (!found) throw new Error("That city isn't in this trip.");
    return found;
  };
  const stopIn = (stopId: string) => {
    for (const candidate of cities) {
      const index = candidate.stops.findIndex((stop) => stop.id === stopId);
      if (index >= 0) return { city: candidate, index, stop: candidate.stops[index] };
    }
    throw new Error("That place isn't in this trip.");
  };
  const toDay = (trip: Trip, value: number | null | undefined) => {
    if (value === undefined || value === null) return null;
    if (value > trip.days) throw new Error(`${trip.city} has only ${trip.days} ${trip.days === 1 ? "day" : "days"}.`);
    return value - 1;
  };

  for (const operation of operations) {
    const need = <T,>(value: T | undefined, field: string): T => {
      if (value === undefined) throw new Error(`${operation.type} needs ${field}.`);
      return value;
    };
    try {
      if (operation.type === "add_stop") {
        const trip = city(need(operation.cityId, "cityId"));
        if (trip.stops.length >= maxStopsPerCity) throw new Error(`${trip.city} already has ${maxStopsPerCity} places.`);
        const assigned = toDay(trip, operation.day);
        const stop: Stop = { ...newStop(need(operation.name, "name")), day: assigned, fixedTime: operation.booked ?? null, duration: operation.minutes ?? 45, optional: operation.optional ?? false };
        if (operation.place) { stop.placeId = operation.place.placeId; stop.location = operation.place.location; }
        if (operation.buffer !== undefined) stop.buffer = operation.buffer;
        if (operation.travel) stop.mode = modes[operation.travel];
        if (operation.slot && !stop.fixedTime) stop.slot = operation.slot;
        if (operation.kind) stop.kind = operation.kind;
        if (operation.note) stop.note = operation.note;
        if (stop.fixedTime && assigned === null) throw new Error(`${stop.name}: a booking needs a day.`);
        if (stop.fixedTime && stop.optional) throw new Error(`${stop.name}: a booking can't be optional.`);
        trip.stops.push(stop); touched.add(trip.id);
        changes.push(`+ ${stop.name} · ${dayText(assigned)}${stop.fixedTime ? ` · booked ${stop.fixedTime}` : stop.slot && stop.slot !== "any" ? ` · ${stop.slot}` : ""} · ${stop.duration} min${stop.optional ? " · optional" : ""} · ${stop.placeId ? "on the map" : "not on the map yet"}`);
        if (!stop.placeId) warnings.push(`Confirm ${stop.name} on the map before planning.`);
      } else if (operation.type === "update_stop") {
        const { city: trip, index, stop } = stopIn(need(operation.stopId, "stopId"));
        const next: Stop = { ...stop };
        const parts: string[] = [];
        if (operation.name !== undefined && operation.name !== stop.name) {
          next.name = operation.name; parts.push(`renamed to ${operation.name}`);
          if (stop.placeId) { next.placeId = null; delete next.location; warnings.push(`Renaming ${stop.name} clears its map location; confirm it again.`); }
        }
        if (operation.day !== undefined) {
          next.day = toDay(trip, operation.day);
          // Choosing Flexible clears the booked time, as in the editor.
          if (next.day === null && stop.fixedTime && operation.booked === undefined) { next.fixedTime = null; parts.push(`booking ${stop.fixedTime} removed`); }
          if (next.day !== stop.day) parts.push(`${dayText(stop.day)} → ${dayText(next.day)}`);
          // A place in a day trip takes the whole day trip with it: its other places and the day it's allowed on.
          const group = trip.dayGroups?.find((candidate) => candidate.stopIds.includes(stop.id));
          if (group && next.day !== null && !group.allowedDays.includes(next.day)) {
            group.allowedDays = [next.day];
            for (const member of trip.stops) if (member.id !== stop.id && group.stopIds.includes(member.id) && member.day !== null) member.day = next.day;
            parts.push(`${group.name} day trip moves with it`);
          }
        }
        if (operation.booked !== undefined && operation.booked !== stop.fixedTime) {
          next.fixedTime = operation.booked;
          parts.push(operation.booked === null ? `booking ${stop.fixedTime} removed` : stop.fixedTime ? `booking ${stop.fixedTime} → ${operation.booked}` : `booked ${operation.booked}`);
        }
        if (operation.optional !== undefined && operation.optional !== stop.optional) { next.optional = operation.optional; parts.push(operation.optional ? "required → optional" : "optional → required"); }
        if (operation.minutes !== undefined && operation.minutes !== stop.duration) { next.duration = operation.minutes; parts.push(`${stop.duration} → ${operation.minutes} min`); }
        if (operation.buffer !== undefined && operation.buffer !== stop.buffer) { next.buffer = operation.buffer; parts.push(`buffer ${stop.buffer} → ${operation.buffer} min`); }
        if (operation.travel !== undefined && modes[operation.travel] !== stop.mode) { next.mode = modes[operation.travel]; parts.push(`travel ${modeText[stop.mode]} → ${modeText[next.mode]}`); }
        if (operation.slot !== undefined && operation.slot !== (stop.slot ?? null)) {
          if (operation.slot === null) delete next.slot; else next.slot = operation.slot;
          parts.push(operation.slot === null ? "no time of day" : operation.slot);
        }
        if (operation.kind !== undefined && operation.kind !== stop.kind) { next.kind = operation.kind; parts.push(operation.kind); }
        if (operation.note !== undefined && operation.note !== (stop.note ?? "")) {
          if (operation.note) next.note = operation.note; else delete next.note;
          parts.push(operation.note ? `note: “${operation.note}”` : "note removed");
        }
        // Shortening choices start at the planned duration and never apply to bookings, so a change resets them.
        if (next.duration !== stop.duration || next.fixedTime !== stop.fixedTime) delete next.durationOptions;
        if (next.fixedTime && next.day === null) throw new Error(`${next.name}: a booking needs a day.`);
        if (next.fixedTime && next.optional) throw new Error(`${next.name}: a booking can't be optional.`);
        if (!parts.length) { warnings.push(`${stop.name}: nothing to change.`); continue; }
        trip.stops[index] = next; touched.add(trip.id);
        changes.push(`${stop.name}: ${parts.join(" · ")}`);
      } else if (operation.type === "remove_stop") {
        const { city: trip, stop } = stopIn(need(operation.stopId, "stopId"));
        trip.stops = trip.stops.filter((candidate) => candidate.id !== stop.id);
        if (trip.dayGroups) {
          const groups = trip.dayGroups.map((group) => ({ ...group, stopIds: group.stopIds.filter((member) => member !== stop.id) })).filter((group) => group.stopIds.length);
          if (groups.length) trip.dayGroups = groups; else delete trip.dayGroups;
        }
        touched.add(trip.id);
        changes.push(`− ${stop.name} removed`);
        if (stop.fixedTime) warnings.push(`${stop.name} had a booking at ${stop.fixedTime} on ${dayText(stop.day)}.`);
      } else if (operation.type === "update_city") {
        let trip = city(need(operation.cityId, "cityId"));
        const parts: string[] = [];
        const days = operation.days;
        if (days !== undefined && days !== trip.days) {
          const beyond = trip.stops.find((stop) => stop.day !== null && stop.day >= days);
          if (beyond) throw new Error(`${beyond.name} is on ${dayText(beyond.day)}, beyond the new dates. Move it first.`);
          if (trip.dayGroups?.some((group) => group.allowedDays.some((allowed) => allowed >= days))) throw new Error(`A day-trip group in ${trip.city} includes later days. Adjust it in the editor first.`);
          parts.push(`${trip.days} → ${days} days`);
          trip = { ...trip, days };
        }
        if (operation.startDate !== undefined && operation.startDate !== trip.startDate) {
          parts.push(`starts ${dayLabel(trip.startDate)} → ${dayLabel(operation.startDate)}`);
          trip = changeStartDate(trip, operation.startDate);
        }
        const start = operation.dailyStart ?? trip.dailyStart; const end = operation.dailyEnd ?? trip.dailyEnd;
        if (start !== trip.dailyStart || end !== trip.dailyEnd) { parts.push(`hours ${trip.dailyStart}–${trip.dailyEnd} → ${start}–${end}`); trip = { ...trip, dailyStart: start, dailyEnd: end }; }
        if (operation.returnToHotel !== undefined && operation.returnToHotel !== trip.returnToHotel) { parts.push(operation.returnToHotel ? "back to the hotel each evening" : "no return to the hotel each evening"); trip = { ...trip, returnToHotel: operation.returnToHotel }; }
        if (!parts.length) { warnings.push(`${trip.city}: nothing to change.`); continue; }
        cities[cities.findIndex((candidate) => candidate.id === trip.id)] = trip; touched.add(trip.id);
        changes.push(`${trip.city}: ${parts.join(" · ")}`);
      } else if (operation.type === "update_transfer") {
        const trip = city(need(operation.cityId, "cityId"));
        const kind = need(operation.transfer, "transfer");
        const transfer = trip[kind];
        if (!transfer) throw new Error(`${trip.city} has no ${kind} details yet; add them in the city settings.`);
        const next = { ...transfer };
        const parts: string[] = [];
        if (operation.time !== undefined && operation.time !== transfer.time) { next.time = operation.time; parts.push(`${transfer.time} → ${operation.time}`); }
        if (operation.reference !== undefined && operation.reference !== (transfer.reference ?? "")) {
          if (operation.reference) next.reference = operation.reference; else delete next.reference;
          parts.push(operation.reference ? `reference ${operation.reference}` : "reference removed");
        }
        if (!parts.length) { warnings.push(`${trip.city} ${kind}: nothing to change.`); continue; }
        trip[kind] = next; touched.add(trip.id);
        changes.push(`${trip.city} ${kind}: ${parts.join(" · ")}`);
      } else {
        const stopId = need(operation.stopId, "stopId"); const status = need(operation.status, "status");
        const entry = tripModeDays(cities, journey.plans, execution, now).find((candidate) => candidate.isToday && candidate.plan.visits.some((visit) => visit.stopId === stopId));
        if (!entry) throw new Error("Only today's planned visits can be marked done or skipped.");
        const stop = entry.cityTrip.stops.find((candidate) => candidate.id === stopId) ?? entry.trip.stops.find((candidate) => candidate.id === stopId)!;
        const progress = status === "done" ? markDone(entry, stop.id, minuteNow(entry, now)) : markSkipped(entry, stop);
        execution[entry.cityId] = { ...execution[entry.cityId], [entry.date]: progress };
        changes.push(status === "done" ? `✓ ${stop.name} done` : `Skip ${stop.name} today`);
      }
    } catch (cause) {
      errors.push(cause instanceof Error ? cause.message : "That change isn't possible.");
    }
  }
  if (errors.length) return { journey, changes: [], warnings: [], staleCities: [], errors };

  for (const trip of cities.filter((candidate) => touched.has(candidate.id))) {
    const parsed = cityTripSchema.safeParse(trip);
    if (!parsed.success) return { journey, changes: [], warnings: [], staleCities: [], errors: [`${trip.city}: ${parsed.error.issues[0]?.message ?? "invalid change."}`] };
    const before = journey.cities.find((candidate) => candidate.id === trip.id)!;
    const known = new Set(bookingConflicts(before));
    for (const conflict of bookingConflicts(trip)) if (!known.has(conflict)) warnings.push(conflict);
    const late = new Set(lateBookings(before));
    for (const notice of lateBookings(trip)) if (!late.has(notice)) warnings.push(notice);
  }
  // Validated, but returned as built: parsing reorders keys, and itineraries go stale by comparing JSON.
  const next: Journey = { ...journey, cities, ...(Object.keys(execution).length ? { execution } : {}) };
  const parsed = journeySchema.safeParse(next);
  if (!parsed.success) return { journey, changes: [], warnings: [], staleCities: [], errors: [parsed.error.issues[0]?.message ?? "That change isn't possible."] };
  const staleCities = cities.filter((trip) => touched.has(trip.id) && journey.plans[trip.id]?.snapshot && planningKey(journey.plans[trip.id].snapshot!.trip) !== planningKey(trip)).map((trip) => trip.id);
  for (const cityId of staleCities) warnings.push(`${cities.find((trip) => trip.id === cityId)!.city}'s itinerary will need replanning.`);
  return { journey: next, changes, warnings, staleCities, errors: [] };
}

function localNow(trip: Trip, now: Temporal.Instant) {
  try { return now.toZonedDateTimeISO(trip.timeZone).toPlainDateTime().toString({ smallestUnit: "minute" }).replace("T", " "); } catch { return undefined; }
}

function clock(trip: Trip, dayIndex: number, minute: number) {
  try { return formatMinute(trip, dayIndex, minute); } catch { return `${Math.floor(minute / 60)}:${String(Math.round(minute % 60)).padStart(2, "0")}`; }
}

// What the model sees of the trip: compact, with the ids it may use, the accepted itinerary with clock times, places left
// out with where they could still fit, and today's progress. Day numbers are 1-based, as in operations.
export function assistantContext(journey: Journey, view: { cityId?: string; day?: number; tripMode?: boolean }, now: Temporal.Instant) {
  const viewing = journey.cities.find((trip) => trip.id === view.cityId);
  return {
    trip: journey.title,
    viewing: viewing ? { cityId: viewing.id, city: viewing.city, day: view.day === undefined ? undefined : view.day + 1, tripMode: view.tripMode || undefined } : undefined,
    cities: journey.cities.map((trip) => {
      const snapshot = journey.plans[trip.id]?.snapshot;
      const name = (stopId: string) => snapshot?.trip.stops.find((stop) => stop.id === stopId)?.name ?? trip.stops.find((stop) => stop.id === stopId)?.name ?? "a place";
      let today: string | undefined;
      try { today = now.toZonedDateTimeISO(trip.timeZone).toPlainDate().toString(); } catch { today = undefined; }
      const progress = today ? journey.execution?.[trip.id]?.[today] : undefined;
      return {
        cityId: trip.id, city: trip.city, firstDay: trip.startDate, lastDay: tripDate(trip, trip.days - 1), days: trip.days, localNow: localNow(trip, now),
        hotel: trip.hotel || undefined, hours: `${trip.dailyStart}–${trip.dailyEnd}`, returnToHotel: trip.returnToHotel,
        arrival: trip.arrival ? { mode: trip.arrival.mode, time: trip.arrival.time, place: trip.arrival.place || undefined } : undefined,
        departure: trip.departure ? { mode: trip.departure.mode, time: trip.departure.time, place: trip.departure.place || undefined } : undefined,
        places: trip.stops.map((stop) => ({
          id: stop.id, name: stop.name, day: stop.day === null ? "flexible" : stop.day + 1, booked: stop.fixedTime ?? undefined, minutes: stop.duration,
          optional: stop.optional || undefined, slot: stop.slot, kind: stop.kind, travel: stop.mode === "AUTO" ? undefined : stop.mode.toLowerCase(), onMap: Boolean(stop.placeId && stop.location),
          source: stop.source ? stop.source.slice(0, 160) : undefined, note: stop.note || undefined,
          dayTrip: trip.dayGroups?.find((group) => group.stopIds.includes(stop.id))?.name,
        })),
        itinerary: snapshot ? {
          outOfDate: planningKey(snapshot.trip) !== planningKey(trip) || undefined,
          days: snapshot.schedule.days.map((planned) => ({
            day: planned.day + 1, date: planned.date,
            visits: planned.visits.map((visit) => `${clock(snapshot.trip, planned.day, visit.start)}–${clock(snapshot.trip, planned.day, visit.end)} ${name(visit.stopId)} (${Math.round(visit.leg.minutes)} min ${visit.leg.mode === "WALK" ? "walk" : "transit"} before)`),
          })),
          leftOut: snapshot.schedule.omitted.map(name),
          couldFit: snapshot.schedule.squeezeIns?.map((squeeze) => `${name(squeeze.stopId)}: ${squeezeInNote(snapshot.trip, squeeze)}`),
        } : undefined,
        today: progress ? { date: progress.date, done: progress.completed.map((visit) => name(visit.stopId)), skipped: progress.skipped.map(name) } : undefined,
      };
    }),
  };
}
