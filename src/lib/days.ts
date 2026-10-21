import { bookingConflicts, PlanningError, planningEngine } from "./planner";
import { dayEnd, dayStart, minuteAt, planningPreferences, type Place, type Stop, type Trip } from "./trip";
import { alternativeGroups, capCategory, dailyCaps, isRequiredStop, mealCover, mealWindowsToCover, morningCafe, morningCafeDay, visitHours, type CapCategory } from "./visit-slots";

export async function assignDays(input: Trip, locations: Record<string, Place["location"]>, places: Record<string, Place> = {}): Promise<Trip> {
  const conflicts = bookingConflicts(input);
  if (conflicts.length) throw new PlanningError(conflicts.join(" "), "conflict", true);
  const ordered = [...input.stops].sort((left, right) => locations[left.id].lng - locations[right.id].lng || locations[left.id].lat - locations[right.id].lat);
  const centers = Array.from({ length: input.days }, (_, day) => {
    const assigned = input.stops.filter((stop) => stop.day === day);
    const points = assigned.length ? assigned.map((stop) => locations[stop.id]) : [locations[ordered[Math.min(ordered.length - 1, Math.floor((day + 0.5) * ordered.length / input.days))]?.id] ?? locations.hotel];
    return { lat: points.reduce((total, point) => total + point.lat, 0) / points.length, lng: points.reduce((total, point) => total + point.lng, 0) / points.length };
  });
  const alternatives = alternativeGroups(input);
  const highs = await planningEngine();
  const model = highs.createModel();
  const choices: { stop: Stop; day: number; window: number; column: number }[] = [];
  const windows: { day: number; minutes: number }[] = [];
  const booked = input.stops.filter((stop) => stop.fixedTime);
  const bookedLoad = Array.from({ length: input.days }, () => 0);
  let columns = 0;
  const addRow = (entries: [number, number][], lower: number, upper: number) => model.addRow(lower, upper, { indices: entries.map(([column]) => column), values: entries.map(([, value]) => value) });
  try {
    model.options.set({ output_flag: false, time_limit: 2, mip_rel_gap: 0.02 });
    model.addVar(0, highs.infinity);
    model.changeColCost(columns++, 1);
    for (let day = 0; day < input.days; day++) {
      let cursor = dayStart(input, day);
      for (const stop of booked.filter((stop) => stop.day === day).sort((left, right) => left.fixedTime!.localeCompare(right.fixedTime!))) {
        const at = minuteAt(input, day, stop.fixedTime!);
        windows.push({ day, minutes: Math.max(0, at - stop.buffer - cursor) });
        cursor = at + stop.duration;
        bookedLoad[day] += stop.duration + stop.buffer;
      }
      windows.push({ day, minutes: Math.max(0, dayEnd(input, day) - cursor) });
    }
    for (const stop of input.stops.filter((stop) => !stop.fixedTime)) {
      windows.forEach((window, index) => {
        if ((stop.day !== null && stop.day !== window.day) || stop.duration > window.minutes || visitHours(input, window.day, stop, places[stop.id])?.length === 0) return;
        const point = locations[stop.id];
        const center = centers[window.day];
        const distance = Math.hypot((point.lng - center.lng) * Math.cos(center.lat * Math.PI / 180), point.lat - center.lat) * 111;
        model.addVar(0, 1);
        model.changeColIntegrality(columns, highs.constants.variableType.integer);
        model.changeColCost(columns, Math.min(distance, 1000) + (isRequiredStop(stop, alternatives) ? 0 : -1_000_000 * stop.priority));
        choices.push({ stop, day: window.day, window: index, column: columns++ });
      });
      addRow(choices.filter((choice) => choice.stop.id === stop.id).map((choice) => [choice.column, 1]), isRequiredStop(stop, alternatives) ? 1 : 0, 1);
    }
    for (const group of alternatives) if (group.required && !group.stopIds.some((id) => input.stops.find((stop) => stop.id === id)?.fixedTime)) addRow(choices.filter((choice) => group.stopIds.includes(choice.stop.id)).map((choice) => [choice.column, 1]), 1, highs.infinity);
    windows.forEach((window, index) => addRow(choices.filter((choice) => choice.window === index).map((choice) => [choice.column, choice.stop.duration]), 0, window.minutes));
    for (let day = 0; day < input.days; day++) {
      const dayChoices = choices.filter((choice) => choice.day === day);
      addRow(dayChoices.map((choice) => [choice.column, 1]), 0, planningPreferences(input).maxStopsPerDay - booked.filter((stop) => stop.day === day).length);
      addRow([...dayChoices.map((choice): [number, number] => [choice.column, choice.stop.duration]), [0, -1]], -highs.infinity, -bookedLoad[day]);
      // Spread meals and coffee across days; exceeding a cap is allowed but costs more than an optional visit is worth.
      for (const category of Object.keys(dailyCaps) as CapCategory[]) {
        const members = dayChoices.filter((choice) => capCategory(input, choice.stop, places[choice.stop.id]) === category);
        const booked = input.stops.filter((stop) => stop.fixedTime && stop.day === day && capCategory(input, stop, places[stop.id]) === category).length;
        if (members.length + booked <= dailyCaps[category]) continue;
        model.addVar(0, highs.infinity);
        model.changeColCost(columns, 2_000_000);
        addRow([...members.map((choice): [number, number] => [choice.column, 1]), [columns++, -1]], -highs.infinity, dailyCaps[category] - booked);
      }
      // A café for each morning and a lunch and dinner for each day that takes them in, from the trip's own places;
      // missing one costs more than a long way across town.
      const cover = (members: typeof dayChoices, cost: number) => {
        if (!members.length) return;
        model.addVar(0, 1);
        model.changeColCost(columns, cost);
        addRow([...members.map((choice): [number, number] => [choice.column, 1]), [columns++, 1]], 1, highs.infinity);
      };
      if (morningCafeDay(input, day) && !input.stops.some((stop) => stop.fixedTime && stop.day === day && morningCafe(input, stop, places[stop.id]))) cover(dayChoices.filter((choice) => morningCafe(input, choice.stop, places[choice.stop.id])), 200);
      for (const { meal } of mealWindowsToCover(input, day)) cover(dayChoices.filter((choice) => { const covers = mealCover(input, choice.stop, places[choice.stop.id]); return covers === meal || covers === "either"; }), 60);
    }
    model.run();
    if (model.info.get("primal_solution_status") !== 2) throw new PlanningError("Could not assign visits around the bookings and daily limits. Reduce required visits, shorten durations, or extend the daily hours.");
    const values = model.getSolution().colValue;
    const selected = new Map(choices.filter((choice) => values[choice.column] > 0.5).map((choice) => [choice.stop.id, choice.day]));
    return { ...input, stops: input.stops.flatMap((stop) => stop.fixedTime ? [{ ...stop }] : selected.has(stop.id) ? [{ ...stop, day: selected.get(stop.id)! }] : []) };
  } finally { model.dispose(); }
}