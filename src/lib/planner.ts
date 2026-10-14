import { Temporal } from "@js-temporal/polyfill";
import loadHighs from "highs";
import { allowsTravelEdge, allowsVisitPair, bookingConflicts, dayEnd, dayStart, directDeparture, endpointKey, formatMinute, groupAllowedDays, minuteAt, planningPreferences, returnDeadline, stopAllowedOnDay, tripDate, tripForDay, tripSchema, type Place, type PlanningFailureCode, type PlanningFix, type Schedule, type SqueezeIn, type TravelEdge, type Trip } from "./trip";
import { splitVisits, validateSchedule, type ScheduleBoundary } from "./schedule-validation";
import { alternativeGroups, capCategory, dailyCaps, isRequiredStop, openingIntervals, relaxAlternatives, timeTarget, type AlternativeGroup, type CapCategory } from "./visit-slots";

export { bookingConflicts } from "./trip";

let engine: ReturnType<typeof loadHighs> | undefined;

export function planningEngine() {
  return engine ??= loadHighs();
}

export class PlanningError extends Error {
  constructor(message: string, public readonly reason: "conflict" | "incomplete" = "incomplete", public readonly detailed = false, public readonly code: PlanningFailureCode = reason === "conflict" ? "sampled-model-conflict" : "search-incomplete", public readonly fixes: PlanningFix[] = []) {
    super(message);
    this.name = "PlanningError";
  }
}

export type SolverStage = {
  stage: "feasibility" | "optimization";
  outcome: "feasible" | "conflict" | "incomplete";
  elapsedMs: number;
  firstSolutionMs: number | null;
  columns: number | null;
  nodes: number | null;
  engine?: "highs" | "ortools";
  startupMs?: number;
  durationLevel?: number;
  objective?: "duration" | "balance" | "optional" | "travel";
  optimal?: boolean;
  objectiveValue?: number | null;
  constructionMs?: number;
  seeded?: boolean;
};
// `together`: sets of stops visited in one go when on the same day (a day trip planned alone for one day).
export type SolverOptions = { strategy?: "optimized" | "feasibility-first"; onStage?: (stage: SolverStage) => void; initialSchedule?: Schedule; boundary?: ScheduleBoundary; places?: Record<string, Place>; together?: string[][]; cautiousEstimates?: boolean };

// Exceeding a daily meal or coffee cap costs more than keeping a priority-1 optional visit is worth.
const capPenalty = 200_000;
// A second member of a "this or that" group is worth this many travel minutes per priority point: kept when nearby,
// dropped when it would need a detour. The first member is always required by the group row.
const alternativeBonus = 45;
// Each kilometre on the road costs this many travel minutes in the objective (never in timing). Sampled transit
// minutes swing with the departure time; distance does not, so near-ties go to the compact route instead of a zig-zag.
const distanceWeight = 1.5;
const travelCost = (edge: Pick<TravelEdge, "minutes" | "meters">) => edge.minutes + distanceWeight * edge.meters / 1000;

export function visitsOutsideHours(trip: Trip, schedule: Schedule, places?: Record<string, Place>) {
  return schedule.days.flatMap((day) => day.visits.filter((visit) => {
    const stop = trip.stops.find((candidate) => candidate.id === visit.stopId);
    const intervals = stop && !stop.fixedTime ? openingIntervals(trip, day.day, places?.[stop.id]) : null;
    return intervals !== null && !intervals.some(([open, close]) => visit.start >= open - 0.01 && visit.end <= close + 0.01);
  }));
}

type HourConflict = { message: string; fix: PlanningFix };

function openingHourConflicts(trip: Trip, groups: AlternativeGroup[], places?: Record<string, Place>): HourConflict[] {
  return trip.stops.filter((stop) => !stop.fixedTime && isRequiredStop(stop, groups) && places?.[stop.id]?.hours?.length).flatMap((stop) => {
    const shortest = Math.min(stop.duration, ...(stop.durationOptions ?? []));
    const fits = (day: number) => { const intervals = openingIntervals(trip, day, places![stop.id]); return intervals === null || intervals.some(([open, close]) => close - open >= shortest); };
    const tripDays = Array.from({ length: trip.days }, (_, day) => day);
    if (tripDays.filter((day) => stopAllowedOnDay(trip, stop, day)).some(fits)) return [];
    const openDays = tripDays.filter(fits);
    const fix = (issue: string, action: PlanningFix["action"]): PlanningFix => ({ stopId: stop.id, stopName: stop.name, issue, action });
    if (stop.day === null || !openDays.length) return [{ message: `${stop.name} is closed, or open for less than ${shortest} min, on every trip day (Google regular hours). Mark it optional or remove it.`, fix: fix("Closed, or open too briefly, on every trip day.", "make-optional") }];
    const days = openDays.map((day) => `Day ${day + 1}`).join(" and ");
    return [{ message: `${stop.name} is closed on Day ${stop.day + 1}, or open for less than ${shortest} min (Google regular hours); it is open on ${days}. Set its day to Optimize or one of those days, or mark it optional.`, fix: fix(`Closed on Day ${stop.day + 1}; open on ${days}.`, "optimize-day") }];
  });
}

// Holidays observed across most of Europe and the Americas, when Google's regular weekly hours often do not apply.
export function commonHoliday(date: string) {
  const day = Temporal.PlainDate.from(date);
  const fixed: Record<string, string> = { "01-01": "New Year's Day", "12-25": "Christmas Day", "12-26": "Boxing Day (St Stephen's Day)" };
  const name = fixed[date.slice(5)];
  if (name) return name;
  // Anonymous Gregorian algorithm for Easter Sunday.
  const year = day.year, a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const g = Math.floor((8 * b + 13) / 25), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 19 * l) / 433);
  const easter = Temporal.PlainDate.from({ year, month: Math.floor((h + l - 7 * m + 114) / 31), day: ((h + l - 7 * m + 114) % 31) + 1 });
  const offset = easter.until(day).days;
  return offset === -2 ? "Good Friday" : offset === 1 ? "Easter Monday" : null;
}

// Free time between visits worth pointing out: long enough for another sight or a deliberate rest.
const idleWarningMinutes = 90;

