import { Temporal } from "@js-temporal/polyfill";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DayProgress } from "@/lib/day-recovery";
import type { Journey } from "@/lib/journey";
import { minuteAt, newStop, newTrip, persistedPlan, type Place, type Schedule, type TravelEdge } from "@/lib/trip";

const place = (id: string, name: string): Place => ({ id, name, address: `${name} street`, location: { lat: 52.37, lng: 4.89 } });
const leg = (from: string, to: string, minutes: number): TravelEdge => ({ day: 0, from, to, mode: "WALK", minutes, meters: 900 });
// 10:00 in Amsterdam on Christmas Eve.
const now = Temporal.Instant.from("2026-12-24T09:00:00Z");

function fixture() {
  const coffee = { ...newStop("Sango Coffee"), placeId: "g-sango", duration: 45 };
  const amsterdam = { ...newTrip(), city: "Amsterdam", hotel: "Motel One", startDate: "2026-12-24", days: 1, timeZone: "Europe/Amsterdam", stops: [coffee] };
  const schedule: Schedule = { generatedAt: "2026-10-14T06:00:00Z", warnings: [], omitted: [], days: [
    { day: 0, date: "2026-12-24", visits: [{ stopId: coffee.id, start: minuteAt(amsterdam, 0, "09:30"), end: minuteAt(amsterdam, 0, "10:15"), leg: leg("hotel", coffee.id, 15) }], returnLeg: leg(coffee.id, "hotel", 15) },
  ] };
  const journey: Journey = { id: crypto.randomUUID(), title: "Christmas", cities: [amsterdam], plans: { [amsterdam.id]: persistedPlan(schedule, amsterdam, { hotel: place("g-hotel", "Motel One"), [coffee.id]: place("g-sango", "Sango Coffee") }) } };
  return { journey, amsterdam, coffee };
}

// A fresh copy of the module, as after a reload: nothing kept in memory, only what's in local storage.
async function load() {
  vi.resetModules();
  return (await import("./nativeApi")).createNativeApi;
}

function api(createNativeApi: Awaited<ReturnType<typeof load>>, journey: Journey) {
  const recorded: { cityId: string; date: string; next: DayProgress | undefined }[] = [];
  const native = createNativeApi({ journey, recordProgress: (cityId, date, next) => recorded.push({ cityId, date, next }), adjustToday() {}, opened() {}, closed() {}, now: () => now });
  return { native, recorded };
}

const withProgress = (journey: Journey, cityId: string, next: DayProgress | undefined): Journey => ({ ...journey, execution: { [cityId]: next ? { "2026-12-24": next } : {} } });

let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal("window", { localStorage: {
    getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key),
    key: (index: number) => [...store.keys()][index] ?? null, get length() { return store.size; },
  } });
});
afterEach(() => vi.unstubAllGlobals());

