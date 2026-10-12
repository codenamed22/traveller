import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

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
  day: z.number().int().min(0).max(6).nullable(),
  fixedTime: timeSchema.nullable(),
  buffer: z.number().int().min(0).max(120),
  optional: z.boolean(),
  priority: z.number().int().min(1).max(5),
  mode: modeSchema,
  source: z.string().max(1000),
  sourceUrl: sourceUrlSchema.optional(),
}).strict().superRefine((stop, context) => {
  if (stop.fixedTime && stop.day === null) {
    context.addIssue({ code: "custom", message: "Assign a day to a fixed booking.", path: ["day"] });
  }
  if (stop.fixedTime && stop.optional) {
    context.addIssue({ code: "custom", message: "A fixed booking cannot be optional.", path: ["optional"] });
  }
});

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
  stops: z.array(stopSchema).max(25),
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
});

export type Trip = z.infer<typeof tripSchema>;
export type Stop = z.infer<typeof stopSchema>;
export type TravelMode = "WALK" | "TRANSIT";
export type Place = { id: string; name: string; address: string; location: { lat: number; lng: number }; timeZone?: string };
export type TravelStep = { instruction: string; mode: string; line?: string; from?: string; to?: string; departure?: string; arrival?: string };
export type TravelEdge = {
  day: number; from: string; to: string; mode: TravelMode;
  minutes: number; meters: number; polyline?: string; steps?: TravelStep[]; fare?: string;
  alternatives?: TravelEdge[];
};
export type Visit = { stopId: string; start: number; end: number; leg: TravelEdge };
export type DayPlan = { day: number; date: string; visits: Visit[]; returnLeg?: TravelEdge };
export type Schedule = { days: DayPlan[]; omitted: string[]; warnings: string[]; generatedAt: string };
export type SavedPlan = { days: { day: number; stopIds: string[] }[]; omitted: string[] };
export type PlanResult = { schedule: Schedule; places: Record<string, Place>; verified: boolean };

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

export function minuteAt(trip: Trip, day: number, time: string) {
  return (instantAt(trip, day, time).epochMilliseconds - instantAt(trip, day, "00:00").epochMilliseconds) / 60_000;
}

export function instantForMinute(trip: Trip, day: number, minute: number) {
  return instantAt(trip, day, "00:00").add({ milliseconds: Math.round(minute * 60_000) });
}

export function formatMinute(trip: Trip, day: number, minute: number) {
  return instantForMinute(trip, day, minute).toZonedDateTimeISO(trip.timeZone).toPlainTime().toString({ smallestUnit: "minute" });
}

export function persistedPlan(schedule: Schedule): SavedPlan {
  return { days: schedule.days.map(({ day, visits }) => ({ day, stopIds: visits.map((visit) => visit.stopId) })), omitted: schedule.omitted };
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