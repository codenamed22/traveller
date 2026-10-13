import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { allowsTravelEdge, dayPlanSchema, instantForMinute, minuteAt, placeSchema, tripDate, tripSchema, type DayPlan, type TravelEdge, type Trip } from "./trip";

const idsSchema = z.array(z.uuid()).max(60).refine((ids) => new Set(ids).size === ids.length, "Visits must be unique.");
const recoveryOriginSchema = z.object({ id: z.union([z.literal("hotel"), z.uuid()]), location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict().optional() }).strict();
export const savedRecoverySchema = z.object({
  trip: tripSchema, day: dayPlanSchema, checkedAt: z.iso.datetime(), departureAt: z.iso.datetime(), origin: recoveryOriginSchema,
  places: z.record(z.string().max(300), placeSchema).refine((places) => Object.keys(places).length <= 61, "Too many saved places."),
}).strict();
const remainderSchema = z.object({ stopIds: idsSchema, durations: z.record(z.uuid(), z.number().int().min(5).max(480)), skipped: idsSchema, snapshot: savedRecoverySchema.optional() }).strict();
export const dayProgressSchema = z.object({
  date: z.iso.date(), version: z.number().int().nonnegative(), planKey: z.string().max(200_000),
  timeZone: tripSchema.shape.timeZone.optional(),
  baselineStopIds: idsSchema.optional(),
  completed: z.array(z.object({ stopId: z.uuid(), start: z.number().min(0).max(1500), end: z.number().min(0).max(1500) }).strict().refine((visit) => visit.end >= visit.start, "Finish after starting.")).max(60),
  skipped: idsSchema, missedBookings: idsSchema,
  originId: z.union([z.literal("hotel"), z.uuid()]), readyAt: z.number().min(0).max(1500).nullable(),
  remaining: remainderSchema.optional(), previousRemaining: remainderSchema.optional(), undoAvailable: z.boolean().optional(),
}).strict();
export type DayProgress = z.infer<typeof dayProgressSchema>;
export const recoveryRequestSchema = z.object({
  trip: tripSchema, day: z.number().int().min(0).max(6), stopIds: idsSchema, progress: dayProgressSchema,
  origin: recoveryOriginSchema,
  departureAt: z.iso.datetime(), operationId: z.uuid(), mode: z.enum(["route", "replan"]), targetId: z.union([z.literal("hotel"), z.uuid()]).optional(),
  permissions: z.object({ skipIds: idsSchema, minimumDurations: z.record(z.uuid(), z.number().int().min(5).max(480)) }).strict(),
  preferredRoute: z.object({ to: z.union([z.literal("hotel"), z.uuid()]), key: z.string().max(20_000) }).strict().optional(),
}).strict();
export type RecoveryRequest = z.infer<typeof recoveryRequestSchema>;
export type RecoveryOption = { label: string; day: DayPlan; skipped: string[]; durations: Record<string, number> };
export type RecoveryResult = {
  status: "route-checked" | "recovery-checked" | "unresolved"; context: string; checkedAt: string; departureAt: string;
  routes?: TravelEdge[]; options?: RecoveryOption[]; message?: string;
};
export type CheckedNextRoute = { edge: TravelEdge; origin: RecoveryRequest["origin"]; checkedAt: string; departureAt: string };
export function liveCheckIsFresh(checkedAt: string, departureAt: string, now = Temporal.Now.instant()): boolean {
  const checked = Date.parse(checkedAt); const departure = Date.parse(departureAt);
  return Number.isFinite(checked) && Number.isFinite(departure) && checked <= now.epochMilliseconds + 5000 && now.epochMilliseconds - Math.min(checked, departure) <= 120_000;
}

export function liveRouteKey(edge?: TravelEdge) { return edge ? JSON.stringify([edge.mode, edge.polyline, edge.steps?.map((step) => [step.line, step.from, step.to, step.departure])]) : ""; }

export function recoveryPlanKey(trip: Trip, day: number, stopIds: string[]) {
  const parsed = tripSchema.safeParse(trip);
  const canonical = parsed.success ? parsed.data : trip;
  return JSON.stringify({ ...canonical, hotelLocation: undefined, stops: canonical.stops.map((stop) => ({ ...stop, location: undefined, source: "", sourceUrl: undefined })), day, stopIds });
}
export function newDayProgress(trip: Trip, day: number, stopIds: string[]): DayProgress {
  return { date: tripDate(trip, day), timeZone: trip.timeZone, version: 0, planKey: recoveryPlanKey(trip, day, stopIds), baselineStopIds: stopIds, completed: [], skipped: [], missedBookings: [], originId: "hotel", readyAt: null };
}
export function remainingIds(stopIds: string[], progress: DayProgress): string[] {
  const done = new Set([...progress.completed.map((visit) => visit.stopId), ...progress.skipped, ...(progress.remaining?.skipped ?? [])]);
  return (progress.remaining?.stopIds ?? stopIds).filter((id) => !done.has(id));
}
export function recoveryMinute(trip: Trip, day: number, instant: string) {
  return (Temporal.Instant.from(instant).epochMilliseconds - instantForMinute(trip, day, 0).epochMilliseconds) / 60_000;
}
export function recoveryContext(request: RecoveryRequest) { return JSON.stringify(recoveryRequestSchema.parse(request)); }

