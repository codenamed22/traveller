import loadHighs from "highs";
import { allowsTravelEdge, minuteAt, planningPreferences, tripDate, tripSchema, type Schedule, type TravelEdge, type Trip } from "./trip";
import { validateSchedule } from "./schedule-validation";

let engine: ReturnType<typeof loadHighs> | undefined;

export class PlanningError extends Error {
  constructor(message: string, public readonly reason: "conflict" | "incomplete" = "incomplete", public readonly detailed = false) {
    super(message);
    this.name = "PlanningError";
  }
}

// Lower bound: uses the fastest known leg, or none when the route is unknown.
export function bookingConflicts(trip: Trip, travel: TravelEdge[]) {
  const issues: string[] = [];
  for (let day = 0; day < trip.days; day++) {
    const start = minuteAt(trip, day, trip.dailyStart);
    const end = minuteAt(trip, day, trip.dailyEnd);
    const booked = trip.stops.filter((stop) => stop.day === day && stop.fixedTime).map((stop) => ({ stop, at: minuteAt(trip, day, stop.fixedTime!) })).sort((left, right) => left.at - right.at);
    for (const { stop, at } of booked) {
      if (at < start) issues.push(`Day ${day + 1}: ${stop.name} is booked at ${stop.fixedTime}, before the day starts.`);
      else if (at + stop.duration > end) issues.push(`Day ${day + 1}: ${stop.name} (${stop.fixedTime}, ${stop.duration} min) ends after the day ends.`);
    }
    booked.slice(1).forEach(({ stop, at }, index) => {
      const previous = booked[index];
      const legs = travel.filter((edge) => edge.day === day && edge.from === previous.stop.id && edge.to === stop.id).map((edge) => edge.minutes);
      const needed = previous.stop.duration + stop.buffer + (legs.length ? Math.min(...legs) : 0);
      if (at - previous.at < needed) issues.push(`Day ${day + 1}: ${previous.stop.name} (${previous.stop.fixedTime}) and ${stop.name} (${stop.fixedTime}) are too close; ${needed} min needed, ${Math.round(at - previous.at)} available.`);
    });
  }
  return issues;
}

