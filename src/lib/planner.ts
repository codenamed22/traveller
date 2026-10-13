import loadHighs from "highs";
import { allowsTravelEdge, allowsVisitPair, bookingConflicts, groupAllowedDays, minuteAt, planningPreferences, stopAllowedOnDay, tripDate, tripSchema, type PlanningFailureCode, type Schedule, type TravelEdge, type Trip } from "./trip";
import { validateSchedule, type ScheduleBoundary } from "./schedule-validation";

export { bookingConflicts } from "./trip";

let engine: ReturnType<typeof loadHighs> | undefined;

export function planningEngine() {
  return engine ??= loadHighs();
}

export class PlanningError extends Error {
  constructor(message: string, public readonly reason: "conflict" | "incomplete" = "incomplete", public readonly detailed = false, public readonly code: PlanningFailureCode = reason === "conflict" ? "sampled-model-conflict" : "search-incomplete") {
    super(message);
    this.name = "PlanningError";
  }
}

export type SolverStage = {
  stage: "feasibility" | "optimization";
  outcome: "feasible" | "conflict" | "incomplete";
  elapsedMs: number;
  firstSolutionMs: number | null;
  columns: number | null;
  nodes: number | null;
  engine?: "highs" | "ortools";
  startupMs?: number;
  durationLevel?: number;
  objective?: "duration" | "optional" | "travel";
  optimal?: boolean;
  objectiveValue?: number | null;
  constructionMs?: number;
  seeded?: boolean;
};
export type SolverOptions = { strategy?: "optimized" | "feasibility-first"; onStage?: (stage: SolverStage) => void; initialSchedule?: Schedule; boundary?: ScheduleBoundary };

function bookingRouteConflicts(trip: Trip, travel: TravelEdge[]) {
  const issues: string[] = [];
  const ids = ["hotel", ...trip.stops.map((stop) => stop.id)];
  for (let day = 0; day < trip.days; day++) {
    const shortest = ids.map((_, origin) => ids.map((_, destination) => origin === destination ? 0 : Infinity));
    for (const edge of travel.filter((edge) => edge.day === day && allowsTravelEdge(trip, edge) && Number.isFinite(edge.minutes) && edge.minutes >= 0 && Number.isFinite(edge.meters) && edge.meters >= 0)) {
      const origin = ids.indexOf(edge.from);
      const destination = ids.indexOf(edge.to);
      if (origin >= 0 && destination >= 0) shortest[origin][destination] = Math.min(shortest[origin][destination], edge.minutes);
    }
    for (let via = 0; via < ids.length; via++) for (let origin = 0; origin < ids.length; origin++) for (let destination = 0; destination < ids.length; destination++) {
      shortest[origin][destination] = Math.min(shortest[origin][destination], shortest[origin][via] + shortest[via][destination]);
    }
    let previous = { id: "hotel", name: `hotel start (${trip.dailyStart})`, end: minuteAt(trip, day, trip.dailyStart) };
    const booked = trip.stops.filter((stop) => stop.day === day && stop.fixedTime).sort((left, right) => left.fixedTime!.localeCompare(right.fixedTime!));
    const check = (id: string, name: string, deadline: number) => {
      const needed = shortest[ids.indexOf(previous.id)][ids.indexOf(id)];
      const available = deadline - previous.end;
      if (Number.isFinite(needed) && needed > available) issues.push(`Day ${day + 1}: ${previous.name} to ${name} leaves ${Math.round(available)} min for travel; sampled routes need at least ${Math.ceil(needed)} min.`);
    };
    for (const stop of booked) {
      const at = minuteAt(trip, day, stop.fixedTime!);
      const name = `${stop.name} (${stop.fixedTime})`;
      check(stop.id, name, at - stop.buffer);
      previous = { id: stop.id, name, end: at + stop.duration };
    }
    if (trip.returnToHotel && booked.length) check("hotel", `hotel return (${trip.dailyEnd})`, minuteAt(trip, day, trip.dailyEnd));
  }
  return issues;
}

export function sampledRouteReachability(trip: Trip, travel: TravelEdge[]) {
  return Array.from({ length: trip.days }, (_, day) => {
    const stops = trip.stops.filter((stop) => stopAllowedOnDay(trip, stop, day));
    const ids = new Set(["hotel", ...stops.map((stop) => stop.id)]);
    const minutes = minuteAt(trip, day, trip.dailyEnd) - minuteAt(trip, day, trip.dailyStart);
    const edges = travel.filter((edge) => edge.day === day && ids.has(edge.from) && ids.has(edge.to) && allowsVisitPair(trip, edge.from, edge.to) && allowsTravelEdge(trip, edge) && Number.isFinite(edge.minutes) && edge.minutes >= 0 && edge.minutes <= minutes && Number.isFinite(edge.meters) && edge.meters >= 0);
    const reachable = (reverse: boolean) => {
      const visited = new Set(["hotel"]);
      for (let size = 0; size !== visited.size;) {
        size = visited.size;
        for (const edge of edges) if (visited.has(reverse ? edge.to : edge.from)) visited.add(reverse ? edge.from : edge.to);
      }
      return visited;
    };
    const outbound = reachable(false);
    const inbound = reachable(true);
    const required = stops.filter((stop) => !stop.optional && stop.day === day);
    const noDeparture = required.length > 0 && outbound.size === 1;
    const noReturn = trip.returnToHotel && required.length > 0 && inbound.size === 1;
    return { day, stops, outbound, inbound, noDeparture, noReturn };
  });
}

