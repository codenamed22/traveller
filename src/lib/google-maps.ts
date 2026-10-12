import "server-only";
import { z } from "zod";
import { instantAt, instantForMinute, minuteAt, type Place, type Schedule, type TravelEdge, type TravelMode, type Trip } from "./trip";
import { HttpError } from "./server";
import { solveTrip, PlanningError } from "./planner";
import { validateSchedule } from "./schedule-validation";

const placeResponse = z.object({ id: z.string(), displayName: z.object({ text: z.string() }), formattedAddress: z.string().optional(), location: z.object({ latitude: z.number(), longitude: z.number() }), timeZone: z.object({ id: z.string() }).optional() });
const routeResponse = z.object({ routes: z.array(z.object({
  duration: z.string(), distanceMeters: z.number().default(0), polyline: z.object({ encodedPolyline: z.string() }).optional(),
  localizedValues: z.object({ transitFare: z.object({ text: z.string() }).optional() }).optional(),
  legs: z.array(z.object({ steps: z.array(z.object({
    travelMode: z.string().optional(), navigationInstruction: z.object({ instructions: z.string() }).optional(),
    transitDetails: z.object({ transitLine: z.object({ nameShort: z.string().optional(), name: z.string().optional() }).optional(), stopDetails: z.object({ departureStop: z.object({ name: z.string() }).optional(), arrivalStop: z.object({ name: z.string() }).optional(), departureTime: z.string().optional(), arrivalTime: z.string().optional() }).optional() }).optional(),
  })).default([]) })).default([]),
})).default([]) });

export class RequestBudget {
  matrix = 0;
  routes = 0;
  readonly deadline = Date.now() + 110_000;
  consume(kind: "matrix" | "routes", amount: number) {
    if (Date.now() > this.deadline || this[kind] + amount > (kind === "matrix" ? 1000 : 100)) throw new HttpError(422, "This plan reached its request budget. Use fewer sights or assign them to specific days.");
    this[kind] += amount;
  }
}

async function googleRequest(url: string, fields: string, body?: unknown) {
  if (!process.env.GOOGLE_MAPS_API_KEY) throw new HttpError(503, "The Google Maps server key is not configured.");
  const response = await fetch(url, {
    method: body ? "POST" : "GET", cache: "no-store", signal: AbortSignal.timeout(12_000),
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY, "X-Goog-FieldMask": fields },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const detail = await response.clone().json().catch(() => null) as { error?: { status?: string; message?: string; details?: { reason?: string }[] } } | null;
    console.error("[google-maps]", response.status, detail?.error?.status, detail?.error?.details?.[0]?.reason, detail?.error?.message);
  }
  if (!response.ok) throw new HttpError(response.status === 429 ? 429 : 502, response.status === 429 ? "Google Maps quota reached. Try again later." : "Google Maps could not complete the request. Check the enabled APIs and key restrictions.");
  return response.json();
}

function normalizePlace(value: z.infer<typeof placeResponse>): Place {
  return { id: value.id, name: value.displayName.text, address: value.formattedAddress ?? "", location: { lat: value.location.latitude, lng: value.location.longitude }, timeZone: value.timeZone?.id };
}

export async function searchPlaces(query: string): Promise<Place[]> {
  const body = await googleRequest("https://places.googleapis.com/v1/places:searchText", "places.id,places.displayName,places.formattedAddress,places.location", { textQuery: query, pageSize: 5 });
  return z.object({ places: z.array(placeResponse).default([]) }).parse(body).places.map(normalizePlace);
}

