import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";
import type { Journey } from "./journey";
import { withProgress } from "./native-actions";
import { hasRecap, tripRecap } from "./recap";
import { minuteAt, mustSeePriority, newStop, newTrip, persistedPlan, type Schedule, type TravelEdge, type Trip } from "./trip";
import { markDone, markSkipped, tripModeDays } from "./trip-mode";

const leg = (from: string, to: string, minutes: number, extra: Partial<TravelEdge> = {}): TravelEdge => ({ day: 0, from, to, mode: "WALK", minutes, meters: 1200, ...extra });

function fixture() {
  const coffee = { ...newStop("Sango Coffee"), duration: 45 };
  const museum = { ...newStop("Rijksmuseum"), duration: 120, priority: mustSeePriority };
  const park = { ...newStop("Vondelpark"), duration: 60 };
  const dinner = { ...newStop("FUKU"), duration: 60 };
  const amsterdam: Trip = { ...newTrip(), city: "Amsterdam", hotel: "Motel One", startDate: "2026-12-24", days: 2, timeZone: "Europe/Amsterdam", stops: [coffee, museum, park, dinner] };
  const at = (day: number, time: string) => minuteAt(amsterdam, day, time);
  const schedule: Schedule = { generatedAt: "2026-10-14T06:00:00Z", warnings: [], omitted: [], days: [
    { day: 0, date: "2026-12-24", visits: [
      { stopId: coffee.id, start: at(0, "09:30"), end: at(0, "10:15"), leg: leg("hotel", coffee.id, 15) },
      { stopId: museum.id, start: at(0, "11:00"), end: at(0, "13:00"), leg: leg(coffee.id, museum.id, 20, { mode: "TRANSIT", meters: 3000 }) },
      { stopId: park.id, start: at(0, "13:30"), end: at(0, "14:30"), leg: leg(museum.id, park.id, 10) },
    ], returnLeg: leg(park.id, "hotel", 25, { meters: 2000 }) },
    { day: 1, date: "2026-12-25", visits: [{ stopId: dinner.id, start: at(1, "18:00"), end: at(1, "19:00"), leg: leg("hotel", dinner.id, 10) }] },
  ] };
  let journey: Journey = { id: crypto.randomUUID(), title: "Christmas", cities: [amsterdam], plans: { [amsterdam.id]: persistedPlan(schedule, amsterdam, {}) } };
  // On the day: coffee done 09:40–10:30, the museum skipped, the park still to come.
  const eve = Temporal.Instant.from("2026-12-24T09:30:00Z");
  const day = () => tripModeDays(journey.cities, journey.plans, journey.execution, eve)[0];
  journey = withProgress(journey, amsterdam.id, "2026-12-24", markDone(day(), coffee.id, at(0, "10:30")));
  journey = withProgress(journey, amsterdam.id, "2026-12-24", markSkipped(day(), museum));
  journey = { ...journey, journal: { [amsterdam.id]: { "2026-12-24": { note: "Snow on the canals", favourites: [coffee.id] } } } };
  return { journey, amsterdam, coffee, museum, park, dinner };
}

describe("trip recap", () => {
  it("sets each visit's planned time against when it was done, and counts the walking on the way", () => {
    const { journey, coffee, museum, park } = fixture();
    const recap = tripRecap(journey, Temporal.Instant.from("2026-12-24T12:00:00Z"));
    expect(recap.days).toHaveLength(1);
    const [eve] = recap.days;
    expect(eve).toMatchObject({ label: "Day 1 · Thu 24 Dec", city: "Amsterdam", isToday: true, note: "Snow on the canals" });
    expect(eve.visits).toEqual([
      { stopId: coffee.id, name: "Sango Coffee", status: "done", planned: "09:30–10:15", actual: "09:45–10:30", favourite: true, mustSee: false },
      { stopId: museum.id, name: "Rijksmuseum", status: "skipped", planned: "11:00–13:00", favourite: false, mustSee: true },
      { stopId: park.id, name: "Vondelpark", status: "upcoming", planned: "13:30–14:30", favourite: false, mustSee: false },
    ]);
    // Only the walk to the coffee, as the day isn't over.
    expect(eve.travel).toEqual({ walkKm: 1.2, walkMinutes: 15, transitMinutes: 0 });
  });

  it("calls what was left not visited once the day is over, and adds up the trip", () => {
    const { journey } = fixture();
    const recap = tripRecap(journey, Temporal.Instant.from("2026-12-26T09:00:00Z"));
    expect(recap.days.map((day) => day.visits.map((visit) => visit.status))).toEqual([["done", "skipped", "missed"], ["missed"]]);
    // The way back counts once the day is over.
    expect(recap.days[0].travel).toEqual({ walkKm: 3.2, walkMinutes: 40, transitMinutes: 0 });
    expect(recap.totals).toEqual({ days: 2, done: 1, skipped: 1, missed: 2, favourites: 1, walkKm: 3.2, walkMinutes: 40, transitMinutes: 0 });
  });

  it("has nothing to recap before the trip starts", () => {
    const { journey } = fixture();
    expect(hasRecap(journey, Temporal.Instant.from("2026-12-23T12:00:00Z"))).toBe(false);
    expect(hasRecap(journey, Temporal.Instant.from("2026-12-24T00:00:00Z"))).toBe(true);
  });
});
