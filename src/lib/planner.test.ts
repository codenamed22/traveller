import { describe, expect, it, vi } from "vitest";
import { blockedDayFixes, bookingConflicts, commonHoliday, compactWaits, PlanningError, squeezeIns, solveTrip, solveTripByDays, travelEstimator, type SolverStage } from "./planner";
import { applyPlanningFixes, bookingConflictDetails, bookingTimeSuggestion, minuteAt, squeezeInNote, tripDate, newStop, newTrip, planningPreferences, resolvePlanningConstraints, type Trip, type TravelEdge } from "./trip";
import { splitVisits, validateSchedule } from "./schedule-validation";
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
    const trip = { ...fixture(), days: 1, dailyEnd: "11:14", stops: [required, optional] };
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
  it("puts meals in their time slots even when travel favours the opposite order", async () => {
    const dinner = { ...newStop("Bouillon d'Amsterdam"), source: "Dinner: Bouillon d'Amsterdam for a budget French bistro main (€12)." };
    const lunch = { ...newStop("Taco Lindo West"), source: "Lunch: Viral, authentic tacos at Taco Lindo West (€10)." };
    const museum = newStop("Museum");
    const trip = { ...fixture(), days: 1, dailyStart: "08:00", dailyEnd: "22:00", returnToHotel: false, stops: [dinner, lunch, museum] };
    const travel = routes(trip).map((edge) => edge.from === lunch.id && edge.to === dinner.id ? { ...edge, minutes: 100 } : edge);
    const schedule = await solveTrip(trip, travel, 3);
    expect(validateSchedule(trip, schedule)).toEqual([]);
    const start = (id: string) => schedule.days[0].visits.find((visit) => visit.stopId === id)!.start;
    expect(start(lunch.id)).toBeGreaterThanOrEqual(11 * 60 + 45);
    expect(start(lunch.id)).toBeLessThanOrEqual(14 * 60);
    expect(start(dinner.id)).toBeGreaterThanOrEqual(18 * 60);
    expect(start(dinner.id)).toBeLessThanOrEqual(20 * 60 + 30);
    expect(schedule.warnings.join(" ")).not.toContain("Outside preferred time");

    const short = { ...trip, dailyEnd: "17:00", stops: [dinner] };
    const late = await solveTrip(short, routes(short), 2);
    expect(late.days[0].visits[0].end).toBe(17 * 60);
    expect(late.warnings.join(" ")).toContain("Outside preferred time: Bouillon d'Amsterdam (Dinner 18:00–20:30, planned 16:15)");
  });
  it("replays the saved Amsterdam day: dinner after the booked cruise and itinerary times kept", async () => {
    const stop = (name: string, source: string, patch = {}) => ({ ...newStop(name), source, ...patch });
    const roti = "Grab a massive Surinamese roti at Roopram Roti or fresh stroopwafels at the Albert Cuyp Market (€12).";
    const stops = [
      stop("Dam Square", "Walk Damrak to Dam Square.", { duration: 30 }),
      stop("De Poezenboot", "Visit the free Cat Boat (De Poezenboot) (Free/€2 donation).", { duration: 15 }),
      stop("De Pijp", "Tram to De Pijp (€3).", { duration: 30 }),
      stop("Roopram Roti", roti, { duration: 60 }), stop("Albert Cuyp Market", roti, { duration: 45 }),
      stop("Bouillon d'Amsterdam", "Dinner: Bouillon d'Amsterdam for a budget French bistro main (€12)."),
      stop("Amsterdam Light Festival Canal Cruise", "Walk 12 mins to Dam/Rokin canal dock for the Amsterdam Light Festival Canal Cruise (75 mins)", { day: 0, fixedTime: "18:15", duration: 75 }),
      stop("Sango Specialty Coffee", "14:45 – 15:30 | Sango Specialty Coffee Coffee: Sango pour-over (€6)."),
      stop("The Begijnhof", "16:20 – 16:50 | The Begijnhof Walk 5 mins to the hidden 14th-century Begijnhof courtyard (20 mins)", { duration: 30 }),
      stop("Toki Specialty Coffee", "17:50 – 18:35 | Toki Specialty Coffee Walk 8 mins into Jordaan for coffee at Toki (45 mins)"),
    ];
    const trip: Trip = { ...newTrip(), city: "Amsterdam", hotel: "Hotel", startDate: "2026-12-24", timeZone: "Europe/Amsterdam", days: 1, dailyStart: "08:00", dailyEnd: "21:00", returnToHotel: true, stops };
    const schedule = await solveTrip(trip, routes(trip, 10), 4);
    expect(validateSchedule(trip, schedule)).toEqual([]);
    const start = (name: string) => schedule.days[0].visits.find((visit) => visit.stopId === stops.find((entry) => entry.name === name)!.id)?.start;
    expect(start("Bouillon d'Amsterdam")).toBeGreaterThanOrEqual(19 * 60 + 30);
    expect(start("Sango Specialty Coffee")).toBeGreaterThanOrEqual(13 * 60 + 45);
    expect(start("Sango Specialty Coffee")).toBeLessThanOrEqual(15 * 60 + 45);
    expect(start("The Begijnhof")).toBeGreaterThanOrEqual(15 * 60 + 20);
    expect(schedule.days[0].visits[0].stopId).not.toBe(stops[5].id);
  });
  it("treats Google regular opening hours as hard limits", async () => {
    const bistro = { ...newStop("Bistro"), slot: "any" as const, duration: 60 };
    const trip = { ...fixture(), days: 2, dailyStart: "08:00", dailyEnd: "22:00", stops: [bistro] };
    const place = (hours: { open: { day: number; hour: number; minute: number }; close: { day: number; hour: number; minute: number } }[]) => ({ [bistro.id]: { id: "bistro", name: "Bistro", address: "", location: { lat: 48.85, lng: 2.35 }, hours } });
    // 2026-10-12 is a Monday (Google day 1); the bistro opens at noon on Monday and Tuesday.
    const noon = await solveTrip({ ...trip, stops: [{ ...bistro, day: 0 }] }, routes(trip), 2, { places: place([1, 2].map((day) => ({ open: { day, hour: 12, minute: 0 }, close: { day, hour: 23, minute: 0 } }))) });
    expect(noon.days[0].visits[0].start).toBeGreaterThanOrEqual(12 * 60);
    const tuesdayOnly = await solveTrip(trip, routes(trip), 2, { places: place([{ open: { day: 2, hour: 9, minute: 0 }, close: { day: 2, hour: 17, minute: 0 } }]) });
    expect(tuesdayOnly.days[1].visits.map((visit) => visit.stopId)).toEqual([bistro.id]);
    await expect(solveTrip(trip, routes(trip), 2, { places: place([{ open: { day: 5, hour: 9, minute: 0 }, close: { day: 5, hour: 17, minute: 0 } }]) })).rejects.toThrow("No schedule fits these opening hours. Bistro is closed, or open for less than 60 min, on every trip day");
    await expect(solveTrip({ ...trip, stops: [{ ...bistro, day: 0 }] }, routes(trip), 2, { places: place([{ open: { day: 2, hour: 9, minute: 0 }, close: { day: 2, hour: 17, minute: 0 } }]) })).rejects.toThrow("Bistro is closed on Day 1, or open for less than 60 min (Google regular hours); it is open on Day 2. Set its day to Optimize or one of those days, or mark it optional.");
  });
  it("names a visit whose opening hours leave no gap between the day's bookings", async () => {
    // Open daily from noon, but Day 1's bookings leave only short gaps after noon once 40-minute legs and buffers count.
    const taco = { ...newStop("Taco Lindo"), slot: "any" as const, duration: 30, day: 0 };
    const trip: Trip = { ...fixture(), days: 2, dailyStart: "08:00", dailyEnd: "21:00", stops: [
      { ...newStop("Museum"), day: 0, fixedTime: "11:30", duration: 90, buffer: 15 },
      { ...newStop("Brewery"), day: 0, fixedTime: "14:00", duration: 90, buffer: 15 },
      { ...newStop("Ice rink"), day: 0, fixedTime: "17:00", duration: 180, buffer: 15 },
      taco,
    ] };
    const hours = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ open: { day, hour: 12, minute: 0 }, close: { day, hour: 21, minute: 0 } }));
    const places = { [taco.id]: { id: "taco", name: "Taco Lindo", address: "", location: { lat: 48.85, lng: 2.35 }, hours } };
    const message = "No schedule fits these bookings and opening hours. Taco Lindo does not fit on Day 1: it is open 12:00–21:00 (Google regular hours), and the gaps around the bookings at Museum 11:30, Brewery 14:00 and Ice rink 17:00 are too short once sampled travel and booking buffers are counted. Day 2 has room for it around the bookings; set its day to Optimize or one of those days, or mark it optional.";
    await expect(solveTrip(trip, routes(trip, 40), 2, { places })).rejects.toThrow(message);
    await expect(solveTripByDays(trip, routes(trip, 40), 2, { places })).rejects.toThrow(message);
    const failure = await solveTrip(trip, routes(trip, 40), 2, { places }).catch((error: PlanningError) => error);
    expect((failure as PlanningError).fixes).toEqual([{ stopId: taco.id, stopName: "Taco Lindo", issue: "Open 12:00–21:00, which leaves no gap around Day 1's bookings. Day 2 has room.", action: "optimize-day" }]);
    expect(applyPlanningFixes(trip, (failure as PlanningError).fixes).stops.map((stop) => stop.day)).toEqual([0, 0, 0, null]);
    const closed = await solveTrip({ ...trip, days: 1 }, routes({ ...trip, days: 1 }, 40), 2, { places }).catch((error: PlanningError) => error);
    expect((closed as PlanningError).fixes.map((fix) => fix.action)).toEqual(["make-optional"]);
    const moved = await solveTrip({ ...trip, stops: trip.stops.map((stop) => stop.id === taco.id ? { ...stop, day: null } : stop) }, routes(trip, 40), 2, { places });
    expect(moved.days[1].visits.map((visit) => visit.stopId)).toEqual([taco.id]);
  });
  it("keeps both alternatives when they fit and drops one when they do not", async () => {
    const note = "Coffee: Filter coffee at Five Ways or Rum Baba (€6).";
    const fiveWays = { ...newStop("Five Ways"), source: note };
    const rumBaba = { ...newStop("Rum Baba"), source: note };
    const trip = { ...fixture(), days: 1, dailyStart: "09:00", dailyEnd: "18:00", stops: [fiveWays, rumBaba] };
    const both = await solveTrip(trip, routes(trip), 2);
    expect(validateSchedule(trip, both)).toEqual([]);
    expect(both.omitted).toEqual([]);

    const tight = { ...trip, dailyEnd: "10:20" };
    const one = await solveTrip(tight, routes(tight), 2);
    expect(validateSchedule(tight, one)).toEqual([]);
    expect(one.omitted).toHaveLength(1);
    expect(one.warnings.join(" ")).toContain("listed as alternatives");
    expect(validateSchedule(tight, { ...one, days: [{ ...one.days[0], visits: [], returnLeg: undefined }], omitted: [fiveWays.id, rumBaba.id] })).toContain("Five Ways / Rum Baba: plan at least one of these alternatives.");

    const elevate = { ...newStop("Elevate Coffee Lab"), source: "Coffee 2: Elevate Coffee Lab (€7)." };
    const capped = { ...trip, stops: [fiveWays, rumBaba, elevate] };
    const stages: SolverStage[] = [];
    const twoCoffees = await solveTrip(capped, routes(capped), 2, { onStage: (stage) => stages.push(stage) });
    expect(validateSchedule(capped, twoCoffees)).toEqual([]);
    expect(twoCoffees.days[0].visits).toHaveLength(2);
    expect(twoCoffees.days[0].visits.map((visit) => visit.stopId)).toContain(elevate.id);

    const coupled = { ...capped, stops: [fiveWays, rumBaba, { ...elevate, duration: 45, durationOptions: [45, 41, 36] }] };
    const coupledStages: SolverStage[] = [];
    const coupledSchedule = await solveTrip(coupled, routes(coupled), 3, { onStage: (stage) => coupledStages.push(stage) });
    expect(validateSchedule(coupled, coupledSchedule)).toEqual([]);
    expect(coupledSchedule.days[0].visits).toHaveLength(2);
    expect(coupledStages.filter((stage) => stage.stage === "optimization").map((stage) => stage.objective)).toEqual(["duration", "balance", "travel"]);
  });
  it("finishes one neighbourhood before crossing town even when itinerary times zig-zag", async () => {
    const names = ["West A", "East A", "West B", "East B"];
    const stops = names.map((name, index) => ({ ...newStop(name), duration: 45, source: `${String(10 + index).padStart(2, "0")}:00 – ${String(10 + index).padStart(2, "0")}:45 | ${name}` }));
    const trip: Trip = { ...fixture(), days: 1, dailyStart: "09:00", dailyEnd: "19:00", stops };
    const side = (id: string) => trip.stops.find((stop) => stop.id === id)!.name.split(" ")[0];
    const travel = routes(trip).map((edge) => ({ ...edge, minutes: edge.from === "hotel" || edge.to === "hotel" ? 20 : side(edge.from) === side(edge.to) ? 5 : 40 }));
    const schedule = await solveTrip(trip, travel, 3);
    expect(validateSchedule(trip, schedule)).toEqual([]);
    const sides = schedule.days[0].visits.map((visit) => side(visit.stopId));
    expect(sides.filter((name, index) => index && name !== sides[index - 1])).toHaveLength(1);
  });
  it("prefers the compact route when travel minutes are nearly tied", async () => {
    // A, B and C sit in a row; going B > A > C saves 2 sampled minutes but rides 2 km further.
    const [a, b, c] = ["A", "B", "C"].map((name) => ({ ...newStop(name), duration: 30 }));
    const trip: Trip = { ...fixture(), days: 1, dailyStart: "09:00", dailyEnd: "18:00", stops: [a, b, c] };
    const neighbours = new Set([`${a.id}|${b.id}`, `${b.id}|${a.id}`, `${b.id}|${c.id}`, `${c.id}|${b.id}`]);
    const travel = routes(trip).map((edge): TravelEdge => ({ ...edge, mode: "TRANSIT", minutes: (edge.from === "hotel" && edge.to === b.id) || (edge.from === a.id && edge.to === c.id) ? 9 : 10, meters: edge.from === "hotel" || edge.to === "hotel" || neighbours.has(`${edge.from}|${edge.to}`) ? 1000 : 3000 }));
    const schedule = await solveTrip(trip, travel, 3);
    expect(validateSchedule(trip, schedule)).toEqual([]);
    const order = schedule.days[0].visits.map((visit) => trip.stops.find((stop) => stop.id === visit.stopId)!.name).join("");
    expect(["ABC", "CBA"]).toContain(order);
  });
  it("escapes local optima on a trip too large for the optimizer to prove", async () => {
    // A seeded 6 x 6 km city: 24 places, some pinned to days, two bookings and short opening windows.
    let state = 9973;
    const random = () => (state = (state * 48271) % 2147483647) / 2147483647;
    const stops = Array.from({ length: 24 }, (_, index) => ({ ...newStop(`P${index}`), duration: 30 + Math.floor(random() * 4) * 15, ...(index < 8 ? { day: index % 3 } : {}), ...(index === 8 ? { day: 1, fixedTime: "13:00", duration: 90 } : {}), ...(index === 9 ? { day: 2, fixedTime: "17:00", duration: 90 } : {}) }));
    const trip: Trip = { ...newTrip(), city: "X", hotel: "H", startDate: "2026-12-26", timeZone: "Europe/Amsterdam", days: 3, dailyStart: "08:30", dailyEnd: "21:00", stops };
    const points = new Map<string, [number, number]>([["hotel", [3, 3]], ...stops.map((stop) => [stop.id, [random() * 6, random() * 6]] as [string, [number, number]])]);
    const week = (open: number, close: number) => [0, 1, 2, 3, 4, 5, 6].map((day) => ({ open: { day, hour: open, minute: 0 }, close: { day, hour: close, minute: 0 } }));
    const places = Object.fromEntries(stops.map((stop, index) => [stop.id, { id: stop.id, name: stop.name, address: "", location: { lat: 52 + points.get(stop.id)![1] / 111, lng: 4.9 + points.get(stop.id)![0] / 68 }, ...(index % 5 === 0 ? { hours: week(11, 17) } : index % 7 === 0 ? { hours: week(9, 14) } : {}) }]));
    const travel = Array.from({ length: 3 }, (_, day) => [...points.keys()].flatMap((from) => [...points.keys()].filter((to) => to !== from).map((to): TravelEdge => {
      const [a, b] = [points.get(from)!, points.get(to)!];
      const km = Math.hypot(a[0] - b[0], a[1] - b[1]);
      return km < 1.1 ? { day, from, to, mode: "WALK", minutes: Math.ceil(km * 16) + 2, meters: Math.round(km * 1300) } : { day, from, to, mode: "TRANSIT", minutes: Math.round(15 + 4.5 * km), meters: Math.round(km * 1300) };
    }))).flat();
    const schedule = await solveTrip(trip, travel, 5, { places });
    expect(validateSchedule(trip, schedule)).toEqual([]);
    // Single-visit moves alone stop at 564 travel minutes here; segment moves and ruin-and-recreate reach about 533.
    expect(schedule.days.reduce((total, day) => total + day.visits.reduce((sum, visit) => sum + visit.leg.minutes, day.returnLeg?.minutes ?? 0), 0)).toBeLessThan(555);
  }, 30_000);
  it("drops a second alternative that needs a detour but keeps one that is next door", async () => {
    const note = "Coffee: Filter coffee at Five Ways or Rum Baba (€6).";
    const fiveWays = { ...newStop("Five Ways"), source: note };
    const rumBaba = { ...newStop("Rum Baba"), source: note };
    const trip = { ...fixture(), days: 1, dailyStart: "09:00", dailyEnd: "18:00", stops: [fiveWays, rumBaba] };
    const far = routes(trip).map((edge) => edge.from === rumBaba.id || edge.to === rumBaba.id ? { ...edge, minutes: 60 } : edge);
    const detour = await solveTrip(trip, far, 2);
    expect(validateSchedule(trip, detour)).toEqual([]);
    expect(detour.omitted).toEqual([rumBaba.id]);
    expect(detour.warnings.join(" ")).toContain("left out Rum Baba");
    const near = await solveTrip(trip, routes(trip, 5), 2);
    expect(near.omitted).toEqual([]);
  });
  it("allows the hotel return after sightseeing ends and says when you will be back", async () => {
    const museum = { ...newStop("Museum"), duration: 50 };
    const trip = { ...fixture(), days: 1, dailyStart: "09:00", dailyEnd: "10:20", returnToHotel: true, stops: [museum] };
    const schedule = await solveTrip(trip, routes(trip, 30), 2);
    expect(validateSchedule(trip, schedule)).toEqual([]);
    expect(schedule.days[0].visits[0].end).toBeLessThanOrEqual(10 * 60 + 20);
    expect(schedule.warnings).toContain("Day 1: back at the hotel around 10:50, after sightseeing ends at 10:20.");
  });
  it("points out long free gaps and holiday dates where only regular hours are known", async () => {
    const bistro = { ...newStop("Bistro"), slot: "any" as const, duration: 60 };
    const trip: Trip = { ...fixture(), startDate: "2026-12-25", days: 1, dailyStart: "09:00", dailyEnd: "18:00", stops: [
      { ...newStop("Morning tour"), day: 0, fixedTime: "09:30", duration: 60 },
      { ...newStop("Afternoon show"), day: 0, fixedTime: "14:00", duration: 60 },
      bistro,
    ] };
    const hours = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ open: { day, hour: 11, minute: 0 }, close: { day, hour: 12, minute: 15 } }));
    const places = { [bistro.id]: { id: "bistro", name: "Bistro", address: "", location: { lat: 48.85, lng: 2.35 }, hours } };
    const schedule = await solveTrip(trip, routes(trip), 2, { places });
    expect(validateSchedule(trip, schedule)).toEqual([]);
    const warnings = schedule.warnings.join(" ");
    expect(warnings).toMatch(/Day 1 has 1 h \d\d min free between Bistro \(ends 12:\d\d\) and Afternoon show \(14:00\)/);
    expect(warnings).toContain("Day 1 (2026-12-25) is Christmas Day. Google lists only regular weekly hours for Bistro;");
    expect(["2026-04-03", "2026-04-06", "2027-03-26", "2027-01-01", "2026-12-26"].map(commonHoliday)).toEqual(["Good Friday", "Easter Monday", "Good Friday", "New Year's Day", "Boxing Day (St Stephen's Day)"]);
    expect(commonHoliday("2026-12-24")).toBeNull();
  });
  it.each([2, 3])("jointly assigns an exclusive day trip and preserves individual durations across %i days", async (days) => {
    const stops = [
      { ...newStop("Priority Amsterdam lunch"), day: 0, duration: 60, durationOptions: [60, 54, 48], priority: 5 },
      { ...newStop("Flexible Amsterdam cafe"), duration: 60, durationOptions: [60, 54, 48] },
      { ...newStop("Utrecht canal"), duration: 30 }, { ...newStop("Utrecht lunch"), duration: 30 },
    ];
    const trip = { ...fixture(), days, dailyEnd: "11:14", stops, dayGroups: [{ id: crypto.randomUUID(), name: "Utrecht", stopIds: stops.slice(2).map((stop) => stop.id), allowedDays: Array.from({ length: days - 1 }, (_, index) => index + 1), exclusive: true }] };
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
    const trip = { ...fixture(), days: 1, dailyEnd: "11:14", stops: [
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
    const short = { ...trip, dailyEnd: "09:15", stops: [{ ...newStop("Small visit"), duration: 15, durationOptions: [15, 10] }] };
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
    // Sightseeing ends at 18:00; the trip back may take up to two more hours.
    trip.stops[0].fixedTime = "17:55";
    expect(validateSchedule(trip, await solveTrip(trip, routes(trip, 10)))).toEqual([]);
    await expect(solveTrip(trip, routes(trip, 125))).rejects.toThrow("Museum (17:55) to the hotel leaves 120 min for travel; sampled routes need at least 125 min");
    trip.returnToHotel = false;
    expect(validateSchedule(trip, await solveTrip(trip, routes(trip, 125)))).toEqual([]);
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
  it("plans nothing before the arrival time and releases visits that no longer fit the shortened day", async () => {
    const stops = [
      { ...newStop("Breakfast cafe"), day: 0, duration: 60, plannedTime: "09:30" },
      { ...newStop("Museum"), day: 0, duration: 120 },
      { ...newStop("Canal walk"), day: 0, duration: 90 },
      { ...newStop("Dinner"), day: 0, duration: 60 },
    ];
    const trip: Trip = { ...fixture(), days: 2, dailyStart: "08:00", dailyEnd: "21:00", stops, arrival: { mode: "FLIGHT", time: "13:20", place: "Schiphol" } };
    const failure = await solveTrip(trip, routes(trip, 20)).catch((error) => error);
    expect(failure).toBeInstanceOf(PlanningError);
    expect((failure as PlanningError).message).toMatch(/^Not enough time on these days .* Day 1 starts about 15:05 after arriving at 13:20/);
    expect((failure as PlanningError).fixes).toEqual([expect.objectContaining({ stopId: stops[0].id, action: "optimize-day" })]);
    const fixed = applyPlanningFixes(trip, (failure as PlanningError).fixes);
    const schedule = await solveTrip(fixed, routes(fixed, 20));
    expect(validateSchedule(fixed, schedule)).toEqual([]);
    expect(schedule.days[0].visits.length).toBeGreaterThan(0);
    expect(Math.min(...schedule.days[0].visits.map((visit) => visit.start - visit.leg.minutes))).toBeGreaterThanOrEqual(minuteAt(fixed, 0, "15:05"));
    expect(schedule.days[1].visits.map((visit) => visit.stopId)).toContain(stops[0].id);
  });
  it("brings the last day back to the hotel before the departure transfer", async () => {
    const trip: Trip = { ...fixture(), days: 1, dailyStart: "09:00", dailyEnd: "21:00", returnToHotel: true, stops: [{ ...newStop("Market"), duration: 60 }, { ...newStop("Gallery"), duration: 60 }], departure: { mode: "FLIGHT", time: "17:00", place: "CDG" } };
    const schedule = await solveTrip(trip, routes(trip, 15));
    expect(validateSchedule(trip, schedule)).toEqual([]);
    const last = schedule.days[0];
    // 17:00 − 3 h at the airport − 45 min transfer − 15 min for bags.
    expect(last.visits.at(-1)!.end + last.returnLeg!.minutes).toBeLessThanOrEqual(minuteAt(trip, 0, "13:00"));
  });
  it("finds which visits to release when a short day fails on ordering, not total minutes", async () => {
    // 15:05–21:00 around an 18:15 cruise: the minutes add up, but the visits that close at 17:00 cannot all fit first.
    const cruise = { ...newStop("Cruise"), day: 0, fixedTime: "18:15", duration: 75, buffer: 15 };
    const early = Array.from({ length: 2 }, (_, index) => ({ ...newStop(`Closes early ${index}`), day: 0, duration: 45, priority: index ? 1 : 3 }));
    const later = { ...newStop("Evening walk"), day: 0, duration: 30 };
    const trip: Trip = { ...fixture(), days: 3, dailyStart: "08:00", dailyEnd: "21:00", stops: [cruise, ...early, later], arrival: { mode: "FLIGHT", time: "13:20", place: "Schiphol" } };
    const places = Object.fromEntries(early.map((stop) => [stop.id, { id: stop.id, name: stop.name, address: "", location: { lat: 52.37, lng: 4.89 }, hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ open: { day: weekday, hour: 9, minute: 0 }, close: { day: weekday, hour: 17, minute: 0 } })) }]));
    const travel = routes(trip, 15);
    const failure = await solveTrip(trip, travel, 5, { places }).catch((error) => error);
    expect(failure).toBeInstanceOf(PlanningError);
    const { blocked, fixes } = await blockedDayFixes(trip, travel, places, Date.now() + 20_000);
    expect(blocked).toEqual([expect.stringMatching(/^Day 1 starts about 15:05 after arriving at 13:20 and cannot fit its 4 assigned visits/)]);
    // The lowest-priority early visit goes first, and the trip has room on the other days.
    expect(fixes).toEqual([expect.objectContaining({ stopId: early[1].id, action: "optimize-day" })]);
    const fixed = applyPlanningFixes(trip, fixes);
    expect(validateSchedule(fixed, await solveTripByDays(fixed, routes(fixed, 15), 5, { places }))).toEqual([]);
  });
  it("suggests keeping released visits optional when the other days are full, and leaves them out by day", async () => {
    const fill = (day: number) => Array.from({ length: 6 }, (_, index) => ({ ...newStop(`Day ${day + 1} visit ${index}`), day, duration: 90 }));
    const breakfast = { ...newStop("Breakfast"), day: 0, duration: 60, plannedTime: "09:00" };
    const trip: Trip = { ...fixture(), days: 2, dailyStart: "09:00", dailyEnd: "19:00", stops: [breakfast, ...fill(0).slice(0, 4), ...fill(1).slice(0, 5)], arrival: { mode: "TRAIN", time: "11:30", place: "Centraal" } };
    const failure = await solveTrip(trip, routes(trip, 10)).catch((error) => error) as PlanningError;
    expect(failure.message).toContain("let Breakfast move to any day and keep it only where there is room");
    expect(failure.fixes).toEqual([expect.objectContaining({ stopId: breakfast.id, action: "flexible-optional" })]);
    const fixed = applyPlanningFixes(trip, failure.fixes);
    expect(fixed.stops[0]).toMatchObject({ day: null, optional: true });
    const schedule = await solveTripByDays(fixed, routes(fixed, 10), 5);
    expect(validateSchedule(fixed, schedule)).toEqual([]);
    expect(schedule.omitted).toEqual([breakfast.id]);
  });
  it("starts later instead of waiting mid-day, keeping preferred times and a little slack", async () => {
    // The light trail is only worth it after dark; the other visits have no preferred time.
    const trail = { ...newStop("Light trail"), duration: 15, preferredTimeWindow: { start: "16:30", end: "20:00", sources: ["https://example.com/trail"] } };
    const lunch = { ...newStop("Castle lunch"), duration: 45, preferredTimeWindow: { start: "12:00", end: "13:30", sources: ["https://example.com/lunch"] } };
    const walks = [{ ...newStop("Canal walk"), duration: 45 }, { ...newStop("Cafe"), duration: 35 }];
    const trip: Trip = { ...fixture(), days: 1, dailyStart: "09:00", dailyEnd: "21:00", stops: [...walks, trail] };
    const schedule = await solveTrip(trip, routes(trip, 15));
    expect(validateSchedule(trip, schedule)).toEqual([]);
    const visits = schedule.days[0].visits;
    expect(visits.at(-1)!.stopId).toBe(trail.id);
    expect(visits.at(-1)!.start).toBeGreaterThanOrEqual(minuteAt(trip, 0, "16:30"));
    // Each visit ends just in time for the next (15 min walk + 10 min slack); the morning is left free.
    visits.slice(1).forEach((visit, index) => expect(visit.start - visits[index].end).toBeLessThanOrEqual(15 + 10 + 1));
    expect(visits[0].start).toBeGreaterThan(minuteAt(trip, 0, "14:00"));
    // A visit with its own preferred time keeps it rather than closing the gap.
    const withLunch = { ...trip, stops: [lunch, trail] };
    const lunchFirst = await solveTrip(withLunch, routes(withLunch, 15));
    expect(lunchFirst.days[0].visits[0]).toMatchObject({ stopId: lunch.id });
    expect(lunchFirst.days[0].visits[0].start).toBeLessThanOrEqual(minuteAt(trip, 0, "13:30"));
  });
  it("visits a shared-day trip in one outing", async () => {
    const away = Array.from({ length: 3 }, (_, index) => ({ ...newStop(`Utrecht ${index}`), duration: 40 }));
    const home = Array.from({ length: 3 }, (_, index) => ({ ...newStop(`Amsterdam ${index}`), duration: 40 }));
    const trip: Trip = { ...fixture(), days: 1, dailyStart: "09:00", dailyEnd: "21:00", stops: [home[0], away[0], home[1], away[1], home[2], away[2]], dayGroups: [{ id: crypto.randomUUID(), name: "Utrecht", stopIds: away.map((stop) => stop.id), allowedDays: [0], exclusive: false }] };
    // Within each city everything is 10 min apart; between them 30 min; misleadingly, Utrecht 1 → Amsterdam 1 is 5 min.
    const city = (id: string) => away.some((stop) => stop.id === id) ? "U" : home.some((stop) => stop.id === id) ? "A" : "H";
    const travel = routes(trip).map((edge) => ({ ...edge, minutes: edge.from === away[1].id && edge.to === home[1].id ? 5 : city(edge.from) === city(edge.to) || city(edge.from) === "H" && city(edge.to) === "A" || city(edge.to) === "H" && city(edge.from) === "A" ? 10 : 30 }));
    const schedule = await solveTrip(trip, travel);
    expect(validateSchedule(trip, schedule)).toEqual([]);
    const ids = schedule.days[0].visits.map((visit) => city(visit.stopId)).join("");
    expect(ids).toMatch(/^A*U{3}A*$/);
    const visits = schedule.days[0].visits;
    const interleaved = [visits.find((visit) => city(visit.stopId) === "U")!, visits.find((visit) => city(visit.stopId) === "A")!, ...visits.filter((visit) => city(visit.stopId) === "U").slice(1), ...visits.filter((visit) => city(visit.stopId) === "A").slice(1)];
    expect(splitVisits(interleaved, away.map((stop) => stop.id))).toBe(true);
    expect(splitVisits(visits, away.map((stop) => stop.id))).toBe(false);
    expect(validateSchedule(trip, { ...schedule, days: [{ ...schedule.days[0], visits: interleaved }] })).toContain("Utrecht: visit the group's places in one go, not split by other visits.");
  });
  it("routes the last leg of a direct departure day to the station", async () => {
    const trip: Trip = { ...fixture(), days: 1, dailyStart: "08:00", dailyEnd: "21:00", returnToHotel: true, stops: [{ ...newStop("Coffee by the station"), duration: 45 }, { ...newStop("Station sandwich"), duration: 15 }], departure: { mode: "TRAIN", time: "11:10", place: "Centraal", placeId: "centraal", direct: true } };
    const schedule = await solveTrip(trip, routes(trip, 10));
    expect(validateSchedule(trip, schedule)).toEqual([]);
    const day = schedule.days[0];
    expect(day.visits.at(-1)!.end + day.returnLeg!.minutes).toBeLessThanOrEqual(minuteAt(trip, 0, "10:50"));
    // Spare time sits before the train: the morning starts with the first visit.
    expect(day.visits[0].start).toBeLessThanOrEqual(minuteAt(trip, 0, "08:10"));
    const late = { ...trip, departure: { ...trip.departure!, time: "09:30" } };
    expect(validateSchedule(late, schedule).join(" ")).toMatch(/hotel|return/i);
  });
  it("makes a visit to the departure station the last one that day, even when doubling back is shorter", async () => {
    const coffee = { ...newStop("Coffee"), duration: 45, placeId: "coffee" };
    const hall = { ...newStop("Station hall"), duration: 15, placeId: "centraal" };
    const trip: Trip = { ...fixture(), days: 1, dailyStart: "08:00", dailyEnd: "21:00", returnToHotel: true, stops: [coffee, hall], departure: { mode: "TRAIN", time: "11:10", place: "Centraal", placeId: "centraal", direct: true } };
    // The station is a quick ride from the hotel and the coffee is not: by travel alone, station first is 20 min shorter.
    const minutes: Record<string, number> = { [`hotel>${hall.id}`]: 5, [`hotel>${coffee.id}`]: 30, [`${hall.id}>${coffee.id}`]: 5, [`${coffee.id}>${hall.id}`]: 5, [`${hall.id}>hotel`]: 0, [`${coffee.id}>hotel`]: 5 };
    const travel = Object.entries(minutes).map(([key, value]): TravelEdge => { const [from, to] = key.split(">"); return { day: 0, from, to, mode: "TRANSIT", minutes: value, meters: value * 300 }; });
    const schedule = await solveTrip(trip, travel, 2);
    expect(schedule.days[0].visits.map((visit) => visit.stopId)).toEqual([coffee.id, hall.id]);
    // Without the direct departure, the shorter order wins.
    const ordinary = await solveTrip({ ...trip, departure: { ...trip.departure!, direct: undefined } }, travel, 2);
    expect(ordinary.days[0].visits.map((visit) => visit.stopId)).toEqual([hall.id, coffee.id]);
  });
  it("starts the departure day's visits early so spare time sits before the train", () => {
    const [coffee, station] = [{ ...newStop("Coffee"), duration: 45 }, { ...newStop("Station hall"), duration: 15 }];
    const trip: Trip = { ...fixture(), days: 2, dailyStart: "08:00", dailyEnd: "21:00", returnToHotel: true, stops: [{ ...coffee, day: 1 }, { ...station, day: 1 }], departure: { mode: "TRAIN", time: "11:10", place: "Centraal", placeId: "centraal", direct: true } };
    const leg = (day: number, from: string, to: string, minutes: number): TravelEdge => ({ day, from, to, mode: "TRANSIT", minutes, meters: 2000 });
    const at = (day: number, time: string) => minuteAt(trip, day, time);
    const schedule = { generatedAt: "", warnings: [], omitted: [], days: [
      { day: 0, date: tripDate(trip, 0), visits: [] },
      { day: 1, date: tripDate(trip, 1), visits: [{ stopId: coffee.id, start: at(1, "09:30"), end: at(1, "10:15"), leg: leg(1, "hotel", coffee.id, 20) }, { stopId: station.id, start: at(1, "10:30"), end: at(1, "10:45"), leg: leg(1, coffee.id, station.id, 15) }], returnLeg: leg(1, station.id, "hotel", 0) },
    ] };
    const early = compactWaits(trip, schedule).days[1].visits;
    expect(early.map((visit) => [visit.start, visit.end])).toEqual([[at(1, "08:20"), at(1, "09:05")], [at(1, "09:20"), at(1, "09:35")]]);
    expect(validateSchedule(trip, { ...schedule, days: [schedule.days[0], { ...schedule.days[1], visits: early }] })).toEqual([]);
    // Without a departure the same day keeps its late start: waits move to the start of the day, not the end.
    expect(compactWaits({ ...trip, departure: undefined }, schedule).days[1].visits.map((visit) => visit.start)).toEqual([at(1, "09:30"), at(1, "10:30")]);
  });
  it("plans a day by day trip whose own visits were never sampled towards each other", async () => {
    const at = (lat: number) => ({ id: "x", name: "x", address: "", location: { lat, lng: 4.89 } });
    const cruise = { ...newStop("Cruise"), day: 0, fixedTime: "18:15", duration: 75 };
    const coffee = { ...newStop("Coffee"), day: 0, duration: 45, plannedTime: "16:00" };
    const trip: Trip = { ...fixture(), days: 2, dailyStart: "09:00", dailyEnd: "21:00", stops: [cruise, coffee, { ...newStop("Museum"), day: 1, duration: 60 }] };
    const places = { hotel: at(52.35), [cruise.id]: at(52.37), [coffee.id]: at(52.372), [trip.stops[2].id]: at(52.36) };
    // Only hotel legs were sampled: nothing connects the coffee to the cruise directly.
    const travel = routes(trip, 20).filter((edge) => edge.from === "hotel" || edge.to === "hotel");
    const schedule = await solveTripByDays(trip, travel, 5, { places });
    expect(validateSchedule(trip, schedule)).toEqual([]);
    expect(schedule.days[0].visits.map((visit) => visit.stopId)).toEqual([coffee.id, cruise.id]);
    expect(schedule.days[0].visits[1].leg).toMatchObject({ from: coffee.id, estimated: true });
  });
});

