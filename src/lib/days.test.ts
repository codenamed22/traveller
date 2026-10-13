import { describe, expect, it } from "vitest";
import { assignDays } from "./days";
import { newStop, newTrip, planningPreferences } from "./trip";

describe("large itinerary day assignment", () => {
  it.each([26, 60])("assigns %i stops within daily capacity without changing bookings", async (count) => {
    const trip = { ...newTrip(), days: 7, stops: Array.from({ length: count }, (_, index) => ({ ...newStop(`Place ${index}`), duration: 30 })) };
    trip.stops[0] = { ...trip.stops[0], day: 2, fixedTime: "10:00" };
    const input = { ...trip, planning: { ...planningPreferences(trip), maxStopsPerDay: 10 } };
    const locations = Object.fromEntries(["hotel", ...trip.stops.map((stop) => stop.id)].map((id, index) => [id, { lat: 48.8, lng: 2.3 + index * 0.001 }]));
    const grouped = await assignDays(input, locations);
    expect(grouped.stops).toHaveLength(count);
    expect(grouped.stops[0]).toEqual(trip.stops[0]);
    for (let day = 0; day < trip.days; day++) expect(grouped.stops.filter((stop) => stop.day === day).length).toBeLessThanOrEqual(10);
    expect(trip.stops[1].day).toBeNull();
  });
  it("respects booking gaps and omits optional visits that cannot fit", async () => {
    const trip = { ...newTrip(), days: 2, dailyEnd: "12:00", stops: [
      { ...newStop("Booking"), day: 0, fixedTime: "10:00", duration: 30, buffer: 0 },
      { ...newStop("Long visit"), duration: 100 },
      { ...newStop("Optional"), duration: 200, optional: true },
    ] };
    const locations = Object.fromEntries(["hotel", ...trip.stops.map((stop) => stop.id)].map((id) => [id, { lat: 48.8, lng: 2.3 }]));
    const grouped = await assignDays(trip, locations);
    expect(grouped.stops).toHaveLength(2);
    expect(grouped.stops[1].day).toBe(1);
    await expect(assignDays({ ...trip, stops: trip.stops.map((stop) => ({ ...stop, optional: false })) }, locations)).rejects.toThrow("daily limits");
  });
});