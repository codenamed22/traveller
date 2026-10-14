import { PlanningError, sampledRouteGaps } from "./planner";
import { dayStart, minuteAt, tripSchema, type Schedule, type TravelEdge, type Trip } from "./trip";
import { validateSchedule } from "./schedule-validation";

type Solve = (trip: Trip, seconds: number, level: number) => Promise<Schedule>;

function restoreDurations(trip: Trip, schedule: Schedule): Schedule {
  const durations = new Map(schedule.days.flatMap((day) => day.visits.map((visit) => [visit.stopId, visit.end - visit.start] as const)));
  const retime = () => ({ ...schedule, days: schedule.days.map((day) => {
    let cursor = dayStart(trip, day.day);
    const visits = day.visits.map((visit) => {
      const stop = trip.stops.find((candidate) => candidate.id === visit.stopId)!;
      const start = stop.fixedTime ? minuteAt(trip, day.day, stop.fixedTime) : cursor + visit.leg.minutes;
      const end = start + durations.get(stop.id)!;
      cursor = end;
      return { ...visit, start, end };
    });
    return { ...day, visits };
  }) });
  let best = schedule;
  const ranked = trip.stops.filter((stop) => durations.has(stop.id) && !stop.fixedTime).sort((left, right) => right.priority - left.priority || (right.duration - durations.get(right.id)!) - (left.duration - durations.get(left.id)!));
  for (const stop of ranked) {
    const current = durations.get(stop.id)!;
    for (const duration of stop.durationOptions ?? [stop.duration]) {
      if (duration <= current) continue;
      durations.set(stop.id, duration);
      const candidate = retime();
      if (!validateSchedule(trip, candidate).length) { best = candidate; break; }
      durations.set(stop.id, current);
    }
  }
  return best;
}

export async function solveWithDurationRelaxation(input: Trip, travel: TravelEdge[], seconds: number, solve: Solve): Promise<Schedule> {
  const trip = tripSchema.parse(input);
  const flexible = trip.stops.some((stop) => (stop.durationOptions?.length ?? 0) > 1);
  if (!flexible) return solve(trip, seconds, 0);
  const gaps = sampledRouteGaps(trip, travel);
  if (gaps.length) throw new PlanningError(`Route coverage is incomplete. ${gaps.join(" ")} Visit durations were not reduced.`, "incomplete", true);
  const attempts: { trip: Trip; level: number }[] = [];
  const seen = new Set<string>();
  for (const level of [0, 1, 2, 3]) {
    const candidate = { ...trip, stops: trip.stops.map((stop) => {
      const floor = level === 0 || stop.fixedTime ? stop.duration : level === 1 ? Math.ceil(stop.duration * 0.9) : level === 2 ? Math.ceil(stop.duration * 0.8) : 5;
      const duration = Math.min(...(stop.durationOptions ?? [stop.duration]).filter((value) => value >= floor));
      const next = { ...stop, duration };
      delete next.durationOptions;
      return next;
    }) };
    const key = candidate.stops.map((stop) => stop.duration).join(",");
    if (!seen.has(key)) { attempts.push({ trip: candidate, level }); seen.add(key); }
  }
  const deadline = performance.now() + seconds * 1000;
  for (const [index, attempt] of attempts.entries()) {
    const remaining = (deadline - performance.now()) / 1000;
    if (remaining <= 0) throw new PlanningError("The duration search reached its time budget. This does not prove the trip is impossible.");
    let schedule: Schedule;
    try { schedule = await solve(attempt.trip, remaining / (attempts.length - index), attempt.level); }
    catch (error) {
      if (!(error instanceof PlanningError) || error.reason !== "conflict" || error.detailed) throw error;
      if (index === attempts.length - 1) throw new PlanningError("No schedule fits the sampled routes within the approved duration limits. No required visits were dropped and no further constraints were relaxed.", "conflict");
      continue;
    }
    if (validateSchedule(attempt.trip, schedule).length) throw new PlanningError("The duration search returned an invalid schedule.");
    return restoreDurations(trip, schedule);
  }
  throw new PlanningError("No duration choices could be searched.");
}