export async function placeDetails(id: string) {
  const body = await googleRequest(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`, "id,displayName,formattedAddress,location,timeZone");
  return normalizePlace(placeResponse.parse(body));
}

function minutesFromDuration(duration: string) {
  if (!/^\d+(\.\d+)?s$/.test(duration)) throw new HttpError(502, "Google returned an invalid travel time.");
  return Math.ceil(Number(duration.slice(0, -1)) / 60);
}

export async function computeLeg(trip: Trip, day: number, from: string, to: string, mode: TravelMode, departure: number, places: Record<string, Place>, budget: RequestBudget): Promise<TravelEdge | null> {
  budget.consume("routes", 1);
  if (mode === "TRANSIT") {
    const delta = instantForMinute(trip, day, departure).epochMilliseconds - Date.now();
    if (delta < -7 * 86_400_000 || delta > 100 * 86_400_000) return null;
  }
  const body = await googleRequest("https://routes.googleapis.com/directions/v2:computeRoutes", "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.steps.travelMode,routes.legs.steps.navigationInstruction,routes.legs.steps.transitDetails,routes.localizedValues.transitFare", {
    origin: { placeId: places[from].id }, destination: { placeId: places[to].id }, travelMode: mode,
    ...(mode === "TRANSIT" ? { departureTime: instantForMinute(trip, day, departure).toString() } : {}),
  });
  const route = routeResponse.parse(body).routes[0];
  if (!route) return null;
  return {
    day, from, to, mode, minutes: minutesFromDuration(route.duration), meters: route.distanceMeters,
    polyline: route.polyline?.encodedPolyline, fare: route.localizedValues?.transitFare?.text,
    steps: route.legs.flatMap((leg) => leg.steps.map((step) => ({
      instruction: step.navigationInstruction?.instructions ?? "", mode: step.travelMode ?? mode,
      line: step.transitDetails?.transitLine?.nameShort ?? step.transitDetails?.transitLine?.name,
      from: step.transitDetails?.stopDetails?.departureStop?.name, to: step.transitDetails?.stopDetails?.arrivalStop?.name,
      departure: step.transitDetails?.stopDetails?.departureTime, arrival: step.transitDetails?.stopDetails?.arrivalTime,
    }))),
  };
}

async function matrixRow(trip: Trip, day: number, from: string, targets: string[], mode: TravelMode, places: Record<string, Place>, budget: RequestBudget): Promise<TravelEdge[]> {
  if (!targets.length) return [];
  budget.consume("matrix", targets.length);
  const response = await googleRequest("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", "originIndex,destinationIndex,status,condition,duration,distanceMeters", {
    origins: [{ waypoint: { placeId: places[from].id } }],
    destinations: targets.map((target) => ({ waypoint: { placeId: places[target].id } })),
    travelMode: mode, ...(mode === "TRANSIT" ? { departureTime: instantAt(trip, day, trip.dailyStart).toString() } : {}),
  });
  const entries = z.array(z.object({ destinationIndex: z.number().int(), condition: z.string().optional(), status: z.object({ code: z.number().optional() }).optional(), duration: z.string().optional(), distanceMeters: z.number().optional() })).parse(response);
  return entries.flatMap((entry): TravelEdge[] => {
    if (entry.status?.code || entry.condition !== "ROUTE_EXISTS" || !entry.duration || !targets[entry.destinationIndex]) return [];
    return [{ day, from, to: targets[entry.destinationIndex], mode, minutes: minutesFromDuration(entry.duration), meters: entry.distanceMeters ?? 0 }];
  });
}

async function mapConcurrent<Value, Result>(values: Value[], action: (value: Value) => Promise<Result>) {
  const results: Result[] = [];
  for (let offset = 0; offset < values.length; offset += 5) results.push(...await Promise.all(values.slice(offset, offset + 5).map(action)));
  return results;
}

export async function planWithGoogle(trip: Trip) {
  if (!trip.hotelPlaceId || trip.stops.some((stop) => !stop.placeId)) throw new HttpError(400, "Confirm the hotel and every place on the map before planning.");
  if (!trip.stops.length) throw new HttpError(400, "Add at least one place to visit.");
  const ids = ["hotel", ...trip.stops.map((stop) => stop.id)];
  const places: Record<string, Place> = {};
  const details = await mapConcurrent([trip.hotelPlaceId, ...trip.stops.map((stop) => stop.placeId!)], placeDetails);
  ids.forEach((id, index) => { places[id] = details[index]; });
  if (places.hotel.timeZone && places.hotel.timeZone !== trip.timeZone) throw new HttpError(400, `The hotel timezone is ${places.hotel.timeZone}. Update the trip timezone before planning.`);
  const budget = new RequestBudget();
  const walking = (await mapConcurrent(ids, (from) => matrixRow(trip, 0, from, ids.filter((to) => to !== from), "WALK", places, budget))).flat();
  let edges: TravelEdge[] = Array.from({ length: trip.days }, (_, day) => walking.map((edge) => ({ ...edge, day }))).flat();
  const warnings = ["Opening hours have not been verified. Check venue hours and ticket conditions.", "Transit schedules and fares can change. Refresh before departure."];
  const transitTargets = Math.max(0, Math.floor((1000 - budget.matrix) / (trip.days * ids.length)));
  for (let day = 0; day < trip.days; day++) {
    const delta = instantAt(trip, day, trip.dailyStart).epochMilliseconds - Date.now();
    if (delta < -7 * 86_400_000 || delta > 100 * 86_400_000) {
      if (trip.stops.some((stop) => stop.mode === "TRANSIT" && (stop.day === null || stop.day === day))) throw new HttpError(422, "Transit-only stops fall outside Google's routing horizon. Change the dates or transport preference.");
      warnings.push(`Day ${day + 1}: transit is outside the available date range; walking only.`);
      continue;
    }
    const rows = await mapConcurrent(ids, (from) => {
      const targets = ids.filter((to) => to !== from).sort((left, right) => {
        const leftRequired = trip.stops.find((stop) => stop.id === left)?.mode === "TRANSIT" ? 1 : 0;
        const rightRequired = trip.stops.find((stop) => stop.id === right)?.mode === "TRANSIT" ? 1 : 0;
        const duration = (to: string) => walking.find((edge) => edge.from === from && edge.to === to)?.minutes ?? 1000;
        return rightRequired - leftRequired || duration(right) - duration(left);
      }).slice(0, transitTargets);
      return matrixRow(trip, day, from, targets, "TRANSIT", places, budget);
    });
    edges.push(...rows.flat());
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    let schedule: Schedule;
    try { schedule = await solveTrip(trip, edges); } catch (error) {
      if (error instanceof PlanningError) throw new HttpError(422, `${error.message} Transit candidates are budget-limited; this is not proof that no alternative exists.`);
      throw error;
    }
    for (const day of schedule.days) {
      let departure = minuteAt(trip, day.day, trip.dailyStart);
      let from = "hotel";
      for (const visit of day.visits) {
        const stop = trip.stops.find((candidate) => candidate.id === visit.stopId)!;
        const modes: TravelMode[] = stop.mode === "AUTO" ? ["WALK", "TRANSIT"] : [stop.mode];
        const options = (await Promise.all(modes.map((mode) => computeLeg(trip, day.day, from, stop.id, mode, departure, places, budget)))).filter((edge): edge is TravelEdge => edge !== null);
        edges = edges.filter((edge) => !(edge.day === day.day && edge.from === from && edge.to === stop.id && modes.includes(edge.mode)));
        edges.push(...options);
        const best = options.sort((left, right) => left.minutes - right.minutes)[0];
        if (!best) { visit.leg.minutes = Number.POSITIVE_INFINITY; break; }
        visit.leg = { ...best, alternatives: options.filter((option) => option !== best) };
        visit.start = stop.fixedTime ? minuteAt(trip, day.day, stop.fixedTime) : Math.max(visit.start, departure + best.minutes);
        visit.end = visit.start + stop.duration;
        departure = visit.end;
        from = stop.id;
      }
      if (trip.returnToHotel && day.visits.length && Number.isFinite(day.visits.at(-1)?.leg.minutes)) {
        const options = (await Promise.all((["WALK", "TRANSIT"] as const).map((mode) => computeLeg(trip, day.day, from, "hotel", mode, departure, places, budget)))).filter((edge): edge is TravelEdge => edge !== null);
        edges = edges.filter((edge) => !(edge.day === day.day && edge.from === from && edge.to === "hotel"));
        edges.push(...options);
        const best = options.sort((left, right) => left.minutes - right.minutes)[0];
        day.returnLeg = best ? { ...best, alternatives: options.filter((option) => option !== best) } : undefined;
      }
    }
    if (!validateSchedule(trip, schedule).length) {
      schedule.warnings = [...new Set(warnings)];
      return { schedule, places, verified: true };
    }
  }
  throw new HttpError(422, "Transit timing changed enough to break the schedule. Add more time between bookings or assign fewer sights to each day.");
}