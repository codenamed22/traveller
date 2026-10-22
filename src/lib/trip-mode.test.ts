import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";
import { newDayProgress } from "./day-recovery";
import { minuteAt, newStop, newTrip, persistedPlan, type DayPlan, type Place, type Schedule, type TravelEdge, type Trip } from "./trip";
import { dayMeals, daySummary, directionsUrl, durationLabel, leaveBy, markDone, markPending, markSkipped, mealSearch, mealSoon, minuteNow, nextVisit, startingDay, tripModeDays, visitStatus, walkingUrl } from "./trip-mode";

const place = (id: string, name: string): Place => ({ id, name, address: `${name} street`, location: { lat: 52.37, lng: 4.89 } });
const leg = (from: string, to: string, minutes: number, mode: TravelEdge["mode"] = "WALK"): TravelEdge => ({ day: 0, from, to, mode, minutes, meters: 900 });

function fixture() {
  const coffee = { ...newStop("Sango Coffee"), placeId: "g-sango", duration: 45 };
  const museum = { ...newStop("Rijksmuseum"), placeId: "g-rijks", day: 0, fixedTime: "11:00", duration: 120 };
  const dinner = { ...newStop("FUKU"), placeId: "g-fuku", duration: 60 };
  const amsterdam: Trip = { ...newTrip(), city: "Amsterdam", hotel: "Motel One", startDate: "2026-12-24", days: 2, timeZone: "Europe/Amsterdam", dailyStart: "09:00", dailyEnd: "21:00", stops: [coffee, museum, dinner] };
  const at = (day: number, time: string) => minuteAt(amsterdam, day, time);
  const days: DayPlan[] = [
    { day: 0, date: "2026-12-24", visits: [
      { stopId: coffee.id, start: at(0, "09:30"), end: at(0, "10:15"), leg: leg("hotel", coffee.id, 15) },
      { stopId: museum.id, start: at(0, "11:00"), end: at(0, "13:00"), leg: leg(coffee.id, museum.id, 20, "TRANSIT") },
    ], returnLeg: leg(museum.id, "hotel", 25) },
    { day: 1, date: "2026-12-25", visits: [{ stopId: dinner.id, start: at(1, "18:00"), end: at(1, "19:00"), leg: leg("hotel", dinner.id, 10) }], returnLeg: leg(dinner.id, "hotel", 10) },
  ];
  const schedule: Schedule = { generatedAt: "2026-10-14T06:00:00Z", warnings: [], omitted: [], days };
  const places = { hotel: place("g-hotel", "Motel One"), [coffee.id]: place("g-sango", "Sango Coffee"), [museum.id]: place("g-rijks", "Rijksmuseum"), [dinner.id]: place("g-fuku", "FUKU") };
  const brussels: Trip = { ...newTrip(), city: "Brussels", startDate: "2026-12-26", days: 1, timeZone: "Europe/Brussels", stops: [newStop("Grand Place")] };
  return { amsterdam, brussels, coffee, museum, dinner, places, plans: { [amsterdam.id]: persistedPlan(schedule, amsterdam, places) } };
}
// 10:00 in Amsterdam on 24 December is 09:00 UTC.
const christmasEve = Temporal.Instant.from("2026-12-24T09:00:00Z");

