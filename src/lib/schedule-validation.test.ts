import { describe, expect, it } from "vitest";
import { validateSchedule } from "./schedule-validation";
import { newStop, newTrip, type Schedule, type TravelEdge } from "./trip";

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
});