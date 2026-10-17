import { Temporal } from "@js-temporal/polyfill";
import { dayProgressSchema, type DayProgress } from "@/lib/day-recovery";
import type { Journey } from "@/lib/journey";
import { applyNativeAction, type NativeAction } from "@/lib/native-actions";

// What the iPhone app calls in the page (`window.travellerNative`), built from one render's trip. The page stays the only
// place that saves the trip. `features` tells the app which calls this version of the site understands.
export const nativeFeatures = ["record-at", "undo-saved", "reset", "opened", "send"];

type Deps = {
  journey: Journey;
  recordProgress: (cityId: string, date: string, next: DayProgress | undefined) => void;
  adjustToday: (cityId: string, day: number) => void;
  opened: () => void;
  closed: () => void;
  photo?: (placeId: string, index: number) => Promise<unknown>;
  send?: (journeyId: string, actions: unknown[]) => Promise<unknown>;
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

export function createNativeApi({ journey, recordProgress, adjustToday, opened, closed, photo, send, now: clock = () => Temporal.Now.instant() }: Deps) {
  function apply(action: NativeAction) {
    const change = applyNativeAction(journey, action, clock());
    if (!change.changed) return change.message;
    pruneUndo(change.date);
    writeUndo(undoKey(journey.id, change.cityId, change.date), { before: change.before ?? null, afterVersion: change.next!.version });
    recordProgress(change.cityId, change.date, change.next);
    return change.message;
  }
  return {
    features: nativeFeatures,
    // The trip these calls change, so the app never records a visit against another one.
    journeyId: journey.id,
    // `at` (epoch ms) is when the app recorded it, for Done tapped without a connection and sent later; without it, now.
    record(kind: "done" | "skip", cityId: string, day: number, stopId: string, at?: number) {
      return apply({ kind, cityId, day, stopId, ...(at === undefined || at === null ? {} : { at }) });
    },
    // Undo on the visit itself, any time that day: back to not done, whatever was recorded after it.
    reset(cityId: string, day: number, stopId: string, at?: number) {
      return apply({ kind: "reset", cityId, day, stopId, ...(at === undefined || at === null ? {} : { at }) });
    },
    // Changes saved on the phone for a trip this page doesn't hold: the site saves them straight to that trip.
    send(journeyId: string, actions: unknown[]) {
      if (!send) throw new Error("Saving is unavailable");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(journeyId)) throw new Error("That trip isn't valid.");
      return send(journeyId, actions);
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