export function recoveryInputErrors(request: RecoveryRequest, now = Temporal.Now.instant()): string[] {
  const { trip, day, stopIds, progress, origin, permissions } = request;
  const errors: string[] = [];
  if (progress.timeZone && progress.timeZone !== trip.timeZone && (progress.completed.length || progress.readyAt !== null)) errors.push(`Actual progress uses ${progress.timeZone}. Restore that city timezone before live recovery.`);
  if (day >= trip.days || tripDate(trip, day) !== now.toZonedDateTimeISO(trip.timeZone).toPlainDate().toString()) errors.push("Live recovery is available only on the actual trip day.");
  if (progress.date !== tripDate(trip, day) || progress.planKey !== recoveryPlanKey(trip, day, stopIds)) errors.push("The trip changed. Reconcile today's progress before refreshing routes.");
  const members = new Set(stopIds);
  const completed = new Set(progress.completed.map((visit) => visit.stopId));
  if (progress.completed.some((visit) => visit.end > recoveryMinute(trip, day, now.toString()) + 1)) errors.push("Actual completion cannot be in the future.");
  if (completed.size !== progress.completed.length || progress.completed.some((visit, index) => index > 0 && visit.start < progress.completed[index - 1].end)) errors.push("Actual visits overlap or repeat.");
  const allIds = [...stopIds, ...completed, ...progress.skipped, ...progress.missedBookings, ...(progress.remaining?.stopIds ?? []), ...(progress.remaining?.skipped ?? [])];
  if (allIds.some((id) => !members.has(id) || !trip.stops.some((stop) => stop.id === id)) || [...completed].some((id) => progress.skipped.includes(id))) errors.push("Progress contains unknown or conflicting visits.");
  if (progress.missedBookings.some((id) => !progress.skipped.includes(id) || !trip.stops.find((stop) => stop.id === id)?.fixedTime)) errors.push("Missed booking acknowledgements must refer to explicitly skipped bookings.");
  if (progress.remaining && stopIds.some((id) => !completed.has(id) && !progress.skipped.includes(id) && !progress.remaining!.skipped.includes(id) && !progress.remaining!.stopIds.includes(id))) errors.push("Saved recovery must explain every unfinished visit.");
  for (const [id, duration] of Object.entries(progress.remaining?.durations ?? {})) {
    const stop = trip.stops.find((stop) => stop.id === id);
    if (!stop || !members.has(id) || duration > stop.duration || (stop.fixedTime && duration !== stop.duration)) errors.push("Saved recovery contains invalid visit durations.");
  }
  if (origin.id !== "hotel" && !trip.stops.some((stop) => stop.id === origin.id)) errors.push("Confirm your current location.");
  const pending = remainingIds(stopIds, progress);
  const minute = recoveryMinute(trip, day, request.departureAt);
  if (minute < minuteAt(trip, day, trip.dailyStart) || minute > minuteAt(trip, day, trip.dailyEnd) || minute + 0.01 < Math.max(progress.readyAt ?? 0, ...progress.completed.map((visit) => visit.end))) errors.push("Departure must follow actual progress and stay within today's hours.");
  const departure = Temporal.Instant.from(request.departureAt);
  if (Math.abs(departure.epochMilliseconds - now.epochMilliseconds) > 120_000 && departure.epochMilliseconds < now.epochMilliseconds) errors.push("Departure time is stale. Refresh from the current time.");
  if (request.mode === "route" && (!request.targetId || (request.targetId !== "hotel" && !pending.includes(request.targetId)))) errors.push("Choose a remaining destination.");
  if (request.preferredRoute && request.preferredRoute.to !== "hotel" && !pending.includes(request.preferredRoute.to)) errors.push("The selected next route is no longer relevant.");
  for (const stop of trip.stops.filter((stop) => members.has(stop.id))) {
    if (stop.day !== null && stop.day !== day) errors.push(`${stop.name}: assigned day changed.`);
    if (stop.fixedTime && [...progress.skipped, ...(progress.remaining?.skipped ?? [])].includes(stop.id) && !progress.missedBookings.includes(stop.id)) errors.push(`${stop.name}: acknowledge the missed booking explicitly.`);
    if (stop.fixedTime && pending.includes(stop.id) && minute + stop.buffer > minuteAt(trip, day, stop.fixedTime) + 0.01) errors.push(`${stop.name}: the booking can no longer be reached with its arrival buffer. Record it as missed or keep the current plan.`);
  }
  for (const id of [...permissions.skipIds, ...Object.keys(permissions.minimumDurations)]) {
    const stop = trip.stops.find((stop) => stop.id === id);
    if (!stop || !pending.includes(id) || stop.fixedTime || (permissions.minimumDurations[id] ?? 5) > (progress.remaining?.durations[id] ?? stop.duration)) errors.push("Only remaining flexible visits may be skipped or shortened within your chosen limits.");
  }
  for (const group of trip.dayGroups ?? []) {
    if (stopIds.some((id) => group.stopIds.includes(id)) && (!group.allowedDays.includes(day) || (group.exclusive && stopIds.some((id) => !group.stopIds.includes(id))))) errors.push(`${group.name}: today's group constraints changed.`);
  }
  return [...new Set(errors)];
}

