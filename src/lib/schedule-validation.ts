import { minuteAt, tripDate, type Schedule, type Trip } from "./trip";

export function validateSchedule(trip: Trip, schedule: Schedule): string[] {
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
    if (day.date !== tripDate(trip, day.day)) errors.push("A sightseeing date changed.");
    let previousEnd = minuteAt(trip, day.day, trip.dailyStart);
    let previousId = "hotel";
    const dayEnd = minuteAt(trip, day.day, trip.dailyEnd);
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
      if (stop.mode !== "AUTO" && stop.mode !== visit.leg.mode) errors.push(`${stop.name}: transport choice changed.`);
      if (stop.day !== null && stop.day !== day.day) errors.push(`${stop.name}: assigned day changed.`);
      const buffer = stop.fixedTime ? stop.buffer : 0;
      if (visit.start + 0.01 < previousEnd + duration + buffer) errors.push(`${stop.name}: not enough time to arrive.`);
      if (stop.fixedTime && Math.abs(visit.start - minuteAt(trip, day.day, stop.fixedTime)) > 0.01) errors.push(`${stop.name}: booking time changed.`);
      if (Math.abs(visit.end - visit.start - stop.duration) > 0.01) errors.push(`${stop.name}: visit duration changed.`);
      if (visit.end > dayEnd + 0.01) errors.push(`${stop.name}: outside sightseeing hours.`);
      previousEnd = visit.end;
      previousId = stop.id;
    }
    if (day.visits.length && trip.returnToHotel) {
      const leg = day.returnLeg;
      if (!leg || leg.from !== previousId || leg.to !== "hotel" || leg.day !== day.day || !Number.isFinite(leg.minutes) || leg.minutes < 0 || previousEnd + leg.minutes > dayEnd + 0.01) {
        errors.push(`Day ${day.day + 1}: no timely return to the hotel.`);
      }
    }
  }
  if (seenDays.size !== trip.days) errors.push("Missing sightseeing day.");
  const omitted = new Set(schedule.omitted);
  if (omitted.size !== schedule.omitted.length) errors.push("Repeated omitted stop.");
  for (const stop of trip.stops) {
    if (!seen.has(stop.id) && !stop.optional) errors.push(`${stop.name}: required stop is missing.`);
    if (!seen.has(stop.id) && !omitted.has(stop.id)) errors.push(`${stop.name}: omission is not explained.`);
    if (seen.has(stop.id) && omitted.has(stop.id)) errors.push(`${stop.name}: both scheduled and omitted.`);
  }
  for (const stopId of omitted) if (!stops.has(stopId)) errors.push("Unknown omitted stop.");
  return errors;
}