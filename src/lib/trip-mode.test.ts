import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";
import { newDayProgress } from "./day-recovery";
import { minuteAt, newStop, newTrip, persistedPlan, type DayPlan, type Place, type Schedule, type TravelEdge, type Trip } from "./trip";
import { daySummary, directionsUrl, durationLabel, leaveBy, markDone, markSkipped, minuteNow, nextVisit, startingDay, tripModeDays, visitStatus } from "./trip-mode";

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
    const { amsterdam, brussels, plans } = fixture();
    const days = tripModeDays([amsterdam, brussels], plans, undefined, christmasEve);
    expect(days.map((entry) => [entry.label, entry.city, entry.isToday, entry.stale])).toEqual([["Day 1 · Thu 24 Dec", "Amsterdam", true, false], ["Day 2 · Fri 25 Dec", "Amsterdam", false, false]]);
    // 23:30 UTC on the 24th is already the 25th in Amsterdam.
    expect(tripModeDays([amsterdam], plans, undefined, Temporal.Instant.from("2026-12-24T23:30:00Z")).map((entry) => entry.isToday)).toEqual([false, true]);
    expect(startingDay(days)?.day).toBe(0);
    expect(startingDay(tripModeDays([amsterdam], plans, undefined, Temporal.Instant.from("2026-11-01T09:00:00Z")), { cityId: amsterdam.id, day: 1 })?.day).toBe(1);
    expect(tripModeDays([{ ...amsterdam, dailyEnd: "20:00" }], plans, undefined, christmasEve)[0].stale).toBe(true);
  });

  it("shows today's replan instead of the accepted day once there is one", () => {
    const { amsterdam, museum, places, plans } = fixture();
    const replanned: DayPlan = { day: 0, date: "2026-12-24", visits: [{ stopId: museum.id, start: minuteAt(amsterdam, 0, "11:00"), end: minuteAt(amsterdam, 0, "12:30"), leg: leg("hotel", museum.id, 20) }] };
    const progress = { ...newDayProgress(amsterdam, 0, plans[amsterdam.id].days[0].stopIds), remaining: { stopIds: [museum.id], durations: { [museum.id]: 90 }, skipped: [], snapshot: { trip: amsterdam, day: replanned, checkedAt: "2026-12-24T09:00:00Z", departureAt: "2026-12-24T09:00:00Z", origin: { id: "hotel" as const }, places } } };
    const [today] = tripModeDays([amsterdam], plans, { [amsterdam.id]: { "2026-12-24": progress } }, christmasEve);
    expect(today.replanned).toBe(true);
    expect(today.plan.visits.map((visit) => visit.end - visit.start)).toEqual([90]);
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