export function recoveryLocationErrors(request: RecoveryRequest): string[] {
  const needed = request.mode === "route" ? [request.targetId!] : [...remainingIds(request.stopIds, request.progress), ...(request.trip.returnToHotel ? ["hotel"] : [])];
  if (!request.origin.location) needed.push(request.origin.id);
  return needed.some((id) => id === "hotel" ? !request.trip.hotelPlaceId : !request.trip.stops.find((stop) => stop.id === id)?.placeId) ? ["Confirm your origin, hotel, and remaining destinations on the map first."] : [];
}

export function validateDayRecovery(request: RecoveryRequest, option: RecoveryOption): string[] {
  const errors: string[] = [];
  const { trip, day, progress } = request;
  const pending = remainingIds(request.stopIds, progress);
  const visited = new Set<string>();
  let previous = "current";
  let end = recoveryMinute(trip, day, request.departureAt);
  const edgeErrors = (leg: DayPlan["returnLeg"], to: string) => {
    if (!leg || leg.from !== previous || leg.to !== to || leg.day !== day || !Number.isFinite(leg.minutes) || leg.minutes < 0 || !Number.isFinite(leg.meters) || leg.meters < 0 || leg.assumed || leg.estimated || leg.timetableDate || !allowsTravelEdge(trip, leg)) errors.push("Travel is disconnected, unavailable, or not checked for the actual date.");
  };
  if (option.day.day !== day || option.day.date !== tripDate(trip, day)) errors.push("The recovery date changed.");
  for (const visit of option.day.visits) {
    const stop = trip.stops.find((stop) => stop.id === visit.stopId);
    if (!stop || !pending.includes(visit.stopId) || visited.has(visit.stopId)) { errors.push("Recovery repeats or changes an actual visit."); continue; }
    edgeErrors(visit.leg, stop.id);
    const duration = visit.end - visit.start;
    const original = progress.remaining?.durations[stop.id] ?? stop.duration;
    if (!Number.isFinite(visit.start) || !Number.isFinite(visit.end) || Math.abs(duration - Math.round(duration)) > 0.01 || duration + 0.01 < (request.permissions.minimumDurations[stop.id] ?? original) || duration > original + 0.01 || Math.abs((option.durations[stop.id] ?? Infinity) - duration) > 0.01 || (stop.fixedTime && (Math.abs(duration - stop.duration) > 0.01 || Math.abs(visit.start - minuteAt(trip, day, stop.fixedTime!)) > 0.01))) errors.push(`${stop.name}: unapproved duration or changed booking.`);
    if (visit.start + 0.01 < end + visit.leg.minutes + (stop.fixedTime ? stop.buffer : 0) || visit.end > minuteAt(trip, day, trip.dailyEnd)) errors.push(`${stop.name}: insufficient time.`);
    visited.add(stop.id); previous = stop.id; end = visit.end;
  }
  if (new Set(option.skipped).size !== option.skipped.length || option.skipped.some((id) => !pending.includes(id) || !request.permissions.skipIds.includes(id) || trip.stops.find((stop) => stop.id === id)?.fixedTime || visited.has(id))) errors.push("An omission was not approved.");
  if (pending.some((id) => !visited.has(id) && !option.skipped.includes(id))) errors.push("A remaining visit is missing.");
  if (request.preferredRoute && (option.day.visits[0]?.stopId ?? "hotel") !== request.preferredRoute.to) errors.push("The selected next destination changed.");
  if (request.preferredRoute && liveRouteKey(option.day.visits[0]?.leg ?? option.day.returnLeg!) !== request.preferredRoute.key) errors.push("The selected route changed. Refresh it before continuing.");
  if (visited.size + progress.completed.length > (trip.planning?.maxStopsPerDay ?? 25)) errors.push("Too many visits today.");
  if (trip.returnToHotel) {
    edgeErrors(option.day.returnLeg, "hotel");
    if (end + (option.day.returnLeg?.minutes ?? Infinity) > minuteAt(trip, day, trip.dailyEnd)) errors.push("No timely hotel return.");
  }
  return errors;
}

export function applyDayRecovery(progress: DayProgress, option: RecoveryOption, snapshot?: z.infer<typeof savedRecoverySchema>): DayProgress {
  return { ...progress, version: progress.version + 1, previousRemaining: progress.remaining, undoAvailable: true, remaining: { stopIds: option.day.visits.map((visit) => visit.stopId), durations: option.durations, skipped: [...new Set([...(progress.remaining?.skipped ?? []), ...option.skipped])], ...(snapshot ? { snapshot: savedRecoverySchema.parse(snapshot) } : {}) } };
}