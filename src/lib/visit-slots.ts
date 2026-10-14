import { Temporal } from "@js-temporal/polyfill";
import { instantAt, minuteAt, tripDate, type Place, type Stop, type Trip, type VisitKind, type VisitSlot } from "./trip";

// Time-of-day guidance for flexible visits. Explicit choices win over the original itinerary time,
// which wins over cues in the imported note, which win over Google place types.
export type TimingSource = "set" | "research" | "itinerary" | "note" | "place";
export type TimingContext = { places?: Record<string, Place> };
export type VisitTiming = { kind?: VisitKind; kindSource?: TimingSource; slot?: VisitSlot; slotSource?: TimingSource; plannedTime?: string; plannedSource?: TimingSource };
export type TimeTarget = { start: number; end: number; weight: number; label: string; source: TimingSource };
export type CapCategory = "breakfast" | "lunch" | "dinner" | "coffee";
export type AlternativeGroup = { key: string; stopIds: string[]; required: boolean; inferred: boolean };

export const slotLabels: Record<VisitSlot, string> = { breakfast: "Breakfast", morning: "Morning", lunch: "Lunch", afternoon: "Afternoon", dinner: "Dinner", evening: "Evening", any: "Any time" };
export const kindLabels: Record<VisitKind, string> = { meal: "Meal", snack: "Snack", coffee: "Coffee", sight: "Sight", walk: "Walk", activity: "Activity", nightlife: "Nightlife" };
export const timingSourceLabels: Record<TimingSource, string> = { set: "your choice", research: "timing research", itinerary: "original itinerary time", note: "from your note", place: "Google place type" };
export const dailyCaps: Record<CapCategory, number> = { breakfast: 1, lunch: 1, dinner: 1, coffee: 2 };

// Windows constrain the visit start. Weights are travel-minute equivalents per minute outside the window.
const slotWindows: Record<Exclude<VisitSlot, "any" | "evening">, { start: string; end: string; weight: number }> = {
  breakfast: { start: "07:30", end: "10:30", weight: 4 },
  morning: { start: "08:00", end: "11:30", weight: 1.5 },
  lunch: { start: "11:45", end: "14:00", weight: 5 },
  afternoon: { start: "13:00", end: "17:00", weight: 1.5 },
  dinner: { start: "18:00", end: "20:30", weight: 5 },
};
const kindWindows: Partial<Record<VisitKind, { start: string; end: string; weight: number; label: string }>> = {
  meal: { start: "11:45", end: "20:30", weight: 2, label: "Meal hours" },
  coffee: { start: "08:00", end: "16:30", weight: 1, label: "Daytime coffee" },
  snack: { start: "10:30", end: "17:30", weight: 0.5, label: "Snack hours" },
};
const eveningWeight = 3;
// Original itinerary times are a hint from a plan that may have grouped places differently, so they stay weak:
// an hour off costs less than a cross-town detour.
const plannedWeight = 1;
const plannedTolerance = 60;
const preferredWeight = 4;
const daylightWeight = 1.5;