function timingWarnings(trip: Trip, schedule: Schedule, groups: AlternativeGroup[], places?: Record<string, Place>) {
  const warnings: string[] = [];
  const name = (id: string) => trip.stops.find((stop) => stop.id === id)?.name ?? id;
  const misses = schedule.days.flatMap((day) => day.visits.flatMap((visit) => {
    const stop = trip.stops.find((candidate) => candidate.id === visit.stopId)!;
    const target = timeTarget(trip, stop, day.day, { places });
    if (!target || (visit.start >= target.start - 5 && visit.start <= target.end + 5)) return [];
    return [`${stop.name} (${target.label}, planned ${formatMinute(trip, day.day, visit.start)})`];
  }));
  if (misses.length) warnings.push(`Outside preferred time: ${misses.slice(0, 5).join("; ")}${misses.length > 5 ? `; and ${misses.length - 5} more` : ""}. Adjust daily hours, days or durations if these matter.`);
  for (const day of schedule.days) {
    const counts = new Map<CapCategory, number>();
    for (const visit of day.visits) {
      const category = capCategory(trip, trip.stops.find((stop) => stop.id === visit.stopId)!, places?.[visit.stopId]);
      if (category) counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    for (const [category, count] of counts) if (count > dailyCaps[category]) warnings.push(`Day ${day.day + 1} has ${count} ${category === "coffee" ? "coffee stops" : `${category} places`}; required visits left no room to spread them out.`);
  }
  const visited = new Set(schedule.days.flatMap((day) => day.visits.map((visit) => visit.stopId)));
  for (const group of groups) {
    const kept = group.stopIds.filter((id) => visited.has(id));
    const dropped = group.stopIds.filter((id) => !visited.has(id));
    if (kept.length && dropped.length) warnings.push(`Kept ${kept.map(name).join(", ")} and left out ${dropped.map(name).join(", ")}: they were listed as alternatives and did not all fit.`);
  }
  for (const day of schedule.days) {
    const label = `Day ${day.day + 1}`;
    day.visits.forEach((visit, index) => {
      const previous = day.visits[index - 1];
      const idle = previous ? visit.start - previous.end - (Number.isFinite(visit.leg.minutes) ? visit.leg.minutes : 0) : 0;
      if (idle >= idleWarningMinutes) warnings.push(`${label} has ${Math.floor(idle / 60)} h ${String(Math.round(idle % 60)).padStart(2, "0")} min free between ${name(previous.stopId)} (ends ${formatMinute(trip, day.day, previous.end)}) and ${name(visit.stopId)} (${formatMinute(trip, day.day, visit.start)}), set by bookings, opening hours or preferred times. Add a nearby visit or keep it as rest time.`);
    });
    const holiday = commonHoliday(day.date);
    const regular = holiday ? day.visits.filter((visit) => { const stop = trip.stops.find((candidate) => candidate.id === visit.stopId); return stop && !stop.fixedTime && openingIntervals(trip, day.day, places?.[stop.id]) !== null; }) : [];
    if (holiday && regular.length) warnings.push(`${label} (${day.date}) is ${holiday}. Google lists only regular weekly hours for ${regular.slice(0, 4).map((visit) => name(visit.stopId)).join(", ")}${regular.length > 4 ? ` and ${regular.length - 4} more` : ""}; many venues close or shorten hours on holidays, so check before going.`);
    const last = day.visits.at(-1);
    const back = last && day.returnLeg && Number.isFinite(day.returnLeg.minutes) ? last.end + day.returnLeg.minutes : null;
    if (back !== null && back > minuteAt(trip, day.day, trip.dailyEnd) + 0.5) warnings.push(`${label}: back at the hotel around ${formatMinute(trip, day.day, back)}, after sightseeing ends at ${trip.dailyEnd}.`);
  }
  return warnings;
}

// Shortest sampled travel minutes between any two places on one day; a lower bound on any real leg.
// `via` gives the minutes spent at an intermediate place, or null when a route may not pass through it.
function shortestTravel(trip: Trip, travel: TravelEdge[], day: number, via: (id: string) => number | null = () => 0) {
  const ids = ["hotel", ...trip.stops.map((stop) => stop.id)];
  const shortest = ids.map((_, origin) => ids.map((_, destination) => origin === destination ? 0 : Infinity));
  for (const edge of travel.filter((edge) => edge.day === day && allowsTravelEdge(trip, edge) && Number.isFinite(edge.minutes) && edge.minutes >= 0 && Number.isFinite(edge.meters) && edge.meters >= 0)) {
    const origin = ids.indexOf(edge.from);
    const destination = ids.indexOf(edge.to);
    if (origin >= 0 && destination >= 0) shortest[origin][destination] = Math.min(shortest[origin][destination], edge.minutes);
  }
  for (let middle = 0; middle < ids.length; middle++) {
    const stay = via(ids[middle]);
    if (stay === null) continue;
    for (let origin = 0; origin < ids.length; origin++) for (let destination = 0; destination < ids.length; destination++) {
      shortest[origin][destination] = Math.min(shortest[origin][destination], shortest[origin][middle] + stay + shortest[middle][destination]);
    }
  }
  return (from: string, to: string) => shortest[ids.indexOf(from)]?.[ids.indexOf(to)] ?? Infinity;
}

// Whether a flexible stop fits inside its opening hours in some gap between the day's bookings, ignoring other flexible
// stops. Uses shortest sampled travel, so false proves no schedule exists; null means the hours or routes are unknown.
function fitsAroundBookings(trip: Trip, travel: TravelEdge[], stop: Trip["stops"][number], day: number, places?: Record<string, Place>, withHours = true): boolean | null {
  const intervals = withHours ? openingIntervals(trip, day, places?.[stop.id]) : [[-Infinity, Infinity] as [number, number]];
  if (intervals === null) return null;
  // Legs join consecutive visits directly, so a shorter chain must stop at a flexible visit and spend its duration there.
  const minimum = (other: Trip["stops"][number]) => Math.min(other.duration, ...(other.durationOptions ?? []));
  const minutes = shortestTravel(trip, travel, day, (id) => { const other = trip.stops.find((candidate) => candidate.id === id); return other && !other.fixedTime && other.id !== stop.id ? minimum(other) : null; });
  const duration = minimum(stop);
  const booked = trip.stops.filter((other) => other.id !== stop.id && other.day === day && other.fixedTime).map((other) => ({ id: other.id, start: minuteAt(trip, day, other.fixedTime!), buffer: other.buffer, end: minuteAt(trip, day, other.fixedTime!) + other.duration })).sort((left, right) => left.start - right.start);
  const lastEnd = dayEnd(trip, day);
  const gaps = [{ id: "hotel", end: dayStart(trip, day) }, ...booked].map((previous, index) => {
    const next = booked[index];
    return next ? { previous, next: next.id, deadline: next.start - next.buffer } : { previous, next: trip.returnToHotel ? "hotel" : null, deadline: trip.returnToHotel ? returnDeadline(trip, day) : lastEnd };
  });
  let unknown = false;
  for (const gap of gaps) {
    const there = minutes(gap.previous.id, stop.id);
    const back = gap.next ? minutes(stop.id, gap.next) : 0;
    if (!Number.isFinite(there) || !Number.isFinite(back)) { unknown = true; continue; }
    for (const [open, close] of intervals) {
      const start = Math.max(gap.previous.end + there, open, dayStart(trip, day));
      if (start + duration <= Math.min(close, lastEnd) + 0.01 && start + duration + back <= gap.deadline + 0.01) return true;
    }
  }
  return unknown ? null : false;
}

const hourConflictError = (issues: HourConflict[], capacity: HourConflict[] = []) => {
  const messages = [...issues, ...capacity].map((issue) => issue.message).filter(Boolean);
  const headline = issues.length ? "No schedule fits these bookings and opening hours." : "Not enough time on these days for the visits assigned to them.";
  return new PlanningError(`${headline} ${messages.slice(0, 5).join(" ")}${messages.length > 5 ? ` (${messages.length - 5} more)` : ""}`, "conflict", false, "sampled-model-conflict", [...issues, ...capacity].map((issue) => issue.fix));
};

function bookingHourConflicts(trip: Trip, travel: TravelEdge[], groups: AlternativeGroup[], places?: Record<string, Place>): HourConflict[] {
  const tripDays = Array.from({ length: trip.days }, (_, day) => day);
  return trip.stops.filter((stop) => !stop.fixedTime && stop.day !== null && isRequiredStop(stop, groups)).flatMap((stop) => {
    const day = stop.day!;
    // Closed days are reported by openingHourConflicts with a clearer message.
    const intervals = openingIntervals(trip, day, places?.[stop.id]) ?? [];
    if (!intervals.length || fitsAroundBookings(trip, travel, stop, day, places) !== false || fitsAroundBookings(trip, travel, stop, day, places, false) === false) return [];
    const hours = intervals.map(([open, close]) => `${formatMinute(trip, day, open)}–${formatMinute(trip, day, close)}`).join(", ");
    const bookings = trip.stops.filter((other) => other.day === day && other.fixedTime).sort((left, right) => left.fixedTime!.localeCompare(right.fixedTime!)).map((other) => `${other.name} ${other.fixedTime}`);
    const listed = bookings.length > 1 ? `${bookings.slice(0, -1).join(", ")} and ${bookings.at(-1)}` : bookings[0];
    const elsewhere = tripDays.filter((other) => other !== day && stopAllowedOnDay(trip, { ...stop, day: null }, other) && fitsAroundBookings(trip, travel, { ...stop, day: other }, other, places) !== false);
    const roomDays = elsewhere.map((other) => `Day ${other + 1}`).join(" and ");
    return [{
      message: `${stop.name} does not fit on Day ${day + 1}: it is open ${hours} (Google regular hours), and the gaps around ${bookings.length ? `the bookings at ${listed}` : "the day's hours"} are too short once sampled travel and booking buffers are counted. ${elsewhere.length ? `${roomDays} ${elsewhere.length > 1 ? "have" : "has"} room for it around the bookings; set its day to Optimize or one of those days, or mark it optional.` : "No other day has room for it around the bookings; mark it optional or remove it."}`,
      fix: { stopId: stop.id, stopName: stop.name, issue: `Open ${hours}, which leaves no gap around Day ${day + 1}'s bookings.${elsewhere.length ? ` ${roomDays} ${elsewhere.length > 1 ? "have" : "has"} room.` : ""}`, action: elsewhere.length ? "optimize-day" : "make-optional" },
    }];
  });
}

// Waiting for a later anchor (a booking, an opening time, a preferred time such as dusk) moves to the start of the day:
// earlier visits shift later, keeping `waitSlack` minutes before the anchor for a leg that runs long at its new
// departure time. A visit never moves past its opening hours, the end of its preferred window, the day's end or a
// booking, so the result stays valid; the order and legs are unchanged. The departure day is the exception (below).
const waitSlack = 10;
export function compactWaits(trip: Trip, schedule: Schedule, places?: Record<string, Place>): Schedule {
  return { ...schedule, days: schedule.days.map((day) => {
    const visits = day.visits.map((visit) => ({ ...visit }));
    for (let index = visits.length - 2; index >= 0; index--) {
      const [visit, next] = [visits[index], visits[index + 1]];
      const stop = trip.stops.find((candidate) => candidate.id === visit.stopId);
      const nextStop = trip.stops.find((candidate) => candidate.id === next.stopId);
      if (!stop || !nextStop || stop.fixedTime) continue;
      const room = next.start - next.leg.minutes - (nextStop.fixedTime ? nextStop.buffer : 0) - waitSlack - visit.end;
      const caps = [room, dayEnd(trip, day.day) - visit.end];
      const hours = openingIntervals(trip, day.day, places?.[stop.id]);
      if (hours) caps.push((hours.find(([open, close]) => visit.start >= open - 0.01 && visit.end <= close + 0.01)?.[1] ?? visit.end) - visit.end);
      const target = timeTarget(trip, stop, day.day, { places });
      if (target) caps.push(target.end - visit.start);
      const shift = Math.floor(Math.min(...caps));
      if (shift >= 1) { visit.start += shift; visit.end += shift; }
    }
    // On the departure day, visits after the last booking start as early as travel, opening hours and preferred windows
    // allow instead, so spare time sits before the train or flight rather than before the first visit.
    if (trip.departure && day.day === trip.days - 1) {
      let last = -1;
      visits.forEach((visit, index) => { if (trip.stops.find((stop) => stop.id === visit.stopId)?.fixedTime) last = index; });
      let ready = last >= 0 ? visits[last].end : dayStart(trip, day.day);
      for (const visit of visits.slice(last + 1)) {
        const stop = trip.stops.find((candidate) => candidate.id === visit.stopId);
        let earliest = ready + visit.leg.minutes;
        const open = openingIntervals(trip, day.day, places?.[visit.stopId])?.find(([start, close]) => visit.start >= start - 0.01 && visit.end <= close + 0.01)?.[0];
        if (open !== undefined) earliest = Math.max(earliest, open);
        const target = stop && timeTarget(trip, stop, day.day, { places });
        if (target && visit.start >= target.start) earliest = Math.max(earliest, target.start);
        const shift = Math.floor(visit.start - earliest);
        if (shift >= 1) { visit.start -= shift; visit.end -= shift; }
        ready = visit.end;
      }
    }
    return { ...day, visits };
  }) };
}

// What narrows a day's window, for messages: arrival on the first day, departure on the last, otherwise daily hours.
function windowReason(trip: Trip, day: number) {
  const [start, end] = [dayStart(trip, day), dayEnd(trip, day)];
  const parts: string[] = [];
  if (day === 0 && trip.arrival && start > minuteAt(trip, day, trip.dailyStart)) parts.push(`starts about ${formatMinute(trip, day, start)} after arriving at ${trip.arrival.time}`);
  if (trip.departure && day === trip.days - 1 && end < minuteAt(trip, day, trip.dailyEnd)) parts.push(`ends about ${formatMinute(trip, day, end)} to make the ${trip.departure.time} departure`);
  return parts.length ? `Day ${day + 1} ${parts.join(" and ")}` : `Day ${day + 1} runs ${formatMinute(trip, day, start)}–${formatMinute(trip, day, end)}`;
}

// Visits pinned to a day that cannot all fit its window, even with each visit's shortest sampled leg and shortest
// approved duration (so this never rejects a feasible day). The suggestion releases the visits that suit the day
// least, those whose preferred time falls outside the window, then the lowest priority, until typical legs fit.
// Rough minutes left across the whole trip for visits: day windows less each visit's shortest duration plus 25 min of
// travel (the estimate day assignment uses). An exclusive day trip takes one whole day and its members. Negative
// means the trip is overpacked, so a released visit cannot simply move to another day.
function tripSlack(trip: Trip) {
  const exclusive = (trip.dayGroups ?? []).filter((group) => group.exclusive);
  const reserved = new Set(exclusive.flatMap((group) => group.stopIds));
  const lengths = Array.from({ length: trip.days }, (_, day) => dayEnd(trip, day) - dayStart(trip, day));
  const capacity = lengths.reduce((total, length) => total + length - 25, 0) - exclusive.reduce((total, group) => total + Math.max(0, ...group.allowedDays.filter((day) => day < trip.days).map((day) => lengths[day] - 25)), 0);
  return capacity - trip.stops.filter((stop) => !reserved.has(stop.id) && !stop.optional).reduce((total, stop) => total + (stop.fixedTime ? stop.duration + stop.buffer : Math.min(stop.duration, ...(stop.durationOptions ?? []))) + 25, 0);
}

// Released visits move to another day while the trip clearly has room (an hour a day is kept for waits around
// bookings, which the estimate cannot see). Otherwise they may also move but become optional, kept only where they fit.
function releaseActions(trip: Trip, released: Trip["stops"]) {
  let room = tripSlack(trip) - 60 * trip.days;
  return released.map((stop) => {
    if (room >= 0) return "optimize-day" as const;
    room += Math.min(stop.duration, ...(stop.durationOptions ?? [])) + 25;
    return "flexible-optional" as const;
  });
}

const listNames = (names: string[]) => names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
const releaseAdvice = (released: Trip["stops"], actions: ReturnType<typeof releaseActions>) => {
  const moved = released.filter((_, index) => actions[index] === "optimize-day").map((stop) => stop.name);
  const optional = released.filter((_, index) => actions[index] === "flexible-optional").map((stop) => stop.name);
  return [moved.length ? `let the planner choose days for ${listNames(moved)}` : "", optional.length ? `the other days are nearly full, so let ${listNames(optional)} move to any day and keep ${optional.length > 1 ? "them" : "it"} only where there is room` : ""].filter(Boolean).join("; ");
};

// The visits that suit a day least come first: those whose preferred time falls outside the day's window, then the
// lowest priority, then the longest.
function releaseOrder(trip: Trip, day: number, stops: Trip["stops"], places?: Record<string, Place>) {
  const [start, end] = [dayStart(trip, day), dayEnd(trip, day)];
  const misfit = (stop: Trip["stops"][number]) => { const target = timeTarget(trip, stop, day, { places }); return target ? Math.max(0, start - target.end, target.start - end) : 0; };
  return [...stops].sort((left, right) => misfit(right) - misfit(left) || left.priority - right.priority || right.duration - left.duration);
}

// A visit at the station or airport you leave from (the same Google place, or within 200 m of it), on a trip whose last
// day goes straight there. A booked visit keeps its own time instead.
export function atDeparturePlace(trip: Trip, stopId: string, places?: Record<string, Place>) {
  const stop = trip.stops.find((candidate) => candidate.id === stopId);
  if (!stop || stop.fixedTime || !directDeparture(trip)) return false;
  const [here, there] = [places?.[stopId]?.location ?? stop.location, places?.departure?.location];
  return stop.placeId === trip.departure!.placeId || Boolean(here && there && kmBetween(here, there) <= 0.2);
}

export const kmBetween = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => Math.hypot((a.lat - b.lat) * 111.2, (a.lng - b.lng) * 111.2 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180));
const estimateFormula = (mode: TravelEdge["mode"], km: number) => mode === "WALK" ? Math.max(5, Math.ceil(km * 1.3 / 4.5 * 60) + 3) : Math.max(15, Math.ceil(12 + 4 * km));
const estimateBands = [1.2, 4];

// Straight-line travel minutes calibrated to the trip's own Google routes. Per mode and distance band (under 1.2 km,
// 1.2-4 km, farther) the formula is scaled by the median of real minutes over formula minutes (the 75th percentile when
// cautious, after an estimate failed verification), never below 1. Mid-distance transit is where the bare formula is
// most often optimistic (transfers and waits on short hops).
export function travelEstimator(edges: TravelEdge[], km: (edge: TravelEdge) => number | undefined, cautious = false) {
  const band = (distance: number) => estimateBands.filter((limit) => distance >= limit).length;
  const ratios = new Map<string, number[]>();
  for (const edge of edges) {
    if (edge.estimated || edge.assumed || !Number.isFinite(edge.minutes)) continue;
    const distance = km(edge);
    if (distance === undefined) continue;
    const key = `${edge.mode}|${band(distance)}`;
    ratios.set(key, [...(ratios.get(key) ?? []), edge.minutes / estimateFormula(edge.mode, distance)]);
  }
  const scale = new Map([...ratios].map(([key, values]) => {
    const sorted = values.sort((left, right) => left - right);
    return [key, sorted.length >= 5 ? Math.min(4, Math.max(1, sorted[Math.floor(sorted.length * (cautious ? 0.75 : 0.5))])) : 1];
  }));
  return (mode: TravelEdge["mode"], distance: number) => Math.ceil(estimateFormula(mode, distance) * (scale.get(`${mode}|${band(distance)}`) ?? 1));
}

