import { describe, expect, it } from "vitest";
import { validateSchedule } from "./schedule-validation";
import { newStop, newTrip, type Schedule, type Stop, type TravelEdge } from "./trip";

function fixture() {
  const stop = { ...newStop("Museum"), day: 0, fixedTime: "10:00", duration: 60 };
  const trip = { ...newTrip(), city: "Paris", hotel: "Hotel", days: 1, startDate: "2026-10-12", timeZone: "Europe/Paris", stops: [stop] };
  const leg: TravelEdge = { day: 0, from: "hotel", to: stop.id, mode: "WALK", minutes: 20, meters: 1400 };
  const schedule: Schedule = { days: [{ day: 0, date: trip.startDate, visits: [{ stopId: stop.id, start: 600, end: 660, leg }], returnLeg: { ...leg, from: stop.id, to: "hotel" } }], omitted: [], warnings: [], generatedAt: new Date().toISOString() };
  return { trip, schedule };
}

describe("independent schedule validator", () => {
  it("accepts a booking with enough travel time and arrival buffer", () => {
    const { trip, schedule } = fixture();
    expect(validateSchedule(trip, schedule)).toEqual([]);
  });
  it("never plans a place kept for spare time", () => {
    const { trip, schedule } = fixture();
    const park = { ...newStop("Park"), optional: true, spare: true as const };
    const withPark = { ...trip, stops: [...trip.stops, park] };
    expect(validateSchedule(withPark, schedule)).toEqual([]);
    const leg: TravelEdge = { day: 0, from: trip.stops[0].id, to: park.id, mode: "WALK", minutes: 10, meters: 700 };
    const planned = { ...schedule, days: [{ ...schedule.days[0], visits: [...schedule.days[0].visits, { stopId: park.id, start: 670, end: 715, leg }], returnLeg: { ...leg, from: park.id, to: "hotel" } }] };
    expect(validateSchedule(withPark, planned)).not.toEqual([]);
  });
  it("rejects late arrival, moved bookings, and missing required stops", () => {
    const { trip, schedule } = fixture();
    schedule.days[0].visits[0].leg.minutes = 55;
    expect(validateSchedule(trip, schedule)).toContain("Museum: not enough time to arrive.");
    schedule.days[0].visits[0].start = 610;
    expect(validateSchedule(trip, schedule)).toContain("Museum: booking time changed.");
    schedule.days[0].visits = [];
    expect(validateSchedule(trip, schedule)).toContain("Museum: required stop is missing.");
  });
  it("rejects nonexistent travel, repeated days, and omitted scheduled stops", () => {
    const { trip, schedule } = fixture();
    schedule.days[0].visits[0].leg.minutes = Number.NaN;
    schedule.days.push(schedule.days[0]);
    schedule.omitted.push(trip.stops[0].id);
    expect(validateSchedule(trip, schedule)).toContain("Museum: invalid travel or visit time.");
    expect(validateSchedule(trip, schedule)).toContain("Invalid or repeated sightseeing day.");
    expect(validateSchedule(trip, schedule)).toContain("Museum: both scheduled and omitted.");
  });
  it("lets a morning café start the day up to an hour early, and nothing else", () => {
    const cafe: Stop = { ...newStop("Coffee"), kind: "coffee", duration: 30 };
    const museum = { ...newStop("Museum"), day: 0, fixedTime: "09:30", duration: 60, buffer: 0 };
    const trip = { ...newTrip(), city: "Paris", hotel: "Hotel", days: 1, startDate: "2026-10-12", timeZone: "Europe/Paris", dailyStart: "09:00", dailyEnd: "18:00", stops: [cafe, museum] };
    const leg = (from: string, to: string): TravelEdge => ({ day: 0, from, to, mode: "WALK", minutes: 10, meters: 700 });
    const plan = (first: Stop, start: number, second = 570): Schedule => ({ days: [{ day: 0, date: trip.startDate, visits: [{ stopId: first.id, start, end: start + 30, leg: leg("hotel", first.id) }, { stopId: museum.id, start: second, end: second + 60, leg: leg(first.id, museum.id) }], returnLeg: leg(museum.id, "hotel") }], omitted: [], warnings: [], generatedAt: new Date().toISOString() });
    // Out at 08:00 for coffee at 08:10 is fine; a minute earlier is not.
    expect(validateSchedule(trip, plan(cafe, 490))).toEqual([]);
    expect(validateSchedule(trip, plan(cafe, 489))).toContain("Coffee: not enough time to arrive.");
    const sight: Stop = { ...cafe, kind: "sight" };
    expect(validateSchedule({ ...trip, stops: [sight, museum] }, plan(sight, 490))).toContain("Coffee: not enough time to arrive.");
    const arriving = { ...trip, arrival: { mode: "TRAIN" as const, time: "07:00", place: "Gare du Nord" } };
    expect(validateSchedule(arriving, plan(cafe, 490))).toContain("Coffee: not enough time to arrive.");
    const flexible = { ...museum, fixedTime: null };
    expect(validateSchedule({ ...trip, stops: [cafe, flexible] }, plan(cafe, 490, 530))).toContain("Museum: before sightseeing starts.");
  });
});