const labelPattern = /\b(breakfast|brunch|lunch|dinner|supper|coffee|snack|dessert|drinks|activity)(?:\s*\d+)?\s*:/i;
const labelTiming: Record<string, { kind: VisitKind; slot?: VisitSlot }> = {
  breakfast: { kind: "meal", slot: "breakfast" }, brunch: { kind: "meal", slot: "morning" }, lunch: { kind: "meal", slot: "lunch" },
  dinner: { kind: "meal", slot: "dinner" }, supper: { kind: "meal", slot: "dinner" }, coffee: { kind: "coffee" }, snack: { kind: "snack" },
  dessert: { kind: "snack" }, drinks: { kind: "nightlife", slot: "evening" }, activity: { kind: "activity" },
};
const kindRules: { pattern: RegExp; kind: VisitKind; slot?: VisitSlot }[] = [
  { pattern: /\b(dinner|supper)\b/i, kind: "meal", slot: "dinner" },
  { pattern: /\blunch\b/i, kind: "meal", slot: "lunch" },
  { pattern: /\bbreakfast\b/i, kind: "meal", slot: "breakfast" },
  { pattern: /\bbrunch\b/i, kind: "meal", slot: "morning" },
  { pattern: /\b(coffee|espresso|pour-over|roasters?|roastery|café|cafe)\b/i, kind: "coffee" },
  { pattern: /\b(nightlife|cocktails?|wine bar|pub crawl|night ?club)\b/i, kind: "nightlife", slot: "evening" },
  { pattern: /\b(döner|doner|kebab|lahmacun|sandwich|herring|stroopwafels?|roti|poffertjes|fries|frites|waffles?|snacks?|street food|food stalls?|bakery|pastry|desserts?|ice cream|gelato)\b/i, kind: "snack" },
  { pattern: /\b(restaurant|bistro|brasserie|bouillon|eatery|trattoria|tasting menu)\b/i, kind: "meal" },
  { pattern: /\b(walk|stroll|wander|park|gardens?|canals?|promenade)\b/i, kind: "walk" },
  { pattern: /\b(museum|gallery|church|cathedral|palace|castle|monument|courtyard)\b/i, kind: "sight" },
  { pattern: /\b(tour|experience|cruise|show|class|workshop)\b/i, kind: "activity" },
];
const slotRules: { pattern: RegExp; slot: VisitSlot }[] = [
  { pattern: /\b(evening|night|after dark|sunset|light (?:trail|festival|show|walk|route)|illuminat\w*)\b/i, slot: "evening" },
  { pattern: /\bmorning\b/i, slot: "morning" },
  { pattern: /\bafternoon\b/i, slot: "afternoon" },
];
const timeRange = /\b([01]?\d|2[0-3]):([0-5]\d)\s*(?:[–—-]|to)\s*(?:[01]?\d|2[0-3]):[0-5]\d\b/;
const timeAt = /\b(?:at|@)\s*([01]?\d|2[0-3]):([0-5]\d)\b/i;

export function textTiming(stop: Pick<Stop, "name" | "source">): { kind?: VisitKind; slot?: VisitSlot; plannedTime?: string } {
  const text = `${stop.name}\n${stop.source}`;
  const result: { kind?: VisitKind; slot?: VisitSlot; plannedTime?: string } = {};
  const label = stop.source.match(labelPattern)?.[1]?.toLowerCase();
  if (label) Object.assign(result, labelTiming[label]);
  for (const rule of kindRules) {
    if (result.kind) break;
    if (rule.pattern.test(text)) { result.kind = rule.kind; result.slot ??= rule.slot; }
  }
  for (const rule of slotRules) {
    if (result.slot) break;
    if (rule.pattern.test(text)) result.slot = rule.slot;
  }
  const time = stop.source.match(timeRange) ?? stop.source.match(timeAt);
  if (time) result.plannedTime = `${time[1].padStart(2, "0")}:${time[2]}`;
  return result;
}

const placeCategories: { types: (type: string) => boolean; kind: VisitKind; slot?: VisitSlot }[] = [
  { types: (type) => type === "breakfast_restaurant", kind: "meal", slot: "breakfast" },
  { types: (type) => type === "brunch_restaurant", kind: "meal", slot: "morning" },
  { types: (type) => ["bar", "pub", "night_club", "wine_bar", "cocktail_bar", "karaoke", "bar_and_grill"].includes(type), kind: "nightlife", slot: "evening" },
  { types: (type) => ["cafe", "coffee_shop", "tea_house", "cat_cafe"].includes(type), kind: "coffee" },
  { types: (type) => ["bakery", "dessert_shop", "ice_cream_shop", "fast_food_restaurant", "sandwich_shop", "donut_shop", "confectionery", "food_court", "dessert_restaurant", "juice_shop", "bagel_shop"].includes(type), kind: "snack" },
  { types: (type) => type === "restaurant" || type.endsWith("_restaurant") || ["diner", "steak_house", "bistro"].includes(type), kind: "meal" },
  { types: (type) => ["park", "garden", "botanical_garden", "hiking_area", "national_park", "city_park", "plaza", "dog_park"].includes(type), kind: "walk" },
  { types: (type) => ["museum", "art_gallery", "church", "place_of_worship", "historical_landmark", "monument", "castle", "palace", "historical_place", "cultural_landmark"].includes(type), kind: "sight" },
];