export function sampledRouteGaps(trip: Trip, travel: TravelEdge[]) {
  const issues: string[] = [];
  const reachableDays = sampledRouteReachability(trip, travel);
  for (const { day, noDeparture, noReturn } of reachableDays) {
    if (noDeparture) issues.push(`Day ${day + 1}: no allowed sampled route connects the hotel to the required visits (start ${trip.dailyStart}).`);
    if (noReturn) issues.push(`Day ${day + 1}: no allowed sampled route connects the required visits back to the hotel.`);
  }
  for (const stop of trip.stops.filter((stop) => !stop.optional)) {
    const days = reachableDays.filter((_, day) => stopAllowedOnDay(trip, stop, day));
    if (days.some((day) => day.outbound.has(stop.id) && (!trip.returnToHotel || day.inbound.has(stop.id)))) continue;
    if (stop.day !== null && days[0] && (days[0].noDeparture || days[0].noReturn)) continue;
    issues.push(`${stop.day === null ? "Any available day" : `Day ${stop.day + 1}`}: ${stop.name} has no allowed sampled connection from the hotel${trip.returnToHotel ? " and back" : ""}.`);
  }
  for (const group of trip.dayGroups ?? []) {
    const required = trip.stops.filter((stop) => group.stopIds.includes(stop.id) && !stop.optional);
    if (required.length && !reachableDays.some((day) => groupAllowedDays(trip, group).includes(day.day) && required.every((stop) => day.outbound.has(stop.id) && (!trip.returnToHotel || day.inbound.has(stop.id))))) {
      issues.push(`${group.name}: grouped visits lack complete route coverage on a common allowed day.`);
    }
  }
  return issues;
}

