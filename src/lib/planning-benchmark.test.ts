import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanningError, solveTrip, type SolverStage } from "./planner";
import { validateSchedule } from "./schedule-validation";
import { allowsTravelEdge, minuteAt, newStop, newTrip, planningPreferences, tripDate, type Schedule, type TravelEdge, type Trip } from "./trip";

vi.mock("server-only", () => ({}));
import { solveTripWithOrTools } from "./ortools";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function solveWithOrTools(trip: Trip, travel: TravelEdge[], timeLimitMs = 2000) {
  const executable = process.env.TRAVELLER_BENCHMARK_PYTHON;
  if (!executable) throw new Error("Set TRAVELLER_BENCHMARK_PYTHON to the isolated Python environment with scripts/planning-requirements.txt installed.");
  const payload = {
    stops: trip.stops.map((stop) => ({ ...stop, fixedMinute: stop.fixedTime ? minuteAt(trip, stop.day!, stop.fixedTime) : null })),
    days: Array.from({ length: trip.days }, (_, day) => ({ date: tripDate(trip, day), start: minuteAt(trip, day, trip.dailyStart), end: minuteAt(trip, day, trip.dailyEnd) })),
    travel: travel.filter((edge) => allowsTravelEdge(trip, edge) && Number.isInteger(edge.minutes) && edge.minutes >= 0 && Number.isFinite(edge.meters) && edge.meters >= 0),
    returnToHotel: trip.returnToHotel, ...planningPreferences(trip), timeLimitMs, generatedAt: "2026-10-12T00:00:00Z",
  };
  const child = spawnSync(executable, [fileURLToPath(new URL("../../scripts/benchmark-routing.py", import.meta.url))], { input: JSON.stringify(payload), encoding: "utf8", timeout: 15_000, maxBuffer: 2_000_000, env: { PATH: process.env.PATH, NODE_ENV: "test", PYTHONNOUSERSITE: "1" } });
  if (child.error || child.status !== 0) throw new Error(`OR-Tools benchmark failed: ${child.error?.message ?? child.stderr}`);
  return JSON.parse(child.stdout) as { outcome: string; schedule?: Schedule; startupMs: number; firstSolutionMs: number | null; elapsedMs: number };
}

function benchmarkFixture(sparse: boolean) {
  const trip: Trip = { ...newTrip(), id: "00000000-0000-4000-8000-000000000000", city: "Synthetic city", hotel: "Synthetic hotel", startDate: "2026-12-24", timeZone: "Europe/Amsterdam", days: 4, dailyStart: "08:00", dailyEnd: "21:00",
    stops: Array.from({ length: 33 }, (_, index) => ({ ...newStop(`Visit ${index + 1}`), id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, duration: [30, 45, 60, 90][Math.floor(index / 4) % 4], buffer: 10 })),
  };
  const ids = ["hotel", ...trip.stops.map((stop) => stop.id)];
  const travel: TravelEdge[] = [];
  for (let day = 0; day < trip.days; day++) {
    ids.forEach((from, origin) => ids.forEach((to, destination) => {
      if (from === to) return;
      const sameArea = origin > 0 && destination > 0 && (origin - 1) % 4 === (destination - 1) % 4;
      if (sparse && origin > 0 && destination > 0 && !sameArea && Math.abs(origin - destination) !== 1) return;
      const walk = sameArea && Math.abs(origin - destination) <= 8;
      travel.push({ day, from, to, mode: walk ? "WALK" : "TRANSIT", minutes: (origin === 0 || destination === 0 ? 18 : sameArea ? 6 : 45) + (origin * 7 + destination * 3 + day) % 11, meters: walk ? 850 : 6000 });
    }));
  }
  const witness: Schedule = { days: [], omitted: [], warnings: [], generatedAt: "2026-10-12T00:00:00Z" };
  for (let day = 0; day < trip.days; day++) {
    let from = "hotel";
    let cursor = 480;
    const visits = trip.stops.filter((_, index) => index % 4 === day).map((stop) => {
      const leg = travel.find((edge) => edge.day === day && edge.from === from && edge.to === stop.id)!;
      const start = cursor + leg.minutes;
      cursor = start + stop.duration;
      from = stop.id;
      return { stopId: stop.id, start, end: cursor, leg };
    });
    witness.days.push({ day, date: tripDate(trip, day), visits, returnLeg: travel.find((edge) => edge.day === day && edge.from === from && edge.to === "hotel")! });
  }
  return { trip, travel, witness };
}

