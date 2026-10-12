import { describe, expect, it } from "vitest";
import { asJourney, cityPreset, createJourney, journeySchema, restoreJourney, stayDates, type CityStay } from "./journey";
import { newStop, newTrip } from "./trip";

const stays: CityStay[] = [
  { city: "Paris, France", timeZone: "Europe/Paris", startDate: null, days: 3 },
  { city: "Amsterdam, Netherlands", timeZone: "Europe/Amsterdam", startDate: null, days: 2 },
  { city: "Brussels, Belgium", timeZone: "Europe/Brussels", startDate: null, days: 2 },
];

describe("multi-city journeys", () => {
  it("finds presets without requiring exact capitalization or country", () => {
    expect(cityPreset(" paris ")?.timeZone).toBe("Europe/Paris");
    expect(cityPreset("Amsterdam, Netherlands")?.days).toBe(3);
    expect(cityPreset("Brussels")?.timeZone).toBe("Europe/Brussels");
    expect(cityPreset("A custom city")).toBeUndefined();
  });
  it("builds independent city drafts with consecutive calendar dates across DST and month boundaries", () => {
    const journey = createJourney("Autumn trip", "2026-10-30", stays);
    expect(journey.cities.map((city) => city.startDate)).toEqual(["2026-10-30", "2026-11-02", "2026-11-04"]);
    expect(journey.cities.map((city) => city.days)).toEqual([3, 2, 2]);
    expect(new Set(journey.cities.map((city) => city.id)).size).toBe(3);
    expect(journey.cities.every((city) => city.hotel === "" && city.stops.length === 0)).toBe(true);
    expect(stayDates("2026-03-28", stays)[1].startDate).toBe("2026-03-31");
  });
  it("preserves explicit arrivals and fills subsequent dates", () => {
    const journey = createJourney("", "2026-10-12", [stays[0], { ...stays[1], startDate: "2026-10-20" }, stays[2]]);
    expect(journey.cities.map((city) => city.startDate)).toEqual(["2026-10-12", "2026-10-20", "2026-10-22"]);
    expect(journey.title).toBe("Paris / Amsterdam / Brussels");
  });
  it("permits a shared transfer date but rejects backwards or excessive visits", () => {
    expect(createJourney("Trip", "2026-10-12", [stays[0], { ...stays[1], startDate: "2026-10-14" }]).cities).toHaveLength(2);
    expect(() => createJourney("Trip", "2026-10-12", [stays[0], { ...stays[1], startDate: "2026-10-13" }])).toThrow("previous city");
    expect(() => createJourney("Trip", "2026-10-12", [])).toThrow();
    expect(() => createJourney("Trip", "2026-10-12", Array.from({ length: 11 }, () => stays[0]))).toThrow();
    expect(() => createJourney("Trip", "2026-10-12", [{ ...stays[0], days: 8 }])).toThrow();
  });
  it("reports malformed backup dates as validation errors without throwing", () => {
    const journey = createJourney("Trip", "2026-10-12", stays);
    for (const startDate of ["", "not-a-date", "2026-02-30"]) {
      expect(journeySchema.safeParse({ ...journey, cities: [{ ...journey.cities[0], startDate }, ...journey.cities.slice(1)] }).success).toBe(false);
    }
  });
  it("restores legacy and multi-city backups without dropping booked stops or source links", () => {
    const stop = { ...newStop("Museum"), day: 0, fixedTime: "10:30", sourceUrl: "https://example.com/trip" };
    const trip = { ...newTrip(), city: "Paris", hotel: "Hotel", stops: [stop] };
    const plan = { days: [{ day: 0, stopIds: [stop.id] }], omitted: [] };
    const legacy = asJourney(trip, plan);
    expect(restoreJourney({ trip, plan }).cities[0]).toEqual(trip);
    const restored = restoreJourney({ journey: legacy });
    expect(restored.id).not.toBe(trip.id);
    expect(restored.cities[0].stops[0]).toEqual(stop);
    expect(restored.plans[trip.id]).toEqual(plan);
    expect(journeySchema.safeParse({ ...legacy, cities: [trip, trip] }).success).toBe(false);
  });
});