// Sparse sampling can leave pairs of a day's own visits unconnected (each was sampled towards other neighbours). For a
// timing check, those pairs get straight-line walking and transit estimates from the place locations, calibrated to the
// day's real routes; transit is never estimated slower than two real legs through a third place.
function withDistanceEstimates(trip: Trip, day: number, stops: Trip["stops"], travel: TravelEdge[], places?: Record<string, Place>, cautious = false) {
  const ids = ["hotel", ...stops.map((stop) => stop.id)];
  const location = (id: string, role: "from" | "to") => places?.[endpointKey(trip, day, id, role)]?.location ?? (id === "hotel" ? trip.hotelLocation : trip.stops.find((stop) => stop.id === id)?.location);
  const estimate = travelEstimator(travel, (edge) => { const [a, b] = [location(edge.from, "from"), location(edge.to, "to")]; return a && b ? kmBetween(a, b) : undefined; }, cautious);
  // The fastest real route out of each place, for a two-leg bound: going via any place with real routes both ways is a
  // trip you could actually make, and far tighter than the formula for a day trip by train.
  const real = new Map<string, number>();
  for (const edge of travel) if (!edge.estimated && !edge.assumed && Number.isFinite(edge.minutes) && allowsTravelEdge(trip, edge)) real.set(`${edge.from}>${edge.to}`, Math.min(edge.minutes, real.get(`${edge.from}>${edge.to}`) ?? Infinity));
  const via = (from: string, to: string) => Math.min(Infinity, ...[...new Set(travel.map((edge) => edge.from))].map((hub) => (real.get(`${from}>${hub}`) ?? Infinity) + (real.get(`${hub}>${to}`) ?? Infinity)));
  const extra: TravelEdge[] = [];
  for (const from of ids) for (const to of ids) {
    if (from === to || (from === "hotel" && to === "hotel") || travel.some((edge) => edge.from === from && edge.to === to && Number.isFinite(edge.minutes))) continue;
    const [a, b] = [location(from, "from"), location(to, "to")];
    if (!a || !b) continue;
    const km = kmBetween(a, b);
    const twoLegs = via(from, to);
    for (const mode of ["WALK", "TRANSIT"] as const) {
      const edge: TravelEdge = { day, from, to, mode, minutes: mode === "TRANSIT" ? Math.min(estimate(mode, km), twoLegs) : estimate(mode, km), meters: Math.round(km * 1300), estimated: true };
      if (allowsVisitPair(trip, from, to) && allowsTravelEdge(trip, edge)) extra.push(edge);
    }
  }
  return [...travel, ...extra];
}

// For each place left out of the plan, where it fits best: before the first visit, between two, or after the last, open
// at that time. Later visits may start later, but only as far as their bookings, opening hours, the day's end and the
// trip back allow; nothing moves earlier or changes order. Ranked by the travel it adds plus half the delay to later
// visits (a day already at its meal or coffee cap counts as 20 min worse). Unsampled legs use calibrated estimates, so
// the times guide squeezing it in on the day; they are not a checked plan.
export function squeezeIns(trip: Trip, schedule: Schedule, travel: TravelEdge[], places?: Record<string, Place>): SqueezeIn[] {
  const fits: SqueezeIn[] = [];
  for (const id of schedule.omitted) {
    const stop = trip.stops.find((candidate) => candidate.id === id);
    if (!stop || stop.fixedTime) continue;
    const category = capCategory(trip, stop, places?.[id]);
    let best: { fit: SqueezeIn; rank: number } | undefined;
    for (const plan of schedule.days) {
      const day = plan.day;
      if (!stopAllowedOnDay(trip, stop, day) || trip.dayGroups?.some((group) => group.exclusive && !group.stopIds.includes(id) && plan.visits.some((visit) => group.stopIds.includes(visit.stopId)))) continue;
      const dayTravel = travel.filter((edge) => edge.day === day);
      const location = (node: string, role: "from" | "to") => places?.[endpointKey(trip, day, node, role)]?.location ?? (node === "hotel" ? trip.hotelLocation : trip.stops.find((candidate) => candidate.id === node)?.location);
      const estimate = travelEstimator(dayTravel, (edge) => { const [a, b] = [location(edge.from, "from"), location(edge.to, "to")]; return a && b ? kmBetween(a, b) : undefined; });
      const leg = (from: string, to: string) => {
        const real = Math.min(Infinity, ...dayTravel.filter((edge) => edge.from === from && edge.to === to && Number.isFinite(edge.minutes) && allowsTravelEdge(trip, edge)).map((edge) => edge.minutes));
        if (Number.isFinite(real)) return real;
        const [a, b] = [location(from, "from"), location(to, "to")];
        if (!a || !b) return Infinity;
        const km = kmBetween(a, b);
        return Math.min(...(["WALK", "TRANSIT"] as const).map((mode) => { const edge: TravelEdge = { day, from, to, mode, minutes: estimate(mode, km), meters: Math.round(km * 1300) }; return allowsTravelEdge(trip, edge) ? edge.minutes : Infinity; }));
      };
      const hours = openingIntervals(trip, day, places?.[id]);
      const same = category ? plan.visits.filter((visit) => { const other = trip.stops.find((candidate) => candidate.id === visit.stopId); return other && capCategory(trip, other, places?.[other.id]) === category; }).length : 0;
      for (let position = 0; position <= plan.visits.length; position++) {
        const [previous, next] = [plan.visits[position - 1], plan.visits[position]];
        const from = previous?.stopId ?? "hotel";
        const arrival = Math.max(dayStart(trip, day), (previous?.end ?? dayStart(trip, day)) + leg(from, id));
        const open = hours?.find(([opens, closes]) => Math.max(arrival, opens) + stop.duration <= closes);
        if (hours && !open) continue;
        const start = Math.max(arrival, open?.[0] ?? arrival);
        const end = start + stop.duration;
        if (!Number.isFinite(start) || end > dayEnd(trip, day)) continue;
        // The rest of the day after the insertion: each later visit starts when it can, no earlier than planned.
        let [cursor, at, delay, ok] = [end, id, 0, true];
        for (const visit of plan.visits.slice(position)) {
          const later = trip.stops.find((candidate) => candidate.id === visit.stopId);
          const arrive = cursor + (at === id ? leg(id, visit.stopId) : visit.leg.minutes) + (later?.fixedTime ? later.buffer : 0);
          const begin = later?.fixedTime ? visit.start : Math.max(visit.start, arrive);
          const length = visit.end - visit.start;
          const intervals = later?.fixedTime ? null : openingIntervals(trip, day, places?.[visit.stopId]);
          if (arrive > begin + 0.01 || begin + length > dayEnd(trip, day) || (intervals && !intervals.some(([opens, closes]) => begin >= opens - 0.01 && begin + length <= closes + 0.01))) { ok = false; break; }
          delay = Math.max(delay, begin - visit.start); cursor = begin + length; at = visit.stopId;
        }
        const back = trip.returnToHotel ? (at === id ? leg(id, "hotel") : plan.returnLeg?.minutes ?? leg(at, "hotel")) : 0;
        if (!ok || cursor + back > (trip.returnToHotel ? returnDeadline(trip, day) : dayEnd(trip, day)) + 0.01) continue;
        const replaced = next ? next.leg.minutes : trip.returnToHotel ? plan.returnLeg?.minutes ?? 0 : 0;
        const added = leg(from, id) + (next ? leg(id, next.stopId) : trip.returnToHotel ? leg(id, "hotel") : 0) - replaced;
        if (!Number.isFinite(added)) continue;
        const overCap = category && same >= dailyCaps[category] ? { category, count: same + 1 } : undefined;
        const fit: SqueezeIn = { stopId: id, day, ...(previous ? { after: previous.stopId } : next ? { before: next.stopId } : {}), start, end, extraMinutes: Math.max(0, added), ...(delay >= 1 ? { delayMinutes: Math.round(delay) } : {}), ...(overCap ? { overCap } : {}) };
        const rank = fit.extraMinutes + delay / 2 + (overCap ? 20 : 0);
        if (!best || rank < best.rank - 0.01) best = { fit, rank };
      }
    }
    if (best) fits.push(best.fit);
  }
  return fits;
}

// Exact check, after a failed solve, of each day's assigned visits alone on the sampled routes. A day that cannot fit
// releases visits (least suited first, preferring a single release that makes the day fit) until a short single-day
// solve succeeds. Days with day-trip members are skipped; the check stops at the deadline and is limited to the
// sampled routes, so it suggests rather than proves.
export async function blockedDayFixes(trip: Trip, travel: TravelEdge[], places: Record<string, Place> | undefined, deadline: number, seconds = 0.5): Promise<{ blocked: string[]; fixes: PlanningFix[] }> {
  const blocked: string[] = [];
  const fixes: PlanningFix[] = [];
  for (let day = 0; day < trip.days; day++) {
    // Optional visits can always be left out, so only the required ones decide whether the day fits.
    const assigned = trip.stops.filter((stop) => stop.day === day && !stop.optional);
    if (!assigned.length || trip.dayGroups?.some((group) => group.stopIds.some((id) => assigned.some((stop) => stop.id === id)))) continue;
    const edges = withDistanceEstimates(trip, day, assigned, travel.filter((edge) => edge.day === day), places).map((edge) => ({ ...edge, day: 0 }));
    // A busy day can take longer than the first time limit to prove either way, so an inconclusive check is retried
    // with more time while the deadline allows.
    const fits = async (stops: Trip["stops"]) => {
      for (const limit of [seconds, seconds * 4, seconds * 10]) {
        if (Date.now() > deadline - limit * 1000) return null;
        try { await solveTrip(tripForDay(trip, day, { stops: stops.map((stop) => ({ ...stop, day: 0 })), dayGroups: undefined }), edges, limit, { places, strategy: "feasibility-first" }); return true; }
        catch (error) {
          if (!(error instanceof PlanningError) || error.reason !== "incomplete") return error instanceof PlanningError && error.reason === "conflict" ? false : null;
        }
      }
      return null;
    };
    if (await fits(assigned) !== false) continue;
    let kept = assigned;
    const released: Trip["stops"] = [];
    let settled = false;
    while (!settled && released.length < 6) {
      const candidates = releaseOrder(trip, day, kept.filter((stop) => !stop.fixedTime), places);
      if (!candidates.length) break;
      let chosen: Trip["stops"][number] | undefined;
      for (const candidate of candidates.slice(0, 4)) {
        const result = await fits(kept.filter((stop) => stop.id !== candidate.id));
        if (result === null) break;
        if (result) { chosen = candidate; settled = true; break; }
      }
      chosen ??= candidates[0];
      released.push(chosen); kept = kept.filter((stop) => stop.id !== chosen.id);
      if (Date.now() > deadline - seconds * 1000) break;
    }
    // Releases forced before the deciding one may be unnecessary once it is gone: keep any that still fit.
    if (settled) for (const stop of [...released].reverse().slice(1)) {
      if (await fits([...kept, stop]) !== true) continue;
      kept = [...kept, stop]; released.splice(released.indexOf(stop), 1);
    }
    const reason = windowReason(trip, day);
    const actions = releaseActions(trip, released);
    blocked.push(`${reason} and cannot fit its ${assigned.length} assigned visits with the sampled routes${settled ? `. To fit, ${releaseAdvice(released, actions)}` : ""}.`);
    if (settled) fixes.push(...released.map((stop, index) => ({ stopId: stop.id, stopName: stop.name, issue: `${reason}; the day's other visits and bookings leave no room for it.${actions[index] === "flexible-optional" ? " Other days are nearly full." : ""}`, action: actions[index] })));
  }
  return { blocked, fixes };
}

// Visits in `released` already have a fix (for example opening hours) and no longer count against the day.
function dayCapacityConflicts(trip: Trip, travel: TravelEdge[], groups: AlternativeGroup[], places?: Record<string, Place>, released = new Set<string>()): HourConflict[] {
  return Array.from({ length: trip.days }, (_, day) => day).flatMap((day) => {
    const [start, end] = [dayStart(trip, day), dayEnd(trip, day)];
    const capacity = end - start - trip.stops.filter((stop) => stop.day === day && stop.fixedTime).reduce((total, stop) => total + stop.duration + stop.buffer, 0);
    const pinned = trip.stops.filter((stop) => stop.day === day && !stop.fixedTime && !released.has(stop.id) && isRequiredStop(stop, groups) && !trip.dayGroups?.some((group) => group.stopIds.includes(stop.id)));
    if (!pinned.length) return [];
    const legs = (id: string) => travel.filter((edge) => edge.day === day && edge.to === id && allowsTravelEdge(trip, edge) && Number.isFinite(edge.minutes)).map((edge) => edge.minutes).sort((left, right) => left - right);
    const shortest = (id: string) => legs(id)[0] ?? 0;
    const typical = (id: string) => { const sorted = legs(id); return sorted[Math.floor(sorted.length / 2)] ?? 0; };
    const visit = (stop: Trip["stops"][number]) => Math.min(stop.duration, ...(stop.durationOptions ?? []));
    const lower = pinned.reduce((total, stop) => total + visit(stop) + shortest(stop.id), 0);
    if (lower <= capacity) return [];
    let used = pinned.reduce((total, stop) => total + visit(stop) + typical(stop.id), 0);
    const moved: typeof pinned = [];
    for (const stop of releaseOrder(trip, day, pinned, places)) {
      if (used <= Math.max(0, capacity)) break;
      moved.push(stop); used -= visit(stop) + typical(stop.id);
    }
    const reason = windowReason(trip, day);
    const actions = releaseActions(trip, moved);
    const advice = releaseAdvice(moved, actions);
    return moved.map((stop, index) => ({
      message: index ? "" : `${reason}, leaving ${Math.max(0, Math.round(capacity))} min around bookings for ${pinned.length} visits assigned to it that need at least ${Math.round(lower)} min with the shortest sampled travel. To fit, ${advice}.`,
      fix: { stopId: stop.id, stopName: stop.name, issue: `${reason}; not enough time for it that day.${actions[index] === "flexible-optional" ? " Other days are nearly full." : ""}`, action: actions[index] },
    }));
  });
}