export function placeTiming(place?: Pick<Place, "primaryType" | "types">): { kind?: VisitKind; slot?: VisitSlot } {
  for (const type of [place?.primaryType, ...(place?.types ?? [])]) {
    if (!type) continue;
    const category = placeCategories.find((candidate) => candidate.types(type));
    if (category) return { kind: category.kind, ...(category.slot ? { slot: category.slot } : {}) };
  }
  return {};
}

export function visitTiming(trip: Pick<Trip, "stops">, stop: Stop, place?: Place): VisitTiming {
  const text = textTiming(stop);
  const fromPlace = placeTiming(place);
  const source = stop.source.trim();
  const shared = Boolean(source) && trip.stops.some((other) => other.id !== stop.id && other.source.trim() === source);
  const timing: VisitTiming = {};
  if (stop.kind) Object.assign(timing, { kind: stop.kind, kindSource: "set" });
  else if (text.kind) Object.assign(timing, { kind: text.kind, kindSource: "note" });
  else if (fromPlace.kind) Object.assign(timing, { kind: fromPlace.kind, kindSource: "place" });
  if (stop.slot) Object.assign(timing, { slot: stop.slot, slotSource: "set" });
  else if (text.slot) Object.assign(timing, { slot: text.slot, slotSource: "note" });
  else if (fromPlace.slot) Object.assign(timing, { slot: fromPlace.slot, slotSource: "place" });
  if (stop.plannedTime) Object.assign(timing, { plannedTime: stop.plannedTime, plannedSource: "itinerary" });
  else if (text.plannedTime && !shared) Object.assign(timing, { plannedTime: text.plannedTime, plannedSource: "itinerary" });
  return timing;
}

