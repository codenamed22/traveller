import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";
import type { Journey } from "@/lib/journey";
import { minuteAt, newStop, newTrip, persistedPlan, type Place, type Schedule, type TravelEdge, type Trip } from "@/lib/trip";
import { markDone, markSkipped, tripModeDays } from "@/lib/trip-mode";
import { nativeTripMode } from "./nativeTripMode";

const place = (id: string, name: string, lat = 52.37): Place => ({ id, name, address: `${name} street`, location: { lat, lng: 4.89 } });
const leg = (from: string, to: string, minutes: number, extra: Partial<TravelEdge> = {}): TravelEdge => ({ day: 0, from, to, mode: "WALK", minutes, meters: 900, ...extra });
// 10:00 in Amsterdam on 24 December is 09:00 UTC.
const christmasEve = Temporal.Instant.from("2026-12-24T09:00:00Z");

function fixture() {
  const coffee = { ...newStop("Sango Coffee"), placeId: "g-sango", duration: 45, note: "Ask for the filter", source: "09:30 – 10:15 | Sango\nBest **pour-over** in town" };
  const museum = { ...newStop("Rijksmuseum"), placeId: "g-rijks", day: 0, fixedTime: "11:00", duration: 120 };
  const dinner = { ...newStop("FUKU"), placeId: "g-fuku", duration: 60 };
  const extra = { ...newStop("Albert Cuyp"), optional: true };
  const amsterdam: Trip = {
    ...newTrip(), city: "Amsterdam", hotel: "Motel One", startDate: "2026-12-24", days: 2, timeZone: "Europe/Amsterdam", dailyStart: "09:00", dailyEnd: "21:00",
    stops: [coffee, museum, dinner, extra], arrival: { mode: "TRAIN", time: "08:30", place: "Amsterdam Centraal", reference: "ICE 123", bufferMinutes: 15, transferMinutes: 20 },
  };
  const at = (day: number, time: string) => minuteAt(amsterdam, day, time);
  const transit = leg(coffee.id, museum.id, 20, { mode: "TRANSIT", polyline: "_p~iF~ps|U_ulLnnqC", steps: [{ instruction: "Walk to Dam", mode: "WALK" }, { instruction: "Tram", mode: "TRANSIT", line: "2", from: "Dam", to: "Rijksmuseum" }], fare: "€3.40" });
  const schedule: Schedule = { generatedAt: "2026-10-14T06:00:00Z", warnings: [], omitted: [extra.id], days: [
    { day: 0, date: "2026-12-24", visits: [{ stopId: coffee.id, start: at(0, "09:30"), end: at(0, "10:15"), leg: leg("hotel", coffee.id, 15) }, { stopId: museum.id, start: at(0, "11:00"), end: at(0, "13:00"), leg: transit }], returnLeg: leg(museum.id, "hotel", 25) },
    { day: 1, date: "2026-12-25", visits: [{ stopId: dinner.id, start: at(1, "18:00"), end: at(1, "19:00"), leg: leg("hotel", dinner.id, 10) }], returnLeg: leg(dinner.id, "hotel", 10) },
  ] };
  const places = { hotel: place("g-hotel", "Motel One", 52.36), [coffee.id]: place("g-sango", "Sango Coffee"), [museum.id]: place("g-rijks", "Rijksmuseum", 52.359), [dinner.id]: place("g-fuku", "FUKU") };
  const journey: Journey = { id: crypto.randomUUID(), title: "Christmas", cities: [amsterdam], plans: { [amsterdam.id]: persistedPlan(schedule, amsterdam, places) } };
  return { journey, amsterdam, coffee, museum };
}