function bookingRouteConflicts(trip: Trip, travel: TravelEdge[]) {
  const issues: string[] = [];
  for (let day = 0; day < trip.days; day++) {
    const minutes = shortestTravel(trip, travel, day);
    let previous = { id: "hotel", name: `hotel start (${trip.dailyStart})`, end: dayStart(trip, day) };
    const booked = trip.stops.filter((stop) => stop.day === day && stop.fixedTime).sort((left, right) => left.fixedTime!.localeCompare(right.fixedTime!));
    const check = (id: string, name: string, deadline: number) => {
      const needed = minutes(previous.id, id);
      const available = deadline - previous.end;
      if (Number.isFinite(needed) && needed > available) issues.push(`Day ${day + 1}: ${previous.name} to ${name} leaves ${Math.round(available)} min for travel; sampled routes need at least ${Math.ceil(needed)} min.`);
    };
    for (const stop of booked) {
      const at = minuteAt(trip, day, stop.fixedTime!);
      const name = `${stop.name} (${stop.fixedTime})`;
      check(stop.id, name, at - stop.buffer);
      previous = { id: stop.id, name, end: at + stop.duration };
    }
    if (trip.returnToHotel && booked.length) check("hotel", "the hotel", returnDeadline(trip, day));
  }
  return issues;
}

export function sampledRouteReachability(trip: Trip, travel: TravelEdge[]) {
  return Array.from({ length: trip.days }, (_, day) => {
    const stops = trip.stops.filter((stop) => stopAllowedOnDay(trip, stop, day));
    const ids = new Set(["hotel", ...stops.map((stop) => stop.id)]);
    const minutes = dayEnd(trip, day) - dayStart(trip, day);
    const edges = travel.filter((edge) => edge.day === day && ids.has(edge.from) && ids.has(edge.to) && allowsVisitPair(trip, edge.from, edge.to) && allowsTravelEdge(trip, edge) && Number.isFinite(edge.minutes) && edge.minutes >= 0 && edge.minutes <= minutes && Number.isFinite(edge.meters) && edge.meters >= 0);
    const reachable = (reverse: boolean) => {
      const visited = new Set(["hotel"]);
      for (let size = 0; size !== visited.size;) {
        size = visited.size;
        for (const edge of edges) if (visited.has(reverse ? edge.to : edge.from)) visited.add(reverse ? edge.from : edge.to);
      }
      return visited;
    };
    const outbound = reachable(false);
    const inbound = reachable(true);
    const required = stops.filter((stop) => !stop.optional && stop.day === day);
    const noDeparture = required.length > 0 && outbound.size === 1;
    const noReturn = trip.returnToHotel && required.length > 0 && inbound.size === 1;
    return { day, stops, outbound, inbound, noDeparture, noReturn };
  });
}

export function sampledRouteGaps(trip: Trip, travel: TravelEdge[]) {
  const issues: string[] = [];
  const reachableDays = sampledRouteReachability(trip, travel);
  for (const { day, noDeparture, noReturn } of reachableDays) {
    if (noDeparture) issues.push(`Day ${day + 1}: no allowed sampled route connects the hotel to the required visits (start ${trip.dailyStart}).`);
    if (noReturn) issues.push(`Day ${day + 1}: no allowed sampled route connects the required visits back to the hotel.`);
  }
  for (const stop of trip.stops.filter((stop) => !stop.optional)) {
    const days = reachableDays.filter((_, day) => stopAllowedOnDay(trip, stop, day));
    if (days.some((day) => day.outbound.has(stop.id) && (!trip.returnToHotel || day.inbound.has(stop.id)))) continue;
    if (stop.day !== null && days[0] && (days[0].noDeparture || days[0].noReturn)) continue;
    issues.push(`${stop.day === null ? "Any available day" : `Day ${stop.day + 1}`}: ${stop.name} has no allowed sampled connection from the hotel${trip.returnToHotel ? " and back" : ""}.`);
  }
  for (const group of trip.dayGroups ?? []) {
    const required = trip.stops.filter((stop) => group.stopIds.includes(stop.id) && !stop.optional);
    if (required.length && !reachableDays.some((day) => groupAllowedDays(trip, group).includes(day.day) && required.every((stop) => day.outbound.has(stop.id) && (!trip.returnToHotel || day.inbound.has(stop.id))))) {
      issues.push(`${group.name}: grouped visits lack complete route coverage on a common allowed day.`);
    }
  }
  return issues;
}