function wallMinutes(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function clockTime(minutes: number) {
  const value = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

// Minutes since local midnight for a UTC instant, measured the same way as minuteAt.
function elapsedMinutes(trip: Trip, day: number, epochMilliseconds: number) {
  return (epochMilliseconds - instantAt(trip, day, "00:00").epochMilliseconds) / 60_000;
}

// NOAA-style sunrise equation; accurate to a few minutes, which is ample for soft daylight and evening windows.
export function sunsetMinute(trip: Trip, day: number, location?: { lat: number; lng: number }): number | null {
  return sunTimes(trip, day, location)?.sunset ?? null;
}

export function sunTimes(trip: Trip, day: number, location?: { lat: number; lng: number }): { sunrise: number; sunset: number } | null {
  if (!location) return null;
  const radians = Math.PI / 180;
  const noon = Date.parse(`${tripDate(trip, day)}T12:00:00Z`);
  const julianNoon = noon / 86_400_000 + 2440587.5;
  const cycle = Math.round(julianNoon - 2451545.0009 + location.lng / 360);
  const solarNoon = 2451545.0009 - location.lng / 360 + cycle;
  const anomaly = (357.5291 + 0.98560028 * (solarNoon - 2451545)) % 360;
  const center = 1.9148 * Math.sin(anomaly * radians) + 0.02 * Math.sin(2 * anomaly * radians) + 0.0003 * Math.sin(3 * anomaly * radians);
  const longitude = (anomaly + center + 180 + 102.9372) % 360;
  const transit = solarNoon + 0.0053 * Math.sin(anomaly * radians) - 0.0069 * Math.sin(2 * longitude * radians);
  const declination = Math.asin(Math.sin(longitude * radians) * Math.sin(23.4397 * radians));
  const hourAngle = (Math.sin(-0.833 * radians) - Math.sin(location.lat * radians) * Math.sin(declination)) / (Math.cos(location.lat * radians) * Math.cos(declination));
  if (hourAngle < -1 || hourAngle > 1) return null;
  const half = Math.acos(hourAngle) / radians / 360;
  const minute = (julian: number) => elapsedMinutes(trip, day, (julian - 2440587.5) * 86_400_000);
  return { sunrise: minute(transit - half), sunset: minute(transit + half) };
}

function minuteOrWall(trip: Trip, day: number, time: string) {
  try { return minuteAt(trip, day, time); } catch { return wallMinutes(time); }
}

function slotTarget(trip: Trip, day: number, slot: VisitSlot, source: TimingSource, location?: { lat: number; lng: number }): TimeTarget | null {
  if (slot === "any") return null;
  if (slot === "evening") {
    const sunset = sunsetMinute(trip, day, location) ?? minuteOrWall(trip, day, "17:30");
    const end = Math.max(sunset + 60, minuteOrWall(trip, day, "22:00"));
    return { start: sunset, end, weight: eveningWeight, label: `Evening, after sunset (${clockTime(sunset)})`, source };
  }
  const window = slotWindows[slot];
  return { start: minuteOrWall(trip, day, window.start), end: minuteOrWall(trip, day, window.end), weight: window.weight, label: `${slotLabels[slot]} ${window.start}–${window.end}`, source };
}

// Walks and other outdoor visits should start after sunrise and finish by sunset.
function withDaylight(trip: Trip, stop: Stop, day: number, target: TimeTarget | null, location?: { lat: number; lng: number }): TimeTarget | null {
  const sun = sunTimes(trip, day, location);
  if (!sun) return target;
  const start = sun.sunrise + 15;
  const end = Math.max(start, sun.sunset - Math.min(stop.duration, 60));
  const daylight: TimeTarget = { start, end, weight: daylightWeight, label: `Daylight ${clockTime(start)}–${clockTime(end)}`, source: target?.source ?? "place" };
  if (!target) return daylight;
  const overlap = { start: Math.max(target.start, start), end: Math.min(target.end, end) };
  return overlap.start <= overlap.end ? { ...target, ...overlap, label: `${target.label.replace(/ \d\d:\d\d–\d\d:\d\d$/, "")} ${clockTime(overlap.start)}–${clockTime(overlap.end)} (daylight)` } : daylight;
}

// An itinerary time is dropped when it collides with a booking on the planned day; it came from a different arrangement.
function plannedClashes(trip: Trip, stop: Stop, day: number, planned: number) {
  return trip.stops.some((other) => other.id !== stop.id && other.day === day && other.fixedTime && (() => {
    const booking = minuteOrWall(trip, day, other.fixedTime!);
    return planned < booking + other.duration && planned + stop.duration > booking - other.buffer;
  })());
}

export function timeTarget(trip: Trip, stop: Stop, day: number, context: TimingContext = {}): TimeTarget | null {
  if (stop.fixedTime) return null;
  if (stop.preferredTimeWindow) {
    const { start, end } = stop.preferredTimeWindow;
    return { start: minuteOrWall(trip, day, start), end: minuteOrWall(trip, day, end), weight: preferredWeight, label: `Preferred ${start}–${end}`, source: "research" };
  }
  const place = context.places?.[stop.id];
  const location = place?.location ?? stop.location ?? context.places?.hotel?.location ?? trip.hotelLocation;
  const timing = visitTiming(trip, stop, place);
  const outdoor = timing.kind === "walk";
  if (stop.slot) { const target = slotTarget(trip, day, stop.slot, "set", location); return outdoor && target && stop.slot !== "evening" ? withDaylight(trip, stop, day, target, location) : target; }
  if (timing.plannedTime) {
    const planned = minuteOrWall(trip, day, timing.plannedTime);
    if (!plannedClashes(trip, stop, day, planned)) return { start: planned - plannedTolerance, end: planned + plannedTolerance, weight: plannedWeight, label: `Original plan ${timing.plannedTime}`, source: "itinerary" };
  }
  if (timing.slot === "evening") return slotTarget(trip, day, timing.slot, timing.slotSource!, location);
  if (timing.slot && timing.slot !== "any") { const target = slotTarget(trip, day, timing.slot, timing.slotSource!, location); return outdoor ? withDaylight(trip, stop, day, target, location) : target; }
  const window = timing.kind ? kindWindows[timing.kind] : undefined;
  if (window) return { start: minuteOrWall(trip, day, window.start), end: minuteOrWall(trip, day, window.end), weight: window.weight, label: `${window.label} ${window.start}–${window.end}`, source: timing.kindSource! };
  return outdoor ? withDaylight(trip, stop, day, null, location) : null;
}

// A day-independent summary for the editor; evening windows depend on the date, so they are described.
export function describeTiming(trip: Trip, stop: Stop, place?: Place): { label: string; source: TimingSource } | null {
  if (stop.fixedTime) return null;
  if (stop.preferredTimeWindow) return { label: `Preferred ${stop.preferredTimeWindow.start}–${stop.preferredTimeWindow.end}`, source: "research" };
  const describe = (slot: VisitSlot, source: TimingSource) => slot === "any" ? { label: "Any time", source } : slot === "evening" ? { label: "Evening, after sunset", source } : { label: `${slotLabels[slot]} ${slotWindows[slot].start}–${slotWindows[slot].end}`, source };
  if (stop.slot) return describe(stop.slot, "set");
  const timing = visitTiming(trip, stop, place);
  if (timing.plannedTime) return { label: `Original plan ${timing.plannedTime}`, source: "itinerary" };
  if (timing.slot) return describe(timing.slot, timing.slotSource!);
  const window = timing.kind ? kindWindows[timing.kind] : undefined;
  if (window) return { label: `${window.label} ${window.start}–${window.end}`, source: timing.kindSource! };
  return timing.kind === "walk" ? { label: "Daylight hours", source: timing.kindSource! } : null;
}

export function capCategory(trip: Pick<Trip, "stops">, stop: Stop, place?: Place): CapCategory | null {
  const timing = visitTiming(trip, stop, place);
  if (timing.kind === "coffee") return "coffee";
  if (timing.kind === "meal" && (timing.slot === "breakfast" || timing.slot === "lunch" || timing.slot === "dinner")) return timing.slot;
  return null;
}

// Regular weekly hours as [start, end] minute intervals for one trip day; null means no restriction is known.
export function openingIntervals(trip: Trip, day: number, place?: Pick<Place, "hours">): [number, number][] | null {
  const hours = place?.hours;
  if (!hours?.length || hours.some((period) => !period.close)) return null;
  const weekday = Temporal.PlainDate.from(tripDate(trip, day)).dayOfWeek % 7;
  const intervals: [number, number][] = [];
  for (const period of hours) {
    const open = period.open.hour * 60 + period.open.minute;
    let span = ((period.close!.day - period.open.day + 7) % 7) * 1440 + period.close!.hour * 60 + period.close!.minute - open;
    if (span <= 0) span += 7 * 1440;
    for (let back = 0; back < 7; back++) {
      if (period.open.day !== (weekday - back + 7) % 7) continue;
      const start = open - back * 1440;
      if (start + span > 0) intervals.push([Math.max(0, start), Math.min(2880, start + span)]);
    }
  }
  intervals.sort((left, right) => left[0] - right[0]);
  const merged: [number, number][] = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  if (merged.some(([start, end]) => start <= 0 && end >= 1440)) return null;
  const shift = minuteOrWall(trip, day, trip.dailyStart) - wallMinutes(trip.dailyStart);
  return merged.map(([start, end]) => [start + shift, end + shift]);
}

function namePosition(source: string, name: string) {
  const lower = source.toLowerCase();
  for (const candidate of [name, name.replace(/\s*\([^)]*\)\s*/g, " ").trim()]) {
    const index = candidate.length >= 3 ? lower.indexOf(candidate.toLowerCase()) : -1;
    if (index >= 0) return { index, end: index + candidate.length };
  }
  return null;
}

// Alternatives come from an explicit group label or, when unset, from a shared note that lists the places as "A or B".
export function alternativeGroups(trip: Pick<Trip, "stops">): AlternativeGroup[] {
  const groups: AlternativeGroup[] = [];
  const explicit = new Map<string, Stop[]>();
  for (const stop of trip.stops) if (stop.alternativeGroup) explicit.set(stop.alternativeGroup, [...explicit.get(stop.alternativeGroup) ?? [], stop]);
  for (const [key, members] of explicit) if (members.length > 1) groups.push({ key, stopIds: members.map((stop) => stop.id), required: members.some((stop) => !stop.optional), inferred: false });
  const bySource = new Map<string, Stop[]>();
  for (const stop of trip.stops) {
    const source = stop.source.trim();
    if (stop.alternativeGroup === undefined && /\bor\b/i.test(source)) bySource.set(source, [...bySource.get(source) ?? [], stop]);
  }
  for (const [source, stops] of bySource) {
    if (stops.length < 2) continue;
    const located = stops.flatMap((stop) => { const position = namePosition(source, stop.name); return position ? [{ stop, ...position }] : []; }).sort((left, right) => left.index - right.index);
    const chains: (typeof located)[] = [];
    const separators: string[][] = [];
    for (const entry of located) {
      const chain = chains.at(-1);
      const previous = chain?.at(-1);
      const between = previous ? source.slice(previous.end, entry.index) : "";
      if (chain && previous && entry.index >= previous.end && between.length <= 60 && !/[;|\n]|\.\s|\band\b|\bthen\b/i.test(between)) { chain.push(entry); separators.at(-1)!.push(between); }
      else { chains.push([entry]); separators.push([]); }
    }
    chains.forEach((chain, index) => {
      if (chain.length < 2) return;
      const trailing = source.slice(chain.at(-1)!.end, chain.at(-1)!.end + 20);
      if (!separators[index].some((between) => /\bor\b/i.test(between)) && !/^[\s,]*or\b/i.test(trailing)) return;
      groups.push({ key: `auto:${chain[0].stop.id}`, stopIds: chain.map((entry) => entry.stop.id), required: chain.some((entry) => !entry.stop.optional), inferred: true });
    });
  }
  return groups;
}

export function isRequiredStop(stop: Stop, groups: AlternativeGroup[]) {
  return !stop.optional && (Boolean(stop.fixedTime) || !groups.some((group) => group.stopIds.includes(stop.id)));
}

// Planning view of a trip: alternative members become individually optional; callers enforce "at least one" per group.
export function relaxAlternatives<T extends Pick<Trip, "stops">>(trip: T, groups: AlternativeGroup[]): T {
  return { ...trip, stops: trip.stops.map((stop) => ({ ...stop, alternativeGroup: null, ...(!stop.fixedTime && groups.some((group) => group.stopIds.includes(stop.id)) ? { optional: true } : {}) })) };
}

export function usesVisitTiming(trip: Trip, context: TimingContext = {}) {
  return alternativeGroups(trip).length > 0 || trip.stops.some((stop) => !stop.fixedTime && (timeTarget(trip, stop, 0, context) !== null || Boolean(context.places?.[stop.id]?.hours?.length)));
}