describe("day by day planning", () => {
  it("spreads coffees across days instead of filling the roomiest day past its cap", async () => {
    const [alpha, beta, gamma] = ["Alpha", "Beta", "Gamma"].map((name) => ({ ...newStop(`${name} Coffee`), duration: 45 }));
    // Day 2 is mostly one long museum visit, so by room alone the third coffee would join the first two on day 1.
    const trip: Trip = { ...fixture(), days: 2, dailyStart: "09:00", dailyEnd: "18:00", stops: [{ ...alpha, day: 0 }, { ...beta, day: 0 }, gamma, { ...newStop("Long museum"), day: 1, duration: 400 }] };
    const schedule = await solveTripByDays(trip, routes(trip), 3);
    expect(validateSchedule(trip, schedule)).toEqual([]);
    expect(schedule.days[1].visits.map((visit) => visit.stopId)).toContain(gamma.id);
  });
});

describe("squeezing in a place left out", () => {
  it("names the gap that fits it with the least extra travel, and says when it breaks a cap", () => {
    const [alpha, beta, museum, gamma] = [{ ...newStop("Alpha Coffee"), day: 0 }, { ...newStop("Beta Coffee"), day: 0 }, { ...newStop("Museum"), day: 0, duration: 60 }, { ...newStop("Gamma Coffee"), optional: true }];
    const trip: Trip = { ...fixture(), days: 1, dailyStart: "09:00", dailyEnd: "18:00", returnToHotel: true, stops: [alpha, beta, museum, gamma] };
    const at = (time: string) => minuteAt(trip, 0, time);
    const leg = (from: string, to: string): TravelEdge => ({ day: 0, from, to, mode: "WALK", minutes: 10, meters: 600 });
    const schedule = { generatedAt: "", warnings: [], omitted: [gamma.id], days: [{ day: 0, date: tripDate(trip, 0), visits: [
      { stopId: alpha.id, start: at("09:10"), end: at("09:55"), leg: leg("hotel", alpha.id) },
      { stopId: museum.id, start: at("12:00"), end: at("13:00"), leg: leg(alpha.id, museum.id) },
      { stopId: beta.id, start: at("13:10"), end: at("13:55"), leg: leg(museum.id, beta.id) },
    ], returnLeg: leg(beta.id, "hotel") }] };
    // Before Alpha it would make Alpha late, and Museum to Beta leaves 10 min; after Alpha and after Beta both add 10 min.
    const [fit] = squeezeIns(trip, schedule, routes(trip));
    expect(fit).toMatchObject({ stopId: gamma.id, day: 0, after: alpha.id, start: at("10:05"), end: at("10:50"), extraMinutes: 10, overCap: { category: "coffee", count: 3 } });
    expect(squeezeInNote(trip, fit)).toBe("Day 1 (Mon 12 Oct) after Alpha Coffee, about 10:05–10:50, adding about 10 min of travel; it would be the 3rd coffee that day");
    // With no gap long enough anywhere, nothing is suggested.
    const full = { ...schedule, days: [{ ...schedule.days[0], visits: schedule.days[0].visits.map((visit, index) => index === 1 ? { ...visit, start: at("10:05"), end: at("13:00") } : visit) }] };
    expect(squeezeIns({ ...trip, dailyEnd: "14:30" }, full, routes(trip))).toEqual([]);
  });
});