describe("offline planning benchmark", () => {
  it.skipIf(!process.env.TRAVELLER_BENCHMARK_PYTHON)("runs the bounded asynchronous OR-Tools adapter", async () => {
    vi.stubEnv("TRAVELLER_ROUTING_PYTHON", process.env.TRAVELLER_BENCHMARK_PYTHON);
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network access is forbidden."); }));
    const { trip, travel } = benchmarkFixture(true);
    const original = structuredClone(trip);
    const stages: SolverStage[] = [];
    const schedule = await solveTripWithOrTools(trip, travel, 0.2, { onStage: (stage) => stages.push(stage) });
    expect(validateSchedule(trip, schedule)).toEqual([]);
    expect(stages).toEqual([expect.objectContaining({ engine: "ortools", outcome: "feasible", columns: null, nodes: null })]);
    const repaired = await solveTripWithOrTools(trip, travel, 0.2, { initialSchedule: schedule });
    expect(validateSchedule(trip, repaired)).toEqual([]);
    await expect(solveTripWithOrTools(trip, travel, 1, { timeoutMs: 1 })).rejects.toThrow("deadline");
    const controller = new AbortController();
    const pending = solveTripWithOrTools(trip, travel, 1, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("worker failed");
    expect(trip).toEqual(original);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.skipIf(!process.env.TRAVELLER_BENCHMARK_PYTHON).each(["2026-03-28", "2026-10-24"])("keeps DST bookings and balanced daily limits across %s", async (startDate) => {
    vi.stubEnv("TRAVELLER_ROUTING_PYTHON", process.env.TRAVELLER_BENCHMARK_PYTHON);
    const fixture = benchmarkFixture(false);
    const trip = { ...fixture.trip, startDate, days: 3, returnToHotel: startDate === "2026-03-28", planning: { ...planningPreferences(fixture.trip), goal: "BALANCED" as const, maxStopsPerDay: 2 }, stops: fixture.trip.stops.slice(0, 6).map((stop, index) => ({ ...stop, duration: 30, day: index === 0 ? 1 : null, fixedTime: index === 0 ? "10:00" : null })) };
    const ids = new Set(["hotel", ...trip.stops.map((stop) => stop.id)]);
    const travel = fixture.travel.filter((edge) => edge.day < 3 && ids.has(edge.from) && ids.has(edge.to));
    const schedule = await solveTripWithOrTools(trip, travel, 0.2);
    expect(validateSchedule(trip, schedule)).toEqual([]);
    expect(schedule.days.every((day) => day.visits.length === 2)).toBe(true);
    expect(schedule.days[1].visits.find((visit) => visit.stopId === trip.stops[0].id)?.start).toBe(minuteAt(trip, 1, "10:00"));
  });
  it.each([false, true])("compares search strategies on a known-feasible 33-stop graph (sparse=%s)", async (sparse) => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network access is forbidden in the offline planning benchmark."); }));
    const { trip, travel, witness } = benchmarkFixture(sparse);
    expect(validateSchedule(trip, witness)).toEqual([]);
    for (const strategy of ["optimized", "feasibility-first"] as const) {
      const started = performance.now();
      const stages: SolverStage[] = [];
      let outcome = "feasible";
      let violations: number | null = null;
      let travelMinutes: number | null = null;
      try {
        const schedule = await solveTrip(trip, travel, 2, { strategy, onStage: (stage) => stages.push(stage) });
        violations = validateSchedule(trip, schedule).length;
        travelMinutes = schedule.days.reduce((total, day) => total + day.visits.reduce((sum, visit) => sum + visit.leg.minutes, 0) + (day.returnLeg?.minutes ?? 0), 0);
      } catch (error) {
        if (!(error instanceof PlanningError)) throw error;
        outcome = error.reason;
      }
      console.table([{ strategy, stops: trip.stops.length, edges: travel.length, sparse, outcome, violations, travelMinutes, elapsedMs: Math.round(performance.now() - started), googleRequests: 0 }]);
      console.table(stages);
      expect(violations === null || violations === 0).toBe(true);
      expect(outcome).not.toBe("conflict");
    }
    expect(fetch).not.toHaveBeenCalled();
  }, 30_000);
  it.skipIf(!process.env.TRAVELLER_BENCHMARK_PYTHON).each([false, true])("benchmarks OR-Tools on the identical graph (sparse=%s)", (sparse) => {
    const { trip, travel, witness } = benchmarkFixture(sparse);
    expect(validateSchedule(trip, witness)).toEqual([]);
    const started = performance.now();
    const result = solveWithOrTools(trip, travel);
    const violations = result.schedule ? validateSchedule(trip, result.schedule) : null;
    const travelMinutes = result.schedule?.days.reduce((total, day) => total + day.visits.reduce((sum, visit) => sum + visit.leg.minutes, 0) + (day.returnLeg?.minutes ?? 0), 0) ?? null;
    console.table([{ strategy: "ortools", stops: trip.stops.length, edges: travel.length, sparse, outcome: result.outcome, startupMs: result.startupMs, firstSolutionMs: result.firstSolutionMs, solveMs: result.elapsedMs, elapsedMs: Math.round(performance.now() - started), violations: violations?.length ?? null, travelMinutes, googleRequests: 0 }]);
    expect(result.outcome).toBe("feasible");
    expect(violations).toEqual([]);
  });
  it.skipIf(!process.env.TRAVELLER_BENCHMARK_PYTHON).each([false, true])("OR-Tools preserves bookings, days, transport limits and optional omissions (return=%s)", (returnToHotel) => {
    const fixture = benchmarkFixture(false);
    const trip: Trip = { ...fixture.trip, days: 2, dailyStart: "09:00", dailyEnd: "12:00", returnToHotel,
      planning: { ...planningPreferences(fixture.trip), maxStopsPerDay: 1, maxWalkMinutes: 5 },
      stops: fixture.trip.stops.slice(0, 3).map((stop, index) => ({ ...stop, day: index === 2 ? null : index, fixedTime: index === 0 ? "10:00" : null, optional: index === 2, mode: index === 1 ? "TRANSIT" : "AUTO" })),
    };
    const ids = ["hotel", ...trip.stops.slice(0, 2).map((stop) => stop.id)];
    const travel = Array.from({ length: trip.days }, (_, day) => ids.flatMap((from) => ids.filter((to) => to !== from && (to !== "hotel" || returnToHotel)).flatMap((to): TravelEdge[] => [
      { day, from, to, mode: "WALK", minutes: 6, meters: 600 },
      { day, from, to, mode: "TRANSIT", minutes: 10, meters: 2000 },
    ]))).flat();
    const result = solveWithOrTools(trip, travel, 200);
    expect(result.outcome).toBe("feasible");
    expect(result.schedule).toBeDefined();
    expect(validateSchedule(trip, result.schedule!)).toEqual([]);
    expect(result.schedule!.omitted).toEqual([trip.stops[2].id]);
    expect(result.schedule!.days.flatMap((day) => day.visits).every((visit) => visit.leg.mode === "TRANSIT")).toBe(true);
  });
  it.skipIf(!process.env.TRAVELLER_BENCHMARK_PYTHON).each(["missing-route", "booking-buffer", "daily-capacity", "day-end"] as const)("OR-Tools rejects a required %s violation", (constraint) => {
    const fixture = benchmarkFixture(false);
    const trip: Trip = { ...fixture.trip, days: 1, dailyStart: "09:00", dailyEnd: "12:00",
      planning: { ...planningPreferences(fixture.trip), maxStopsPerDay: constraint === "daily-capacity" ? 1 : 25 },
      stops: fixture.trip.stops.slice(0, 2).map((stop, index) => ({ ...stop, day: 0, fixedTime: constraint === "booking-buffer" && index === 0 ? "09:25" : null, duration: constraint === "day-end" ? 100 : 30, buffer: 10 })),
    };
    const ids = new Set(["hotel", ...trip.stops.map((stop) => stop.id)]);
    const travel = fixture.travel.filter((edge) => edge.day === 0 && ids.has(edge.from) && ids.has(edge.to) && (constraint !== "missing-route" || edge.to !== trip.stops[1].id))
      .map((edge) => ({ ...edge, minutes: 20 }));
    const result = solveWithOrTools(trip, travel, 200);
    expect(result.outcome).not.toBe("feasible");
    expect(result.schedule).toBeUndefined();
  });
});