function constructionHint(trip: Trip, travel: TravelEdge[], deadline: number, boundary?: ScheduleBoundary): Schedule | undefined {
  const edges = new Map<string, TravelEdge>();
  const key = (day: number, from: string, to: string) => JSON.stringify([day, from, to]);
  const bounds = Array.from({ length: trip.days }, (_, day) => ({ date: tripDate(trip, day), start: boundary?.startMinute ?? minuteAt(trip, day, trip.dailyStart), end: minuteAt(trip, day, trip.dailyEnd) }));
  const allowed = bounds.map((_, day) => trip.stops.map((stop) => stopAllowedOnDay(trip, stop, day)));
  const bookings = trip.stops.map((stop) => stop.fixedTime ? minuteAt(trip, stop.day!, stop.fixedTime) : null);
  const maxStops = planningPreferences(trip).maxStopsPerDay;
  for (const edge of travel) {
    if (!allowsTravelEdge(trip, edge) || !allowsVisitPair(trip, edge.from, edge.to) || !Number.isFinite(edge.minutes) || edge.minutes < 0 || !Number.isFinite(edge.meters) || edge.meters < 0) continue;
    const previous = edges.get(key(edge.day, edge.from, edge.to));
    if (!previous || edge.minutes < previous.minutes) edges.set(key(edge.day, edge.from, edge.to), edge);
  }
  const groups = trip.dayGroups ?? [];
  for (let variant = 0; variant < trip.days * 2 && performance.now() < deadline; variant++) {
    const durations = trip.stops.map((stop) => variant < trip.days || stop.fixedTime ? stop.duration : stop.durationOptions?.at(-1) ?? stop.duration);
    const groupDays = new Map<string, number>();
    let orders = Array.from({ length: trip.days }, (_, day) => trip.stops.flatMap((stop, index) => stop.day === day && stop.fixedTime ? [index] : []).sort((left, right) => trip.stops[left].fixedTime!.localeCompare(trip.stops[right].fixedTime!)));
    for (const group of groups) {
      const booking = trip.stops.find((stop) => group.stopIds.includes(stop.id) && stop.fixedTime);
      if (booking) groupDays.set(group.id, booking.day!);
    }
    const retime = (day: number, order: number[]): Schedule["days"][number] | null => {
      if (order.length > maxStops) return null;
      const result: Schedule["days"][number] = { day, date: bounds[day].date, visits: [] };
      let departure = bounds[day].start;
      const end = bounds[day].end;
      let from = boundary?.startId ?? "hotel";
      for (const index of order) {
        const stop = trip.stops[index];
        const leg = edges.get(key(day, from, stop.id));
        if (!leg || !allowed[day][index]) return null;
        const start = bookings[index] ?? departure + leg.minutes;
        if (departure + leg.minutes + (stop.fixedTime ? stop.buffer : 0) > start || start + durations[index] > end) return null;
        result.visits.push({ stopId: stop.id, start, end: start + durations[index], leg });
        departure = start + durations[index]; from = stop.id;
      }
      if ((order.length || boundary) && trip.returnToHotel) {
        const leg = edges.get(key(day, from, "hotel"));
        if (!leg || departure + leg.minutes > end) return null;
        result.returnLeg = leg;
      }
      return result;
    };
    const routeMinutes = (day: Schedule["days"][number]) => day.visits.reduce((total, visit) => total + visit.leg.minutes, day.returnLeg?.minutes ?? 0);
    const insert = (pending: number[], required: boolean, restrictedDay?: number): boolean => {
      while (pending.length && performance.now() < deadline) {
        let best: { index: number; day: number; order: number[]; score: number } | undefined;
        for (const index of pending) {
          const stop = trip.stops[index];
          const ownGroup = groups.find((group) => group.stopIds.includes(stop.id));
          for (let offset = 0; offset < trip.days; offset++) {
            const day = (offset + variant) % trip.days;
            if (restrictedDay !== undefined && day !== restrictedDay) continue;
            if (!allowed[day][index] || (ownGroup && groupDays.has(ownGroup.id) && groupDays.get(ownGroup.id) !== day)) continue;
            if (groups.some((group) => group.exclusive && groupDays.get(group.id) === day && !group.stopIds.includes(stop.id))) continue;
            if (ownGroup?.exclusive && orders[day].some((other) => !ownGroup.stopIds.includes(trip.stops[other].id))) continue;
            const current = retime(day, orders[day]);
            if (!current) continue;
            for (let position = 0; position <= orders[day].length; position++) {
              const order = [...orders[day].slice(0, position), index, ...orders[day].slice(position)];
              const candidate = retime(day, order);
              if (!candidate) continue;
              const score = (routeMinutes(candidate) - routeMinutes(current)) * 1000 + candidate.visits.at(-1)!.end - bounds[day].start;
              if (!best || score < best.score) best = { index, day, order, score };
            }
          }
          if (best) break;
        }
        if (!best) return !required;
        orders[best.day] = best.order;
        const ownGroup = groups.find((group) => group.stopIds.includes(trip.stops[best.index].id));
        if (ownGroup) groupDays.set(ownGroup.id, best.day);
        pending.splice(pending.indexOf(best.index), 1);
      }
      return !required || !pending.length;
    };
    let possible = true;
    for (const group of [...groups].sort((left, right) => groupAllowedDays(trip, left).length - groupAllowedDays(trip, right).length)) {
      const members = trip.stops.flatMap((stop, index) => group.stopIds.includes(stop.id) && !stop.optional && !stop.fixedTime ? [index] : []);
      if (!members.length) continue;
      const before = orders.map((order) => [...order]);
      const assignedDay = groupDays.get(group.id);
      let fitted = false;
      for (let offset = 0; offset < trip.days; offset++) {
        const day = (variant + offset) % trip.days;
        if (!groupAllowedDays(trip, group).includes(day) || (assignedDay !== undefined && day !== assignedDay)) continue;
        orders = before.map((order) => [...order]);
        groupDays.set(group.id, day);
        if (insert([...members], true, day)) { fitted = true; break; }
      }
      if (!fitted) { possible = false; break; }
    }
    if (!possible) continue;
    const required = trip.stops.flatMap((stop, index) => !stop.optional && !stop.fixedTime && !groups.some((group) => group.stopIds.includes(stop.id)) ? [index] : []);
    if (!insert(required, true)) continue;
    insert(trip.stops.flatMap((stop, index) => stop.optional ? [index] : []), false);
    const days = orders.map((order, day) => retime(day, order));
    if (days.some((day) => !day)) continue;
    const included = new Set(orders.flat());
    const schedule: Schedule = { days: days as Schedule["days"], omitted: trip.stops.filter((_, index) => !included.has(index)).map((stop) => stop.id), warnings: [], generatedAt: new Date().toISOString() };
    if (!validateSchedule(trip, schedule, boundary).length) return schedule;
  }
}

