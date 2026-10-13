import { describe, expect, it, vi } from "vitest";
import { bookingConflicts, PlanningError, solveTrip, solveTripByDays, type SolverStage } from "./planner";
import { bookingConflictDetails, bookingTimeSuggestion, newStop, newTrip, planningPreferences, resolvePlanningConstraints, type Trip, type TravelEdge } from "./trip";
import { validateSchedule } from "./schedule-validation";
import { solveWithDurationRelaxation } from "./duration-relaxation";

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
  it("plans day by day around locked days, bookings and an exclusive day trip", async () => {
    const locked = Array.from({ length: 6 }, (_, index) => ({ ...newStop(`Locked ${index}`), day: index % 2, duration: 60 }));
    const flexible = Array.from({ length: 4 }, (_, index) => ({ ...newStop(`Flexible ${index}`), duration: 45, ...(index === 0 ? { durationOptions: [45, 41, 36] } : {}) }));
    const trips = [{ ...newStop("Day trip A"), duration: 60 }, { ...newStop("Day trip B"), duration: 60 }];
    const booking = { ...newStop("Booked show"), day: 1, fixedTime: "17:00", duration: 90 };
    const trip = { ...fixture(), days: 3, dailyStart: "09:00", dailyEnd: "19:00", stops: [...locked, ...flexible, ...trips, booking], dayGroups: [{ id: crypto.randomUUID(), name: "Day trip", stopIds: trips.map((stop) => stop.id), allowedDays: [0, 1, 2], exclusive: true }] };
    const original = structuredClone(trip);
    const schedule = await solveTripByDays(trip, routes(trip, 15), 5);
    expect(validateSchedule(trip, schedule)).toEqual([]);
    expect(schedule.omitted).toEqual([]);
    const dayOf = (id: string) => schedule.days.find((day) => day.visits.some((visit) => visit.stopId === id))!.day;
    expect(dayOf(trips[0].id)).toBe(2);
    expect(schedule.days[2].visits.map((visit) => visit.stopId).sort()).toEqual(trips.map((stop) => stop.id).sort());
    locked.forEach((stop) => expect(dayOf(stop.id)).toBe(stop.day));
    expect(trip).toEqual(original);
  });
  it("keeps duration preservation ahead of optional utility and never promotes optional group members", async () => {
    const required = { ...newStop("Required lunch"), duration: 60, durationOptions: [60, 54, 48] };
    const optional = { ...newStop("Optional cafe"), duration: 60, optional: true };
    const trip = { ...fixture(), days: 1, dailyEnd: "11:24", stops: [required, optional] };
    const schedule = await solveTrip(trip, routes(trip), 2);
    expect(validateSchedule(trip, schedule)).toEqual([]);
    expect(schedule.omitted).toEqual([optional.id]);
    expect(schedule.optimization).toMatchObject({ weightedDurationLoss: 0, durationOptimal: true, optionalOptimal: true });
    const grouped = { ...trip, days: 2, stops: [{ ...required, day: 1 }, { ...optional, day: 0 }], dayGroups: [{ id: crypto.randomUUID(), name: "Day trip", stopIds: [required.id, optional.id], allowedDays: [0, 1], exclusive: true }] };
    const groupSchedule = await solveTrip(grouped, routes(grouped), 2);
    expect(validateSchedule(grouped, groupSchedule)).toEqual([]);
    expect(groupSchedule.omitted).toEqual([optional.id]);
    expect(groupSchedule.days[1].visits[0].stopId).toBe(required.id);
  });
  it.each([2, 3])("jointly assigns an exclusive day trip and preserves individual durations across %i days", async (days) => {
    const stops = [
      { ...newStop("Priority Amsterdam lunch"), day: 0, duration: 60, durationOptions: [60, 54, 48], priority: 5 },
      { ...newStop("Flexible Amsterdam cafe"), duration: 60, durationOptions: [60, 54, 48] },
      { ...newStop("Utrecht canal"), duration: 30 }, { ...newStop("Utrecht lunch"), duration: 30 },
    ];
    const trip = { ...fixture(), days, dailyEnd: "11:24", stops, dayGroups: [{ id: crypto.randomUUID(), name: "Utrecht", stopIds: stops.slice(2).map((stop) => stop.id), allowedDays: Array.from({ length: days - 1 }, (_, index) => index + 1), exclusive: true }] };
    const original = structuredClone(trip);
    const stages: SolverStage[] = [];
    const schedule = await solveTrip(trip, routes(trip), 3, { onStage: (stage) => stages.push(stage) });
    expect(validateSchedule(trip, schedule)).toEqual([]);
    const visits = schedule.days.flatMap((day) => day.visits);
    expect(stops.map((stop) => { const visit = visits.find((entry) => entry.stopId === stop.id)!; return visit.end - visit.start; })).toEqual([60, days === 2 ? 54 : 60, 30, 30]);
    const grouped = schedule.days.find((day) => day.visits.some((visit) => visit.stopId === stops[2].id))!;
    expect(new Set(grouped.visits.map((visit) => visit.stopId))).toEqual(new Set(stops.slice(2).map((stop) => stop.id)));
    expect(schedule.optimization).toMatchObject({ weightedDurationLoss: days === 2 ? 6 : 0, durationOptimal: true });
    expect(stages[0].objective).toBe("duration");
    expect(trip).toEqual(original);
  });
  it("selectively restores eatery time and permits approved 15-to-10 minute visits", async () => {
    const trip = { ...fixture(), days: 1, dailyEnd: "11:24", stops: [
      { ...newStop("Priority lunch"), duration: 60, durationOptions: [60, 54, 48], priority: 5 },
      { ...newStop("Cafe"), duration: 60, durationOptions: [60, 54, 48] },
    ] };
    const original = structuredClone(trip);
    const edges = routes(trip);
    const levels: number[] = [];
    const schedule = await solveWithDurationRelaxation(trip, edges, 3, (candidate, seconds, level) => { levels.push(level); return solveTrip(candidate, edges, seconds); });
    expect(levels).toEqual([0, 1]);
    expect(validateSchedule(trip, schedule)).toEqual([]);
    const durations = new Map(schedule.days[0].visits.map((visit) => [visit.stopId, visit.end - visit.start]));
    expect(trip.stops.map((stop) => durations.get(stop.id))).toEqual([60, 54]);
    expect(trip).toEqual(original);
    const short = { ...trip, dailyEnd: "09:20", stops: [{ ...newStop("Small visit"), duration: 15, durationOptions: [15, 10] }] };
    const shortEdges = routes(short, 5);
    const fitted = await solveWithDurationRelaxation(short, shortEdges, 3, (candidate, seconds) => solveTrip(candidate, shortEdges, seconds));
    expect(validateSchedule(short, fitted)).toEqual([]);
    expect(fitted.days[0].visits[0].end - fitted.days[0].visits[0].start).toBe(10);
  });
  it("does not shorten visits to conceal route gaps or incomplete search", async () => {
    const trip = { ...fixture(), stops: [{ ...newStop("Cafe"), duration: 60, durationOptions: [60, 54, 48] }] };
    const solve = vi.fn().mockRejectedValue(new PlanningError("Search incomplete."));
    await expect(solveWithDurationRelaxation(trip, [], 3, solve)).rejects.toThrow("Route coverage is incomplete");
    expect(solve).not.toHaveBeenCalled();
    await expect(solveWithDurationRelaxation(trip, routes(trip), 3, solve)).rejects.toThrow("Search incomplete");
    expect(solve).toHaveBeenCalledTimes(1);
    expect(solve.mock.calls[0][0].stops[0].duration).toBe(60);
  });
  it.each(["optimized", "feasibility-first"] as const)("validates %s incumbents and retains optional-visit rewards", async (strategy) => {
    const trip = fixture();
    trip.stops[1].optional = true;
    const stages: SolverStage[] = [];
    const schedule = await solveTrip(trip, routes(trip), 2, { strategy, onStage: (stage) => stages.push(stage) });
    expect(validateSchedule(trip, schedule)).toEqual([]);
    expect(schedule.omitted).toEqual([]);
    expect(stages.map((stage) => stage.stage)).toEqual(strategy === "optimized" ? ["optimization"] : ["feasibility", "optimization"]);
    expect(stages.every((stage) => stage.outcome === "feasible" && stage.columns !== null && stage.columns > 0 && stage.elapsedMs >= 0)).toBe(true);
  });
  it.each(["departure", "return"])("identifies missing hotel %s routes instead of asking to change bookings", async (direction) => {
    const trip = fixture();
    trip.days = 1;
    trip.stops = trip.stops.map((stop) => ({ ...stop, day: 0, fixedTime: null }));
    await expect(solveTrip(trip, routes(trip).filter((edge) => (direction === "departure" ? edge.from : edge.to) !== "hotel"))).rejects.toThrow(direction === "departure" ? "Day 1: no allowed sampled route connects the hotel to the required visits" : "Day 1: no allowed sampled route connects the required visits back to the hotel");
  });
  it("names disconnected required flexible visits but permits explicit optional omissions", async () => {
    const trip = fixture();
    const isolated = trip.stops[1];
    const edges = routes(trip).filter((edge) => edge.from !== isolated.id && edge.to !== isolated.id);
    await expect(solveTrip(trip, edges)).rejects.toThrow(`Any available day: ${isolated.name} has no allowed sampled connection`);
    isolated.optional = true;
    const schedule = await solveTrip(trip, edges);
    expect(validateSchedule(trip, schedule)).toEqual([]);
    expect(schedule.omitted).toEqual([isolated.id]);
  });
  it("does not count paths through visits assigned to another day as hotel connections", async () => {
    const trip = fixture();
    trip.stops = trip.stops.map((stop, index) => ({ ...stop, fixedTime: null, day: index === 0 ? 0 : 1 }));
    const edges = routes(trip).filter((edge) => edge.day !== 0 || edge.from !== "hotel" || edge.to !== trip.stops[0].id);
    await expect(solveTrip(trip, edges)).rejects.toThrow("Day 1: no allowed sampled route connects the hotel to the required visits");
  });
  it("identifies conflicting visits by ID and recalculates after an explicit release", () => {
    const trip = fixture();
    trip.stops = [
      { ...newStop("Same name"), day: 0, fixedTime: "10:00" },
      { ...newStop("Same name"), day: 0, fixedTime: "10:20" },
      { ...newStop("Later visit"), day: 0, fixedTime: "10:40" },
      { ...newStop("Early visit"), day: 1, fixedTime: "08:30" },
    ];
    const details = bookingConflictDetails(trip);
    expect(details.map((issue) => issue.stopIds)).toEqual([
      [trip.stops[0].id, trip.stops[1].id], [trip.stops[1].id, trip.stops[2].id], [trip.stops[3].id],
    ]);
    expect(details.map((issue) => issue.message)).toEqual(bookingConflicts(trip));
    const changed = resolvePlanningConstraints(trip, { keepTimeIds: [trip.stops[0].id, trip.stops[2].id], movableDayIds: [], optionalIds: [] });
    expect(bookingConflictDetails(changed).map((issue) => issue.stopIds)).toEqual([[trip.stops[0].id, trip.stops[2].id]]);
    expect(bookingConflictDetails(resolvePlanningConstraints(trip, { keepTimeIds: [], movableDayIds: [], optionalIds: [] }))).toEqual([]);
    expect(trip.stops.every((stop) => stop.fixedTime)).toBe(true);
  });
  it.each([0, 10, 20] as const)("reduces flexible durations by at most %i percent without changing locked reservations or omitting visits", (durationReductionPercent) => {
    const trip = fixture();
    trip.stops.push({ ...newStop("Short visit"), duration: 5, day: 0 });
    const original = structuredClone(trip);
    const choices = { keepTimeIds: [trip.stops[0].id], movableDayIds: trip.stops.slice(1).map((stop) => stop.id), optionalIds: [], durationReductionPercent };
    const candidate = resolvePlanningConstraints(trip, choices);
    expect(candidate.stops[0]).toEqual(trip.stops[0]);
    candidate.stops.slice(1).forEach((stop, index) => {
      const before = trip.stops[index + 1];
      expect(stop).toEqual({ ...before, day: null, fixedTime: null, duration: Math.max(5, Math.ceil(before.duration * (100 - durationReductionPercent) / 100)) });
      expect(stop.duration).toBeGreaterThanOrEqual(before.duration * (100 - durationReductionPercent) / 100);
      expect(stop.optional).toBe(false);
    });
    expect(resolvePlanningConstraints(trip, { ...choices, durationReductionPercent: 0 }).stops.map((stop) => stop.duration)).toEqual(trip.stops.map((stop) => stop.duration));
    expect(trip).toEqual(original);
  });
  it("releases only approved constraints without changing the original trip", () => {
    const trip = fixture();
    const original = structuredClone(trip);
    const keepTimeIds = trip.stops.filter((stop) => stop.fixedTime).map((stop) => stop.id);
    expect(resolvePlanningConstraints(trip, { keepTimeIds, movableDayIds: [], optionalIds: [] })).toEqual(trip);
    const candidate = resolvePlanningConstraints(trip, { keepTimeIds: [trip.stops[2].id], movableDayIds: [], optionalIds: [] });
    expect(candidate.stops[0]).toEqual({ ...trip.stops[0], fixedTime: null });
    expect(candidate.stops[2]).toEqual(trip.stops[2]);
    const relaxed = resolvePlanningConstraints(trip, { keepTimeIds: [trip.stops[2].id], movableDayIds: [trip.stops[0].id], optionalIds: [trip.stops[0].id] });
    expect(relaxed.stops[0]).toEqual({ ...trip.stops[0], fixedTime: null, day: null, optional: true });
    expect(trip).toEqual(original);
    expect(() => resolvePlanningConstraints(trip, { keepTimeIds, movableDayIds: [trip.stops[0].id], optionalIds: [] })).toThrow("fixed reservation");
    expect(() => resolvePlanningConstraints(trip, { keepTimeIds, movableDayIds: [], optionalIds: [trip.stops[0].id] })).toThrow("fixed reservation");
    expect(() => resolvePlanningConstraints(trip, { keepTimeIds, movableDayIds: ["missing"], optionalIds: [] })).toThrow("no longer in this trip");
  });
  it("names bookings whose visit and buffer leave no time for sampled travel", async () => {
    const trip = { ...fixture(), days: 1, dailyStart: "08:00", dailyEnd: "21:00", stops: [
      { ...newStop("DAK Showroom"), day: 0, fixedTime: "08:30" },
      { ...newStop("Vondelpark"), day: 0, fixedTime: "09:30" },
    ] };
    expect(bookingConflicts(trip)).toEqual([]);
    const error = await solveTrip(trip, routes(trip, 5)).catch((cause: Error) => cause);
    expect(error).toMatchObject({ reason: "conflict", detailed: false });
    expect((error as Error).message).toContain("DAK Showroom (08:30) to Vondelpark (09:30) leaves 0 min for travel; sampled routes need at least 5 min");
  });
  it("explains sampled hotel departure and return shortfalls", async () => {
    const trip = { ...fixture(), days: 1, stops: [{ ...newStop("Museum"), day: 0, fixedTime: "09:05", duration: 5, buffer: 0 }] };
    await expect(solveTrip(trip, routes(trip, 10))).rejects.toThrow("hotel start (09:00) to Museum (09:05) leaves 5 min for travel; sampled routes need at least 10 min");
    trip.stops[0].fixedTime = "17:55";
    await expect(solveTrip(trip, routes(trip, 10))).rejects.toThrow("Museum (17:55) to hotel return (18:00) leaves 0 min for travel; sampled routes need at least 10 min");
    trip.returnToHotel = false;
    expect(validateSchedule(trip, await solveTrip(trip, routes(trip, 10)))).toEqual([]);
  });
  it("suggests the nearest same-day gap without changing any bookings", () => {
    const trip = fixture();
    trip.dailyStart = "09:00";
    trip.dailyEnd = "18:00";
    trip.stops = [
      { ...newStop("Sango Specialty Coffee"), day: 0, fixedTime: "14:45" },
      { ...newStop("Sango"), day: 0, fixedTime: "15:13" },
      { ...newStop("Canal cruise"), day: 0, fixedTime: "17:00" },
    ];
    const before = structuredClone(trip);
    expect(bookingTimeSuggestion(trip, trip.stops[0].id)).toBe("14:13");
    expect(bookingTimeSuggestion(trip, trip.stops[1].id)).toBe("15:45");
    expect(bookingTimeSuggestion(trip, trip.stops[2].id)).toBeNull();
    expect(trip).toEqual(before);
    trip.stops[1].fixedTime = "15:45";
    expect(bookingConflicts(trip)).toEqual([]);
    expect(bookingTimeSuggestion(trip, trip.stops[1].id)).toBeNull();
  });
  it("does not suggest a slot that overruns the day or another booking's arrival buffer", () => {
    const trip = fixture();
    trip.dailyStart = "09:00";
    trip.dailyEnd = "11:00";
    trip.stops = [
      { ...newStop("First"), day: 0, fixedTime: "09:15", duration: 45 },
      { ...newStop("Second"), day: 0, fixedTime: "10:15", duration: 45 },
      { ...newStop("Overlapping"), day: 0, fixedTime: "10:00", duration: 15 },
    ];
    expect(bookingTimeSuggestion(trip, trip.stops[2].id)).toBeNull();
    trip.dailyEnd = "11:30";
    expect(bookingTimeSuggestion(trip, trip.stops[2].id)).toBe("11:15");
    trip.stops[2].fixedTime = null;
    expect(bookingTimeSuggestion(trip, trip.stops[2].id)).toBeNull();
    expect(bookingTimeSuggestion(trip, "missing")).toBeNull();
  });
  it("does not blame valid bookings when an intermediate route is faster", async () => {
    const trip = fixture();
    trip.days = 1;
    trip.stops = [
      { ...newStop("First"), day: 0, fixedTime: "10:00", duration: 5, buffer: 0 },
      { ...newStop("Intermediate"), duration: 5, buffer: 0 },
      { ...newStop("Second"), day: 0, fixedTime: "10:20", duration: 5, buffer: 0 },
    ];
    const [first, middle, last] = trip.stops;
    const leg = (from: string, to: string, minutes: number): TravelEdge => ({ day: 0, from, to, minutes, meters: 500, mode: "TRANSIT" });
    const edges = [leg("hotel", first.id, 5), leg(first.id, middle.id, 5), leg(middle.id, last.id, 5), leg(first.id, last.id, 60), leg(last.id, "hotel", 5)];
    expect(validateSchedule(trip, await solveTrip(trip, edges))).toEqual([]);
    expect(bookingConflicts(trip)).toEqual([]);
    trip.stops.push(newStop("Unreachable"));
    await expect(solveTrip(trip, edges)).rejects.toMatchObject({ detailed: false });
  });
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