// Builds a schedule by insertion and local search. With `start`, it only polishes that schedule's days.
function constructionHint(trip: Trip, travel: TravelEdge[], deadline: number, boundary?: ScheduleBoundary, places?: Record<string, Place>, alternatives: AlternativeGroup[] = [], start?: Schedule): Schedule | undefined {
  const edges = new Map<string, TravelEdge>();
  const key = (day: number, from: string, to: string) => JSON.stringify([day, from, to]);
  const bounds = Array.from({ length: trip.days }, (_, day) => ({ date: tripDate(trip, day), start: boundary?.startMinute ?? dayStart(trip, day), end: dayEnd(trip, day) }));
  const allowed = bounds.map((_, day) => trip.stops.map((stop) => stopAllowedOnDay(trip, stop, day)));
  const bookings = trip.stops.map((stop) => stop.fixedTime ? minuteAt(trip, stop.day!, stop.fixedTime) : null);
  const maxStops = planningPreferences(trip).maxStopsPerDay;
  const targets = bounds.map((_, day) => trip.stops.map((stop) => timeTarget(trip, stop, day, { places })));
  const categories = trip.stops.map((stop) => capCategory(trip, stop, places?.[stop.id]));
  const hours = bounds.map((_, day) => trip.stops.map((stop) => stop.fixedTime ? null : openingIntervals(trip, day, places?.[stop.id])));
  for (const edge of travel) {
    if (!allowsTravelEdge(trip, edge) || !allowsVisitPair(trip, edge.from, edge.to) || !Number.isFinite(edge.minutes) || edge.minutes < 0 || !Number.isFinite(edge.meters) || edge.meters < 0) continue;
    const previous = edges.get(key(edge.day, edge.from, edge.to));
    if (!previous || edge.minutes < previous.minutes) edges.set(key(edge.day, edge.from, edge.to), edge);
  }
  const groups = trip.dayGroups ?? [];
  const bonusGroups = alternatives.filter((group) => group.required);
  const bonus = trip.stops.map((stop) => !stop.fixedTime && bonusGroups.some((group) => group.stopIds.includes(stop.id)) ? alternativeBonus * stop.priority : 0);
  const startVisits = new Map(start?.days.flatMap((day) => day.visits.map((visit) => [visit.stopId, visit] as const)) ?? []);
  let best: { schedule: Schedule; value: number; cost: number } | undefined;
  for (let variant = 0; variant < (start ? 1 : trip.days * 2) && performance.now() < deadline; variant++) {
    const durations = trip.stops.map((stop) => { const visit = startVisits.get(stop.id); return visit ? visit.end - visit.start : variant < trip.days || stop.fixedTime ? stop.duration : stop.durationOptions?.at(-1) ?? stop.duration; });
    const groupDays = new Map<string, number>();
    let orders = start
      ? Array.from({ length: trip.days }, (_, day) => start.days.find((plan) => plan.day === day)?.visits.map((visit) => trip.stops.findIndex((stop) => stop.id === visit.stopId)) ?? [])
      : Array.from({ length: trip.days }, (_, day) => trip.stops.flatMap((stop, index) => stop.day === day && stop.fixedTime ? [index] : []).sort((left, right) => trip.stops[left].fixedTime!.localeCompare(trip.stops[right].fixedTime!)));
    if (start) for (const group of groups) { const day = orders.findIndex((order) => order.some((index) => group.stopIds.includes(trip.stops[index].id))); if (day >= 0) groupDays.set(group.id, day); }
    for (const group of groups) {
      const booking = trip.stops.find((stop) => group.stopIds.includes(stop.id) && stop.fixedTime);
      if (booking) groupDays.set(group.id, booking.day!);
    }
    // Earliest starts forward, latest feasible starts backward, then wait for each soft window only within that slack.
    const retime = (day: number, order: number[]): Schedule["days"][number] | null => {
      if (order.length > maxStops) return null;
      const end = bounds[day].end;
      const legs: TravelEdge[] = [];
      let from = boundary?.startId ?? "hotel";
      for (const index of order) {
        const leg = edges.get(key(day, from, trip.stops[index].id));
        if (!leg || !allowed[day][index]) return null;
        legs.push(leg); from = trip.stops[index].id;
      }
      const returnLeg = (order.length || boundary) && trip.returnToHotel ? edges.get(key(day, from, "hotel")) : undefined;
      if ((order.length || boundary) && trip.returnToHotel && !returnLeg) return null;
      const opening = (index: number, start: number) => {
        const intervals = hours[day][index];
        if (!intervals) return start;
        const open = intervals.find(([opens, closes]) => Math.max(start, opens) + durations[index] <= closes);
        return open ? Math.max(start, open[0]) : null;
      };
      const earliest: number[] = [];
      let departure = bounds[day].start;
      for (const [position, index] of order.entries()) {
        const arrival = departure + legs[position].minutes + (trip.stops[index].fixedTime ? trip.stops[index].buffer : 0);
        const start = bookings[index] ?? opening(index, arrival);
        if (start === null || arrival > start || start + durations[index] > end) return null;
        earliest.push(start); departure = start + durations[index];
      }
      if (returnLeg && departure + returnLeg.minutes > returnDeadline(trip, day)) return null;
      const latest: number[] = Array(order.length);
      let limit = returnLeg ? Math.min(end, returnDeadline(trip, day) - returnLeg.minutes) : end;
      for (let position = order.length - 1; position >= 0; position--) {
        const index = order[position];
        let start = bookings[index] ?? limit - durations[index];
        const intervals = hours[day][index];
        if (intervals && bookings[index] === null) {
          const open = [...intervals].reverse().find(([opens, closes]) => Math.max(opens, earliest[position]) <= Math.min(start, closes - durations[index]));
          if (!open) return null;
          start = Math.min(start, open[1] - durations[index]);
        }
        if (start < earliest[position] - 0.01) return null;
        latest[position] = start;
        limit = start - legs[position].minutes - (trip.stops[index].fixedTime ? trip.stops[index].buffer : 0);
      }
      const result: Schedule["days"][number] = { day, date: bounds[day].date, visits: [] };
      departure = bounds[day].start;
      for (const [position, index] of order.entries()) {
        const arrival = departure + legs[position].minutes + (trip.stops[index].fixedTime ? trip.stops[index].buffer : 0);
        const desired = targets[day][index]?.start ?? arrival;
        const start = bookings[index] ?? opening(index, Math.max(arrival, Math.min(desired, latest[position])));
        if (start === null || start > latest[position] + 0.01) return null;
        result.visits.push({ stopId: trip.stops[index].id, start, end: start + durations[index], leg: legs[position] });
        departure = start + durations[index];
      }
      if (returnLeg) result.returnLeg = returnLeg;
      return result;
    };
    const routeMinutes = (day: Schedule["days"][number]) => day.visits.reduce((total, visit) => {
      const target = targets[day.day][trip.stops.findIndex((stop) => stop.id === visit.stopId)];
      return total + travelCost(visit.leg) + (target ? target.weight * Math.max(0, target.start - visit.start, visit.start - target.end) : 0);
    }, day.returnLeg ? travelCost(day.returnLeg) : 0);
    const balanced = planningPreferences(trip).goal === "BALANCED";
    const dayCost = (day: number, order: number[]) => { const timed = retime(day, order); return timed ? routeMinutes(timed) : Infinity; };
    // With `one`, placing any single pending stop succeeds: used for "at least one of these alternatives".
    // Required stops go most-constrained first (fewest feasible positions), so easy stops cannot take the only gaps left
    // for hard ones. A stop with no position yet is retried later: sampled edges are sparse, so a neighbour may enable it.
    const insert = (pending: number[], required: boolean, restrictedDay?: number, one = false): boolean => {
      const constrained = required && !one;
      while (pending.length && performance.now() < deadline) {
        let best: { index: number; day: number; order: number[]; score: number; options: number } | undefined;
        for (const index of pending) {
          let own: typeof best;
          let options = 0;
          const stop = trip.stops[index];
          const ownGroup = groups.find((group) => group.stopIds.includes(stop.id));
          for (let offset = 0; offset < trip.days; offset++) {
            const day = (offset + variant) % trip.days;
            if (restrictedDay !== undefined && day !== restrictedDay) continue;
            if (!allowed[day][index] || (ownGroup && groupDays.has(ownGroup.id) && groupDays.get(ownGroup.id) !== day)) continue;
            if (groups.some((group) => group.exclusive && groupDays.get(group.id) === day && !group.stopIds.includes(stop.id))) continue;
            if (ownGroup?.exclusive && orders[day].some((other) => !ownGroup.stopIds.includes(trip.stops[other].id))) continue;
            const current = retime(day, orders[day]);
            if (!current) continue;
            const category = categories[index];
            // A required visit may exceed a meal or coffee cap, but only where no day under the cap takes it.
            const capped = Boolean(category && orders[day].filter((other) => categories[other] === category).length >= dailyCaps[category!]);
            if (!required && capped) continue;
            for (let position = 0; position <= orders[day].length; position++) {
              const order = [...orders[day].slice(0, position), index, ...orders[day].slice(position)];
              const candidate = retime(day, order);
              if (!candidate) continue;
              const score = (routeMinutes(candidate) - routeMinutes(current)) * 1000 + candidate.visits.at(-1)!.end - bounds[day].start + (capped ? capPenalty * 1000 : 0);
              options++;
              if (!own || score < own.score) own = { index, day, order, score, options: 0 };
            }
          }
          if (!own) continue;
          own.options = options;
          if (!best || (constrained ? own.options < best.options || (own.options === best.options && own.score < best.score) : own.score < best.score)) best = own;
          if (!required) break;
        }
        if (!best) return !required;
        orders[best.day] = best.order;
        const ownGroup = groups.find((group) => group.stopIds.includes(trip.stops[best.index].id));
        if (ownGroup) groupDays.set(ownGroup.id, best.day);
        pending.splice(pending.indexOf(best.index), 1);
        if (one) return true;
      }
      return !required || !pending.length;
    };
    if (!start) {
    let possible = true;
    for (const group of [...groups].sort((left, right) => groupAllowedDays(trip, left).length - groupAllowedDays(trip, right).length)) {
      const members = trip.stops.flatMap((stop, index) => group.stopIds.includes(stop.id) && !stop.optional && !stop.fixedTime ? [index] : []);
      if (!members.length) continue;
      const before = orders.map((order) => [...order]);
      const assignedDay = groupDays.get(group.id);
      let fitted = false;
      for (let offset = 0; offset < trip.days; offset++) {
        const day = (variant + offset) % trip.days;
        if (!groupAllowedDays(trip, group).includes(day) || (assignedDay !== undefined && day !== assignedDay)) continue;
        orders = before.map((order) => [...order]);
        groupDays.set(group.id, day);
        if (insert([...members], true, day)) { fitted = true; break; }
      }
      if (!fitted) { possible = false; break; }
    }
    if (!possible) continue;
    const required = trip.stops.flatMap((stop, index) => !stop.optional && !stop.fixedTime && !groups.some((group) => group.stopIds.includes(stop.id)) ? [index] : []);
    if (!insert(required, true)) continue;
    const placed = () => new Set(orders.flat().map((index) => trip.stops[index].id));
    if (!alternatives.filter((group) => group.required && !group.stopIds.some((id) => placed().has(id))).every((group) => insert(trip.stops.flatMap((stop, index) => group.stopIds.includes(stop.id) ? [index] : []), true, undefined, true))) continue;
    insert(trip.stops.flatMap((stop, index) => stop.optional && !placed().has(stop.id) ? [index] : []), false);
    }
    improve();
    if (start) search();
    const days = orders.map((order, day) => retime(day, order));
    if (days.some((day) => !day)) continue;
    const included = new Set(orders.flat());
    const schedule: Schedule = { days: days as Schedule["days"], omitted: trip.stops.filter((_, index) => !included.has(index)).map((stop) => stop.id), warnings: [], generatedAt: new Date().toISOString() };
    if (validateSchedule(trip, schedule, boundary).length) continue;
    // Prefer more optional value, then the lowest travel-and-timing cost.
    const value = [...included].reduce((total, index) => total + (trip.stops[index].optional && !bonus[index] ? trip.stops[index].priority : 0), 0);
    const cost = schedule.days.reduce((total, day) => total + routeMinutes(day), 0) - [...included].reduce((total, index) => total + bonus[index], 0);
    if (!best || value > best.value || (value === best.value && cost < best.cost - 0.01)) best = { schedule, value, cost };

    // Local search: relocate stops and reverse segments within each day, then move flexible stops between days,
    // repeating while the travel-and-timing cost falls. Greedy insertion alone leaves cross-town back-and-forth.
    function improve() {
      const cost = dayCost;
      const costs = orders.map((order, day) => cost(day, order));
      const accept = (day: number, candidate: number[]) => {
        const value = cost(day, candidate);
        if (value >= costs[day] - 0.01) return false;
        orders[day] = candidate; costs[day] = value;
        return true;
      };
      const free = (index: number) => !trip.stops[index].fixedTime && trip.stops[index].day === null && !groups.some((group) => group.stopIds.includes(trip.stops[index].id));
      for (let improved = true; improved && performance.now() < deadline;) {
        improved = false;
        for (let day = 0; day < trip.days; day++) {
          // Move a run of one to three consecutive visits (either way round) to another position in the day.
          for (let length = 1; length <= 3; length++) for (let from = 0; from + length <= orders[day].length; from++) {
            if (orders[day].slice(from, from + length).some((index) => trip.stops[index].fixedTime)) continue;
            for (let to = 0; to <= orders[day].length - length; to++) for (const reversed of length > 1 ? [false, true] : [false]) {
              if (to === from && !reversed) continue;
              const rest = [...orders[day]];
              const segment = rest.splice(from, length);
              rest.splice(to, 0, ...(reversed ? segment.reverse() : segment));
              if (accept(day, rest)) improved = true;
            }
          }
          for (let first = 0; first < orders[day].length - 1; first++) for (let last = first + 1; last < orders[day].length; last++) {
            if (accept(day, [...orders[day].slice(0, first), ...orders[day].slice(first, last + 1).reverse(), ...orders[day].slice(last + 1)])) improved = true;
          }
          // Drop an extra alternative when its detour costs more than it is worth and another member stays planned.
          for (const index of [...orders[day]]) {
            if (!bonus[index]) continue;
            const others = bonusGroups.filter((group) => group.stopIds.includes(trip.stops[index].id)).every((group) => orders.flat().some((other) => other !== index && group.stopIds.includes(trip.stops[other].id)));
            const remaining = orders[day].filter((other) => other !== index);
            const value = others ? cost(day, remaining) : Infinity;
            if (value < costs[day] - bonus[index] - 0.01) { orders[day] = remaining; costs[day] = value; improved = true; }
          }
        }
        if (balanced) continue;
        for (let source = 0; source < trip.days; source++) for (const index of [...orders[source]]) {
          if (!free(index) || performance.now() >= deadline) continue;
          const remaining = orders[source].filter((other) => other !== index);
          const left = cost(source, remaining);
          if (!Number.isFinite(left)) continue;
          let move: { target: number; order: number[]; value: number; delta: number } | undefined;
          for (let target = 0; target < trip.days; target++) {
            if (target === source || !allowed[target][index] || groups.some((group) => group.exclusive && groupDays.get(group.id) === target)) continue;
            const category = categories[index];
            if (category && orders[target].filter((other) => categories[other] === category).length >= dailyCaps[category]) continue;
            for (let position = 0; position <= orders[target].length; position++) {
              const order = [...orders[target].slice(0, position), index, ...orders[target].slice(position)];
              const value = cost(target, order);
              const delta = left + value - costs[source] - costs[target];
              if (delta < -0.01 && (!move || delta < move.delta)) move = { target, order, value, delta };
            }
          }
          if (!move) continue;
          orders[source] = remaining; costs[source] = left;
          orders[move.target] = move.order; costs[move.target] = move.value;
          improved = true;
        }
        // Swap two flexible visits between days, each taking the other's place.
        for (let first = 0; first < trip.days; first++) for (let second = first + 1; second < trip.days; second++) {
          for (let left = 0; left < orders[first].length && performance.now() < deadline; left++) for (let right = 0; right < orders[second].length; right++) {
            const [a, b] = [orders[first][left], orders[second][right]];
            if (!free(a) || !free(b) || !allowed[second][a] || !allowed[first][b] || (categories[a] !== categories[b] && (categories[a] || categories[b]))) continue;
            const one = orders[first].map((index) => index === a ? b : index);
            const two = orders[second].map((index) => index === b ? a : index);
            const [x, y] = [cost(first, one), cost(second, two)];
            if (x + y < costs[first] + costs[second] - 0.01) { orders[first] = one; orders[second] = two; costs[first] = x; costs[second] = y; improved = true; }
          }
        }
      }
    }

    // Ruin and recreate: take out a few neighbouring flexible visits, reinsert each at its cheapest position and polish
    // again, keeping the result only when the whole plan gets cheaper without losing optional visits. This escapes the
    // local optima single moves cannot, such as two nearby visits stranded together on the wrong side of town.
    function search() {
      const movable = orders.flat().filter((index) => !trip.stops[index].fixedTime && !groups.some((group) => group.stopIds.includes(trip.stops[index].id)));
      if (movable.length < 2) return;
      const gap = new Map<string, number>();
      for (const edge of edges.values()) gap.set(`${edge.from}|${edge.to}`, Math.min(gap.get(`${edge.from}|${edge.to}`) ?? Infinity, edge.minutes));
      const near = (from: number, to: number) => Math.min(gap.get(`${trip.stops[from].id}|${trip.stops[to].id}`) ?? Infinity, gap.get(`${trip.stops[to].id}|${trip.stops[from].id}`) ?? Infinity);
      const optionalValue = () => orders.flat().reduce((total, index) => total + (trip.stops[index].optional && !bonus[index] ? trip.stops[index].priority : 0), 0);
      const total = () => orders.reduce((sum, order, day) => sum + dayCost(day, order), 0) - orders.flat().reduce((sum, index) => sum + bonus[index], 0);
      const groupsKept = () => bonusGroups.every((group) => orders.flat().some((index) => group.stopIds.includes(trip.stops[index].id)));
      let seed = 2_147_483_647 % (trip.stops.length * 7919 + 1) || 1;
      const random = () => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647;
      let [value, current] = [optionalValue(), total()];
      for (let stale = 0; stale < 200 && performance.now() < deadline; stale++) {
        const saved = orders.map((order) => [...order]);
        const placed = orders.flat().filter((index) => movable.includes(index));
        if (!placed.length) break;
        const center = placed[Math.floor(random() * placed.length)];
        // Travel cost alone would pack days together, so a balanced plan only reshuffles within one day.
        const day = balanced ? orders.findIndex((order) => order.includes(center)) : undefined;
        const removed = [center, ...placed.filter((index) => index !== center && (day === undefined || orders[day].includes(index))).sort((left, right) => near(center, left) - near(center, right)).slice(0, 1 + Math.floor(random() * 3))];
        orders = orders.map((order) => order.filter((index) => !removed.includes(index)));
        const required = removed.filter((index) => !trip.stops[index].optional && !bonus[index]);
        const restored = insert(required, true, day) && bonusGroups.filter((group) => !orders.flat().some((index) => group.stopIds.includes(trip.stops[index].id))).every((group) => insert(removed.filter((index) => group.stopIds.includes(trip.stops[index].id)), true, day, true));
        if (restored && groupsKept()) {
          insert(removed.filter((index) => !orders.flat().includes(index)).sort(() => random() - 0.5), false, day);
          improve();
          const [nextValue, next] = [optionalValue(), total()];
          if (groupsKept() && orders.every((order, day) => Number.isFinite(dayCost(day, order))) && (nextValue > value || (nextValue === value && next < current - 0.01))) { [value, current] = [nextValue, next]; stale = -1; continue; }
        }
        orders = saved;
      }
    }
  }
  return best?.schedule;
}