// Decomposition fallback: fix each flexible visit's day, then solve every day as a small independent problem.
export async function solveTripByDays(input: Trip, travel: TravelEdge[], seconds = 5, options: SolverOptions = {}): Promise<Schedule> {
  const trip = tripSchema.parse(input);
  const started = performance.now();
  const remaining = () => seconds - (performance.now() - started) / 1000;
  const groups = trip.dayGroups ?? [];
  const day = new Map<string, number>(trip.stops.flatMap((stop) => stop.day === null ? [] : [[stop.id, stop.day] as [string, number]]));
  const reserved = new Map<number, string>();
  const length = (index: number) => minuteAt(trip, index, trip.dailyEnd) - minuteAt(trip, index, trip.dailyStart);
  const load = (index: number) => trip.stops.filter((stop) => day.get(stop.id) === index).reduce((total, stop) => total + Math.min(stop.duration, ...(stop.durationOptions ?? [])) + 25, 25);
  for (const group of groups) {
    const fixed = trip.stops.find((stop) => group.stopIds.includes(stop.id) && stop.day !== null)?.day;
    const options = groupAllowedDays(trip, group).filter((candidate) => !reserved.has(candidate) && (fixed === undefined || candidate === fixed));
    const members = trip.stops.filter((stop) => group.stopIds.includes(stop.id));
    const chosen = options.sort((left, right) => load(left) - load(right) || right - left)[0];
    if (chosen === undefined) throw new PlanningError(`${group.name}: no day is available for this group.`, "conflict", true, "hard-input-conflict");
    members.forEach((stop) => day.set(stop.id, chosen));
    if (group.exclusive) reserved.set(chosen, group.id);
  }
  const fastest = (from: string, to: string, index: number) => Math.min(Infinity, ...travel.filter((edge) => edge.day === index && edge.from === from && edge.to === to && allowsTravelEdge(trip, edge)).map((edge) => edge.minutes));
  const eligible = (stop: Trip["stops"][number], index: number) => stopAllowedOnDay(trip, stop, index) && !reserved.has(index);
  const free = trip.stops.filter((stop) => !day.has(stop.id)).sort((left, right) => right.duration - left.duration);
  const place = (stop: Trip["stops"][number], excluded: number[] = []) => {
    const candidates = Array.from({ length: trip.days }, (_, index) => index).filter((index) => eligible(stop, index) && !excluded.includes(index));
    const score = (index: number) => {
      const peers = trip.stops.filter((other) => other.id !== stop.id && day.get(other.id) === index);
      const near = Math.min(fastest("hotel", stop.id, index), ...peers.map((peer) => Math.min(fastest(peer.id, stop.id, index), fastest(stop.id, peer.id, index))));
      return length(index) - load(index) - stop.duration - 2 * (Number.isFinite(near) ? near : 60);
    };
    const chosen = candidates.sort((left, right) => score(right) - score(left))[0];
    if (chosen === undefined) return false;
    day.set(stop.id, chosen);
    return true;
  };
  for (const stop of free) if (!place(stop) && !stop.optional) throw new PlanningError(`${stop.name} has no eligible day.`, "conflict", true, "hard-input-conflict");
  const movable = new Set(free.map((stop) => stop.id));
  const solveDay = async (index: number) => {
    const stops = trip.stops.filter((stop) => day.get(stop.id) === index).map((stop) => ({ ...stop, day: 0 }));
    const single: Trip = { ...trip, days: 1, startDate: tripDate(trip, index), stops, dayGroups: undefined };
    if (!stops.length) return { day: index, date: tripDate(trip, index), visits: [], omitted: [] as string[], loss: 0, optimal: true };
    const result = await solveTrip(single, travel.filter((edge) => edge.day === index).map((edge) => ({ ...edge, day: 0 })), Math.max(0.5, Math.min(2, remaining() / trip.days)), options);
    const plan = result.days[0];
    const shift = (edge: TravelEdge): TravelEdge => ({ ...edge, day: index });
    return { day: index, date: tripDate(trip, index), visits: plan.visits.map((visit) => ({ ...visit, leg: shift(visit.leg) })), ...(plan.returnLeg ? { returnLeg: shift(plan.returnLeg) } : {}), omitted: result.omitted, loss: result.optimization?.weightedDurationLoss ?? 0, optimal: result.optimization?.durationOptimal ?? true };
  };
  const results = new Map<number, Awaited<ReturnType<typeof solveDay>>>();
  const failed: number[] = [];
  for (let index = 0; index < trip.days; index++) {
    try { results.set(index, await solveDay(index)); } catch (error) { if (!(error instanceof PlanningError)) throw error; failed.push(index); }
  }
  for (const index of failed) {
    let solved = false;
    const candidates = trip.stops.filter((stop) => movable.has(stop.id) && day.get(stop.id) === index).sort((left, right) => left.duration - right.duration);
    for (const stop of candidates) {
      if (remaining() <= 0.5) break;
      const target = Array.from({ length: trip.days }, (_, other) => other).filter((other) => other !== index && !failed.includes(other) && eligible(stop, other)).sort((left, right) => load(left) - load(right))[0];
      if (target === undefined) continue;
      day.set(stop.id, target);
      try {
        const [moved, rest] = await Promise.all([solveDay(target), solveDay(index)]);
        results.set(target, moved); results.set(index, rest); solved = true; break;
      } catch (error) {
        if (!(error instanceof PlanningError)) throw error;
        day.set(stop.id, index);
      }
    }
    if (!solved) throw new PlanningError(`Day ${index + 1} could not be planned with its assigned visits within the time limit.`, "incomplete");
  }
  const days = Array.from({ length: trip.days }, (_, index) => results.get(index)!);
  const schedule: Schedule = {
    days: days.map(({ day: index, date, visits, returnLeg }) => ({ day: index, date, visits, ...(returnLeg ? { returnLeg } : {}) })),
    omitted: days.flatMap((entry) => entry.omitted), warnings: ["Days were planned one at a time after assigning flexible visits to days; a better overall arrangement may exist."], generatedAt: new Date().toISOString(),
    optimization: { weightedDurationLoss: days.reduce((total, entry) => total + entry.loss, 0), durationOptimal: false, optionalOptimal: false, travelOptimal: false },
  };
  const errors = validateSchedule(trip, schedule);
  if (errors.length) throw new PlanningError(errors.join(" "));
  return schedule;
}