export async function solveTrip(input: Trip, travel: TravelEdge[], seconds = 5): Promise<Schedule> {
  const trip = tripSchema.parse(input);
  const highs = await (engine ??= loadHighs());
  const model = highs.createModel();
  let columnCount = 0;
  const assignments = new Map<string, number[]>();
  const routes: { day: number; from: number; to: number; column: number; edge: TravelEdge }[] = [];
  const times: number[][] = [];
  const bigM = 4000;
  const infinity = highs.infinity;
  const endNode = trip.stops.length + 1;
  const addVariable = (lower: number, upper: number, cost = 0, integer = false) => {
    const column = columnCount++;
    model.addVar(lower, upper);
    model.changeColCost(column, cost);
    if (integer) model.changeColIntegrality(column, highs.constants.variableType.integer);
    return column;
  };
  const addRow = (entries: [number, number][], lower: number, upper: number) => {
    model.addRow(lower, upper, { indices: entries.map(([column]) => column), values: entries.map(([, value]) => value) });
  };
  try {
    model.options.set({ output_flag: false, time_limit: Math.min(5, Math.max(0.01, seconds)), mip_rel_gap: 0.02 });
    const preferences = planningPreferences(trip);
    const peakLoad = preferences.goal === "BALANCED" ? addVariable(0, infinity, 1) : null;
    for (let day = 0; day < trip.days; day++) {
      const start = minuteAt(trip, day, trip.dailyStart);
      const end = minuteAt(trip, day, trip.dailyEnd);
      times[day] = [addVariable(start, start)];
      const dayAssignments: number[] = [];
      trip.stops.forEach((stop) => {
        const allowed = stop.day === null || stop.day === day;
        const assigned = addVariable(0, allowed ? 1 : 0, stop.optional ? -100_000 * stop.priority : 0, true);
        dayAssignments.push(assigned);
        assignments.set(stop.id, [...(assignments.get(stop.id) ?? []), assigned]);
        const time = addVariable(0, 1500, 0.0001);
        times[day].push(time);
        const booking = stop.fixedTime && allowed ? minuteAt(trip, day, stop.fixedTime) : null;
        addRow([[time, 1], [assigned, -bigM]], (booking ?? start) - bigM, infinity);
        addRow([[time, 1], [assigned, bigM]], -infinity, Math.min(booking ?? end, end - stop.duration) + bigM);
      });
      times[day].push(addVariable(start, end, 0.001));
      const ids = ["hotel", ...trip.stops.map((stop) => stop.id), "hotel"];
      for (let from = 0; from < endNode; from++) {
        for (let to = 1; to <= endNode; to++) {
          if (from === to) continue;
          const destination = to < endNode ? trip.stops[to - 1] : null;
          const synthetic = to === endNode && (from === 0 || !trip.returnToHotel);
          const edges: TravelEdge[] = synthetic
            ? [{ day, from: ids[from], to: "hotel", mode: "WALK", minutes: 0, meters: 0 }]
            : travel.filter((edge) => edge.day === day && edge.from === ids[from] && edge.to === ids[to] && allowsTravelEdge(trip, edge));
          for (const edge of edges) {
            if (!Number.isFinite(edge.minutes) || edge.minutes < 0 || edge.minutes > end - start || !Number.isFinite(edge.meters) || edge.meters < 0) continue;
            const column = addVariable(0, 1, edge.minutes + (edge.mode === "WALK" ? edge.meters * 0.00001 : 0), true);
            routes.push({ day, from, to, column, edge });
            const service = from === 0 ? 0 : trip.stops[from - 1].duration;
            const buffer = destination?.fixedTime ? destination.buffer : 0;
            addRow([[times[day][to], 1], [times[day][from], -1], [column, -bigM]], service + edge.minutes + buffer - bigM, infinity);
          }
        }
      }
      const dayRoutes = routes.filter((route) => route.day === day);
      addRow(dayAssignments.map((column) => [column, 1]), 0, preferences.maxStopsPerDay);
      if (peakLoad !== null) addRow([
        ...dayAssignments.map((column, index): [number, number] => [column, trip.stops[index].duration + (trip.stops[index].fixedTime ? trip.stops[index].buffer : 0)]),
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
    model.run();
    if (model.info.get("primal_solution_status") !== 2) {
      const conflict = model.getModelStatus() === highs.constants.modelStatus.infeasible;
      const issues = conflict ? bookingConflicts(trip, travel) : [];
      if (issues.length) throw new PlanningError(`No schedule fits these bookings. ${issues.slice(0, 5).join(" ")}${issues.length > 5 ? ` (${issues.length - 5} more)` : ""} Change or clear those booked times.`, "conflict", true);
      throw new PlanningError(conflict ? "No schedule fits these bookings and available routes. Adjust the daily hours, visit durations, or required stops." : "The planning time limit was reached without a feasible schedule. Try fewer stops or assign some sights to a day.", conflict ? "conflict" : "incomplete");
    }
    const values = model.getSolution().colValue;
    const selected = routes.filter((route) => values[route.column] > 0.5);
    const visited = new Set<string>();
    const schedule: Schedule = { days: [], omitted: [], warnings: [], generatedAt: new Date().toISOString() };
    for (let day = 0; day < trip.days; day++) {
      const dayPlan: Schedule["days"][number] = { day, date: tripDate(trip, day), visits: [] };
      let node = 0;
      for (let count = 0; count <= trip.stops.length; count++) {
        const route = selected.find((candidate) => candidate.day === day && candidate.from === node);
        if (!route) throw new PlanningError("The optimizer returned a disconnected route.");
        if (route.to === endNode) {
          if (node !== 0 && trip.returnToHotel) dayPlan.returnLeg = route.edge;
          break;
        }
        const stop = trip.stops[route.to - 1];
        const start = Math.round(values[times[day][route.to]] * 1000) / 1000;
        dayPlan.visits.push({ stopId: stop.id, start, end: start + stop.duration, leg: route.edge });
        visited.add(stop.id);
        node = route.to;
      }
      schedule.days.push(dayPlan);
    }
    schedule.omitted = trip.stops.filter((stop) => !visited.has(stop.id)).map((stop) => stop.id);
    const errors = validateSchedule(trip, schedule);
    if (errors.length) throw new PlanningError(errors.join(" "));
    return schedule;
  } finally {
    model.dispose();
  }
}