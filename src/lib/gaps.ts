import { dayStart, minuteAt, type DayPlan, type Place, type Schedule, type Trip } from "./trip";
import { earlyCafeMinutes, mealCover, mealWindowsToCover, morningCafe, morningCafeDay } from "./visit-slots";

// Meals a day's plan leaves out: breakfast on a morning day that doesn't start at a café, by 11:00, and lunch or dinner where
// the planner would look for one and found none. Each says when it would be (the city's minutes, as visits keep them)
// and where you'd be then, to look for somewhere nearby: the hotel before the day's first ride and after the last, and
// otherwise the visit you're at or have just left. `after` is the visit the meal comes after, or null for the start of
// the day. A meal place pinned to the day since the plan was made fills its gap.
export type RoutineMeal = "breakfast" | "lunch" | "dinner";
export type RoutineGap = { day: number; date: string; meal: RoutineMeal; start: number; end: number; near: string; nearName: string; location?: { lat: number; lng: number }; after: string | null };
export const mealMinutes: Record<RoutineMeal, number> = { breakfast: 45, lunch: 60, dinner: 75 };
export const mealTitles: Record<RoutineMeal, string> = { breakfast: "No breakfast planned", lunch: "No lunch planned", dinner: "No dinner planned" };

const fiveMinutes = (minute: number) => Math.round(minute / 5) * 5;

export function routineGaps(trip: Trip, schedule: Pick<Schedule, "days">, places: Record<string, Place>): RoutineGap[] {
  return schedule.days.flatMap((plan) => dayGaps(trip, plan, places));
}

function dayGaps(trip: Trip, plan: DayPlan, places: Record<string, Place>): RoutineGap[] {
  const visits = [...plan.visits].sort((left, right) => left.start - right.start);
  if (!visits.length) return [];
  const day = plan.day;
  const stop = (id: string) => trip.stops.find((candidate) => candidate.id === id);
  const added = trip.stops.filter((candidate) => candidate.day === day && !visits.some((visit) => visit.stopId === candidate.id));
  const [first, last] = [visits[0], visits.at(-1)!];
  const where = (near: string) => near === "hotel"
    ? { near, nearName: trip.hotel || "the hotel", location: places.hotel?.location }
    : { near, nearName: stop(near)?.name ?? places[near]?.name ?? "the visit", location: places[near]?.location ?? stop(near)?.location };
  const gaps: RoutineGap[] = [];

  const firstStop = stop(first.stopId);
  const leave = first.start - first.leg.minutes;
  if (!(day === 0 && trip.arrival) && morningCafeDay(trip, day) && !(firstStop && morningCafe(trip, firstStop, places[firstStop.id]))
    && !added.some((candidate) => morningCafe(trip, candidate, places[candidate.id])) && leave - mealMinutes.breakfast >= dayStart(trip, day) - earlyCafeMinutes
    && leave - mealMinutes.breakfast <= minuteAt(trip, day, "11:00")) {
    const start = Math.floor((leave - mealMinutes.breakfast) / 5) * 5;
    gaps.push({ day, date: plan.date, meal: "breakfast", start, end: start + mealMinutes.breakfast, ...where("hotel"), after: null });
  }

  for (const window of mealWindowsToCover(trip, day)) {
    const covers = (candidate: ReturnType<typeof stop>) => { const cover = candidate && mealCover(trip, candidate, places[candidate.id]); return cover === window.meal || cover === "either"; };
    if (visits.some((visit) => visit.start >= window.start - 30 && visit.start <= window.end && covers(stop(visit.stopId))) || added.some(covers)) continue;
    const middle = (window.start + window.end) / 2;
    const start = fiveMinutes(middle - mealMinutes[window.meal] / 2);
    const at = visits.find((visit) => visit.start <= middle && middle <= visit.end);
    const before = visits.findLast((visit) => visit.end <= middle);
    const near = at ? at.stopId
      : !before ? (middle < leave ? "hotel" : first.stopId)
      : before === last && plan.returnLeg && middle >= last.end + plan.returnLeg.minutes ? "hotel" : before.stopId;
    gaps.push({ day, date: plan.date, meal: window.meal, start, end: start + mealMinutes[window.meal], ...where(near), after: visits.findLast((visit) => visit.start <= start)?.stopId ?? null });
  }
  return gaps;
}