export async function solveTrip(input: Trip, travel: TravelEdge[], seconds = 5, options: SolverOptions = {}): Promise<Schedule> {
  const trip = tripSchema.parse(input);
  const boundary = options.boundary;
  if (boundary && (trip.days !== 1 || !Number.isFinite(boundary.startMinute) || boundary.startMinute < minuteAt(trip, 0, trip.dailyStart) || boundary.startMinute > minuteAt(trip, 0, trip.dailyEnd))) throw new PlanningError("Invalid remaining-day boundary.", "conflict");
  const coupled = Boolean(trip.dayGroups?.length || trip.stops.some((stop) => (stop.durationOptions?.length ?? 0) > 1));
  if (coupled && !boundary) {
    const gaps = sampledRouteGaps(trip, travel);
    if (gaps.length) throw new PlanningError(`Route coverage is incomplete. ${gaps.join(" ")}`, "incomplete", true, "missing-data");
  }
  const highs = await planningEngine();
  const model = highs.createModel();
  let columnCount = 0;
  const assignments = new Map<string, number[]>();
  const groupAssignments = new Map<string, number[]>();
  const routes: { day: number; from: number; to: number; column: number; edge: TravelEdge }[] = [];
  const times: number[][] = [];
  const services: [number, number][][][] = [];
  const durationLoss: [number, number][] = [];
  const optionalUtility: [number, number][] = [];
  const bigM = 4000;
  const infinity = highs.infinity;
  const endNode = trip.stops.length + 1;
  const costs: number[] = [];
  const addVariable = (lower: number, upper: number, cost = 0, integer = false) => {
    const column = columnCount++;
    model.addVar(lower, upper);
    model.changeColCost(column, cost);
    costs.push(cost);
    if (integer) model.changeColIntegrality(column, highs.constants.variableType.integer);
    return column;
  };
  const addRow = (entries: [number, number][], lower: number, upper: number) => {
    const combined = new Map<number, number>();
    for (const [column, value] of entries) combined.set(column, (combined.get(column) ?? 0) + value);
    const terms = [...combined].filter(([, value]) => value !== 0);
    model.addRow(lower, upper, { indices: terms.map(([column]) => column), values: terms.map(([, value]) => value) });
  };
  try {
    model.options.set({ output_flag: false, time_limit: Math.min(5, Math.max(0.01, seconds)), mip_rel_gap: 0.02 });
    const preferences = planningPreferences(trip);
    const peakLoad = preferences.goal === "BALANCED" ? addVariable(0, infinity, 1) : null;
    for (let day = 0; day < trip.days; day++) {
      const start = boundary?.startMinute ?? minuteAt(trip, day, trip.dailyStart);
      const end = minuteAt(trip, day, trip.dailyEnd);
      times[day] = [addVariable(start, start)];
      services[day] = [[]];
      const dayAssignments: number[] = [];
      trip.stops.forEach((stop) => {
        const allowed = stopAllowedOnDay(trip, stop, day);
        const assigned = addVariable(0, allowed ? 1 : 0, !coupled && stop.optional ? -100_000 * stop.priority : 0, true);
        if (stop.optional) optionalUtility.push([assigned, -stop.priority]);
        dayAssignments.push(assigned);
        assignments.set(stop.id, [...(assignments.get(stop.id) ?? []), assigned]);
        const choices = stop.fixedTime ? [stop.duration] : stop.durationOptions ?? [stop.duration];
        const service: [number, number][] = choices.length === 1 ? [[assigned, stop.duration]] : choices.map((duration) => {
          const column = addVariable(0, allowed ? 1 : 0, 0, true);
          if (duration < stop.duration) durationLoss.push([column, (stop.duration - duration) * stop.priority]);
          return [column, duration];
        });
        services[day].push(service);
        if (choices.length > 1) addRow([...service.map(([column]): [number, number] => [column, 1]), [assigned, -1]], 0, 0);
        const time = addVariable(0, 1500, 0.0001);
        times[day].push(time);
        const booking = stop.fixedTime && allowed ? minuteAt(trip, day, stop.fixedTime) : null;
        addRow([[time, 1], [assigned, -bigM]], (booking ?? start) - bigM, infinity);
        if (coupled) {
          addRow([[time, 1], ...service, [assigned, bigM]], -infinity, end + bigM);
          addRow([[time, 1], [assigned, -1500]], -infinity, 0);
          if (booking !== null) addRow([[time, 1], [assigned, bigM]], -infinity, booking + bigM);
        } else addRow([[time, 1], [assigned, bigM]], -infinity, Math.min(booking ?? end, end - stop.duration) + bigM);
      });
      times[day].push(addVariable(start, end, 0.001));
      const ids = [boundary?.startId ?? "hotel", ...trip.stops.map((stop) => stop.id), "hotel"];
      for (let from = 0; from < endNode; from++) {
        for (let to = 1; to <= endNode; to++) {
          if (from === to) continue;
          if (!allowsVisitPair(trip, ids[from], ids[to]) || (from > 0 && !stopAllowedOnDay(trip, trip.stops[from - 1], day)) || (to < endNode && !stopAllowedOnDay(trip, trip.stops[to - 1], day))) continue;
          const destination = to < endNode ? trip.stops[to - 1] : null;
          const synthetic = to === endNode && ((!boundary && from === 0) || !trip.returnToHotel);
          const edges: TravelEdge[] = synthetic
            ? [{ day, from: ids[from], to: "hotel", mode: "WALK", minutes: 0, meters: 0 }]
            : travel.filter((edge) => edge.day === day && edge.from === ids[from] && edge.to === ids[to] && allowsTravelEdge(trip, edge));
          for (const edge of edges) {
            if (!Number.isFinite(edge.minutes) || edge.minutes < 0 || edge.minutes > end - start || !Number.isFinite(edge.meters) || edge.meters < 0) continue;
            const column = addVariable(0, 1, edge.minutes + (edge.mode === "WALK" ? edge.meters * 0.00001 : 0), true);
            routes.push({ day, from, to, column, edge });
            const service = from === 0 ? 0 : trip.stops[from - 1].duration;
            const buffer = destination?.fixedTime ? destination.buffer : 0;
            if (coupled) addRow([[times[day][to], 1], [times[day][from], -1], ...services[day][from].map(([serviceColumn, duration]): [number, number] => [serviceColumn, -duration]), [column, -bigM]], edge.minutes + buffer - bigM, infinity);
            else addRow([[times[day][to], 1], [times[day][from], -1], [column, -bigM]], service + edge.minutes + buffer - bigM, infinity);
          }
        }
      }
      const dayRoutes = routes.filter((route) => route.day === day);
      addRow(dayAssignments.map((column) => [column, 1]), 0, preferences.maxStopsPerDay);
      if (peakLoad !== null) addRow([
        ...(coupled ? [...services[day].flat(), ...dayAssignments.map((column, index): [number, number] => [column, trip.stops[index].fixedTime ? trip.stops[index].buffer : 0])] : dayAssignments.map((column, index): [number, number] => [column, trip.stops[index].duration + (trip.stops[index].fixedTime ? trip.stops[index].buffer : 0)])),
        ...dayRoutes.map((route): [number, number] => [route.column, route.edge.minutes]),
        [peakLoad, -1],
      ], -infinity, 0);
      addRow(dayRoutes.filter((route) => route.from === 0).map((route) => [route.column, 1]), 1, 1);
      addRow(dayRoutes.filter((route) => route.to === endNode).map((route) => [route.column, 1]), 1, 1);
      for (let node = 1; node < endNode; node++) {
        addRow([...dayRoutes.filter((route) => route.to === node).map((route): [number, number] => [route.column, 1]), [dayAssignments[node - 1], -1]], 0, 0);
        addRow([...dayRoutes.filter((route) => route.from === node).map((route): [number, number] => [route.column, 1]), [dayAssignments[node - 1], -1]], 0, 0);
      }
    }
    for (const stop of trip.stops) addRow((assignments.get(stop.id) ?? []).map((column) => [column, 1]), stop.optional ? 0 : 1, 1);
    for (const group of trip.dayGroups ?? []) {
      const groupDays = Array.from({ length: trip.days }, (_, day) => {
        const active = addVariable(0, groupAllowedDays(trip, group).includes(day) ? 1 : 0, 0, true);
        const members: [number, number][] = [];
        for (const stop of trip.stops) {
          const assigned = assignments.get(stop.id)![day];
          if (group.stopIds.includes(stop.id)) {
            addRow([[assigned, 1], [active, -1]], -infinity, 0);
            members.push([assigned, -1]);
          } else if (group.exclusive) addRow([[assigned, 1], [active, 1]], -infinity, 1);
        }
        addRow([[active, 1], ...members], -infinity, 0);
        return active;
      });
      addRow(groupDays.map((column) => [column, 1]), group.stopIds.some((id) => !trip.stops.find((stop) => stop.id === id)!.optional) ? 1 : 0, 1);
      groupAssignments.set(group.id, groupDays);
    }
    const solveStarted = performance.now();
    const limit = Math.min(5, Math.max(0.01, seconds));
    let lastOptimal = false;
    let constructionMs = 0;
    let seeded = false;
    const run = (stage: SolverStage["stage"], timeLimit: number, objective?: SolverStage["objective"]) => {
      const started = performance.now();
      let firstSolutionMs: number | null = null;
      model.options.set("time_limit", timeLimit);
      model.run({ [highs.constants.callbackType.mipSolution]: () => { firstSolutionMs ??= Math.round(performance.now() - started); } });
      const feasible = model.info.get("primal_solution_status") === 2;
      lastOptimal = feasible && model.getModelStatus() === highs.constants.modelStatus.optimal && Number(model.info.get("mip_gap")) <= 0.000001;
      options.onStage?.({ stage, outcome: feasible ? "feasible" : model.getModelStatus() === highs.constants.modelStatus.infeasible ? "conflict" : "incomplete", elapsedMs: Math.round(performance.now() - started), firstSolutionMs, columns: columnCount, nodes: Number(model.info.get("mip_node_count")), constructionMs, seeded, ...(objective ? { engine: "highs", objective, optimal: lastOptimal, objectiveValue: feasible ? model.getObjectiveValue() : null } : {}) });
      return feasible ? Array.from(model.getSolution().colValue) : null;
    };
    const hintStarted = performance.now();
    const hint = options.initialSchedule && !validateSchedule(trip, options.initialSchedule, boundary).length ? options.initialSchedule : constructionHint(trip, travel, performance.now() + Math.min(400, limit * 100), boundary);
    constructionMs = Math.round(performance.now() - hintStarted);
    const seed = (schedule: Schedule): number[] | null => {
      const candidate = Array<number>(columnCount).fill(0);
      let peak = 0;
      for (const day of schedule.days) {
        candidate[times[day.day][0]] = boundary?.startMinute ?? minuteAt(trip, day.day, trip.dailyStart);
        let from = 0;
        let load = 0;
        for (const visit of day.visits) {
          const index = trip.stops.findIndex((stop) => stop.id === visit.stopId);
          const route = routes.find((route) => route.day === day.day && route.from === from && route.to === index + 1 && route.edge.mode === visit.leg.mode && route.edge.minutes === visit.leg.minutes && route.edge.meters === visit.leg.meters);
          if (!route) return null;
          candidate[route.column] = 1;
          candidate[assignments.get(visit.stopId)![day.day]] = 1;
          const service = services[day.day][index + 1].find(([, duration]) => Math.abs(duration - (visit.end - visit.start)) < 0.01);
          if (!service) return null;
          candidate[service[0]] = 1;
          candidate[times[day.day][index + 1]] = visit.start;
          load += visit.end - visit.start + route.edge.minutes + (trip.stops[index].fixedTime ? trip.stops[index].buffer : 0);
          from = index + 1;
        }
        const final = routes.find((route) => route.day === day.day && route.from === from && route.to === endNode && (!day.returnLeg || (route.edge.mode === day.returnLeg.mode && route.edge.minutes === day.returnLeg.minutes && route.edge.meters === day.returnLeg.meters)));
        if (!final) return null;
        candidate[final.column] = 1;
        candidate[times[day.day][endNode]] = (day.visits.at(-1)?.end ?? boundary?.startMinute ?? minuteAt(trip, day.day, trip.dailyStart)) + final.edge.minutes;
        peak = Math.max(peak, load + final.edge.minutes);
        for (const group of trip.dayGroups ?? []) if (day.visits.some((visit) => group.stopIds.includes(visit.stopId))) candidate[groupAssignments.get(group.id)![day.day]] = 1;
      }
      if (peakLoad !== null) candidate[peakLoad] = peak;
      return candidate;
    };
    let values: number[] | null = hint ? seed(hint) : null;
    seeded = values !== null;
    if (values) model.setSolution({ colValue: values });
    const optimization = { weightedDurationLoss: 0, durationOptimal: !durationLoss.length, optionalOptimal: !optionalUtility.length, travelOptimal: false };
    if (values && durationLoss.every(([column]) => values![column] < 0.5)) optimization.durationOptimal = true;
    if (coupled) {
      const tiers: { objective: NonNullable<SolverStage["objective"]>; entries: [number, number][]; lowerBound?: number }[] = [
        ...(durationLoss.length ? [{ objective: "duration" as const, entries: durationLoss, lowerBound: 0 }] : []),
        ...(optionalUtility.length ? [{ objective: "optional" as const, entries: optionalUtility, lowerBound: -trip.stops.filter((stop) => stop.optional).reduce((total, stop) => total + stop.priority, 0) }] : []),
        { objective: "travel", entries: costs.map((cost, column): [number, number] => [column, cost]).filter(([, cost]) => cost !== 0) },
      ];
      for (const [index, tier] of tiers.entries()) {
        const remaining = limit - (performance.now() - solveStarted) / 1000;
        if (remaining <= 0) break;
        costs.forEach((_, column) => model.changeColCost(column, 0));
        tier.entries.forEach(([column, cost]) => model.changeColCost(column, cost));
        model.options.set("mip_rel_gap", tier.objective === "travel" ? 0.02 : 0);
        if (values) model.setSolution({ colValue: values });
        let candidate = run("optimization", index === tiers.length - 1 ? remaining : remaining * 0.65, tier.objective);
        const extra = limit - (performance.now() - solveStarted) / 1000;
        if (!candidate && !values && extra > 0) candidate = run("optimization", extra, tier.objective);
        if (!candidate) break;
        values = candidate;
        const objectiveValue = tier.entries.reduce((total, [column, cost]) => total + values![column] * cost, 0);
        const optimal = lastOptimal || (tier.lowerBound !== undefined && Math.abs(objectiveValue - tier.lowerBound) < 0.000001);
        if (tier.objective === "duration") optimization.durationOptimal = optimal;
        if (tier.objective === "optional") optimization.optionalOptimal = optimal;
        if (tier.objective === "travel") optimization.travelOptimal = optimal;
        if (!optimal) break;
        if (tier.objective !== "travel") addRow(tier.entries, Math.round(objectiveValue), Math.round(objectiveValue));
      }
    } else if (options.strategy === "feasibility-first") {
      costs.forEach((_, column) => model.changeColCost(column, 0));
      values = run("feasibility", Math.min(1, limit / 2));
      costs.forEach((cost, column) => model.changeColCost(column, cost));
      if (values) model.setSolution({ colValue: values });
    }
    const remaining = limit - (performance.now() - solveStarted) / 1000;
    if (!coupled && remaining > 0) values = run("optimization", remaining) ?? values;
    if (!values) {
      const conflict = model.getModelStatus() === highs.constants.modelStatus.infeasible;
      const issues = conflict ? bookingConflicts(trip) : [];
      if (issues.length) throw new PlanningError(`No schedule fits these bookings. ${issues.slice(0, 5).join(" ")}${issues.length > 5 ? ` (${issues.length - 5} more)` : ""} Change or clear those booked times.`, "conflict", true, "hard-input-conflict");
      const routeIssues = conflict && !boundary ? bookingRouteConflicts(trip, travel) : [];
      if (routeIssues.length) throw new PlanningError(`No schedule fits these bookings and sampled routes. ${routeIssues.slice(0, 5).join(" ")}${routeIssues.length > 5 ? ` (${routeIssues.length - 5} more)` : ""} Change booked times or mark flexible visits as Any time slot.`, "conflict");
      const routeGaps = conflict && !boundary ? sampledRouteGaps(trip, travel) : [];
      if (routeGaps.length) throw new PlanningError(`No schedule fits the sampled route connections. ${routeGaps.slice(0, 5).join(" ")}${routeGaps.length > 5 ? ` (${routeGaps.length - 5} more)` : ""} Check map locations, transport preferences, and daily hours. Changing visit times alone cannot supply a missing route.`, "incomplete", false, "missing-data");
      throw new PlanningError(conflict ? "No schedule fits these bookings and available routes. Adjust the daily hours, visit durations, or required stops." : "The planning time limit was reached without a feasible schedule. Try fewer stops or assign some sights to a day.", conflict ? "conflict" : "incomplete");
    }
    const selected = routes.filter((route) => values[route.column] > 0.5);
    const visited = new Set<string>();
    const schedule: Schedule = { days: [], omitted: [], warnings: [], generatedAt: new Date().toISOString() };
    if (coupled) {
      optimization.weightedDurationLoss = Math.round(durationLoss.reduce((total, [column, loss]) => total + values[column] * loss, 0));
      schedule.optimization = optimization;
      if (!optimization.durationOptimal) schedule.warnings.push("A feasible candidate was found, but minimum duration loss was not proven within the search budget.");
    }
    for (let day = 0; day < trip.days; day++) {
      const dayPlan: Schedule["days"][number] = { day, date: tripDate(trip, day), visits: [] };
      let node = 0;
      for (let count = 0; count <= trip.stops.length; count++) {
        const route = selected.find((candidate) => candidate.day === day && candidate.from === node);
        if (!route) throw new PlanningError("The optimizer returned a disconnected route.");
        if (route.to === endNode) {
          if ((node !== 0 || boundary) && trip.returnToHotel) dayPlan.returnLeg = route.edge;
          break;
        }
        const stop = trip.stops[route.to - 1];
        const start = Math.round(values[times[day][route.to]] * 1000) / 1000;
        const duration = coupled ? Math.round(services[day][route.to].reduce((total, [column, minutes]) => total + values[column] * minutes, 0)) : stop.duration;
        dayPlan.visits.push({ stopId: stop.id, start, end: start + duration, leg: route.edge });
        visited.add(stop.id);
        node = route.to;
      }
      schedule.days.push(dayPlan);
    }
    schedule.omitted = trip.stops.filter((stop) => !visited.has(stop.id)).map((stop) => stop.id);
    const errors = validateSchedule(trip, schedule, boundary);
    if (errors.length) throw new PlanningError(errors.join(" "));
    return schedule;
  } finally {
    model.dispose();
  }
}