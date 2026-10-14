import { allowsTravelEdge, dayEnd, dayStart, groupAllowedDays, minuteAt, planningPreferences, returnDeadline, tripDate, type Schedule, type Trip } from "./trip";
import { alternativeGroups, isRequiredStop } from "./visit-slots";

export type ScheduleBoundary = { startId: string; startMinute: number };

export function validateSchedule(trip: Trip, schedule: Schedule, boundary?: ScheduleBoundary): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const seenDays = new Set<number>();
  const stops = new Map(trip.stops.map((stop) => [stop.id, stop]));
  for (const day of schedule.days) {
    if (day.day < 0 || day.day >= trip.days || seenDays.has(day.day)) {
      errors.push("Invalid or repeated sightseeing day.");
      continue;
    }
    seenDays.add(day.day);
    if (day.visits.length > planningPreferences(trip).maxStopsPerDay) errors.push(`Day ${day.day + 1}: too many places.`);
    if (day.date !== tripDate(trip, day.day)) errors.push("A sightseeing date changed.");
    let previousEnd = boundary?.startMinute ?? dayStart(trip, day.day);
    let previousId = boundary?.startId ?? "hotel";
    const lastEnd = dayEnd(trip, day.day);
    for (const visit of day.visits) {
      const stop = stops.get(visit.stopId);
      if (!stop || seen.has(visit.stopId)) { errors.push("Unknown or repeated stop."); continue; }
      seen.add(stop.id);
      const duration = visit.leg.minutes;
      if (!Number.isFinite(duration) || duration < 0 || !Number.isFinite(visit.start) || !Number.isFinite(visit.end)) {
        errors.push(`${stop.name}: invalid travel or visit time.`);
        continue;
      }
      if (visit.leg.day !== day.day || visit.leg.from !== previousId || visit.leg.to !== stop.id) errors.push(`${stop.name}: disconnected travel leg.`);
      if (!allowsTravelEdge(trip, visit.leg)) errors.push(`${stop.name}: transport choice or walking limit changed.`);
      if (stop.day !== null && stop.day !== day.day) errors.push(`${stop.name}: assigned day changed.`);
      const buffer = stop.fixedTime ? stop.buffer : 0;
      if (visit.start + 0.01 < previousEnd + duration + buffer) errors.push(`${stop.name}: not enough time to arrive.`);
      if (stop.fixedTime && Math.abs(visit.start - minuteAt(trip, day.day, stop.fixedTime)) > 0.01) errors.push(`${stop.name}: booking time changed.`);
      if (!(stop.fixedTime ? [stop.duration] : stop.durationOptions ?? [stop.duration]).some((allowed) => Math.abs(visit.end - visit.start - allowed) <= 0.01)) errors.push(`${stop.name}: visit duration changed beyond the approved choices.`);
      if (visit.end > lastEnd + 0.01) errors.push(`${stop.name}: outside sightseeing hours.`);
      previousEnd = visit.end;
      previousId = stop.id;
    }
    if ((day.visits.length || boundary) && trip.returnToHotel) {
      const leg = day.returnLeg;
      if (!leg || leg.from !== previousId || leg.to !== "hotel" || leg.day !== day.day || !Number.isFinite(leg.minutes) || leg.minutes < 0 || previousEnd + leg.minutes > returnDeadline(trip, day.day) + 0.01) {
        errors.push(`Day ${day.day + 1}: no timely return to the hotel.`);
      }
      if (leg && !allowsTravelEdge(trip, leg)) errors.push(`Day ${day.day + 1}: hotel return violates transport preferences.`);
    }
  }
  for (const group of trip.dayGroups ?? []) {
    const days = schedule.days.filter((day) => day.visits.some((visit) => group.stopIds.includes(visit.stopId)));
    if (days.length > 1) errors.push(`${group.name}: grouped visits must stay on one day.`);
    for (const day of days) {
      if (!groupAllowedDays(trip, group).includes(day.day)) errors.push(`${group.name}: group is outside its allowed days.`);
      if (group.exclusive && day.visits.some((visit) => !group.stopIds.includes(visit.stopId))) errors.push(`${group.name}: this day is reserved for the group.`);
      if (splitVisits(day.visits, group.stopIds)) errors.push(`${group.name}: visit the group's places in one go, not split by other visits.`);
    }
  }
  if (seenDays.size !== trip.days) errors.push("Missing sightseeing day.");
  const alternatives = alternativeGroups(trip);
  for (const group of alternatives) {
    if (group.required && !group.stopIds.some((id) => seen.has(id))) errors.push(`${group.stopIds.map((id) => stops.get(id)!.name).join(" / ")}: plan at least one of these alternatives.`);
  }
  const omitted = new Set(schedule.omitted);
  if (omitted.size !== schedule.omitted.length) errors.push("Repeated omitted stop.");
  for (const stop of trip.stops) {
    if (!seen.has(stop.id) && isRequiredStop(stop, alternatives)) errors.push(`${stop.name}: required stop is missing.`);
    if (!seen.has(stop.id) && !omitted.has(stop.id)) errors.push(`${stop.name}: omission is not explained.`);
    if (seen.has(stop.id) && omitted.has(stop.id)) errors.push(`${stop.name}: both scheduled and omitted.`);
  }
  for (const stopId of omitted) if (!stops.has(stopId)) errors.push("Unknown omitted stop.");
  return errors;
}

// Whether a day's visits to `ids` are interrupted by other visits (a day trip should be one outing).
export function splitVisits(visits: { stopId: string }[], ids: string[]) {
  const positions = visits.flatMap((visit, index) => ids.includes(visit.stopId) ? [index] : []);
  return positions.length > 1 && positions.at(-1)! - positions[0] + 1 !== positions.length;
}
