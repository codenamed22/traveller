import "server-only";
import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { PlanningError, type SolverStage } from "./planner";
import { allowsTravelEdge, bookingConflicts, dayEnd, dayStart, minuteAt, planningPreferences, returnDeadline, tripDate, tripSchema, type Schedule, type TravelEdge, type Trip } from "./trip";
import { validateSchedule } from "./schedule-validation";

const integer = z.number().int().nonnegative();
const edgeSchema = z.object({ day: integer, from: z.string(), to: z.string(), mode: z.enum(["WALK", "TRANSIT"]), minutes: integer, meters: z.number().nonnegative() });
const resultSchema = z.object({
  outcome: z.enum(["feasible", "conflict", "incomplete"]),
  startupMs: integer, elapsedMs: integer, firstSolutionMs: integer.nullable(),
  schedule: z.object({
    days: z.array(z.object({ day: integer, date: z.iso.date(), visits: z.array(z.object({ stopId: z.string(), start: integer, end: integer, leg: edgeSchema })).max(60), returnLeg: edgeSchema.optional() })).max(7),
    omitted: z.array(z.string()).max(60), warnings: z.array(z.string()), generatedAt: z.iso.datetime(),
  }).optional(),
});
let activeSolves = 0;

export async function solveTripWithOrTools(input: Trip, travel: TravelEdge[], seconds = 5, options: { onStage?: (stage: SolverStage) => void; signal?: AbortSignal; timeoutMs?: number; initialSchedule?: Schedule } = {}): Promise<Schedule> {
  const trip = tripSchema.parse(input);
  const conflicts = bookingConflicts(trip);
  if (conflicts.length) throw new PlanningError(conflicts.join(" "), "conflict", true);
  const executable = process.env.TRAVELLER_ROUTING_PYTHON;
  if (!executable || !isAbsolute(executable)) throw new PlanningError("Configure an absolute TRAVELLER_ROUTING_PYTHON path on a host with OR-Tools installed.", "incomplete", true);
  if (activeSolves >= 2) throw new PlanningError("The routing worker is busy. Try again shortly.", "incomplete", true);
  const timeout = Math.min(15_000, options.timeoutMs ?? 15_000);
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(timeout) || timeout <= 0 || options.signal?.aborted) throw new PlanningError("The routing request was cancelled or reached its deadline.");
  const ids = new Set(["hotel", ...trip.stops.map((stop) => stop.id)]);
  const edges = travel.filter((edge) => Number.isInteger(edge.day) && edge.day >= 0 && edge.day < trip.days && ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to && allowsTravelEdge(trip, edge) && Number.isInteger(edge.minutes) && edge.minutes >= 0 && Number.isFinite(edge.meters) && edge.meters >= 0);
  const payload = {
    stops: trip.stops.map((stop) => ({ id: stop.id, day: stop.day, duration: stop.duration, buffer: stop.buffer, optional: stop.optional, priority: stop.priority, fixedMinute: stop.fixedTime ? minuteAt(trip, stop.day!, stop.fixedTime) : null })),
    days: Array.from({ length: trip.days }, (_, day) => ({ date: tripDate(trip, day), start: dayStart(trip, day), end: dayEnd(trip, day), returnEnd: returnDeadline(trip, day) })),
    travel: edges.map(({ day, from, to, mode, minutes, meters }) => ({ day, from, to, mode, minutes, meters })),
    returnToHotel: trip.returnToHotel, maxStopsPerDay: planningPreferences(trip).maxStopsPerDay, goal: planningPreferences(trip).goal,
    initialRoutes: options.initialSchedule ? Array.from({ length: trip.days }, (_, day) => options.initialSchedule!.days.find((candidate) => candidate.day === day)?.visits.map((visit) => visit.stopId) ?? []) : undefined,
    timeLimitMs: Math.max(1, Math.floor(Math.min(seconds * 1000, 5000, timeout))), generatedAt: new Date().toISOString(),
  };
  const started = performance.now();
  let result: z.infer<typeof resultSchema> | undefined;
  let outcome: SolverStage["outcome"] = "incomplete";
  activeSolves++;
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(executable, [join(process.cwd(), "scripts/benchmark-routing.py")], {
        encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 2_000_000, signal: options.signal,
        env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV, PYTHONNOUSERSITE: "1" },
      }, (error, stdout) => error ? reject(new PlanningError("The OR-Tools worker failed or exceeded its deadline. No itinerary was changed.", "incomplete", true)) : resolve(stdout));
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify(payload));
    });
    try { result = resultSchema.parse(JSON.parse(output)); }
    catch { throw new PlanningError("The routing worker returned an invalid response.", "incomplete", true); }
    outcome = result.outcome;
    if (result.outcome !== "feasible") throw new PlanningError(result.outcome === "conflict" ? "No schedule fits the supplied route samples and retained constraints." : "The routing search ended without a schedule. This does not prove the trip is impossible.", result.outcome);
    const schedule = result.schedule;
    if (!schedule) throw new PlanningError("The routing worker returned no schedule.");
    const restoreEdge = (edge: TravelEdge) => {
      const original = edges.find((known) => known.day === edge.day && known.from === edge.from && known.to === edge.to && known.mode === edge.mode && known.minutes === edge.minutes && known.meters === edge.meters);
      if (!original) throw new PlanningError("The routing worker returned an unknown connection.");
      return { ...original };
    };
    for (const day of schedule.days) {
      for (const visit of day.visits) visit.leg = restoreEdge(visit.leg);
      if (day.returnLeg) day.returnLeg = restoreEdge(day.returnLeg);
    }
    if (validateSchedule(trip, schedule).length) throw new PlanningError("The routing worker returned a schedule that failed independent validation.");
    return schedule;
  } catch (error) {
    outcome = error instanceof PlanningError ? error.reason : "incomplete";
    throw error;
  } finally {
    activeSolves--;
    options.onStage?.({ engine: "ortools", stage: "optimization", outcome, elapsedMs: Math.round(performance.now() - started), startupMs: result?.startupMs, firstSolutionMs: result?.firstSolutionMs ?? null, columns: null, nodes: null });
  }
}