describe("the page's calls for the iPhone app", () => {
  it("says which calls it understands", async () => {
    const { journey } = fixture();
    expect(api(await load(), journey).native.features).toEqual(expect.arrayContaining(["record-at", "undo-saved", "reset", "opened", "send"]));
  });

  it("opens Adjust today from the app, with a place from spare time to fit in", async () => {
    const { journey, amsterdam, coffee } = fixture();
    const adjustToday = vi.fn();
    const native = (await load())({ journey, recordProgress() {}, adjustToday, opened() {}, closed() {} });
    native.adjustToday(amsterdam.id, 0);
    native.adjustToday(amsterdam.id, 0, coffee.id);
    native.adjustToday(amsterdam.id, 0, "not a place");
    expect(adjustToday.mock.calls).toEqual([[amsterdam.id, 0, undefined], [amsterdam.id, 0, coffee.id], [amsterdam.id, 0, undefined]]);
  });

  it("asks the agent to swap a visit when the page can", async () => {
    const { journey, amsterdam, coffee } = fixture();
    const createNativeApi = await load();
    const swap = vi.fn();
    const native = createNativeApi({ journey, recordProgress() {}, adjustToday() {}, opened() {}, closed() {}, swap });
    expect(native.features).toContain("swap");
    expect(native.swap(amsterdam.id, 0, coffee.id)).toBe(true);
    expect(swap).toHaveBeenCalledWith(amsterdam.id, 0, coffee.id);
    expect(api(createNativeApi, journey).native.swap(amsterdam.id, 0, coffee.id)).toBe(false);
  });

  it("keeps the day's note and favourites from the app's day sheet", async () => {
    const { journey, amsterdam, coffee } = fixture();
    const createNativeApi = await load();
    const recordJournal = vi.fn();
    const native = createNativeApi({ journey, recordProgress() {}, adjustToday() {}, opened() {}, closed() {}, recordJournal });
    expect(native.features).toContain("journal");
    expect(native.journal(amsterdam.id, 0, { note: "Snow on the canals" })).toBe("Note saved");
    expect(native.journal(amsterdam.id, 0, { stopId: coffee.id, favourite: true })).toBe("Sango Coffee added to favourites");
    expect(recordJournal.mock.calls).toEqual([
      [{ kind: "note", cityId: amsterdam.id, day: 0, text: "Snow on the canals" }],
      [{ kind: "favourite", cityId: amsterdam.id, day: 0, stopId: coffee.id, on: true }],
    ]);
    expect(() => native.journal(amsterdam.id, 0, { stopId: coffee.id })).toThrow("That couldn't be saved.");
    expect(() => native.journal(amsterdam.id, 3, { note: "x" })).toThrow("That day isn't in this trip.");
    expect(() => api(createNativeApi, journey).native.journal(amsterdam.id, 0, { note: "x" })).toThrow("Saving is unavailable");
  });

  it("records what the app adds to a transport card, and takes back one added just before", async () => {
    const { journey, amsterdam } = fixture();
    const card = { kind: "tickets" as const, name: "Strippenkaart", currency: "EUR", travellers: 1, ridePrice: 3 };
    const createNativeApi = await load();
    const recordTransport = vi.fn();
    const native = createNativeApi({ journey: { ...journey, transport: { [amsterdam.id]: { card } } }, recordProgress() {}, adjustToday() {}, opened() {}, closed() {}, recordTransport, now: () => now });
    expect(native.features).toContain("transport");
    const ride = { kind: "transport-entry", cityId: amsterdam.id, entry: { id: crypto.randomUUID(), at: now.epochMilliseconds, kind: "ride" } };
    expect(native.transport(ride)).toBe("Ride added");
    expect(native.transport({ kind: "transport-void", cityId: amsterdam.id, entryId: ride.entry.id })).toBe("Ride removed");
    expect(recordTransport).toHaveBeenCalledTimes(2);
    expect(() => native.transport({ kind: "transport-entry", cityId: amsterdam.id })).toThrow("That couldn't be saved.");
    expect(() => api(createNativeApi, journey).native.transport(ride)).toThrow("Saving is unavailable");
  });

  it("asks the agent for captions only once the traveller has agreed, and remembers it", async () => {
    const { journey } = fixture();
    const createNativeApi = await load();
    const captions = vi.fn(async () => ({ captions: [{ caption: "Snow on the canals.", hashtags: ["Amsterdam"] }] }));
    const native = createNativeApi({ journey, recordProgress() {}, adjustToday() {}, opened() {}, closed() {}, captions });
    const summary = { title: "Christmas", cities: ["Amsterdam"], days: [] };
    expect(native.features).toContain("captions");
    expect(await native.captions(summary)).toEqual({ consent: false });
    expect(captions).not.toHaveBeenCalled();
    expect(await native.captions(summary, true)).toEqual({ captions: [{ caption: "Snow on the canals.", hashtags: ["Amsterdam"] }] });
    expect(await native.captions(summary)).toEqual({ captions: [{ caption: "Snow on the canals.", hashtags: ["Amsterdam"] }] });
    expect(captions).toHaveBeenCalledTimes(2);
    expect(captions).toHaveBeenCalledWith(summary);
    // Agreeing to captions isn't agreeing to the assistant.
    expect(store.get("traveller.assistant.consent")).toBeUndefined();
    await expect(api(createNativeApi, journey).native.captions(summary, true)).rejects.toThrow("Captions are unavailable");
  });

  it("records Done at the time the app tapped it, for a tap made without a connection", async () => {
    const { journey, amsterdam, coffee } = fixture();
    const { native, recorded } = api(await load(), journey);
    // Tapped at 09:50, sent at 10:00.
    expect(native.record("done", amsterdam.id, 0, coffee.id, Date.parse("2026-12-24T08:50:00Z"))).toBe("Sango Coffee marked done");
    expect(recorded[0]).toMatchObject({ cityId: amsterdam.id, date: "2026-12-24" });
    expect(recorded[0].next?.completed).toEqual([{ stopId: coffee.id, start: minuteAt(amsterdam, 0, "09:05"), end: minuteAt(amsterdam, 0, "09:50") }]);
  });

  it("refuses times ahead of now, on another day, or not a time at all", async () => {
    const { journey, amsterdam, coffee } = fixture();
    const { native, recorded } = api(await load(), journey);
    expect(() => native.record("done", amsterdam.id, 0, coffee.id, Date.parse("2026-12-24T09:05:00Z"))).toThrow("ahead of time");
    expect(() => native.record("done", amsterdam.id, 0, coffee.id, Date.parse("2026-12-23T20:00:00Z"))).toThrow("Only today's visits");
    expect(() => native.record("done", amsterdam.id, 0, coffee.id, Number.NaN)).toThrow("isn't valid");
    // Up to a minute ahead is the phone's clock running fast, not a future visit.
    expect(native.record("skip", amsterdam.id, 0, coffee.id, Date.parse("2026-12-24T09:00:30Z"))).toBe("Sango Coffee skipped");
    expect(recorded).toHaveLength(1);
  });

  it("undoes the last Done after the page reloads, once", async () => {
    const { journey, amsterdam, coffee } = fixture();
    const first = api(await load(), journey);
    first.native.record("done", amsterdam.id, 0, coffee.id);
    const done = first.recorded[0].next;

    const reloaded = api(await load(), withProgress(journey, amsterdam.id, done));
    expect(reloaded.native.undo(amsterdam.id, "2026-12-24")).toBe(true);
    expect(reloaded.recorded).toEqual([{ cityId: amsterdam.id, date: "2026-12-24", next: undefined }]);
    expect(reloaded.native.undo(amsterdam.id, "2026-12-24")).toBe(false);
  });

  it("brings back the day as it was before, not an empty one", async () => {
    const { journey, amsterdam, coffee } = fixture();
    const first = api(await load(), journey);
    first.native.record("skip", amsterdam.id, 0, coffee.id);
    const skipped = first.recorded[0].next!;
    const second = api(await load(), withProgress(journey, amsterdam.id, skipped));
    second.native.record("done", amsterdam.id, 0, coffee.id);

    const reloaded = api(await load(), withProgress(journey, amsterdam.id, second.recorded[0].next));
    expect(reloaded.native.undo(amsterdam.id, "2026-12-24")).toBe(true);
    expect(reloaded.recorded[0].next).toEqual(skipped);
  });

  it("won't undo once the day has changed since, so nothing recorded later is lost", async () => {
    const { journey, amsterdam, coffee } = fixture();
    const first = api(await load(), journey);
    first.native.record("done", amsterdam.id, 0, coffee.id);
    const later = { ...first.recorded[0].next!, version: first.recorded[0].next!.version + 1 };
    const reloaded = api(await load(), withProgress(journey, amsterdam.id, later));
    expect(reloaded.native.undo(amsterdam.id, "2026-12-24")).toBe(false);
    expect(reloaded.recorded).toEqual([]);
  });

  it("undoes a visit from the visit itself, long after the quick Undo has gone", async () => {
    const { journey, amsterdam, coffee } = fixture();
    const first = api(await load(), journey);
    first.native.record("done", amsterdam.id, 0, coffee.id, Date.parse("2026-12-24T08:00:00Z"));
    const later = api(await load(), withProgress(journey, amsterdam.id, first.recorded[0].next));
    expect(later.native.reset(amsterdam.id, 0, coffee.id)).toBe("Sango Coffee no longer marked done");
    expect(later.recorded[0].next).toMatchObject({ completed: [], originId: "hotel", readyAt: null });
    // Its own quick Undo puts the Done back.
    const again = api(await load(), withProgress(journey, amsterdam.id, later.recorded[0].next));
    expect(again.native.undo(amsterdam.id, "2026-12-24")).toBe(true);
    expect(again.recorded[0].next).toEqual(first.recorded[0].next);
    expect(api(await load(), journey).native.reset(amsterdam.id, 0, coffee.id)).toBe("Sango Coffee isn't marked");
  });

  it("sends changes saved on the phone for another trip to the site, for a real trip only", async () => {
    const { journey } = fixture();
    const sent: unknown[] = [];
    const native = (await load())({ journey, recordProgress() {}, adjustToday() {}, opened() {}, closed() {}, send: async (journeyId, actions) => { sent.push({ journeyId, actions }); return { revision: 2 }; }, now: () => now });
    const other = crypto.randomUUID();
    await expect(native.send(other, [{ kind: "done" }])).resolves.toEqual({ revision: 2 });
    expect(sent).toEqual([{ journeyId: other, actions: [{ kind: "done" }] }]);
    expect(() => native.send("../plan", [])).toThrow("That trip isn't valid.");
    // Not signed in: nothing to save to.
    const withoutSend = api(await load(), journey).native;
    expect(() => withoutSend.send(other, [])).toThrow("Saving is unavailable");
  });

  it("forgets Undo for days that have passed", async () => {
    const { journey, amsterdam, coffee } = fixture();
    store.set(`traveller.nativeUndo:${journey.id}:${amsterdam.id}:2026-12-22`, JSON.stringify({ before: null, afterVersion: 1 }));
    store.set("someone-else", "kept");
    api(await load(), journey).native.record("done", amsterdam.id, 0, coffee.id);
    expect([...store.keys()]).toEqual(["someone-else", `traveller.nativeUndo:${journey.id}:${amsterdam.id}:2026-12-24`]);
  });
});
