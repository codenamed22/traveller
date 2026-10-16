import { Temporal } from "@js-temporal/polyfill";
import { dayProgressSchema, type DayProgress } from "@/lib/day-recovery";
import type { Journey } from "@/lib/journey";
import { markDone, markPending, markSkipped, minuteNow, tripModeDays, visitStatus } from "@/lib/trip-mode";

// What the iPhone app calls in the page (`window.travellerNative`), built from one render's trip. The page stays the only
// place that saves the trip. `features` tells the app which calls this version of the site understands.
export const nativeFeatures = ["record-at", "undo-saved", "reset", "opened"];

type Deps = {
  journey: Journey;
  recordProgress: (cityId: string, date: string, next: DayProgress | undefined) => void;
  adjustToday: (cityId: string, day: number) => void;
  opened: () => void;
  closed: () => void;
  photo?: (placeId: string, index: number) => Promise<unknown>;
  now?: () => Temporal.Instant;
};

// Undo for the last Done or Skip of each day, kept across reloads: the day as it was, and the version that replaced it.
type UndoEntry = { before: unknown; afterVersion: number };
const undoPrefix = "traveller.nativeUndo:";
const undoKey = (journeyId: string, cityId: string, date: string) => `${undoPrefix}${journeyId}:${cityId}:${date}`;
// Used only when the page can't reach local storage.
const memory = new globalThis.Map<string, string>();

function storage() {
  try { return window.localStorage ?? undefined; } catch { return undefined; }
}

function readUndo(key: string): UndoEntry | undefined {
  let raw: string | null | undefined;
  try { raw = storage()?.getItem(key); } catch { raw = undefined; }
  raw ??= memory.get(key);
  try { return raw ? JSON.parse(raw) as UndoEntry : undefined; } catch { return undefined; }
}

function writeUndo(key: string, entry: UndoEntry | undefined) {
  const store = storage();
  const raw = entry ? JSON.stringify(entry) : undefined;
  memory.delete(key);
  try {
    if (!store) throw new Error("No storage");
    if (raw) store.setItem(key, raw); else store.removeItem(key);
  } catch { if (raw) memory.set(key, raw); }
}

// Undo for a day that has passed is no use; drop those when a newer day records something.
function pruneUndo(date: string) {
  const store = storage();
  try {
    for (let index = (store?.length ?? 0) - 1; index >= 0; index--) {
      const key = store!.key(index);
      if (key?.startsWith(undoPrefix) && key.slice(-10) < date) store!.removeItem(key);
    }
  } catch { /* Nothing to prune. */ }
  for (const key of memory.keys()) if (key.slice(-10) < date) memory.delete(key);
}

export function createNativeApi({ journey, recordProgress, adjustToday, opened, closed, photo, now: clock = () => Temporal.Now.instant() }: Deps) {
  return {
    features: nativeFeatures,
    // `at` (epoch ms) is when the app recorded it, for Done tapped without a connection and sent later; without it, now.
    record(kind: "done" | "skip", cityId: string, day: number, stopId: string, at?: number) {
      const now = clock();
      if (at !== undefined && at !== null && !Number.isFinite(at)) throw new Error("The time of that visit isn't valid.");
      const when = typeof at === "number" ? Temporal.Instant.fromEpochMilliseconds(Math.round(at)) : now;
      if (when.epochMilliseconds > now.epochMilliseconds + 60_000) throw new Error("A visit can't be marked ahead of time.");
      const entry = tripModeDays(journey.cities, journey.plans, journey.execution, now).find((candidate) => candidate.cityId === cityId && candidate.day === day);
      const stop = entry?.trip.stops.find((candidate) => candidate.id === stopId);
      let onDay = Boolean(entry?.isToday);
      if (entry && typeof at === "number") {
        try { onDay = when.toZonedDateTimeISO(entry.cityTrip.timeZone).toPlainDate().toString() === entry.date; } catch { onDay = false; }
      }
      if (!entry || !stop || !onDay) throw new Error("Only today's visits can be marked.");
      const next = kind === "done" ? markDone(entry, stopId, minuteNow(entry, when)) : markSkipped(entry, stop);
      pruneUndo(entry.date);
      writeUndo(undoKey(journey.id, cityId, entry.date), { before: entry.progress ?? null, afterVersion: next.version });
      recordProgress(cityId, entry.date, next);
      return kind === "done" ? `${stop.name} marked done` : `${stop.name} skipped`;
    },
    // Undo on the visit itself, any time that day: back to not done, whatever was recorded after it.
    reset(cityId: string, day: number, stopId: string) {
      const entry = tripModeDays(journey.cities, journey.plans, journey.execution, clock()).find((candidate) => candidate.cityId === cityId && candidate.day === day);
      const stop = entry?.trip.stops.find((candidate) => candidate.id === stopId);
      if (!entry?.isToday || !stop) throw new Error("Only today's visits can be changed.");
      const status = visitStatus(entry.progress, stopId);
      if (status === "pending") return `${stop.name} isn't marked`;
      const next = markPending(entry, stopId);
      writeUndo(undoKey(journey.id, cityId, entry.date), { before: entry.progress ?? null, afterVersion: next.version });
      recordProgress(cityId, entry.date, next);
      return status === "done" ? `${stop.name} no longer marked done` : `${stop.name} no longer skipped`;
    },
    // Only while the day is still as that Done or Skip left it; anything recorded since would be lost.
    undo(cityId: string, date: string) {
      const key = undoKey(journey.id, cityId, date);
      const saved = readUndo(key);
      writeUndo(key, undefined);
      if (!saved || journey.execution?.[cityId]?.[date]?.version !== saved.afterVersion) return false;
      if (saved.before === null) { recordProgress(cityId, date, undefined); return true; }
      const before = dayProgressSchema.safeParse(saved.before);
      if (!before.success) return false;
      recordProgress(cityId, date, before.data);
      return true;
    },
    adjustToday,
    // Trip mode opened by the app itself, such as from a reminder; the page sends it updates from now on.
    opened,
    closed,
    photo(placeId: string, index: number) {
      if (!photo) throw new Error("Photos are unavailable");
      return photo(placeId, index);
    },
  };
}

export type NativeApi = ReturnType<typeof createNativeApi>;