describe("native trip mode snapshot", () => {
  it("lays out each day with times, legs and directions, ready to draw", () => {
    const { journey, amsterdam, coffee, museum } = fixture();
    const snapshot = nativeTripMode(journey, christmasEve, { canTrack: true, photos: true });
    expect(snapshot).toMatchObject({ version: 1, journeyId: journey.id, title: "Christmas", startKey: `${amsterdam.id}:0`, canTrack: true, photos: true, cities: [{ name: "Amsterdam", dates: "Thu 24 Dec – Fri 25 Dec" }] });
    const [today, tomorrow] = snapshot.days;
    expect(today).toMatchObject({
      label: "Day 1 · Thu 24 Dec", city: "Amsterdam", timeZone: "Europe/Amsterdam", stale: false, replanned: false,
      hotel: { name: "Motel One", location: { lat: 52.36, lng: 4.89 } }, end: { title: "Back to Motel One", short: "Back to Motel One" },
      summary: { stops: 2, travel: "1 h", leaveLabel: "09:15", backLabel: "13:25" },
      arrival: { title: "Arrive at Amsterdam Centraal 08:30 · ICE 123" }, omitted: ["Albert Cuyp"], doneElsewhere: [],
    });
    expect(tomorrow.arrival).toBeUndefined();
    // Midnight to midnight in Amsterdam, so the app can tell today and count minutes without time zone rules.
    expect(today.startsAt).toBe(Date.parse("2026-12-23T23:00:00Z"));
    expect(today.endsAt).toBe(Date.parse("2026-12-24T23:00:00Z"));
    expect(today.visits[0]).toMatchObject({
      stopId: coffee.id, name: "Sango Coffee", placeId: "g-sango", location: { lat: 52.37, lng: 4.89 }, startLabel: "09:30", endLabel: "10:15", leaveLabel: "09:15",
      booked: false, status: "pending", note: "Ask for the filter", sourceNote: "Best pour-over in town", alternatives: [],
      leg: { mode: "WALK", minutes: 15, label: "15 min walk", detail: "Walk · 15 min · 0.9 km", from: { lat: 52.36, lng: 4.89 }, to: { lat: 52.37, lng: 4.89 }, steps: [] },
    });
    expect(today.visits[1]).toMatchObject({ stopId: museum.id, booked: true, leg: { mode: "TRANSIT", label: "20 min by transit", polyline: "_p~iF~ps|U_ulLnnqC", steps: ["Walk to Dam", "2 Dam to Rijksmuseum"], fare: "€3.40" } });
    expect(today.visits[1].leg.directions).toContain("origin_place_id=g-sango");
    expect(today.visits[1].leg.directionsFromHere).not.toContain("origin");
    expect(today.visits[1].leg.directionsFromHere).toContain("travelmode=transit");
    expect(today.returnLeg).toMatchObject({ label: "25 min walk", to: { lat: 52.36, lng: 4.89 } });
    // The snapshot crosses into Swift as JSON.
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("shows progress recorded with the trip mode rules", () => {
    const { journey, amsterdam, coffee, museum } = fixture();
    const [entry] = tripModeDays(journey.cities, journey.plans, undefined, christmasEve);
    const done = markDone(entry, coffee.id, minuteAt(amsterdam, 0, "10:20"));
    const withDone = { ...journey, execution: { [amsterdam.id]: { [entry.date]: done } } };
    const [afterDone] = nativeTripMode(withDone, christmasEve, { canTrack: true, photos: false }).days;
    expect(afterDone.visits.map((visit) => [visit.status, visit.doneLabel])).toEqual([["done", "09:35–10:20"], ["pending", undefined]]);
    const [entryAfter] = tripModeDays(withDone.cities, withDone.plans, withDone.execution, christmasEve);
    const skipped = markSkipped(entryAfter, amsterdam.stops.find((stop) => stop.id === museum.id)!);
    const [afterSkip] = nativeTripMode({ ...journey, execution: { [amsterdam.id]: { [entry.date]: skipped } } }, christmasEve, { canTrack: true, photos: false }).days;
    expect(afterSkip.visits.map((visit) => visit.status)).toEqual(["done", "skipped"]);
  });

  it("starts on the chosen day when the trip isn't on today", () => {
    const { journey, amsterdam } = fixture();
    const snapshot = nativeTripMode(journey, Temporal.Instant.from("2026-11-01T09:00:00Z"), { start: { cityId: amsterdam.id, day: 1 }, canTrack: false, photos: false });
    expect(snapshot.startKey).toBe(`${amsterdam.id}:1`);
    expect(nativeTripMode({ ...journey, plans: {} }, christmasEve, { canTrack: true, photos: false })).toMatchObject({ startKey: null, days: [] });
  });
});
