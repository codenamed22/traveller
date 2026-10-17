import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import type { DayProgress } from "./day-recovery";
import type { Journey } from "./journey";
import { markDone, markPending, markSkipped, minuteNow, tripModeDays, visitStatus } from "./trip-mode";

// Done, Skip and taking either back, as the iPhone app records them: straight away through the page, or saved on the
// phone without a connection and sent later. `at` (epoch ms) is when it was tapped; without it, now.
export const nativeActionSchema = z.object({
  kind: z.enum(["done", "skip", "reset"]),
  cityId: z.uuid(),
  day: z.number().int().min(0).max(6),
  stopId: z.uuid(),
  at: z.number().finite().optional(),
}).strict();
export type NativeAction = z.infer<typeof nativeActionSchema>;

// The day's progress after the action, or `changed: false` when there was nothing to take back.
export type NativeChange = { cityId: string; date: string; before: DayProgress | undefined; next: DayProgress | undefined; changed: boolean; message: string };

export function applyNativeAction(journey: Journey, action: NativeAction, now: Temporal.Instant): NativeChange {
  const { kind, cityId, day, stopId, at } = action;
  if (at !== undefined && at !== null && !Number.isFinite(at)) throw new Error("The time of that visit isn't valid.");
  const when = typeof at === "number" ? Temporal.Instant.fromEpochMilliseconds(Math.round(at)) : now;
  if (when.epochMilliseconds > now.epochMilliseconds + 60_000) throw new Error("A visit can't be marked ahead of time.");
  const entry = tripModeDays(journey.cities, journey.plans, journey.execution, now).find((candidate) => candidate.cityId === cityId && candidate.day === day);
  const stop = entry?.trip.stops.find((candidate) => candidate.id === stopId);
  // Only on the visit's own day: today, or the day it was tapped when it was saved on the phone.
  let onDay = Boolean(entry?.isToday);
  if (entry && typeof at === "number") {
    try { onDay = when.toZonedDateTimeISO(entry.cityTrip.timeZone).toPlainDate().toString() === entry.date; } catch { onDay = false; }
  }
  if (!entry || !stop || !onDay) throw new Error(kind === "reset" ? "Only today's visits can be changed." : "Only today's visits can be marked.");
  const before = entry.progress;
  if (kind === "reset") {
    const status = visitStatus(before, stopId);
    if (status === "pending") return { cityId, date: entry.date, before, next: before, changed: false, message: `${stop.name} isn't marked` };
    return { cityId, date: entry.date, before, next: markPending(entry, stopId), changed: true, message: status === "done" ? `${stop.name} no longer marked done` : `${stop.name} no longer skipped` };
  }
  const next = kind === "done" ? markDone(entry, stopId, minuteNow(entry, when)) : markSkipped(entry, stop);
  return { cityId, date: entry.date, before, next, changed: true, message: kind === "done" ? `${stop.name} marked done` : `${stop.name} skipped` };
}

// The journey with one day's progress replaced, as the planner records it.
export function withProgress(journey: Journey, cityId: string, date: string, next: DayProgress | undefined): Journey {
  const city = { ...journey.execution?.[cityId] };
  if (next) city[date] = next; else delete city[date];
  return { ...journey, execution: { ...journey.execution, [cityId]: city } };
}