// Decomposition fallback: fix each flexible visit's day, then solve every day as a small independent problem.
export async function solveTripByDays(input: Trip, travel: TravelEdge[], seconds = 5, options: SolverOptions = {}): Promise<Schedule> {
  const trip = tripSchema.parse(input);
  const alternatives = alternativeGroups(trip);
  const hourGaps = bookingHourConflicts(trip, travel, alternatives, options.places);
  const capacityGaps = dayCapacityConflicts(trip, travel, alternatives, options.places, new Set(hourGaps.map((issue) => issue.fix.stopId)));
  if (hourGaps.length || capacityGaps.length) throw hourConflictError(hourGaps, capacityGaps);
  const started = performance.now();
  const remaining = () => seconds - (performance.now() - started) / 1000;
  const groups = trip.dayGroups ?? [];
  const day = new Map<string, number>(trip.stops.flatMap((stop) => stop.day === null ? [] : [[stop.id, stop.day] as [string, number]]));
  const reserved = new Map<number, string>();
  const length = (index: number) => dayEnd(trip, index) - dayStart(trip, index);
  const load = (index: number) => trip.stops.filter((stop) => day.get(stop.id) === index).reduce((total, stop) => total + Math.min(stop.duration, ...(stop.durationOptions ?? [])) + 25, 25);
  for (const group of groups) {
    const fixed = trip.stops.find((stop) => group.stopIds.includes(stop.id) && stop.day !== null)?.day;
    const options = groupAllowedDays(trip, group).filter((candidate) => !reserved.has(candidate) && (fixed === undefined || candidate === fixed));
    const members = trip.stops.filter((stop) => group.stopIds.includes(stop.id));
    const chosen = options.sort((left, right) => load(left) - load(right) || right - left)[0];
    if (chosen === undefined) throw new PlanningError(`${group.name}: no day is available for this group.`, "conflict", true, "hard-input-conflict");
    members.forEach((stop) => day.set(stop.id, chosen));
    if (group.exclusive) reserved.set(chosen, group.id);
  }
  const fastest = (from: string, to: string, index: number) => Math.min(Infinity, ...travel.filter((edge) => edge.day === index && edge.from === from && edge.to === to && allowsTravelEdge(trip, edge)).map((edge) => edge.minutes));
  // Open for the whole visit at some point inside the day's window (unknown hours count as open).
  const opensFor = (stop: Trip["stops"][number], index: number) => {
    const intervals = openingIntervals(trip, index, options.places?.[stop.id]);
    return !intervals || intervals.some(([open, close]) => Math.min(close, dayEnd(trip, index)) - Math.max(open, dayStart(trip, index)) >= Math.min(stop.duration, ...(stop.durationOptions ?? [])));
  };
  const eligible = (stop: Trip["stops"][number], index: number) => stopAllowedOnDay(trip, stop, index) && !reserved.has(index) && (Boolean(stop.fixedTime) || (opensFor(stop, index) && fitsAroundBookings(trip, travel, stop, index, options.places) !== false));
  const category = (stop: Trip["stops"][number]) => capCategory(trip, stop, options.places?.[stop.id]);
  const alternativeKey = (stop: Trip["stops"][number]) => alternatives.find((group) => group.stopIds.includes(stop.id))?.key ?? stop.id;
  // Required visits are placed first; optional ones only go to days with estimated room and are otherwise left out.
  const free = trip.stops.filter((stop) => !day.has(stop.id)).sort((left, right) => Number(left.optional) - Number(right.optional) || right.duration - left.duration);
  const dropped: string[] = [];
  const place = (stop: Trip["stops"][number], excluded: number[] = []) => {
    const candidates = Array.from({ length: trip.days }, (_, index) => index).filter((index) => eligible(stop, index) && !excluded.includes(index));
    const score = (index: number) => {
      const peers = trip.stops.filter((other) => other.id !== stop.id && day.get(other.id) === index);
      const near = Math.min(fastest("hotel", stop.id, index), ...peers.map((peer) => Math.min(fastest(peer.id, stop.id, index), fastest(stop.id, peer.id, index))));
      // Meals and coffees spread across days: a day already at its cap (alternatives count once) takes another only when
      // no other day can, since each day is then solved alone and cannot move it; below the cap, fewer is better.
      const kind = category(stop);
      const same = kind ? new Set(peers.filter((peer) => category(peer) === kind).map(alternativeKey)).size : 0;
      const capCost = kind ? (same >= dailyCaps[kind] ? 100_000 : 30 * same) : 0;
      // A preferred time the day's window cannot meet at all, such as lunch on an afternoon arrival day.
      const target = timeTarget(trip, stop, index, { places: options.places });
      const targetCost = target && (target.end <= dayStart(trip, index) || target.start >= dayEnd(trip, index)) ? 120 : 0;
      return length(index) - load(index) - stop.duration - 2 * (Number.isFinite(near) ? near : 60) - capCost - targetCost;
    };
    const chosen = candidates.filter((index) => !stop.optional || score(index) >= 0).sort((left, right) => score(right) - score(left))[0];
    if (chosen === undefined) return false;
    day.set(stop.id, chosen);
    return true;
  };
  // The most constrained visit goes next (fewest days with room under its meal or coffee cap), so a visit that fits only
  // a few days is not crowded out by one that could go almost anywhere.
  const roomyDays = (stop: Trip["stops"][number]) => {
    const kind = category(stop);
    return Array.from({ length: trip.days }, (_, index) => index).filter((index) => eligible(stop, index) && (!kind || new Set(trip.stops.filter((other) => other.id !== stop.id && day.get(other.id) === index && category(other) === kind).map(alternativeKey)).size < dailyCaps[kind])).length;
  };
  for (const queue = [...free]; queue.length;) {
    const rank = (stop: Trip["stops"][number]) => [Number(stop.optional), roomyDays(stop), -stop.duration];
    const before = (left: number[], right: number[]) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
    const next = queue.reduce((best, stop) => before(rank(stop), rank(best)) < 0 ? stop : best);
    queue.splice(queue.indexOf(next), 1);
    if (place(next)) continue;
    if (next.optional) dropped.push(next.id);
    else if (isRequiredStop(next, alternatives)) throw new PlanningError(`${next.name} has no eligible day.`, "conflict", true, "hard-input-conflict");
  }
  const movable = new Set(free.map((stop) => stop.id));
  const solveDay = async (index: number) => {
    const stops = trip.stops.filter((stop) => day.get(stop.id) === index).map((stop) => ({ ...stop, day: 0 }));
    const single = tripForDay(trip, index, { stops, dayGroups: undefined });
    if (!stops.length) return { day: index, date: tripDate(trip, index), visits: [], omitted: [] as string[], loss: 0, optimal: true };
    const together = groups.map((group) => group.stopIds.filter((id) => day.get(id) === index)).filter((ids) => ids.length > 1);
    // Pairs of the day's own visits that sparse sampling left unconnected get distance estimates; verification replaces
    // every chosen leg with a real route.
    const dayTravel = withDistanceEstimates(trip, index, stops, travel.filter((edge) => edge.day === index), options.places, options.cautiousEstimates);
    // The time left is shared among the days still to plan, so the last days are not starved.
    const unplanned = Math.max(1, trip.days - results.size);
    const result = await solveTrip(single, dayTravel.map((edge) => ({ ...edge, day: 0 })), Math.max(1, Math.min(3, remaining() / unplanned)), { ...options, together });
    const plan = result.days[0];
    const shift = (edge: TravelEdge): TravelEdge => ({ ...edge, day: index });
    return { day: index, date: tripDate(trip, index), visits: plan.visits.map((visit) => ({ ...visit, leg: shift(visit.leg) })), ...(plan.returnLeg ? { returnLeg: shift(plan.returnLeg) } : {}), omitted: result.omitted, loss: result.optimization?.weightedDurationLoss ?? 0, optimal: result.optimization?.durationOptimal ?? true };
  };
  const results = new Map<number, Awaited<ReturnType<typeof solveDay>>>();
  const failed: number[] = [];
  const proven = new Set<number>();
  for (let index = 0; index < trip.days; index++) {
    try { results.set(index, await solveDay(index)); } catch (error) { if (!(error instanceof PlanningError)) throw error; failed.push(index); if (error.reason === "conflict") proven.add(index); }
  }
  for (const index of failed) {
    let solved = false;
    // Leaving out the day's flexible optional visits comes before moving required ones.
    const optional = trip.stops.filter((stop) => movable.has(stop.id) && stop.optional && day.get(stop.id) === index);
    if (optional.length && remaining() > 0.5) {
      optional.forEach((stop) => { day.delete(stop.id); dropped.push(stop.id); });
      try { results.set(index, await solveDay(index)); continue; } catch (error) { if (!(error instanceof PlanningError)) throw error; }
    }
    const candidates = trip.stops.filter((stop) => movable.has(stop.id) && day.get(stop.id) === index).sort((left, right) => left.duration - right.duration);
    for (const stop of candidates) {
      if (remaining() <= 0.5) break;
      const target = Array.from({ length: trip.days }, (_, other) => other).filter((other) => other !== index && !failed.includes(other) && eligible(stop, other)).sort((left, right) => load(left) - load(right))[0];
      if (target === undefined) continue;
      day.set(stop.id, target);
      // A move that the receiving day absorbs is kept even if this day still fails, so several visits can leave it.
      const [moved, rest] = await Promise.allSettled([solveDay(target), solveDay(index)]);
      for (const outcome of [moved, rest]) if (outcome.status === "rejected" && !(outcome.reason instanceof PlanningError)) throw outcome.reason;
      if (moved.status === "fulfilled") results.set(target, moved.value); else day.set(stop.id, index);
      if (moved.status === "fulfilled" && rest.status === "fulfilled") { results.set(index, rest.value); solved = true; break; }
    }
    // With nothing movable, a day the solver proved infeasible is a conflict in its assigned visits, not a timeout.
    if (!solved) throw proven.has(index) && !candidates.length
      ? new PlanningError(`Day ${index + 1} cannot fit the visits assigned to it with the sampled routes.`, "conflict")
      : new PlanningError(`Day ${index + 1} could not be planned with its assigned visits within the time limit.`, "incomplete");
  }
  const days = Array.from({ length: trip.days }, (_, index) => results.get(index)!);
  let schedule: Schedule = {
    days: days.map(({ day: index, date, visits, returnLeg }) => ({ day: index, date, visits, ...(returnLeg ? { returnLeg } : {}) })),
    omitted: [...days.flatMap((entry) => entry.omitted), ...dropped], warnings: ["Days were planned one at a time after assigning flexible visits to days; a better overall arrangement may exist."], generatedAt: new Date().toISOString(),
    optimization: { weightedDurationLoss: days.reduce((total, entry) => total + entry.loss, 0), durationOptimal: false, optionalOptimal: false, travelOptimal: false },
  };
  // Days were assigned greedily, so the joint plan's local search then works across them: moving or swapping flexible
  // visits between days under the same caps, opening hours and preferred times, keeping a change only when the whole
  // plan gets cheaper. The result is kept only if it is valid and each shared-day trip is still one outing.
  const relaxed = relaxAlternatives(trip, alternatives);
  const allTravel = Array.from({ length: trip.days }, (_, index) => withDistanceEstimates(trip, index, trip.stops.filter((stop) => stopAllowedOnDay(trip, stop, index)), travel.filter((edge) => edge.day === index), options.places, options.cautiousEstimates)).flat();
  const outings = groups.filter((group) => !group.exclusive).map((group) => group.stopIds);
  const polished = constructionHint(relaxed, allTravel, performance.now() + Math.max(300, Math.min(1500, remaining() * 1000)), undefined, options.places, alternatives, schedule);
  if (polished && !validateSchedule(trip, polished).length && !visitsOutsideHours(trip, polished, options.places).length && !polished.days.some((plan) => outings.some((ids) => splitVisits(plan.visits, ids)))) {
    const compact = compactWaits(trip, polished, options.places);
    const kept = !validateSchedule(trip, compact).length && !visitsOutsideHours(trip, compact, options.places).length ? compact : polished;
    schedule = { ...schedule, days: kept.days, omitted: [...new Set([...kept.omitted, ...dropped])] };
  }
  const errors = validateSchedule(trip, schedule);
  if (errors.length) throw new PlanningError(errors.join(" "));
  return schedule;
}