describe("straight-line travel estimates", () => {
  const edge = (mode: TravelEdge["mode"], km: number, minutes: number, index: number): TravelEdge => ({ day: 0, from: `a${index}`, to: `b${index}`, mode, minutes, meters: km * 1000 });
  it("scales mid-distance transit to the trip's real routes but never below the formula", () => {
    // Formula: 2 km transit is 20 min, 0.5 km walk is 12 min. Google took 25-45 min for 2 km hops and 8 min for short walks.
    const edges = [...[25, 30, 33, 33, 36, 40, 45].map((minutes, index) => edge("TRANSIT", 2, minutes, index)), ...Array.from({ length: 6 }, (_, index) => edge("WALK", 0.5, 8, 10 + index))];
    const km = (travel: TravelEdge) => travel.meters / 1000;
    const estimate = travelEstimator(edges, km);
    expect(estimate("TRANSIT", 2)).toBe(33);
    expect(estimate("TRANSIT", 1.8)).toBe(Math.ceil(20 * 1.65));
    expect(estimate("WALK", 0.5)).toBe(12);
    // Fewer than five routes in a band: the bare formula.
    expect(estimate("TRANSIT", 6)).toBe(36);
    expect(travelEstimator(edges, km, true)("TRANSIT", 2)).toBe(40);
    expect(travelEstimator([...edges, { ...edge("TRANSIT", 2, 10, 99), estimated: true }], km)("TRANSIT", 2)).toBe(33);
  });

  it("times an unsampled mid-distance pair from the day's real transit, not the bare formula", async () => {
    // Two visits 1.6 km apart with no sampled link, beyond the walking limit. The bare formula says 19 min of transit;
    // this day's real transit runs 1.74 times the formula, as short hops in Amsterdam do with transfers and waits.
    const at = (lat: number) => ({ lat, lng: 4.89 });
    const [first, second] = [{ ...newStop("First"), duration: 30, location: at(52.37) }, { ...newStop("Second"), duration: 30, location: at(52.3844) }];
    const trip: Trip = { ...newTrip(), city: "Amsterdam", hotel: "Hotel", days: 2, startDate: "2026-12-24", timeZone: "Europe/Amsterdam", dailyStart: "09:00", dailyEnd: "21:00", returnToHotel: true, hotelLocation: at(52.36), stops: [{ ...first, day: 0 }, { ...second, day: 0 }] };
    const leg = (from: string, to: string, mode: TravelEdge["mode"], minutes: number): TravelEdge => ({ day: 0, from, to, mode, minutes, meters: 1500 });
    // The hotel is 2.7 km from Second; Google's transit took 40 min there at every sampled departure (formula: 23 min).
    const travel = [leg("hotel", first.id, "TRANSIT", 20), leg(first.id, "hotel", "TRANSIT", 20), leg(second.id, "hotel", "TRANSIT", 40), ...[540, 600, 660, 720, 780].map((minute) => ({ ...leg("hotel", second.id, "TRANSIT", 40), sampledDeparture: minute }))];
    const schedule = await solveTripByDays(trip, travel, 2);
    expect(schedule.days[0].visits[1].leg).toMatchObject({ mode: "TRANSIT", estimated: true, minutes: Math.ceil(19 * 40 / 23) });
  });
});
