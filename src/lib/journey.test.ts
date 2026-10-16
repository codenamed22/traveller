import { describe, expect, it } from "vitest";
import { asJourney, cityPreset, createJourney, duplicateJourney, journeySchema, restoreJourney, stayDates, type CityStay } from "./journey";
import { newStop, newTrip, persistedPlan, type Schedule } from "./trip";
import { applyDayRecovery, newDayProgress } from "./day-recovery";

const stays: CityStay[] = [
  { city: "Paris, France", timeZone: "Europe/Paris", startDate: null, days: 3 },
  { city: "Amsterdam, Netherlands", timeZone: "Europe/Amsterdam", startDate: null, days: 2 },
  { city: "Brussels, Belgium", timeZone: "Europe/Brussels", startDate: null, days: 2 },
];

describe("multi-city journeys", () => {
  it("round-trips accepted timings, complete routes and places through saves and backups", () => {
    const stop = newStop("Museum");
    const trip = { ...newTrip(), city: "Paris", hotel: "Hotel", stops: [stop] };
    const leg = { day: 0, from: "hotel", to: stop.id, mode: "TRANSIT" as const, minutes: 15, meters: 1800,
      polyline: "encoded-route", fare: "EUR 2.50", sampledDeparture: 540, estimated: true, timetableDate: "2026-10-12",
      steps: [{ instruction: "Take the metro", mode: "TRANSIT", line: "M1", from: "Hotel station", to: "Museum station", departure: "09:00", arrival: "09:15" }],
      alternatives: [{ day: 0, from: "hotel", to: stop.id, mode: "WALK" as const, minutes: 25, meters: 1400 }] };
    const schedule: Schedule = { generatedAt: "2026-10-12T08:00:00Z", warnings: ["Estimated future transit"], omitted: [],
      days: [{ day: 0, date: trip.startDate, visits: [{ stopId: stop.id, start: 555, end: 600, leg }], returnLeg: { ...leg, from: stop.id, to: "hotel" } }] };
    const places = { hotel: { id: "hotel-place", name: "Hotel", address: "Paris", location: { lat: 48.85, lng: 2.35 } } };
    const plan = persistedPlan(schedule, trip, places);
    const journey = journeySchema.parse(JSON.parse(JSON.stringify(asJourney(trip, plan))));
    expect(journey.plans[trip.id].snapshot).toEqual({ trip, schedule, places });
    const progress = applyDayRecovery(newDayProgress(trip, 0, [stop.id]), { label: "Checked", day: schedule.days[0], durations: { [stop.id]: 45 }, skipped: [] },
      { trip, day: schedule.days[0], places, checkedAt: schedule.generatedAt, departureAt: schedule.generatedAt, origin: { id: "hotel" } });
    const withRecovery = journeySchema.parse(JSON.parse(JSON.stringify({ ...journey, execution: { [trip.id]: { [trip.startDate]: progress } } })));
    expect(withRecovery.execution![trip.id][trip.startDate].remaining!.snapshot!.day).toEqual(schedule.days[0]);
    const nextRecovery = applyDayRecovery(progress, { label: "Second", day: schedule.days[0], durations: { [stop.id]: 45 }, skipped: [] });
    expect(nextRecovery.previousRemaining!.snapshot).toEqual(progress.remaining!.snapshot);
    expect(restoreJourney({ journey }).plans[trip.id]).toEqual(plan);
    expect(restoreJourney({ trip, plan }).plans[trip.id]).toEqual(plan);
    expect(journeySchema.safeParse({ ...journey, plans: { [trip.id]: { ...plan, days: [] } } }).success).toBe(false);
    expect(journeySchema.safeParse({ ...journey, plans: { [trip.id]: { ...plan, snapshot: { ...plan.snapshot, trip: { ...trip, id: crypto.randomUUID() } } } } }).success).toBe(false);
    expect(journeySchema.safeParse({ ...journey, plans: { [trip.id]: { ...plan, snapshot: { ...plan.snapshot, schedule: { ...schedule, generatedAt: "invalid" } } } } }).success).toBe(false);
  });
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

  it("duplicates a trip with its places and itinerary but without what was done on the way", () => {
    const stop = { ...newStop("Museum"), day: 0 };
    const trip = { ...newTrip(), city: "Paris", hotel: "Hotel", stops: [stop] };
    const plan = { days: [{ day: 0, stopIds: [stop.id] }], omitted: [] };
    const journey = { ...asJourney(trip, plan), title: "Paris", execution: { [trip.id]: { [trip.startDate]: newDayProgress(trip, 0, [stop.id]) } } };
    const copy = duplicateJourney(journey);
    expect(copy.id).not.toBe(journey.id);
    expect(copy).toEqual({ id: copy.id, title: "Paris (copy)", cities: journey.cities, plans: journey.plans });
    // The longest title still fits.
    expect(duplicateJourney({ ...journey, title: "x".repeat(150) }).title).toHaveLength(150);
  });
});