describe("trip mode days", () => {
  it("lists planned days across cities and knows which one is today in the city's time zone", () => {
    const { amsterdam, brussels, coffee, plans } = fixture();
    const days = tripModeDays([amsterdam, brussels], plans, undefined, christmasEve);
    expect(days.map((entry) => [entry.label, entry.city, entry.isToday, entry.stale])).toEqual([["Day 1 · Thu 24 Dec", "Amsterdam", true, false], ["Day 2 · Fri 25 Dec", "Amsterdam", false, false]]);
    // 23:30 UTC on the 24th is already the 25th in Amsterdam.
    expect(tripModeDays([amsterdam], plans, undefined, Temporal.Instant.from("2026-12-24T23:30:00Z")).map((entry) => entry.isToday)).toEqual([false, true]);
    expect(startingDay(days)?.day).toBe(0);
    expect(startingDay(tripModeDays([amsterdam], plans, undefined, Temporal.Instant.from("2026-11-01T09:00:00Z")), { cityId: amsterdam.id, day: 1 })?.day).toBe(1);
    expect(tripModeDays([{ ...amsterdam, dailyEnd: "20:00" }], plans, undefined, christmasEve)[0].stale).toBe(true);
    // A must-see set on a planned place leaves the plan as it is.
    const coffeeMustSee = { ...amsterdam, stops: amsterdam.stops.map((stop) => stop.id === coffee.id ? { ...stop, priority: 5 } : stop) };
    expect(tripModeDays([coffeeMustSee], plans, undefined, christmasEve)[0].stale).toBe(false);
  });

  it("shows today's replan instead of the accepted day once there is one", () => {
    const { amsterdam, museum, places, plans } = fixture();
    const replanned: DayPlan = { day: 0, date: "2026-12-24", visits: [{ stopId: museum.id, start: minuteAt(amsterdam, 0, "11:00"), end: minuteAt(amsterdam, 0, "12:30"), leg: leg("hotel", museum.id, 20) }] };
    const progress = { ...newDayProgress(amsterdam, 0, plans[amsterdam.id].days[0].stopIds), remaining: { stopIds: [museum.id], durations: { [museum.id]: 90 }, skipped: [], snapshot: { trip: amsterdam, day: replanned, checkedAt: "2026-12-24T09:00:00Z", departureAt: "2026-12-24T09:00:00Z", origin: { id: "hotel" as const }, places } } };
    const [today] = tripModeDays([amsterdam], plans, { [amsterdam.id]: { "2026-12-24": progress } }, christmasEve);
    expect(today.replanned).toBe(true);
    expect(today.plan.visits.map((visit) => visit.end - visit.start)).toEqual([90]);
    // Setting off at 10:40 leaves room for breakfast, but a day replanned since it began has had it.
    expect(dayMeals(today).map((gap) => gap.meal)).toEqual(["lunch", "dinner"]);
  });

  it("finds the next visit, when to leave and a summary of the day", () => {
    const { amsterdam, coffee, museum, plans } = fixture();
    const [today] = tripModeDays([amsterdam], plans, undefined, christmasEve);
    expect(nextVisit(today)?.stopId).toBe(coffee.id);
    expect(leaveBy(today.plan.visits[1])).toBe(minuteAt(amsterdam, 0, "10:40"));
    expect(daySummary(today.plan)).toEqual({ stops: 2, leave: minuteAt(amsterdam, 0, "09:15"), back: minuteAt(amsterdam, 0, "13:25"), travel: 60 });
    expect(durationLabel(60)).toBe("1 h");
    expect(durationLabel(85)).toBe("1 h 25 min");
    const done = { ...today, progress: markDone(today, coffee.id, minuteNow(today, christmasEve)) };
    expect(visitStatus(done.progress, coffee.id)).toBe("done");
    expect(nextVisit(done)?.stopId).toBe(museum.id);
    const skipped = { ...done, progress: markSkipped(done, museum) };
    expect(nextVisit(skipped)).toBeUndefined();
  });

  it("records Done as a visit ending now that never overlaps the previous one, and Skip of a booking as missed", () => {
    const { amsterdam, coffee, museum, plans } = fixture();
    const [today] = tripModeDays([amsterdam], plans, undefined, christmasEve);
    const now = minuteNow(today, christmasEve);
    expect(now).toBe(minuteAt(amsterdam, 0, "10:00"));
    const first = markDone(today, coffee.id, now);
    expect(first.completed).toEqual([{ stopId: coffee.id, start: minuteAt(amsterdam, 0, "09:15"), end: now }]);
    expect(first).toMatchObject({ version: 1, originId: coffee.id, readyAt: now, date: "2026-12-24" });
    // Marked done 30 minutes later: the two-hour museum visit cannot start before the coffee ended.
    const second = markDone({ ...today, progress: first }, museum.id, now + 30);
    expect(second.completed.at(-1)).toEqual({ stopId: museum.id, start: now, end: now + 30 });
    const missed = markSkipped(today, museum);
    expect(missed).toMatchObject({ skipped: [museum.id], missedBookings: [museum.id], version: 1 });
    expect(markSkipped(today, coffee).missedBookings).toEqual([]);
  });

  it("undoes one visit any time that day, keeping the others", () => {
    const { amsterdam, coffee, museum, plans } = fixture();
    const [today] = tripModeDays([amsterdam], plans, undefined, christmasEve);
    const now = minuteNow(today, christmasEve);
    const first = markDone(today, coffee.id, now);
    const second = markDone({ ...today, progress: first }, museum.id, now + 30);
    // The coffee was tapped by mistake; the museum visit stays done and the day still carries on from it.
    const undone = markPending({ ...today, progress: second }, coffee.id);
    expect(undone).toMatchObject({ version: 3, completed: [{ stopId: museum.id }], originId: museum.id, readyAt: now + 30 });
    expect(visitStatus(undone, coffee.id)).toBe("pending");
    // The last one undone too: back to the hotel, free from no particular time.
    expect(markPending({ ...today, progress: undone }, museum.id)).toMatchObject({ completed: [], originId: "hotel", readyAt: null });
    // A skipped booking is no longer missed.
    const missed = markSkipped(today, museum);
    expect(markPending({ ...today, progress: missed }, museum.id)).toMatchObject({ skipped: [], missedBookings: [], version: 2 });
  });

  it("shows a meal the day leaves out as it comes up, and looks near you for somewhere to eat from now", () => {
    const { amsterdam, plans } = fixture();
    const [today] = tripModeDays([amsterdam], plans, undefined, christmasEve);
    const lunch = dayMeals(today).find((gap) => gap.meal === "lunch")!;
    expect(lunch).toMatchObject({ start: minuteAt(amsterdam, 0, "12:25"), end: minuteAt(amsterdam, 0, "13:25"), nearName: "Rijksmuseum" });
    // From half an hour before until it would end.
    expect(["11:50", "11:55", "13:24", "13:25"].map((time) => mealSoon(lunch, minuteAt(amsterdam, 0, time)))).toEqual([false, true, true, false]);
    // Near you in the city, from now for an hour; from a phone in another country, near the museum.
    expect(mealSearch(lunch, minuteAt(amsterdam, 0, "12:00"), { lat: 52.36, lng: 4.88 })).toEqual({ location: { lat: 52.36, lng: 4.88 }, here: true, start: minuteAt(amsterdam, 0, "12:25"), end: minuteAt(amsterdam, 0, "13:25") });
    expect(mealSearch(lunch, minuteAt(amsterdam, 0, "12:50") + 0.4, { lat: 51.5, lng: -0.12 })).toEqual({ location: lunch.location, here: false, start: minuteAt(amsterdam, 0, "12:51"), end: minuteAt(amsterdam, 0, "13:51") });
    expect(mealSearch({ start: 23 * 60, end: 24 * 60 + 15, location: lunch.location }, 23 * 60 + 10)).toMatchObject({ start: 23 * 60 + 10, end: 24 * 60 - 1 });
    // A meal place pinned to the day since fills it.
    const withLunch: Trip = { ...amsterdam, stops: [...amsterdam.stops, { ...newStop("Foodhallen"), day: 0, kind: "meal", slot: "lunch" }] };
    expect(dayMeals(tripModeDays([withLunch], plans, undefined, christmasEve)[0]).map((gap) => gap.meal)).toEqual(["dinner"]);
    const walk = new URL(walkingUrl({ id: "g-foodhallen", name: "Foodhallen" }));
    expect([walk.searchParams.has("origin"), walk.searchParams.get("destination_place_id"), walk.searchParams.get("travelmode")]).toEqual([false, "g-foodhallen", "walking"]);
  });

  it("links directions from the previous stop, or from wherever the phone is", () => {
    const { places, coffee, museum } = fixture();
    const edge = leg(coffee.id, museum.id, 20, "TRANSIT");
    const planned = new URL(directionsUrl(edge, places));
    expect(planned.searchParams.get("origin_place_id")).toBe("g-sango");
    expect(planned.searchParams.get("destination_place_id")).toBe("g-rijks");
    expect(planned.searchParams.get("travelmode")).toBe("transit");
    const here = new URL(directionsUrl(edge, places, { fromHere: true }));
    expect(here.searchParams.has("origin")).toBe(false);
    expect(here.searchParams.get("destination")).toBe("Rijksmuseum");
    const station = new URL(directionsUrl(leg(museum.id, "hotel", 10), { ...places, departure: place("g-centraal", "Amsterdam Centraal") }, { toDeparture: true }));
    expect(station.searchParams.get("destination_place_id")).toBe("g-centraal");
  });
});
