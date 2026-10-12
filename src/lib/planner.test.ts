import { describe, expect, it } from "vitest";
import { solveTrip } from "./planner";
import { newStop, newTrip, planningPreferences, type Trip, type TravelEdge } from "./trip";
import { validateSchedule } from "./schedule-validation";

function routes(trip: Trip, minutes = 10): TravelEdge[] {
  const ids = ["hotel", ...trip.stops.map((stop) => stop.id)];
  return Array.from({ length: trip.days }, (_, day) => ids.flatMap((from) => ids.filter((to) => to !== from).map((to): TravelEdge => ({ day, from, to, mode: "WALK", minutes, meters: 600 })))).flat();
}
function fixture(): Trip {
  return { ...newTrip(), city: "Paris", hotel: "Hotel", startDate: "2026-10-12", timeZone: "Europe/Paris", days: 2, stops: [
    { ...newStop("Booked museum"), day: 0, fixedTime: "10:00", duration: 60 },
    { ...newStop("Garden"), duration: 45 },
    { ...newStop("Booked lunch"), day: 1, fixedTime: "12:00", duration: 60 },
  ] };
}
describe("schedule optimizer", () => {
  it("honors trip transport defaults, explicit overrides and hotel return", async () => {
    const trip = fixture();
    trip.planning = { ...planningPreferences(trip), mode: "TRANSIT" };
    trip.stops[1].mode = "WALK";
    const walking = routes(trip);
    const schedule = await solveTrip(trip, [...walking, ...walking.map((edge): TravelEdge => ({ ...edge, mode: "TRANSIT", minutes: 20 }))]);
    for (const day of schedule.days) {
      for (const visit of day.visits) expect(visit.leg.mode).toBe(visit.stopId === trip.stops[1].id ? "WALK" : "TRANSIT");
      if (day.returnLeg) expect(day.returnLeg.mode).toBe("TRANSIT");
    }
    expect(validateSchedule(trip, schedule)).toEqual([]);
    schedule.days[0].returnLeg!.mode = "WALK";
    expect(validateSchedule(trip, schedule)).toContain("Day 1: hotel return violates transport preferences.");
  });
  it("names the bookings that cannot fit", async () => {
    const trip = fixture();
    trip.stops = [
      { ...newStop("First"), day: 0, fixedTime: "10:00", duration: 45 },
      { ...newStop("Second"), day: 0, fixedTime: "10:30", duration: 45 },
      { ...newStop("Late"), day: 0, fixedTime: "17:30", duration: 60 },
    ];
    trip.dailyEnd = "18:00";
    const error = await solveTrip(trip, routes(trip)).catch((cause: Error) => cause.message);
    expect(error).toContain("First (10:00) and Second (10:30) are too close");
    expect(error).toContain("Late (17:30, 60 min) ends after the day ends");
  });
  it("rejects walking beyond the configured leg limit", async () => {
    const trip = fixture();
    trip.planning = { ...planningPreferences(trip), mode: "WALK", maxWalkMinutes: 5 };
    await expect(solveTrip(trip, routes(trip, 10))).rejects.toThrow("No schedule fits");
  });
  it("clusters nearby stops into days while respecting a daily stop limit", async () => {
    const trip = fixture();
    trip.stops = Array.from({ length: 4 }, (_, index) => newStop(`Place ${index}`));
    trip.planning = { ...planningPreferences(trip), maxStopsPerDay: 2 };
    const cluster = (id: string) => Math.floor(trip.stops.findIndex((stop) => stop.id === id) / 2);
    const edges = routes(trip).map((edge) => ({ ...edge, minutes: edge.from === "hotel" || edge.to === "hotel" ? 10 : cluster(edge.from) === cluster(edge.to) ? 2 : 60 }));
    const schedule = await solveTrip(trip, edges);
    for (const day of schedule.days) {
      expect(day.visits).toHaveLength(2);
      expect(new Set(day.visits.map((visit) => cluster(visit.stopId))).size).toBe(1);
    }
    expect(validateSchedule(trip, schedule)).toEqual([]);
    trip.planning.maxStopsPerDay = 1;
    expect(validateSchedule(trip, schedule)).toContain("Day 1: too many places.");
  });
  it("balances daily activity when requested instead of packing every flexible stop together", async () => {
    const trip = fixture();
    trip.stops = Array.from({ length: 4 }, (_, index) => ({ ...newStop(`Place ${index}`), duration: 60 }));
    trip.planning = { ...planningPreferences(trip), goal: "BALANCED" };
    const schedule = await solveTrip(trip, routes(trip, 5));
    expect(schedule.days.map((day) => day.visits.length)).toEqual([2, 2]);
  });
  it("finds the shortest small unconstrained tour", async () => {
    const trip = fixture();
    trip.days = 1;
    trip.stops = trip.stops.map((stop) => ({ ...stop, day: null, fixedTime: null }));
    const ids = ["hotel", ...trip.stops.map((stop) => stop.id)];
    const minutes = [[0, 12, 3, 4], [5, 0, 2, 8], [9, 2, 0, 2], [3, 11, 1, 0]];
    const edges = routes(trip).map((edge) => ({ ...edge, minutes: minutes[ids.indexOf(edge.from)][ids.indexOf(edge.to)] }));
    const schedule = await solveTrip(trip, edges);
    const day = schedule.days[0];
    expect(day.visits.reduce((sum, visit) => sum + visit.leg.minutes, day.returnLeg!.minutes)).toBe(12);
  });
  it("handles 25 day-assigned stops across seven days within its bound", async () => {
    const trip = fixture();
    trip.days = 7;
    trip.stops = Array.from({ length: 25 }, (_, index) => ({ ...newStop(`Place ${index + 1}`), day: index % 7 }));
    const schedule = await solveTrip(trip, routes(trip), 2);
    expect(schedule.days.flatMap((day) => day.visits)).toHaveLength(25);
    expect(validateSchedule(trip, schedule)).toEqual([]);
  });
  it("preserves bookings and visits every required stop exactly once", async () => {
    const trip = fixture();
    const schedule = await solveTrip(trip, routes(trip));
    expect(validateSchedule(trip, schedule)).toEqual([]);
    expect(schedule.days.flatMap((day) => day.visits)).toHaveLength(3);
    expect(schedule.days[0].visits.find((visit) => visit.stopId === trip.stops[0].id)?.start).toBe(600);
    expect(schedule.days[1].visits.find((visit) => visit.stopId === trip.stops[2].id)?.start).toBe(720);
  });
  it("does not turn missing travel into a zero-minute route", async () => {
    await expect(solveTrip(fixture(), [])).rejects.toThrow("No schedule fits");
  });
  it("rejects impossible bookings instead of moving or dropping them", async () => {
    const trip = fixture();
    trip.stops[0].fixedTime = "09:10";
    await expect(solveTrip(trip, routes(trip))).rejects.toThrow("No schedule fits");
  });
  it("omits only an explicitly optional stop that does not fit", async () => {
    const trip = fixture();
    trip.stops[1] = { ...trip.stops[1], optional: true, duration: 480, day: 0 };
    const schedule = await solveTrip(trip, routes(trip));
    expect(schedule.omitted).toEqual([trip.stops[1].id]);
    expect(validateSchedule(trip, schedule)).toEqual([]);
  });
});