export async function solveTrip(input: Trip, sampled: TravelEdge[], seconds = 5, options: SolverOptions = {}): Promise<Schedule> {
  const original = tripSchema.parse(input);
  const alternatives = alternativeGroups(original);
  const trip = relaxAlternatives(original, alternatives);
  const places = options.places;
  const boundary = options.boundary;
  // A direct departure day ends at the station, so a visit to the station itself is that day's last.
  const travel = sampled.filter((edge) => edge.to === "hotel" || edge.day !== trip.days - 1 || !atDeparturePlace(trip, edge.from, places));
  if (boundary && (trip.days !== 1 || !Number.isFinite(boundary.startMinute) || boundary.startMinute < dayStart(trip, 0) || boundary.startMinute > dayEnd(trip, 0))) throw new PlanningError("Invalid remaining-day boundary.", "conflict");
  const hourGaps = boundary ? [] : bookingHourConflicts(original, travel, alternatives, places);
  const capacityGaps = boundary ? [] : dayCapacityConflicts(original, travel, alternatives, places, new Set(hourGaps.map((issue) => issue.fix.stopId)));
  if (hourGaps.length || capacityGaps.length) throw hourConflictError(hourGaps, capacityGaps);
  const coupled = Boolean(trip.dayGroups?.length || trip.stops.some((stop) => (stop.durationOptions?.length ?? 0) > 1));
  if (coupled && !boundary) {
    const gaps = sampledRouteGaps(trip, travel);
    if (gaps.length) throw new PlanningError(`Route coverage is incomplete. ${gaps.join(" ")}`, "incomplete", true, "missing-data");
  }
  const highs = await planningEngine();
  const model = highs.createModel();
  let columnCount = 0;
  const assignments = new Map<string, number[]>();
  const groupAssignments = new Map<string, number[]>();
  const routes: { day: number; from: number; to: number; column: number; edge: TravelEdge }[] = [];
  const together = [...(trip.dayGroups ?? []).filter((group) => !group.exclusive).map((group) => group.stopIds), ...(options.together ?? [])];
  const split = (schedule: Schedule) => together.some((ids) => schedule.days.some((day) => splitVisits(day.visits, ids)));
  const times: number[][] = [];
  const services: [number, number][][][] = [];
  const durationLoss: [number, number][] = [];
  const optionalUtility: [number, number][] = [];
  const capExcess: [number, number][] = [];
  const deviations: { day: number; index: number; column: number; target: { start: number; end: number } }[] = [];
  const hourPicks: { day: number; index: number; columns: number[]; intervals: [number, number][] }[] = [];
  const capRows: { day: number; columns: number[]; excess: number; limit: number }[] = [];
  const bigM = 4000;
  const infinity = highs.infinity;
  const endNode = trip.stops.length + 1;
  const costs: number[] = [];
  const addVariable = (lower: number, upper: number, cost = 0, integer = false) => {
    const column = columnCount++;
    model.addVar(lower, upper);
    model.changeColCost(column, cost);
    costs.push(cost);
    if (integer) model.changeColIntegrality(column, highs.constants.variableType.integer);
    return column;
  };
  const addRow = (entries: [number, number][], lower: number, upper: number) => {
    const combined = new Map<number, number>();
    for (const [column, value] of entries) combined.set(column, (combined.get(column) ?? 0) + value);
    const terms = [...combined].filter(([, value]) => value !== 0);
    model.addRow(lower, upper, { indices: terms.map(([column]) => column), values: terms.map(([, value]) => value) });
  };
  try {
    // Optional-visit rewards and cap penalties are large constants, so a relative gap would hide real travel and timing costs.
    model.options.set({ output_flag: false, time_limit: Math.min(5, Math.max(0.01, seconds)), mip_rel_gap: 0, mip_abs_gap: 1 });
    const preferences = planningPreferences(trip);
    const peakLoad = preferences.goal === "BALANCED" ? addVariable(0, infinity, 1) : null;
    for (let day = 0; day < trip.days; day++) {
      const start = boundary?.startMinute ?? dayStart(trip, day);
      const end = dayEnd(trip, day);
      times[day] = [addVariable(start, start)];
      services[day] = [[]];
      const dayAssignments: number[] = [];
      trip.stops.forEach((stop) => {
        const hours = stop.fixedTime ? null : openingIntervals(trip, day, places?.[stop.id]);
        const allowed = stopAllowedOnDay(trip, stop, day) && hours?.length !== 0;
        const extra = !stop.fixedTime && alternatives.some((group) => group.required && group.stopIds.includes(stop.id));
        const assigned = addVariable(0, allowed ? 1 : 0, extra ? -alternativeBonus * stop.priority : !coupled && stop.optional ? -100_000 * stop.priority : 0, true);
        if (stop.optional && !extra) optionalUtility.push([assigned, -stop.priority]);
        dayAssignments.push(assigned);
        assignments.set(stop.id, [...(assignments.get(stop.id) ?? []), assigned]);
        const choices = stop.fixedTime ? [stop.duration] : stop.durationOptions ?? [stop.duration];
        const service: [number, number][] = choices.length === 1 ? [[assigned, stop.duration]] : choices.map((duration) => {
          const column = addVariable(0, allowed ? 1 : 0, 0, true);
          if (duration < stop.duration) durationLoss.push([column, (stop.duration - duration) * stop.priority]);
          return [column, duration];
        });
        services[day].push(service);
        if (choices.length > 1) addRow([...service.map(([column]): [number, number] => [column, 1]), [assigned, -1]], 0, 0);
        const time = addVariable(0, 1500, 0.0001);
        times[day].push(time);
        const booking = stop.fixedTime && allowed ? minuteAt(trip, day, stop.fixedTime) : null;
        if (allowed && hours) {
          // Hard regular opening hours: the whole visit fits one open interval.
          const serviceTerms: [number, number][] = coupled ? service : [[assigned, stop.duration]];
          const picks = hours.length === 1 ? [assigned] : hours.map(() => addVariable(0, 1, 0, true));
          if (hours.length > 1) {
            addRow([...picks.map((column): [number, number] => [column, 1]), [assigned, -1]], 0, 0);
            hourPicks.push({ day, index: times[day].length - 2, columns: picks, intervals: hours });
          }
          hours.forEach(([open, close], index) => {
            addRow([[time, 1], [picks[index], -bigM]], open - bigM, infinity);
            addRow([[time, 1], ...serviceTerms, [picks[index], bigM]], -infinity, close + bigM);
          });
        }
        const target = allowed ? timeTarget(trip, stop, day, { places }) : null;
        if (target) {
          // Soft time of day: weighted minutes between the visit start and its preferred window.
          const deviation = addVariable(0, 1500, target.weight);
          const early = Math.max(0, target.start);
          const late = Math.max(0, 1500 - target.end);
          addRow([[deviation, 1], [time, 1], [assigned, -early]], target.start - early, infinity);
          addRow([[deviation, 1], [time, -1], [assigned, -late]], -target.end - late, infinity);
          deviations.push({ day, index: times[day].length - 2, column: deviation, target });
        }
        addRow([[time, 1], [assigned, -bigM]], (booking ?? start) - bigM, infinity);
        if (coupled) {
          addRow([[time, 1], ...service, [assigned, bigM]], -infinity, end + bigM);
          addRow([[time, 1], [assigned, -1500]], -infinity, 0);
          if (booking !== null) addRow([[time, 1], [assigned, bigM]], -infinity, booking + bigM);
        } else addRow([[time, 1], [assigned, bigM]], -infinity, Math.min(booking ?? end, end - stop.duration) + bigM);
      });
      times[day].push(addVariable(start, returnDeadline(trip, day), 0.001));
      const capped = new Map<CapCategory, number[]>();
      trip.stops.forEach((stop, index) => {
        const category = capCategory(trip, stop, places?.[stop.id]);
        if (category) capped.set(category, [...capped.get(category) ?? [], dayAssignments[index]]);
      });
      for (const [category, columns] of capped) {
        if (columns.length <= dailyCaps[category]) continue;
        const excess = addVariable(0, infinity, capPenalty);
        capExcess.push([excess, 1]);
        capRows.push({ day, columns, excess, limit: dailyCaps[category] });
        addRow([...columns.map((column): [number, number] => [column, 1]), [excess, -1]], -infinity, dailyCaps[category]);
      }
      const ids = [boundary?.startId ?? "hotel", ...trip.stops.map((stop) => stop.id), "hotel"];
      for (let from = 0; from < endNode; from++) {
        for (let to = 1; to <= endNode; to++) {
          if (from === to) continue;
          if (!allowsVisitPair(trip, ids[from], ids[to]) || (from > 0 && !stopAllowedOnDay(trip, trip.stops[from - 1], day)) || (to < endNode && !stopAllowedOnDay(trip, trip.stops[to - 1], day))) continue;
          const destination = to < endNode ? trip.stops[to - 1] : null;
          const synthetic = to === endNode && ((!boundary && from === 0) || !trip.returnToHotel);
          const edges: TravelEdge[] = synthetic
            ? [{ day, from: ids[from], to: "hotel", mode: "WALK", minutes: 0, meters: 0 }]
            : travel.filter((edge) => edge.day === day && edge.from === ids[from] && edge.to === ids[to] && allowsTravelEdge(trip, edge));
          for (const edge of edges) {
            if (!Number.isFinite(edge.minutes) || edge.minutes < 0 || edge.minutes > end - start || !Number.isFinite(edge.meters) || edge.meters < 0) continue;
            const column = addVariable(0, 1, travelCost(edge), true);
            routes.push({ day, from, to, column, edge });
            const service = from === 0 ? 0 : trip.stops[from - 1].duration;
            const buffer = destination?.fixedTime ? destination.buffer : 0;
            if (coupled) addRow([[times[day][to], 1], [times[day][from], -1], ...services[day][from].map(([serviceColumn, duration]): [number, number] => [serviceColumn, -duration]), [column, -bigM]], edge.minutes + buffer - bigM, infinity);
            else addRow([[times[day][to], 1], [times[day][from], -1], [column, -bigM]], service + edge.minutes + buffer - bigM, infinity);
          }
        }
      }
      const dayRoutes = routes.filter((route) => route.day === day);
      // A day trip is one outing: at most one leg enters its places from elsewhere.
      for (const ids of together) {
        const members = new Set(ids.map((id) => trip.stops.findIndex((stop) => stop.id === id) + 1).filter((node) => node > 0));
        if (members.size > 1) addRow(dayRoutes.filter((route) => !members.has(route.from) && members.has(route.to)).map((route): [number, number] => [route.column, 1]), -infinity, 1);
      }
      addRow(dayAssignments.map((column) => [column, 1]), 0, preferences.maxStopsPerDay);
      if (peakLoad !== null) addRow([
        ...(coupled ? [...services[day].flat(), ...dayAssignments.map((column, index): [number, number] => [column, trip.stops[index].fixedTime ? trip.stops[index].buffer : 0])] : dayAssignments.map((column, index): [number, number] => [column, trip.stops[index].duration + (trip.stops[index].fixedTime ? trip.stops[index].buffer : 0)])),
        ...dayRoutes.map((route): [number, number] => [route.column, route.edge.minutes]),
        [peakLoad, -1],
      ], -infinity, 0);
      addRow(dayRoutes.filter((route) => route.from === 0).map((route) => [route.column, 1]), 1, 1);
      addRow(dayRoutes.filter((route) => route.to === endNode).map((route) => [route.column, 1]), 1, 1);
      for (let node = 1; node < endNode; node++) {
        addRow([...dayRoutes.filter((route) => route.to === node).map((route): [number, number] => [route.column, 1]), [dayAssignments[node - 1], -1]], 0, 0);
        addRow([...dayRoutes.filter((route) => route.from === node).map((route): [number, number] => [route.column, 1]), [dayAssignments[node - 1], -1]], 0, 0);
      }
    }
    for (const stop of trip.stops) addRow((assignments.get(stop.id) ?? []).map((column) => [column, 1]), stop.optional ? 0 : 1, 1);
    for (const group of alternatives) if (group.required) addRow(group.stopIds.flatMap((id) => assignments.get(id) ?? []).map((column): [number, number] => [column, 1]), 1, infinity);
    for (const group of trip.dayGroups ?? []) {
      const groupDays = Array.from({ length: trip.days }, (_, day) => {
        const active = addVariable(0, groupAllowedDays(trip, group).includes(day) ? 1 : 0, 0, true);
        const members: [number, number][] = [];
        for (const stop of trip.stops) {
          const assigned = assignments.get(stop.id)![day];
          if (group.stopIds.includes(stop.id)) {
            addRow([[assigned, 1], [active, -1]], -infinity, 0);
            members.push([assigned, -1]);
          } else if (group.exclusive) addRow([[assigned, 1], [active, 1]], -infinity, 1);
        }
        addRow([[active, 1], ...members], -infinity, 0);
        return active;
      });
      addRow(groupDays.map((column) => [column, 1]), group.stopIds.some((id) => !trip.stops.find((stop) => stop.id === id)!.optional) ? 1 : 0, 1);
      groupAssignments.set(group.id, groupDays);
    }
    const solveStarted = performance.now();
    const limit = Math.min(5, Math.max(0.01, seconds));
    let lastOptimal = false;
    let constructionMs = 0;
    let seeded = false;
    const run = (stage: SolverStage["stage"], timeLimit: number, objective?: SolverStage["objective"]) => {
      const started = performance.now();
      let firstSolutionMs: number | null = null;
      model.options.set("time_limit", timeLimit);
      model.run({ [highs.constants.callbackType.mipSolution]: () => { firstSolutionMs ??= Math.round(performance.now() - started); } });
      const feasible = model.info.get("primal_solution_status") === 2;
      lastOptimal = feasible && model.getModelStatus() === highs.constants.modelStatus.optimal && Number(model.info.get("mip_gap")) <= 0.000001;
      options.onStage?.({ stage, outcome: feasible ? "feasible" : model.getModelStatus() === highs.constants.modelStatus.infeasible ? "conflict" : "incomplete", elapsedMs: Math.round(performance.now() - started), firstSolutionMs, columns: columnCount, nodes: Number(model.info.get("mip_node_count")), constructionMs, seeded, ...(objective ? { engine: "highs", objective, optimal: lastOptimal, objectiveValue: feasible ? model.getObjectiveValue() : null } : {}) });
      return feasible ? Array.from(model.getSolution().colValue) : null;
    };
    const hintStarted = performance.now();
    const usable = (schedule: Schedule | undefined) => schedule && !validateSchedule(original, schedule, boundary).length && !visitsOutsideHours(trip, schedule, places).length && !split(schedule) ? schedule : undefined;
    const hint = usable(options.initialSchedule) ?? usable(constructionHint(trip, travel, performance.now() + Math.min(1500, limit * 250), boundary, places, alternatives));
    constructionMs = Math.round(performance.now() - hintStarted);
    const seed = (schedule: Schedule): number[] | null => {
      const candidate = Array<number>(columnCount).fill(0);
      let peak = 0;
      for (const day of schedule.days) {
        candidate[times[day.day][0]] = boundary?.startMinute ?? dayStart(trip, day.day);
        let from = 0;
        let load = 0;
        for (const visit of day.visits) {
          const index = trip.stops.findIndex((stop) => stop.id === visit.stopId);
          const route = routes.find((route) => route.day === day.day && route.from === from && route.to === index + 1 && route.edge.mode === visit.leg.mode && route.edge.minutes === visit.leg.minutes && route.edge.meters === visit.leg.meters);
          if (!route) return null;
          candidate[route.column] = 1;
          candidate[assignments.get(visit.stopId)![day.day]] = 1;
          const service = services[day.day][index + 1].find(([, duration]) => Math.abs(duration - (visit.end - visit.start)) < 0.01);
          if (!service) return null;
          candidate[service[0]] = 1;
          candidate[times[day.day][index + 1]] = visit.start;
          load += visit.end - visit.start + route.edge.minutes + (trip.stops[index].fixedTime ? trip.stops[index].buffer : 0);
          from = index + 1;
        }
        const final = routes.find((route) => route.day === day.day && route.from === from && route.to === endNode && (!day.returnLeg || (route.edge.mode === day.returnLeg.mode && route.edge.minutes === day.returnLeg.minutes && route.edge.meters === day.returnLeg.meters)));
        if (!final) return null;
        candidate[final.column] = 1;
        candidate[times[day.day][endNode]] = (day.visits.at(-1)?.end ?? boundary?.startMinute ?? dayStart(trip, day.day)) + final.edge.minutes;
        peak = Math.max(peak, load + final.edge.minutes);
        for (const group of trip.dayGroups ?? []) if (day.visits.some((visit) => group.stopIds.includes(visit.stopId))) candidate[groupAssignments.get(group.id)![day.day]] = 1;
      }
      if (peakLoad !== null) candidate[peakLoad] = peak;
      for (const { day, index, column, target } of deviations) {
        const start = candidate[times[day][index + 1]];
        if (candidate[assignments.get(trip.stops[index].id)![day]] > 0.5) candidate[column] = Math.max(0, target.start - start, start - target.end);
      }
      for (const { day, index, columns, intervals } of hourPicks) {
        const visit = schedule.days.find((entry) => entry.day === day)?.visits.find((entry) => entry.stopId === trip.stops[index].id);
        const pick = visit ? intervals.findIndex(([open, close]) => visit.start >= open - 0.01 && visit.end <= close + 0.01) : -1;
        if (visit && pick < 0) return null;
        if (pick >= 0) candidate[columns[pick]] = 1;
      }
      for (const { columns, excess, limit } of capRows) candidate[excess] = Math.max(0, columns.reduce((total, column) => total + candidate[column], 0) - limit);
      return candidate;
    };
    let values: number[] | null = hint ? seed(hint) : null;
    seeded = values !== null;
    // The time-aware seed is offered to every stage it remains feasible for, and kept if the search cannot beat it.
    const seedValues = values;
    const score = (entries: [number, number][], vector: number[]) => entries.reduce((total, [column, cost]) => total + vector[column] * cost, 0);
    const locks: { entries: [number, number][]; value: number }[] = [];
    const meetsLocks = (vector: number[]) => locks.every(({ entries, value }) => Math.abs(score(entries, vector) - value) < 0.5);
    const allCosts = costs.map((cost, column): [number, number] => [column, cost]);
    if (values) model.setSolution({ colValue: values });
    const optimization = { weightedDurationLoss: 0, durationOptimal: !durationLoss.length, optionalOptimal: !optionalUtility.length, travelOptimal: false };
    if (values && durationLoss.every(([column]) => values![column] < 0.5)) optimization.durationOptimal = true;
    if (coupled) {
      const tiers: { objective: NonNullable<SolverStage["objective"]>; entries: [number, number][]; lowerBound?: number }[] = [
        ...(durationLoss.length ? [{ objective: "duration" as const, entries: durationLoss, lowerBound: 0 }] : []),
        ...(capExcess.length ? [{ objective: "balance" as const, entries: capExcess, lowerBound: 0 }] : []),
        ...(optionalUtility.length ? [{ objective: "optional" as const, entries: optionalUtility, lowerBound: optionalUtility.reduce((total, [, utility]) => total + utility, 0) }] : []),
        { objective: "travel", entries: costs.map((cost, column): [number, number] => [column, cost]).filter(([column, cost]) => cost !== 0 && !capExcess.some(([excess]) => excess === column)) },
      ];
      for (const [index, tier] of tiers.entries()) {
        const remaining = limit - (performance.now() - solveStarted) / 1000;
        if (remaining <= 0) break;
        costs.forEach((_, column) => model.changeColCost(column, 0));
        tier.entries.forEach(([column, cost]) => model.changeColCost(column, cost));
        model.options.set("mip_rel_gap", tier.objective === "travel" ? 0.02 : 0);
        model.options.set("mip_abs_gap", 0.000001);
        if (seedValues && meetsLocks(seedValues) && (!values || score(tier.entries, seedValues) < score(tier.entries, values) - 0.000001)) values = seedValues;
        if (values) model.setSolution({ colValue: values });
        let candidate = run("optimization", index === tiers.length - 1 ? remaining : remaining * 0.65, tier.objective);
        const extra = limit - (performance.now() - solveStarted) / 1000;
        if (!candidate && !values && extra > 0) candidate = run("optimization", extra, tier.objective);
        if (!candidate) break;
        values = candidate;
        const objectiveValue = tier.entries.reduce((total, [column, cost]) => total + values![column] * cost, 0);
        const optimal = lastOptimal || (tier.lowerBound !== undefined && Math.abs(objectiveValue - tier.lowerBound) < 0.000001);
        if (tier.objective === "duration") optimization.durationOptimal = optimal;
        if (tier.objective === "optional") optimization.optionalOptimal = optimal;
        if (tier.objective === "travel") optimization.travelOptimal = optimal;
        if (!optimal) break;
        if (tier.objective !== "travel") { addRow(tier.entries, Math.round(objectiveValue), Math.round(objectiveValue)); locks.push({ entries: tier.entries, value: Math.round(objectiveValue) }); }
      }
      const better = (left: number[], right: number[]) => {
        for (const tier of tiers) {
          const difference = score(tier.entries, left) - score(tier.entries, right);
          if (Math.abs(difference) > (tier.objective === "travel" ? 0.000001 : 0.5)) return difference < 0;
        }
        return false;
      };
      if (seedValues && values && values !== seedValues && better(seedValues, values)) { values = seedValues; optimization.travelOptimal = false; }
    } else if (options.strategy === "feasibility-first") {
      costs.forEach((_, column) => model.changeColCost(column, 0));
      values = run("feasibility", Math.min(1, limit / 2));
      costs.forEach((cost, column) => model.changeColCost(column, cost));
      if (values) model.setSolution({ colValue: values });
    }
    const remaining = limit - (performance.now() - solveStarted) / 1000;
    if (!coupled && remaining > 0) values = run("optimization", remaining) ?? values;
    if (!coupled && seedValues && values && score(allCosts, seedValues) < score(allCosts, values) - 0.000001) values = seedValues;
    if (!values) {
      const conflict = model.getModelStatus() === highs.constants.modelStatus.infeasible;
      const bookingIssues = conflict ? bookingConflicts(trip) : [];
      const hourIssues = conflict ? openingHourConflicts(original, alternatives, places) : [];
      const issues = [...bookingIssues, ...hourIssues.map((issue) => issue.message)];
      if (issues.length) throw new PlanningError(`${bookingIssues.length ? hourIssues.length ? "No schedule fits these bookings and opening hours." : "No schedule fits these bookings." : "No schedule fits these opening hours."} ${issues.slice(0, 5).join(" ")}${issues.length > 5 ? ` (${issues.length - 5} more)` : ""}${bookingIssues.length ? " Change or clear those booked times." : ""}`, "conflict", true, "hard-input-conflict", hourIssues.map((issue) => issue.fix));
      const routeIssues = conflict && !boundary ? bookingRouteConflicts(trip, travel) : [];
      if (routeIssues.length) throw new PlanningError(`No schedule fits these bookings and sampled routes. ${routeIssues.slice(0, 5).join(" ")}${routeIssues.length > 5 ? ` (${routeIssues.length - 5} more)` : ""} Change booked times or mark flexible visits as Any time slot.`, "conflict");
      const routeGaps = conflict && !boundary ? sampledRouteGaps(trip, travel) : [];
      if (routeGaps.length) throw new PlanningError(`No schedule fits the sampled route connections. ${routeGaps.slice(0, 5).join(" ")}${routeGaps.length > 5 ? ` (${routeGaps.length - 5} more)` : ""} Check map locations, transport preferences, and daily hours. Changing visit times alone cannot supply a missing route.`, "incomplete", false, "missing-data");
      throw new PlanningError(conflict ? "No schedule fits these bookings and available routes. Adjust the daily hours, visit durations, or required stops." : "The planning time limit was reached without a feasible schedule. Try fewer stops or assign some sights to a day.", conflict ? "conflict" : "incomplete");
    }
    const selected = routes.filter((route) => values[route.column] > 0.5);
    const visited = new Set<string>();
    const schedule: Schedule = { days: [], omitted: [], warnings: [], generatedAt: new Date().toISOString() };
    if (coupled) {
      optimization.weightedDurationLoss = Math.round(durationLoss.reduce((total, [column, loss]) => total + values[column] * loss, 0));
      schedule.optimization = optimization;
      if (!optimization.durationOptimal) schedule.warnings.push("A feasible candidate was found, but minimum duration loss was not proven within the search budget.");
    }
    for (let day = 0; day < trip.days; day++) {
      const dayPlan: Schedule["days"][number] = { day, date: tripDate(trip, day), visits: [] };
      let node = 0;
      for (let count = 0; count <= trip.stops.length; count++) {
        const route = selected.find((candidate) => candidate.day === day && candidate.from === node);
        if (!route) throw new PlanningError("The optimizer returned a disconnected route.");
        if (route.to === endNode) {
          if ((node !== 0 || boundary) && trip.returnToHotel) dayPlan.returnLeg = route.edge;
          break;
        }
        const stop = trip.stops[route.to - 1];
        const start = Math.round(values[times[day][route.to]] * 1000) / 1000;
        const duration = coupled ? Math.round(services[day][route.to].reduce((total, [column, minutes]) => total + values[column] * minutes, 0)) : stop.duration;
        dayPlan.visits.push({ stopId: stop.id, start, end: start + duration, leg: route.edge });
        visited.add(stop.id);
        node = route.to;
      }
      schedule.days.push(dayPlan);
    }
    schedule.omitted = trip.stops.filter((stop) => !visited.has(stop.id)).map((stop) => stop.id);
    // The solver stops at its time limit; local search from its answer removes leftover back-and-forth.
    // Bounded by its own stall limit, so small trips finish long before this deadline.
    const polished = constructionHint(trip, travel, performance.now() + 1500, boundary, places, alternatives, schedule);
    if (polished && !validateSchedule(original, polished, boundary).length && !visitsOutsideHours(trip, polished, places).length && !split(polished) && JSON.stringify(polished.days.map((day) => day.visits.map((visit) => visit.stopId))) !== JSON.stringify(schedule.days.map((day) => day.visits.map((visit) => visit.stopId)))) {
      schedule.days = polished.days; schedule.omitted = polished.omitted;
      if (schedule.optimization) schedule.optimization.travelOptimal = false;
    }
    if (!boundary) {
      const compact = compactWaits(trip, schedule, places);
      if (!validateSchedule(original, compact).length && !visitsOutsideHours(trip, compact, places).length) schedule.days = compact.days;
    }
    schedule.warnings.push(...timingWarnings(original, schedule, alternatives, places));
    if (visitsOutsideHours(trip, schedule, places).length) throw new PlanningError("The optimizer returned a visit outside regular opening hours.");
    const errors = validateSchedule(original, schedule, boundary);
    if (errors.length) throw new PlanningError(errors.join(" "));
    return schedule;
  } finally {
    model.dispose();
  }
}