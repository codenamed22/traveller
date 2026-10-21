import "server-only";
import { writeFile } from "node:fs/promises";
import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { allowsTravelEdge, allowsVisitPair, applyPlanningFixes, assumedGroupEdge, dayEnd, dayStart, directDeparture, endpointKey, groupAllowedDays, instantAt, instantForMinute, minuteAt, planningPreferences, returnDeadline, stopAllowedOnDay, travelModes, tripDate, tripForDay, type BookingTravelCheck, type Place, type PlanningFailureCode, type PlanningFix, type ProvisionalPlan, type SavedPlan, type Schedule, type TravelEdge, type TravelMode, type Trip } from "./trip";
import { HttpError } from "./server";
import { blockedDayFixes, kmBetween, solveTrip, solveTripByDays, PlanningError, squeezeIns, travelEstimator, twoLegBound, sampledRouteGaps, sampledRouteReachability, visitsOutsideHours, type SolverStage } from "./planner";
import { validateSchedule } from "./schedule-validation";
import { assignDays } from "./days";
import { solveTripWithOrTools } from "./ortools";
import { alternativeGroups, isRequiredStop, usesVisitTiming } from "./visit-slots";
import { RouteSamples } from "./route-samples";
import { liveRouteKey, recoveryContext, recoveryInputErrors, recoveryMinute, remainingIds, validateDayRecovery, type RecoveryOption, type RecoveryRequest, type RecoveryResult } from "./day-recovery";

const jointPlanningLimit = 25;

const openingPointResponse = z.object({ day: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(24), minute: z.number().int().min(0).max(59) });
const placeResponse = z.object({
  id: z.string(), displayName: z.object({ text: z.string() }), formattedAddress: z.string().optional(), location: z.object({ latitude: z.number(), longitude: z.number() }), timeZone: z.object({ id: z.string() }).optional(),
  primaryType: z.string().max(100).optional(), types: z.array(z.string().max(100)).max(50).optional(),
  regularOpeningHours: z.object({ periods: z.array(z.object({ open: openingPointResponse, close: openingPointResponse.optional() })).max(50).default([]) }).optional(),
  businessStatus: z.string().max(50).optional(),
});
const routeResponse = z.object({ routes: z.array(z.object({
  duration: z.string(), distanceMeters: z.number().default(0), polyline: z.object({ encodedPolyline: z.string() }).optional(),
  localizedValues: z.object({ transitFare: z.object({ text: z.string().optional() }).optional() }).optional(),
  legs: z.array(z.object({ steps: z.array(z.object({
    travelMode: z.string().optional(), navigationInstruction: z.object({ instructions: z.string().optional() }).optional(),
    transitDetails: z.object({ transitLine: z.object({ nameShort: z.string().optional(), name: z.string().optional() }).optional(), stopDetails: z.object({ departureStop: z.object({ name: z.string() }).optional(), arrivalStop: z.object({ name: z.string() }).optional(), departureTime: z.string().optional(), arrivalTime: z.string().optional() }).optional() }).optional(),
  })).default([]) })).default([]),
})).default([]) });

export class PlanningFailure extends HttpError {
  constructor(public readonly code: PlanningFailureCode, message: string, public readonly provisional?: ProvisionalPlan, public readonly fixes: PlanningFix[] = []) { super(code === "provider-error" ? 502 : 422, message); }
}

export class RequestBudget {
  matrix = 0;
  routes = 0;
  readonly matrixQueries = new Map<string, { outcome: "available" | "noRoute" | "providerError" | "excluded"; statusCode?: number }>();
  readonly transitProxy = new Map<number, string>();
  readonly deadline: number;
  // Where a destination really is on a day: on a direct departure day "hotel" is the station.
  endpoint?: (day: number, to: string) => string;
  constructor(private readonly routeLimit = 100, private readonly signal?: AbortSignal, private readonly limits = { matrix: 1000, milliseconds: 110_000 }) { this.deadline = Date.now() + limits.milliseconds; }
  requestSignal() { return AbortSignal.any([AbortSignal.timeout(Math.max(1, this.deadline - Date.now())), ...(this.signal ? [this.signal] : [])]); }
  matrixKey(day: number, from: string, to: string, mode: TravelMode, departure: number) {
    return JSON.stringify([mode === "WALK" ? 0 : day, from, this.endpoint?.(day, to) ?? to, mode, mode === "WALK" ? 0 : departure]);
  }
  matrixDiagnostics() {
    const summary = { elements: this.matrix, available: 0, noRoute: 0, providerError: 0, excluded: 0, statusCodes: {} as Record<string, number> };
    for (const query of this.matrixQueries.values()) {
      summary[query.outcome]++;
      if (query.statusCode) summary.statusCodes[query.statusCode] = (summary.statusCodes[query.statusCode] ?? 0) + 1;
    }
    return summary;
  }
  consume(kind: "matrix" | "routes", amount: number) {
    if (this.signal?.aborted) throw new HttpError(499, "The planning request was cancelled.");
    if (Date.now() > this.deadline || this[kind] + amount > (kind === "matrix" ? this.limits.matrix : this.routeLimit)) throw new PlanningFailure("budget-exhausted", "This plan reached its request budget. Use fewer sights or assign them to specific days.");
    this[kind] += amount;
  }
}

// Google rejects a place id that is mistyped or no longer exists; the caller names the place it belongs to.
class InvalidPlaceIdError extends HttpError {
  constructor(public placeId: string) { super(422, "A place's map link is no longer valid. Find it on the map again."); }
}

type GoogleErrorBody = { error?: { status?: string; message?: string; details?: { reason?: string }[] } } | null;

// What to tell the traveller when Google refuses a request. Only a problem with the key points at the key's settings;
// Google's own message stays in the server log.
function googleFailure(status: number, detail: GoogleErrorBody): HttpError {
  const code = detail?.error?.status ?? "";
  const reason = detail?.error?.details?.find((entry) => entry.reason)?.reason ?? "";
  if (status === 429 || code === "RESOURCE_EXHAUSTED") return new HttpError(429, "Google Maps quota reached. Try again later.");
  if (reason === "API_KEY_INVALID") return new HttpError(502, "The Google Maps key isn't valid. Check GOOGLE_MAPS_API_KEY.");
  if (reason === "SERVICE_DISABLED") return new HttpError(502, "A Google Maps API this needs is turned off for the key's project. Enable Places API (New) and Routes API in Google Cloud.");
  if (reason === "BILLING_DISABLED") return new HttpError(502, "Billing is turned off for the Google Maps project. Turn it on in Google Cloud.");
  if (reason.startsWith("API_KEY_")) return new HttpError(502, "The Google Maps key's restrictions block this request. Allow Places API (New) and Routes API, and this server, in the key's settings.");
  if (status === 401 || status === 403 || code === "PERMISSION_DENIED") return new HttpError(502, "Google Maps refused the key for this request. Check that Places API (New) and Routes API are enabled and allowed for the key.");
  if (status >= 500) return new HttpError(502, "Google Maps is having trouble right now. Try again in a minute.");
  return new HttpError(502, "Google Maps couldn't process this request. Try again, and if it keeps happening, check the places and stations on the map.");
}

async function googleRequest(url: string, fields: string | undefined, body?: unknown, signal?: AbortSignal) {
  if (!process.env.GOOGLE_MAPS_API_KEY) throw new HttpError(503, "Route services are unavailable. Check your connections.");
  let response: Response;
  try {
    response = await fetch(url, {
      method: body ? "POST" : "GET", cache: "no-store", signal: AbortSignal.any([AbortSignal.timeout(12_000), ...(signal ? [signal] : [])]),
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY, ...(fields ? { "X-Goog-FieldMask": fields } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new HttpError(504, "Google Maps took too long to answer. Try again.");
    throw error;
  }
  if (!response.ok) {
    const detail = await response.clone().json().catch(() => null) as GoogleErrorBody;
    console.error("[google-maps]", response.status, detail?.error?.status, detail?.error?.details?.[0]?.reason, detail?.error?.message);
    // A mistyped place id is rejected as invalid; a well-formed one for a place that is gone is not found.
    const place = (response.status === 400 && detail?.error?.message?.match(/Place ID: (\S+) is not valid/))
      || (response.status === 404 && url.match(/places\.googleapis\.com\/v1\/places\/([^/?:]+)$/));
    if (place) throw new InvalidPlaceIdError(decodeURIComponent(place[1]));
    throw googleFailure(response.status, detail);
  }
  return response.json();
}

function normalizePlace(value: z.infer<typeof placeResponse>): Place {
  const point = ({ day, hour, minute }: z.infer<typeof openingPointResponse>) => ({ day, hour, minute });
  const hours = value.regularOpeningHours?.periods.map((period) => ({ open: point(period.open), ...(period.close ? { close: point(period.close) } : {}) }));
  return {
    id: value.id, name: value.displayName.text, address: value.formattedAddress ?? "", location: { lat: value.location.latitude, lng: value.location.longitude }, timeZone: value.timeZone?.id,
    ...(value.primaryType ? { primaryType: value.primaryType } : {}), ...(value.types?.length ? { types: value.types } : {}), ...(hours?.length ? { hours } : {}),
    ...(value.businessStatus === "CLOSED_PERMANENTLY" ? { closed: "permanently" as const } : value.businessStatus === "CLOSED_TEMPORARILY" ? { closed: "temporarily" as const } : {}),
  };
}

// Google finds nothing for some bare names ("Wide Awake Coffee") unless told where to look, so a search near the trip
// is biased towards it. A bias, not a limit: a place named with its own town is still found.
export async function searchPlaces(query: string, near?: { lat: number; lng: number }): Promise<Place[]> {
  const body = await googleRequest("https://places.googleapis.com/v1/places:searchText", "places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus", {
    textQuery: query, pageSize: 5, ...(near ? { locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 50_000 } } } : {}),
  });
  return z.object({ places: z.array(placeResponse).default([]) }).parse(body).places.map(normalizePlace);
}

export async function placeDetails(id: string, signal?: AbortSignal) {
  const body = await googleRequest(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`, "id,displayName,formattedAddress,location,timeZone,primaryType,types,regularOpeningHours,businessStatus", undefined, signal);
  return normalizePlace(placeResponse.parse(body));
}

const photoDetailsResponse = z.object({
  id: z.string(),
  photos: z.array(z.object({
    name: z.string(),
    widthPx: z.number().int().positive().optional(),
    heightPx: z.number().int().positive().optional(),
    authorAttributions: z.array(z.object({ displayName: z.string().optional(), uri: z.string().optional(), photoUri: z.string().optional() })).default([]),
    googleMapsUri: z.string().optional(),
    flagContentUri: z.string().optional(),
  })).default([]),
});

function safeHttpsUrl(value: string | undefined, hosts?: string[]) {
  if (!value) return undefined;
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    if (url.protocol !== "https:" || (hosts && !hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)))) return undefined;
    return url.toString();
  } catch { return undefined; }
}

export async function getPlacePhoto(placeId: string, index: number, signal?: AbortSignal) {
  if (!Number.isInteger(index) || index < 0 || index > 3) throw new HttpError(400, "Choose a photo from the first four results.");
  const details = photoDetailsResponse.parse(await googleRequest(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
    "id,photos",
    undefined,
    signal,
  ));
  if (details.id !== placeId) throw new HttpError(502, "Google returned a different place.");
  const photos = details.photos.slice(0, 4);
  const metadata = photos[index];
  if (!metadata) return { placeId, index, total: photos.length, photo: null };

  const resourcePrefix = `places/${placeId}/photos/`;
  if (!metadata.name.startsWith(resourcePrefix) || metadata.name.includes("..") || metadata.name.includes("?") || metadata.name.includes("#")) {
    throw new HttpError(502, "Google returned an invalid photo reference.");
  }
  const source = safeHttpsUrl(metadata.googleMapsUri);
  const sourceHost = source ? new URL(source).hostname : "";
  if (!source || !(sourceHost === "google.com" || sourceHost.endsWith(".google.com"))) {
    throw new HttpError(502, "Google did not provide a photo source link.");
  }
  const mediaUrl = `https://places.googleapis.com/v1/${metadata.name.split("/").map(encodeURIComponent).join("/")}/media?maxWidthPx=960&maxHeightPx=720&skipHttpRedirect=true`;
  const media = z.object({ photoUri: z.string().url() }).parse(await googleRequest(mediaUrl, undefined, undefined, signal));
  const uri = safeHttpsUrl(media.photoUri, ["googleusercontent.com", "googleapis.com"]);
  if (!uri || new URL(uri).searchParams.has("key")) throw new HttpError(502, "Google returned an invalid photo URL.");
  const authors = metadata.authorAttributions.flatMap((author) => {
    if (!author.displayName?.trim()) return [];
    const profile = safeHttpsUrl(author.uri);
    const avatar = safeHttpsUrl(author.photoUri, ["googleusercontent.com", "googleapis.com"]);
    return [{ displayName: author.displayName, ...(profile ? { uri: profile } : {}), ...(avatar ? { photoUri: avatar } : {}) }];
  });
  if (!authors.length || authors.length !== metadata.authorAttributions.length) throw new HttpError(502, "Google did not provide complete photo attribution.");
  const flagContentUri = safeHttpsUrl(metadata.flagContentUri);
  return {
    placeId,
    index,
    total: photos.length,
    photo: {
      uri,
      ...(metadata.widthPx ? { widthPx: metadata.widthPx } : {}),
      ...(metadata.heightPx ? { heightPx: metadata.heightPx } : {}),
      authors,
      googleMapsUri: source,
      ...(flagContentUri ? { flagContentUri } : {}),
    },
  };
}

function minutesFromDuration(duration: string) {
  if (!/^\d+(\.\d+)?s$/.test(duration)) throw new HttpError(502, "Google returned an invalid travel time.");
  return Math.ceil(Number(duration.slice(0, -1)) / 60);
}

// Transit timetables are usually published only a few weeks ahead.
const timetableLeadDays = 21;

export function timetableProxyDate(trip: Trip, day: number) {
  const date = Temporal.PlainDate.from(tripDate(trip, day));
  const today = Temporal.Now.plainDateISO(trip.timeZone);
  if (Temporal.PlainDate.compare(date, today.add({ days: timetableLeadDays })) <= 0) return null;
  return today.add({ days: ((date.dayOfWeek - today.dayOfWeek + 7) % 7) || 7 }).toString();
}

function departureInstant(trip: Trip, day: number, minute: number, date?: string) {
  const instant = instantForMinute(trip, day, minute);
  if (!date) return instant;
  return Temporal.PlainDate.from(date).toZonedDateTime({ timeZone: trip.timeZone, plainTime: instant.toZonedDateTimeISO(trip.timeZone).toPlainTime() }).toInstant();
}

export async function computeLeg(trip: Trip, day: number, from: string, to: string, mode: TravelMode, departure: number, places: Record<string, Pick<Place, "id">>, budget: RequestBudget, includeDetails = true): Promise<TravelEdge | null> {
  budget.consume("routes", 1);
  if (mode === "TRANSIT") {
    const delta = instantForMinute(trip, day, departure).epochMilliseconds - Date.now();
    if (delta < -7 * 86_400_000 || delta > 100 * 86_400_000) return null;
  }
  const request = async (date?: string) => {
    // Without a language Google picks one from where the request comes from; directions came back in German.
    const body = await googleRequest("https://routes.googleapis.com/directions/v2:computeRoutes", includeDetails ? "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.steps.travelMode,routes.legs.steps.navigationInstruction,routes.legs.steps.transitDetails,routes.localizedValues.transitFare" : "routes.duration,routes.distanceMeters", {
      origin: { placeId: places[from].id }, destination: { placeId: places[endpointKey(trip, day, to, "to")].id }, travelMode: mode, languageCode: "en",
      ...(mode === "TRANSIT" ? { departureTime: departureInstant(trip, day, departure, date).toString() } : {}),
      ...(mode === "TRANSIT" && planningPreferences(trip).transitPreference !== "DEFAULT" ? { transitPreferences: { routingPreference: planningPreferences(trip).transitPreference } } : {}),
    }, budget.requestSignal());
    return routeResponse.parse(body).routes[0];
  };
  const known = mode === "TRANSIT" ? budget.transitProxy.get(day) : undefined;
  let date = known;
  let route = await request(date);
  const proxy = mode === "TRANSIT" && !known ? timetableProxyDate(trip, day) : null;
  if (!route && proxy) {
    budget.consume("routes", 1);
    route = await request(proxy);
    if (route) { date = proxy; budget.transitProxy.set(day, proxy); }
  }
  if (!route) return null;
  return {
    day, from, to, mode, minutes: minutesFromDuration(route.duration), meters: route.distanceMeters,
    ...(mode === "TRANSIT" ? { sampledDeparture: departure } : {}),
    ...(date ? { timetableDate: date } : {}),
    polyline: route.polyline?.encodedPolyline, fare: route.localizedValues?.transitFare?.text,
    steps: route.legs.flatMap((leg) => leg.steps.map((step) => ({
      instruction: step.navigationInstruction?.instructions ?? "", mode: step.travelMode ?? mode,
      line: step.transitDetails?.transitLine?.nameShort ?? step.transitDetails?.transitLine?.name,
      from: step.transitDetails?.stopDetails?.departureStop?.name, to: step.transitDetails?.stopDetails?.arrivalStop?.name,
      departure: step.transitDetails?.stopDetails?.departureTime, arrival: step.transitDetails?.stopDetails?.arrivalTime,
    }))),
  };
}

function recoveryWaypoint(request: RecoveryRequest, id: string, role: "from" | "to" = "from") {
  if (id === "current" && request.origin.location) return { location: { latLng: { latitude: request.origin.location.lat, longitude: request.origin.location.lng } } };
  const actual = id === "current" ? request.origin.id : id;
  const placeId = endpointKey(request.trip, request.day, actual, role) === "departure" ? request.trip.departure!.placeId : actual === "hotel" ? request.trip.hotelPlaceId : request.trip.stops.find((stop) => stop.id === actual)?.placeId;
  if (!placeId) throw new HttpError(400, "Confirm your origin, hotel, and remaining destinations on the map first.");
  return { placeId };
}

export async function freshRouteOptions(request: RecoveryRequest, from: string, to: string, departure: number, budget: RequestBudget): Promise<TravelEdge[]> {
  const modes = travelModes(request.trip, request.trip.stops.find((stop) => stop.id === to));
  if (from === "current" && !request.origin.location && request.origin.id === to) return [{ day: request.day, from, to, mode: modes[0], minutes: 0, meters: 0 }];
  const rows = await Promise.all(modes.map(async (mode) => {
    budget.consume("routes", 1);
    const body = await googleRequest("https://routes.googleapis.com/directions/v2:computeRoutes", "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.steps.travelMode,routes.legs.steps.navigationInstruction,routes.legs.steps.transitDetails,routes.localizedValues.transitFare", {
      origin: recoveryWaypoint(request, from), destination: recoveryWaypoint(request, to, "to"), travelMode: mode, languageCode: "en", computeAlternativeRoutes: true,
      ...(mode === "TRANSIT" ? { departureTime: instantForMinute(request.trip, request.day, departure).toString(), ...(planningPreferences(request.trip).transitPreference !== "DEFAULT" ? { transitPreferences: { routingPreference: planningPreferences(request.trip).transitPreference } } : {}) } : {}),
    }, budget.requestSignal());
    return routeResponse.parse(body).routes.map((route): TravelEdge => ({
      day: request.day, from, to, mode, minutes: minutesFromDuration(route.duration), meters: route.distanceMeters, sampledDeparture: departure,
      polyline: route.polyline?.encodedPolyline, fare: route.localizedValues?.transitFare?.text,
      steps: route.legs.flatMap((leg) => leg.steps.map((step) => ({ instruction: step.navigationInstruction?.instructions ?? "", mode: step.travelMode ?? mode, line: step.transitDetails?.transitLine?.nameShort ?? step.transitDetails?.transitLine?.name, from: step.transitDetails?.stopDetails?.departureStop?.name, to: step.transitDetails?.stopDetails?.arrivalStop?.name, departure: step.transitDetails?.stopDetails?.departureTime, arrival: step.transitDetails?.stopDetails?.arrivalTime }))),
    })).filter((edge) => allowsTravelEdge(request.trip, edge));
  }));
  return rows.flat().sort((left, right) => left.minutes - right.minutes);
}

function retimeRecovery(request: RecoveryRequest, day: Schedule["days"][number], durations: Record<string, number>) {
  let end = recoveryMinute(request.trip, request.day, request.departureAt);
  const visits = day.visits.map((visit) => {
    const stop = request.trip.stops.find((stop) => stop.id === visit.stopId)!;
    const start = stop.fixedTime ? minuteAt(request.trip, request.day, stop.fixedTime) : end + visit.leg.minutes;
    end = start + durations[stop.id];
    return { ...visit, start, end };
  });
  return { ...day, visits };
}

export async function recoverDayWithGoogle(request: RecoveryRequest, signal?: AbortSignal): Promise<RecoveryResult> {
  if (signal?.aborted) throw new HttpError(499, "The recovery request was cancelled.");
  const errors = recoveryInputErrors(request);
  if (errors.length) throw new HttpError(422, errors.join(" "));
  const pending = remainingIds(request.stopIds, request.progress);
  const context = recoveryContext(request);
  const base = { context, departureAt: request.departureAt };
  const budget = new RequestBudget(request.mode === "route" ? 2 : Math.max(12, 6 * (pending.length + 1)), signal, { matrix: 250, milliseconds: request.mode === "route" ? 30_000 : 45_000 });
  const departure = recoveryMinute(request.trip, request.day, request.departureAt);
  const routes = new Map<string, TravelEdge[]>();
  const edges: TravelEdge[] = [];
  const options: RecoveryOption[] = [];
  const fresh = async (from: string, to: string, minute: number) => {
    const key = JSON.stringify([from, to, minute]);
    if (!routes.has(key)) routes.set(key, await freshRouteOptions(request, from, to, minute, budget));
    const choices = routes.get(key)!;
    edges.splice(0, edges.length, ...edges.filter((edge) => edge.from !== from || edge.to !== to), ...choices);
    return choices;
  };
  try {
    if (request.mode === "route") {
      const options = await fresh("current", request.targetId!, departure);
      return { ...base, status: options.length ? "route-checked" : "unresolved", routes: options, checkedAt: new Date().toISOString(), ...(!options.length ? { message: "Google returned no allowed route for this departure. Your plan was kept." } : {}) };
    }
    if (!pending.length && request.trip.returnToHotel) await fresh("current", "hotel", departure);
    if (request.preferredRoute && !(await fresh("current", request.preferredRoute.to, departure)).some((edge) => liveRouteKey(edge) === request.preferredRoute!.key)) return { ...base, status: "unresolved", checkedAt: new Date().toISOString(), message: "The selected next route is no longer available. Refresh it or clear the preference; your plan was kept." };
    const nodes = ["current", ...pending];
    const jobs = nodes.flatMap((from, index) => {
      const targets = [...new Set([...(request.trip.returnToHotel ? ["hotel"] : []), ...(request.preferredRoute && from === "current" ? [request.preferredRoute.to] : []), ...pending.filter((id) => id !== from).sort((left, right) => {
        const source = from === "current" ? request.origin.location ?? (request.origin.id === "hotel" ? request.trip.hotelLocation : request.trip.stops.find((stop) => stop.id === request.origin.id)?.location) : request.trip.stops.find((stop) => stop.id === from)?.location;
        const distance = (id: string) => { const target = request.trip.stops.find((stop) => stop.id === id)?.location; return source && target ? Math.hypot(source.lat - target.lat, source.lng - target.lng) : Math.abs(pending.indexOf(id) - index); };
        return distance(left) - distance(right);
      }).slice(0, 4), ...pending.filter((id) => request.trip.stops.find((stop) => stop.id === id)?.fixedTime).slice(0, 2)])];
      return ["WALK", "TRANSIT"].flatMap((mode) => {
        const allowed = targets.filter((to) => travelModes(request.trip, request.trip.stops.find((stop) => stop.id === to)).includes(mode as TravelMode));
        return allowed.length ? [{ from, targets: allowed, mode: mode as TravelMode }] : [];
      });
    });
    let reserved = 0;
    const bounded = jobs.flatMap((job) => { const targets = job.targets.slice(0, Math.max(0, 250 - reserved)); reserved += targets.length; return targets.length ? [{ ...job, targets }] : []; });
    if (pending.length) await mapConcurrent(bounded, async (job) => {
      budget.consume("matrix", job.targets.length);
      const result = z.array(z.object({ destinationIndex: z.number().int(), condition: z.string().optional(), status: z.object({ code: z.number().optional() }).optional(), duration: z.string().optional(), distanceMeters: z.number().optional() })).parse(await googleRequest("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", "originIndex,destinationIndex,status,condition,duration,distanceMeters", {
        origins: [{ waypoint: recoveryWaypoint(request, job.from) }], destinations: job.targets.map((id) => ({ waypoint: recoveryWaypoint(request, id, "to") })), travelMode: job.mode,
        ...(job.mode === "TRANSIT" ? { departureTime: request.departureAt } : {}),
      }, budget.requestSignal()));
      for (const entry of result) if (entry.condition === "ROUTE_EXISTS" && !entry.status?.code && entry.duration && job.targets[entry.destinationIndex]) {
        const edge: TravelEdge = { day: request.day, from: job.from, to: job.targets[entry.destinationIndex], mode: job.mode, minutes: minutesFromDuration(entry.duration), meters: entry.distanceMeters ?? 0, sampledDeparture: departure };
        if (allowsTravelEdge(request.trip, edge)) edges.push(edge);
      }
    });
    let solverMilliseconds = 0;
    let verificationPasses = 0;
    const variants = ["Keep every visit", ...(Object.keys(request.permissions.minimumDurations).length ? ["Shorten approved visits"] : []), ...(request.permissions.skipIds.length ? ["Skip approved visits"] : [])];
    const remainingCapacity = Math.max(0, planningPreferences(request.trip).maxStopsPerDay - request.progress.completed.length);
    for (const label of variants) {
      if (solverMilliseconds >= 5000 || Date.now() >= budget.deadline || verificationPasses >= 3) break;
      const shorten = label !== "Keep every visit";
      if (remainingCapacity === 0 && pending.length && (label !== "Skip approved visits" || pending.some((id) => !request.permissions.skipIds.includes(id)))) continue;
      const forcedSkips = remainingCapacity === 0 ? pending : [];
      const stops = (remainingCapacity === 0 ? [] : pending).map((id) => request.trip.stops.find((stop) => stop.id === id)!).map((stop) => ({ ...stop, day: 0, durationOptions: undefined, duration: shorten ? request.permissions.minimumDurations[stop.id] ?? request.progress.remaining?.durations[stop.id] ?? stop.duration : request.progress.remaining?.durations[stop.id] ?? stop.duration, optional: label === "Skip approved visits" && request.permissions.skipIds.includes(stop.id), alternativeGroup: null }));
      const single = tripForDay(request.trip, request.day, { dayGroups: undefined, planning: { ...planningPreferences(request.trip), maxStopsPerDay: Math.max(1, remainingCapacity) }, stops });
      for (let attempt = 0; attempt < 2 && verificationPasses < 3 && solverMilliseconds < 5000 && Date.now() < budget.deadline; attempt++) {
      let verifying = false;
      try {
        const started = performance.now();
        let schedule: Schedule;
        try { schedule = await solveTrip(single, edges.filter((edge) => edge.from !== "current" || !request.preferredRoute || edge.to === request.preferredRoute.to && liveRouteKey(edge) === request.preferredRoute.key).map((edge) => ({ ...edge, day: 0 })), Math.max(0.01, (5000 - solverMilliseconds) / 1000 / (variants.length - variants.indexOf(label))), { boundary: { startId: "current", startMinute: Math.ceil(departure) } }); }
        finally { solverMilliseconds += performance.now() - started; }
        let day = { ...schedule.days[0], day: request.day, visits: schedule.days[0].visits.map((visit) => ({ ...visit, leg: { ...visit.leg, day: request.day } })), ...(schedule.days[0].returnLeg ? { returnLeg: { ...schedule.days[0].returnLeg, day: request.day } } : {}) };
        const durations = Object.fromEntries(day.visits.map((visit) => [visit.stopId, Math.round(visit.end - visit.start)]));
        const option: RecoveryOption = { label, day, skipped: [...forcedSkips, ...schedule.omitted], durations };
        for (const stop of [...stops].sort((left, right) => right.priority - left.priority)) {
          if (!durations[stop.id]) continue;
          const original = request.progress.remaining?.durations[stop.id] ?? request.trip.stops.find((entry) => entry.id === stop.id)!.duration;
          const restored = { ...durations, [stop.id]: original };
          const candidate = retimeRecovery(request, day, restored);
          if (!validateDayRecovery({ ...request, preferredRoute: undefined }, { ...option, day: candidate, durations: restored }).length) { durations[stop.id] = original; day = candidate; }
        }
        let from = "current";
        let minute = departure;
        verifying = true; verificationPasses++;
        for (const visit of day.visits) {
          const choices = await fresh(from, visit.stopId, minute);
          const leg = from === "current" && request.preferredRoute ? choices.find((edge) => liveRouteKey(edge) === request.preferredRoute!.key) : choices[0];
          if (!leg) throw new PlanningError("Fresh travel for this departure is unavailable.", "incomplete");
          const stop = request.trip.stops.find((stop) => stop.id === visit.stopId)!;
          if (stop.fixedTime && minute + leg.minutes + stop.buffer > minuteAt(request.trip, request.day, stop.fixedTime) + 0.01) throw new PlanningError("Fresh travel misses a protected booking buffer.", "incomplete");
          visit.leg = leg; visit.start = stop.fixedTime ? minuteAt(request.trip, request.day, stop.fixedTime) : minute + leg.minutes; visit.end = visit.start + durations[stop.id];
          minute = visit.end; from = visit.stopId;
        }
        if (request.trip.returnToHotel) day.returnLeg = (await fresh(from, "hotel", minute))[0];
        option.day = day;
        if (!validateDayRecovery(request, option).length) {
          if (!options.some((other) => JSON.stringify([other.durations, other.skipped, other.day.visits.map((visit) => visit.stopId)]) === JSON.stringify([option.durations, option.skipped, option.day.visits.map((visit) => visit.stopId)]))) options.push(option);
          break;
        }
      } catch (error) { if (!(error instanceof PlanningError)) throw error; if (!verifying) break; }
      }
      if (label === "Keep every visit" && options.length) break;
    }
    if (signal?.aborted) throw new HttpError(499, "The recovery request was cancelled.");
    return { ...base, checkedAt: new Date().toISOString(), status: options.length ? "recovery-checked" : "unresolved", options, ...(!options.length ? { message: "No plan found with today's limits. Keep your plan or allow some visits to be shortened or skipped." } : {}) };
  } catch (error) {
    if (signal?.aborted) throw new HttpError(499, "The recovery request was cancelled.");
    if (error instanceof HttpError || error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) return { ...base, checkedAt: new Date().toISOString(), status: options.length ? "recovery-checked" : "unresolved", ...(options.length ? { options } : {}), message: options.length ? "Further alternatives could not be checked. The independently checked recovery below is retained." : error instanceof HttpError ? error.message : "The live check timed out. Your plan was kept." };
    throw error;
  }
}

// Walking times do not depend on the day, so one walk serves every day, except a walk back to the hotel: on a direct
// departure day that destination is the station.
const sharesWalk = (trip: Trip, edge: TravelEdge, day: number) => endpointKey(trip, day, edge.to, "to") === endpointKey(trip, edge.day, edge.to, "to");

async function matrixRow(trip: Trip, day: number, from: string, requested: string[], mode: TravelMode, places: Record<string, Place>, budget: RequestBudget, departure = dayStart(trip, day)): Promise<TravelEdge[]> {
  // Timetable retries spend budget the batch planners did not reserve, so trim instead of failing the whole preview.
  const targets = requested.slice(0, Math.max(0, 1000 - budget.matrix));
  if (!targets.length) return [];
  const entrySchema = z.array(z.object({ destinationIndex: z.number().int().default(0), condition: z.string().optional(), status: z.object({ code: z.number().optional() }).optional(), duration: z.string().optional(), distanceMeters: z.number().optional() }));
  type Entry = z.infer<typeof entrySchema>[number] & { date?: string };
  const request = async (subset: number[], date?: string): Promise<Entry[]> => {
    budget.consume("matrix", subset.length);
    const result = entrySchema.parse(await googleRequest("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", "originIndex,destinationIndex,status,condition,duration,distanceMeters", {
      origins: [{ waypoint: { placeId: places[from].id } }],
      destinations: subset.map((index) => ({ waypoint: { placeId: places[endpointKey(trip, day, targets[index], "to")].id } })),
      travelMode: mode, ...(mode === "TRANSIT" ? { departureTime: departureInstant(trip, day, departure, date).toString() } : {}),
    }));
    return result.map((entry) => ({ ...entry, destinationIndex: subset[entry.destinationIndex], ...(date ? { date } : {}) }));
  };
  const all = targets.map((_, index) => index);
  const known = mode === "TRANSIT" ? budget.transitProxy.get(day) : undefined;
  const byTarget = new Map((await request(all, known)).map((entry) => [entry.destinationIndex, entry]));
  const proxy = mode === "TRANSIT" && !known ? timetableProxyDate(trip, day) : null;
  const missing = all.filter((index) => byTarget.get(index)?.condition === "ROUTE_NOT_FOUND");
  if (proxy && missing.length && budget.matrix + missing.length <= 1000) {
    const retried = (await request(missing, proxy)).filter((entry) => entry.condition === "ROUTE_EXISTS");
    retried.forEach((entry) => byTarget.set(entry.destinationIndex, entry));
    if (retried.length && !all.some((index) => byTarget.get(index)?.condition === "ROUTE_EXISTS" && !byTarget.get(index)?.date)) budget.transitProxy.set(day, proxy);
  }
  return targets.flatMap((to, index): TravelEdge[] => {
    const entry = byTarget.get(index);
    const key = budget.matrixKey(day, from, to, mode, departure);
    if (!entry || entry.status?.code) {
      budget.matrixQueries.set(key, { outcome: "providerError", statusCode: entry?.status?.code });
      return [];
    }
    if (entry.condition === "ROUTE_NOT_FOUND") {
      budget.matrixQueries.set(key, { outcome: "noRoute" });
      return [];
    }
    if (entry.condition !== "ROUTE_EXISTS" || !entry.duration) {
      budget.matrixQueries.set(key, { outcome: "providerError" });
      return [];
    }
    const edge = { day, from, to, mode, minutes: minutesFromDuration(entry.duration), meters: entry.distanceMeters ?? 0, ...(mode === "TRANSIT" ? { sampledDeparture: departure } : {}), ...(entry.date ? { timetableDate: entry.date } : {}) };
    const allowed = allowsTravelEdge(trip, edge) && edge.minutes <= minuteAt(trip, day, trip.dailyEnd) - minuteAt(trip, day, trip.dailyStart);
    budget.matrixQueries.set(key, { outcome: allowed ? "available" : "excluded" });
    return [edge];
  });
}

async function mapConcurrent<Value, Result>(values: Value[], action: (value: Value) => Promise<Result>) {
  const results: Result[] = [];
  for (let offset = 0; offset < values.length; offset += 5) results.push(...await Promise.all(values.slice(offset, offset + 5).map(action)));
  return results;
}

type GroupRouteEvidence = { groupIndex: number; day: number; direction: "outbound" | "return"; available: number; noRoute: number; providerError: number; excluded: number; unqueried: number; outsideHorizon: number };

function groupRouteEvidence(trip: Trip, budget: RequestBudget): GroupRouteEvidence[] {
  const queries = [...budget.matrixQueries].map(([key, result]) => ({ key: JSON.parse(key) as [number, string, string, TravelMode, number], result }));
  return (trip.dayGroups ?? []).flatMap((group, groupIndex) => groupAllowedDays(trip, group).flatMap((day) => {
    const delta = instantAt(trip, day, trip.dailyStart).epochMilliseconds - Date.now();
    return (["outbound", ...(trip.returnToHotel ? ["return" as const] : [])] as const).map((direction) => {
      const evidence: GroupRouteEvidence = { groupIndex, day, direction, available: 0, noRoute: 0, providerError: 0, excluded: 0, unqueried: 0, outsideHorizon: 0 };
      for (const stop of trip.stops.filter((stop) => group.stopIds.includes(stop.id) && stopAllowedOnDay(trip, stop, day))) {
        for (const mode of travelModes(trip, direction === "outbound" ? stop : undefined)) {
          const found = queries.filter(({ key }) => key[0] === (mode === "WALK" ? 0 : day) && key[1] === (direction === "outbound" ? "hotel" : stop.id) && key[2] === (direction === "outbound" ? stop.id : "hotel") && key[3] === mode);
          if (!found.length) evidence[mode === "TRANSIT" && (delta < -7 * 86_400_000 || delta > 100 * 86_400_000) ? "outsideHorizon" : "unqueried"]++;
          for (const { result } of found) evidence[result.outcome]++;
        }
      }
      return evidence;
    });
  }));
}

function provisionalOutline(trip: Trip, budget: RequestBudget, code: PlanningFailureCode, message: string): ProvisionalPlan {
  const grouped = new Set(trip.dayGroups?.flatMap((group) => group.stopIds));
  const unresolved: ProvisionalPlan["unresolved"] = groupRouteEvidence(trip, budget).filter((entry) => !entry.available).map((entry) => ({
    groupId: trip.dayGroups![entry.groupIndex].id, day: entry.day, direction: entry.direction,
    outcome: entry.providerError ? "providerError" : entry.noRoute ? "noRoute" : entry.outsideHorizon ? "outsideHorizon" : entry.excluded ? "excluded" : "unqueried",
  }));
  if (!unresolved.length) unresolved.push({ direction: code === "verification-failed" ? "verification" : "internal", outcome: "unverified" });
  return {
    status: "provisional", verified: false, code, message,
    outline: [
      ...(trip.dayGroups ?? []).map((group) => ({ groupId: group.id, stopIds: group.stopIds, allowedDays: groupAllowedDays(trip, group) })),
      ...trip.stops.filter((stop) => !grouped.has(stop.id)).map((stop) => ({ stopIds: [stop.id], allowedDays: Array.from({ length: trip.days }, (_, day) => day).filter((day) => stopAllowedOnDay(trip, stop, day)) })),
    ],
    unresolved, warnings: ["Untimed outline only. Day assignment, route order, visit durations and travel have not been verified.", "No saved itinerary was changed."],
  };
}

async function sampleGroupAccess(trip: Trip, places: Record<string, Place>, budget: RequestBudget) {
  const jobs: { day: number; from: string; to: string; mode: TravelMode; departure: number; rank: number }[] = [];
  const queued = new Set<string>();
  for (const group of trip.dayGroups ?? []) {
    const members = trip.stops.filter((stop) => group.stopIds.includes(stop.id));
    const distance = (id: string) => Math.hypot(places[id].location.lat - places.hotel.location.lat, (places[id].location.lng - places.hotel.location.lng) * Math.cos(places.hotel.location.lat * Math.PI / 180));
    const endpoints = [...members].sort((left, right) => distance(left.id) - distance(right.id) || places[left.id].id.localeCompare(places[right.id].id)).slice(0, 3);
    for (const day of groupAllowedDays(trip, group)) {
      const start = dayStart(trip, day);
      const end = dayEnd(trip, day);
      const service = members.filter((stop) => !stop.optional).reduce((total, stop) => total + stop.duration, 0);
      for (const [rank, stop] of endpoints.entries()) {
        if (!stopAllowedOnDay(trip, stop, day)) continue;
        for (const direction of ["outbound", ...(trip.returnToHotel ? ["return"] : [])]) {
          const from = direction === "outbound" ? "hotel" : stop.id;
          const to = direction === "outbound" ? stop.id : "hotel";
          const times = direction === "outbound" ? [start, Math.min(start + 120, end - 5)] : stop.fixedTime ? [minuteAt(trip, day, stop.fixedTime) + stop.duration] : [Math.min(start + service + 90, end - 30), Math.max(start, end - 90)];
          for (const mode of [...travelModes(trip, direction === "outbound" ? stop : undefined)].sort((left) => left === "TRANSIT" ? -1 : 1)) {
            for (const [timeIndex, departure] of [...new Set(times.map((time) => Math.max(start, time)))].entries()) {
              const delta = instantForMinute(trip, day, departure).epochMilliseconds - Date.now();
              if (mode === "TRANSIT" && (delta < -7 * 86_400_000 || delta > 100 * 86_400_000)) continue;
              const key = budget.matrixKey(day, from, to, mode, departure);
              if (queued.has(key) || budget.matrixQueries.has(key)) continue;
              queued.add(key);
              jobs.push({ day, from, to, mode, departure, rank: rank * 8 + timeIndex * 2 + Number(mode === "WALK") });
            }
          }
        }
      }
    }
  }
  return (await mapConcurrent(jobs.sort((left, right) => left.rank - right.rank).slice(0, 160), (job) => matrixRow(trip, job.day, job.from, [job.to], job.mode, places, budget, job.departure))).flat();
}

// Search-only travel estimates for nearby pairs Google was not asked about; actual-departure verification replaces every chosen leg.
// Beyond this a pair is a day trip from the city rather than a trip across it.
const dayTripKm = 10;

export function withEstimates(trip: Trip, places: Record<string, Place>, samples: Pick<RouteSamples, "has">, edges: TravelEdge[], limits: { neighbours: number; walkOnlyKm?: number; cautious?: boolean } = { neighbours: 8 }) {
  const km = (from: string, to: string, day = 0) => kmBetween(places[from].location, (places[endpointKey(trip, day, to, "to")] ?? places[to]).location);
  // Calibrated to how slow Google's sampled routes were for this trip, so estimates are not more optimistic than the
  // city's real travel.
  const estimate = travelEstimator(edges, (edge) => places[edge.from] && places[edge.to] ? km(edge.from, edge.to, edge.day) : undefined, limits.cautious);
  // A day trip's way back is far quicker by train than the city formula: never slower than two real legs via a third place.
  const via = twoLegBound(trip, edges);
  const estimates: TravelEdge[] = [];
  for (let day = 0; day < trip.days; day++) {
    const delta = instantAt(trip, day, trip.dailyStart).epochMilliseconds - Date.now();
    const transitAvailable = delta >= -7 * 86_400_000 && delta <= 100 * 86_400_000;
    const nodes = ["hotel", ...trip.stops.filter((stop) => stopAllowedOnDay(trip, stop, day)).map((stop) => stop.id)];
    for (const from of nodes) {
      const near = nodes.filter((to) => to !== from && allowsVisitPair(trip, from, to) && (limits.walkOnlyKm === undefined || km(from, to, day) <= limits.walkOnlyKm)).sort((left, right) => km(from, left, day) - km(from, right, day)).slice(0, limits.neighbours);
      if (from !== "hotel" && trip.returnToHotel && !near.includes("hotel") && limits.walkOnlyKm === undefined) near.push("hotel");
      for (const to of near) {
        const distance = km(from, to, day);
        for (const mode of travelModes(trip, trip.stops.find((stop) => stop.id === to))) {
          if (samples.has(day, from, to, mode) || (mode === "TRANSIT" && (!transitAvailable || limits.walkOnlyKm !== undefined))) continue;
          const edge: TravelEdge = { day, from, to, mode, estimated: true, meters: Math.round(distance * 1300), minutes: mode === "TRANSIT" ? Math.min(estimate(mode, distance), via(day, from, to)) : estimate(mode, distance) };
          if (allowsTravelEdge(trip, edge)) estimates.push(edge);
        }
      }
      // The walking-only pass still connects a day trip with the city by two real legs via a third place, so an evening
      // out of town can come back to any visit that day, not only the few places sampling happened to pair it with.
      if (limits.walkOnlyKm === undefined || !transitAvailable) continue;
      for (const to of nodes) {
        if (to === from || km(from, to, day) <= dayTripKm || samples.has(day, from, to, "TRANSIT") || !allowsVisitPair(trip, from, to) || !travelModes(trip, trip.stops.find((stop) => stop.id === to)).includes("TRANSIT")) continue;
        const minutes = via(day, from, to);
        const edge: TravelEdge = { day, from, to, mode: "TRANSIT", estimated: true, meters: Math.round(km(from, to, day) * 1300), minutes };
        if (Number.isFinite(minutes) && allowsTravelEdge(trip, edge)) estimates.push(edge);
      }
    }
  }
  return [...edges, ...estimates];
}

async function sampleJointRoutes(trip: Trip, places: Record<string, Place>, budget: RequestBudget, seed: TravelEdge[] = []) {
  const ids = ["hotel", ...trip.stops.map((stop) => stop.id)];
  const stops = new Map(trip.stops.map((stop) => [stop.id, stop]));
  const eligible = (id: string, day: number) => id === "hotel" || stopAllowedOnDay(trip, stops.get(id)!, day);
  const nearest = (from: string, targets: string[]) => {
    const distance = (to: string) => (places[from].location.lat - places[to].location.lat) ** 2 + ((places[from].location.lng - places[to].location.lng) * Math.cos(places[from].location.lat * Math.PI / 180)) ** 2;
    return [...targets].sort((left, right) => distance(left) - distance(right) || places[left].id.localeCompare(places[right].id));
  };
  const order: string[] = [];
  let remaining = ids.filter((id) => id !== "hotel");
  while (remaining.length) {
    const next = nearest(order.at(-1) ?? "hotel", remaining)[0];
    order.push(next); remaining = remaining.filter((id) => id !== next);
  }
  const dayNodes = Array.from({ length: trip.days }, (_, day) => {
    const nodes = order.filter((id) => eligible(id, day));
    const offset = Math.floor(nodes.length * day / trip.days);
    return ["hotel", ...nodes.slice(offset), ...nodes.slice(0, offset)];
  });
  const candidates = (nodes: string[], from: string, mode: TravelMode) => {
    const targets = nodes.filter((to) => to !== from && allowsVisitPair(trip, from, to) && (to !== "hotel" || trip.returnToHotel) && travelModes(trip, stops.get(to)).includes(mode));
    const origin = stops.get(from);
    const bookings = nodes.filter((id) => stops.get(id)?.fixedTime).sort((left, right) => stops.get(left)!.fixedTime!.localeCompare(stops.get(right)!.fixedTime!));
    const nextBooking = from === "hotel" ? bookings[0] : origin?.fixedTime ? bookings[bookings.indexOf(from) + 1] : undefined;
    const anchor = from === "hotel" || origin?.fixedTime ? nodes.find((id) => id !== "hotel" && !stops.get(id)!.fixedTime) : undefined;
    const successor = nodes[(nodes.indexOf(from) + 1) % nodes.length];
    // The closest places come right after the next booking: clustering needs those short legs more than anything else.
    const closest = nearest(from, targets.filter((id) => id !== "hotel"));
    return [...new Set([nextBooking, ...closest.slice(0, 3), anchor, ...(origin?.fixedTime ? ["hotel", successor] : [successor, "hotel"]), ...closest])].filter((id): id is string => id !== undefined && targets.includes(id));
  };
  const transitJobs = dayNodes.flatMap((nodes, day) => nodes.map((from) => {
    const origin = stops.get(from);
    const departure = origin?.fixedTime ? minuteAt(trip, day, origin.fixedTime) + origin.duration : dayStart(trip, day);
    return { day, from, targets: candidates(nodes, from, "TRANSIT").filter((to) => !budget.matrixQueries.has(budget.matrixKey(day, from, to, "TRANSIT", departure))) };
  })).filter((job) => job.targets.length);
  const availableTransitJobs = transitJobs.filter((job) => {
    const delta = instantAt(trip, job.day, trip.dailyStart).epochMilliseconds - Date.now();
    if (delta >= -7 * 86_400_000 && delta <= 100 * 86_400_000) return true;
    if (job.targets.some((to) => travelModes(trip, stops.get(to)).length === 1)) throw new PlanningFailure("missing-data", "Transit-only travel falls outside Google's routing horizon. Change the dates or transport preference.");
    return false;
  });
  const walkingLimit = availableTransitJobs.length ? Math.min(250, Math.max(0, 900 - budget.matrix - 2 * availableTransitJobs.length)) : 900 - budget.matrix;
  const walkJobs = ids.map((from) => {
    const choices = dayNodes.filter((nodes) => nodes.includes(from)).map((nodes) => candidates(nodes, from, "WALK"));
    const targets = Array.from({ length: Math.max(0, ...choices.map((choice) => choice.length)) }, (_, rank) => choices.flatMap((choice) => choice[rank] ? [choice[rank]] : [])).flat();
    return { day: 0, from, targets: [...new Set(targets)].filter((to) => !budget.matrixQueries.has(budget.matrixKey(0, from, to, "WALK", 0))) };
  });
  const allocate = (jobs: { day: number; from: string; targets: string[] }[], limit: number) => {
    const selected = jobs.map((job) => ({ ...job, targets: [] as string[] }));
    for (let rank = 0; limit > 0 && jobs.some((job) => job.targets.length > rank); rank++) {
      for (let index = 0; index < jobs.length && limit > 0; index++) {
        if (jobs[index].targets[rank]) { selected[index].targets.push(jobs[index].targets[rank]); limit--; }
      }
    }
    return selected.filter((job) => job.targets.length);
  };
  const walking = [...seed.filter((edge) => edge.mode === "WALK"), ...(await mapConcurrent(allocate(walkJobs, walkingLimit), (job) => matrixRow(trip, job.day, job.from, job.targets, "WALK", places, budget))).flat()];
  // On a direct departure day the walks "home" go to the station, asked separately.
  const last = trip.days - 1;
  if (directDeparture(trip)) walking.push(...(await mapConcurrent(ids.filter((from) => from !== "hotel" && eligible(from, last) && !budget.matrixQueries.has(budget.matrixKey(last, from, "hotel", "WALK", 0))), (from) => matrixRow(trip, last, from, ["hotel"], "WALK", places, budget))).flat());
  const edges = [...seed.filter((edge) => edge.mode === "TRANSIT"), ...dayNodes.flatMap((_, day) => walking.filter((edge) => eligible(edge.from, day) && eligible(edge.to, day) && sharesWalk(trip, edge, day)).map((edge) => ({ ...edge, day })))];
  edges.push(...(await mapConcurrent(allocate(availableTransitJobs, 900 - budget.matrix), (job) => {
    const origin = stops.get(job.from);
    const departure = origin?.fixedTime ? minuteAt(trip, job.day, origin.fixedTime) + origin.duration : dayStart(trip, job.day);
    return matrixRow(trip, job.day, job.from, job.targets, "TRANSIT", places, budget, departure);
  })).flat());
  return { walking, edges, order };
}

async function repairRouteCoverage(trip: Trip, places: Record<string, Place>, budget: RequestBudget, samples: RouteSamples, limit: number) {
  let edges = samples.select();
  for (let round = 0; round < 5 && budget.matrix < limit && budget.deadline - Date.now() > 15_000; round++) {
    const coverage = sampledRouteReachability(trip, edges);
    const incompleteGroups = (trip.dayGroups ?? []).filter((group) => !coverage.some((day) => groupAllowedDays(trip, group).includes(day.day) && trip.stops.filter((stop) => group.stopIds.includes(stop.id) && !stop.optional).every((stop) => day.outbound.has(stop.id) && (!trip.returnToHotel || day.inbound.has(stop.id)))));
    const missing = trip.stops.filter((stop) => !stop.optional && (incompleteGroups.some((group) => group.stopIds.includes(stop.id)) || !coverage.some((day) => stopAllowedOnDay(trip, stop, day.day) && day.outbound.has(stop.id) && (!trip.returnToHotel || day.inbound.has(stop.id)))));
    if (!missing.length) break;
    const jobs: { day: number; from: string; to: string; mode: TravelMode; departure: number; rank: number }[] = [];
    const queued = new Set<string>();
    for (const [stopIndex, stop] of missing.entries()) {
      const days = coverage.filter((day) => stopAllowedOnDay(trip, stop, day.day));
      for (let offset = 0; offset < days.length; offset++) {
        const day = days[(stopIndex + offset) % days.length];
        for (const direction of ["outbound", "inbound"] as const) {
          if (day[direction].has(stop.id) || (direction === "inbound" && !trip.returnToHotel)) continue;
          const distance = (id: string) => (places[id].location.lat - places[stop.id].location.lat) ** 2 + ((places[id].location.lng - places[stop.id].location.lng) * Math.cos(places[stop.id].location.lat * Math.PI / 180)) ** 2;
          const nearest = [...day[direction]].sort((left, right) => distance(left) - distance(right));
          const peers = [...new Set([...nearest.slice(0, 3), "hotel"])];
          for (const [rank, peer] of peers.entries()) {
            const from = direction === "outbound" ? peer : stop.id;
            const to = direction === "outbound" ? stop.id : peer;
            if (!allowsVisitPair(trip, from, to)) continue;
            const origin = trip.stops.find((candidate) => candidate.id === from);
            const start = dayStart(trip, day.day);
            const departure = origin?.fixedTime ? minuteAt(trip, day.day, origin.fixedTime) + origin.duration : start;
            for (const mode of travelModes(trip, trip.stops.find((candidate) => candidate.id === to))) {
              const departures = mode === "TRANSIT" && !origin?.fixedTime ? [departure, Math.round((start + dayEnd(trip, day.day)) / 2)] : [departure];
              for (const [timeRank, at] of [...new Set(departures)].entries()) {
                const delta = instantForMinute(trip, day.day, at).epochMilliseconds - Date.now();
                if (mode === "TRANSIT" && (delta < -7 * 86_400_000 || delta > 100 * 86_400_000)) continue;
                const key = budget.matrixKey(day.day, from, to, mode, at);
                if (budget.matrixQueries.has(key) || queued.has(key)) continue;
                queued.add(key);
                jobs.push({ day: day.day, from, to, mode, departure: at, rank: rank * 8 + timeRank * 4 + offset });
              }
            }
          }
        }
      }
    }
    const batch = jobs.sort((left, right) => left.rank - right.rank).slice(0, Math.min(20, limit - budget.matrix));
    if (!batch.length) break;
    const results = await mapConcurrent(batch, async (job) => ({ job, edges: await matrixRow(trip, job.day, job.from, [job.to], job.mode, places, budget, job.departure) }));
    for (const { job, edges: found } of results) {
      for (const edge of found) {
        if (job.mode === "WALK") {
          for (const day of coverage) if ([edge.from, edge.to].every((id) => id === "hotel" || day.stops.some((stop) => stop.id === id)) && sharesWalk(trip, edge, day.day)) samples.add({ ...edge, day: day.day });
        } else {
          samples.add(edge);
          if (allowsTravelEdge(trip, edge)) samples.setDeparture(job.day, job.from, job.departure);
        }
      }
    }
    edges = samples.select();
  }
  return edges;
}

// Visits pinned to the same day always share it, so any pair of them (or with the hotel) the sparse sample missed is
// asked of Google directly. Otherwise the search fills the pair with a straight-line estimate, and an estimate that
// runs a few minutes short fails actual-departure verification on a tight day, round after round.
export async function samplePinnedPairs(trip: Trip, places: Record<string, Place>, budget: RequestBudget, samples: RouteSamples, elements: number) {
  const jobs: { day: number; from: string; mode: TravelMode; departure: number; targets: string[] }[] = [];
  for (let day = 0; day < trip.days; day++) {
    const ids = ["hotel", ...trip.stops.filter((stop) => stop.day === day).map((stop) => stop.id)];
    for (const from of ids) {
      const origin = trip.stops.find((stop) => stop.id === from);
      const departure = origin?.fixedTime ? minuteAt(trip, day, origin.fixedTime) + origin.duration : dayStart(trip, day);
      const delta = instantForMinute(trip, day, departure).epochMilliseconds - Date.now();
      for (const mode of ["WALK", "TRANSIT"] as const) {
        if (mode === "TRANSIT" && (delta < -7 * 86_400_000 || delta > 100 * 86_400_000)) continue;
        const targets = ids.filter((to) => to !== from && (to !== "hotel" || trip.returnToHotel) && allowsVisitPair(trip, from, to) && travelModes(trip, trip.stops.find((stop) => stop.id === to)).includes(mode) && !samples.has(day, from, to, mode));
        if (targets.length) jobs.push({ day, from, mode, departure, targets });
      }
    }
  }
  let left = Math.min(elements, 1000 - budget.matrix);
  const limited = jobs.map((job) => { const targets = job.targets.slice(0, Math.max(0, left)); left -= targets.length; return { ...job, targets }; }).filter((job) => job.targets.length);
  const found = await mapConcurrent(limited, (job) => matrixRow(trip, job.day, job.from, job.targets, job.mode, places, budget, job.departure));
  for (const edge of found.flat()) samples.add(edge);
  return samples.select();
}

export function savedPlanRefreshErrors(trip: Trip, plan: SavedPlan): string[] {
  const errors: string[] = [];
  const days = new Set(plan.days.map((day) => day.day));
  const scheduled = plan.days.flatMap((day) => day.stopIds);
  const included = new Set(scheduled);
  const omitted = new Set(plan.omitted);
  if (days.size !== trip.days || days.size !== plan.days.length || plan.days.some((day) => day.day >= trip.days)) errors.push("The saved itinerary no longer matches the trip days.");
  if (included.size !== scheduled.length || omitted.size !== plan.omitted.length || [...included, ...omitted].some((id) => !trip.stops.some((stop) => stop.id === id)) || plan.omitted.some((id) => included.has(id))) errors.push("The saved itinerary contains unknown or repeated visits.");
  const alternatives = alternativeGroups(trip);
  for (const group of alternatives) if (group.required && !group.stopIds.some((id) => included.has(id))) errors.push("The saved itinerary drops every option in a group of alternatives. Replan explicitly.");
  for (const stop of trip.stops) {
    if (!included.has(stop.id) && (isRequiredStop(stop, alternatives) || !omitted.has(stop.id))) errors.push(`${stop.name}: the saved itinerary must explain this visit. Replan explicitly to include it.`);
  }
  for (const day of plan.days) {
    if (day.stopIds.length > planningPreferences(trip).maxStopsPerDay) errors.push(`Day ${day.day + 1}: the saved order exceeds the daily visit limit.`);
    if (day.stopIds.some((id) => { const stop = trip.stops.find((stop) => stop.id === id); return stop && !stopAllowedOnDay(trip, stop, day.day); })) errors.push(`Day ${day.day + 1}: a saved visit's assigned day changed.`);
  }
  for (const group of trip.dayGroups ?? []) {
    const groupedDays = plan.days.filter((day) => day.stopIds.some((id) => group.stopIds.includes(id)));
    if (groupedDays.length > 1 || groupedDays.some((day) => !groupAllowedDays(trip, group).includes(day.day) || (group.exclusive && day.stopIds.some((id) => !group.stopIds.includes(id))))) errors.push(`${group.name}: the saved order no longer satisfies the day-trip constraints.`);
  }
  if (!trip.hotelPlaceId || trip.stops.some((stop) => included.has(stop.id) && !stop.placeId)) errors.push("Confirm the hotel and saved visits on the map before refreshing travel times.");
  return [...new Set(errors)];
}

export async function refreshSavedPlanWithGoogle(trip: Trip, plan: SavedPlan, signal?: AbortSignal) {
  const errors = savedPlanRefreshErrors(trip, plan);
  if (errors.length) throw new PlanningFailure("hard-input-conflict", errors.join(" "));
  if (signal?.aborted) throw new HttpError(499, "The refresh request was cancelled.");
  const nodes = ["hotel", ...plan.days.flatMap((day) => day.stopIds)];
  const legCount = nodes.length - 1 + (trip.returnToHotel ? plan.days.filter((day) => day.stopIds.length).length : 0);
  const budget = new RequestBudget(Math.max(1, 4 * legCount), signal, { matrix: 0, milliseconds: 110_000 });
  const places: Record<string, Place> = {};
  for (const id of nodes) {
    if (signal?.aborted) throw new HttpError(499, "The refresh request was cancelled.");
    const stop = trip.stops.find((stop) => stop.id === id);
    const placeId = id === "hotel" ? trip.hotelPlaceId! : stop!.placeId!;
    const saved = plan.snapshot?.places[id];
    const location = id === "hotel" ? trip.hotelLocation : stop?.location;
    places[id] = saved?.id === placeId ? saved : location ? { id: placeId, name: id === "hotel" ? trip.hotel : stop!.name, address: "", location } : await placeDetails(placeId, budget.requestSignal());
  }
  if (directDeparture(trip)) places.departure = plan.snapshot?.places.departure?.id === trip.departure!.placeId ? plan.snapshot!.places.departure : await placeDetails(trip.departure!.placeId!, budget.requestSignal());
  if (places.hotel.timeZone && places.hotel.timeZone !== trip.timeZone) throw new PlanningFailure("hard-input-conflict", `The hotel timezone is ${places.hotel.timeZone}. Update the trip timezone before refreshing.`);
  const schedule: Schedule = { days: [], omitted: [...plan.omitted], generatedAt: Temporal.Now.instant().toString(), warnings: ["Travel times updated. Days and visit order are unchanged.", "Opening hours have not been verified. Check venue hours and ticket conditions.", "Transit schedules and fares can change. Refresh before departure."] };
  for (const savedDay of [...plan.days].sort((left, right) => left.day - right.day)) {
    let from = "hotel";
    // A day that started early for its morning café leaves the hotel when it did.
    const first = plan.snapshot?.schedule.days.find((entry) => entry.day === savedDay.day)?.visits[0];
    let departure = first?.stopId === savedDay.stopIds[0] ? Math.min(dayStart(trip, savedDay.day), first.start - first.leg.minutes) : dayStart(trip, savedDay.day);
    const day: Schedule["days"][number] = { day: savedDay.day, date: tripDate(trip, savedDay.day), visits: [] };
    const routeTo = async (to: string) => {
      const options = (await Promise.all(travelModes(trip, trip.stops.find((stop) => stop.id === to)).map((mode) => computeLeg(trip, day.day, from, to, mode, departure, places, budget))))
        .filter((edge): edge is TravelEdge => edge !== null && allowsTravelEdge(trip, edge)).sort((left, right) => left.minutes - right.minutes);
      if (!options.length) throw new PlanningFailure("missing-data", `Day ${day.day + 1}: no allowed route was returned for ${from === "hotel" ? trip.hotel : trip.stops.find((stop) => stop.id === from)?.name} to ${to === "hotel" ? trip.hotel : trip.stops.find((stop) => stop.id === to)?.name}. Your saved itinerary was kept.`);
      const selected = options[0];
      if (selected.timetableDate) schedule.warnings.push(`Day ${day.day + 1}: transit uses the timetable of ${selected.timetableDate}, not confirmed service on ${day.date}.`);
      return { ...selected, ...(options.length > 1 ? { alternatives: options.slice(1) } : {}) };
    };
    for (const id of savedDay.stopIds) {
      const stop = trip.stops.find((stop) => stop.id === id)!;
      const leg = await routeTo(id);
      const arrival = departure + leg.minutes + (stop.fixedTime ? stop.buffer : 0);
      const original = plan.snapshot?.schedule.days.find((entry) => entry.day === day.day)?.visits.find((visit) => visit.stopId === id);
      const start = stop.fixedTime ? minuteAt(trip, day.day, stop.fixedTime) : Math.max(arrival, original?.start ?? arrival);
      if (start + 0.01 < arrival || start + stop.duration > dayEnd(trip, day.day)) throw new PlanningFailure("verification-failed", `Day ${day.day + 1}: refreshed travel cannot reach ${stop.name}${stop.fixedTime ? ` at its ${stop.fixedTime} booking with the arrival buffer` : " within sightseeing hours"}. Your saved order, durations and bookings were kept. Replan explicitly to consider a different order.`);
      day.visits.push({ stopId: id, start, end: start + stop.duration, leg });
      from = id; departure = start + stop.duration;
    }
    if (day.visits.length && trip.returnToHotel) day.returnLeg = await routeTo("hotel");
    schedule.days.push(day);
  }
  const issues = validateSchedule(trip, schedule, undefined, places);
  if (issues.length) throw new PlanningFailure("verification-failed", `Refreshed travel does not fit the saved itinerary: ${issues.join(" ")} Your saved plan was kept; replan explicitly to consider changes.`);
  schedule.warnings = [...new Set(schedule.warnings)];
  return { verified: true, schedule, places };
}

export async function checkBookingTravel(trip: Trip): Promise<BookingTravelCheck> {
  const booked = trip.stops.filter((stop) => stop.fixedTime);
  if (!booked.length) return { connections: [], warnings: [] };
  if (!trip.hotelPlaceId || booked.some((stop) => !stop.placeId)) throw new HttpError(400, "Confirm the hotel and fixed bookings on the map before checking travel gaps.");
  const places: Record<string, Pick<Place, "id">> = { hotel: { id: trip.hotelPlaceId }, ...(directDeparture(trip) ? { departure: { id: trip.departure!.placeId! } } : {}) };
  booked.forEach((stop) => { places[stop.id] = { id: stop.placeId! }; });
  const jobs: { day: number; from: string; to: string; departure: number; deadline: number }[] = [];
  for (let day = 0; day < trip.days; day++) {
    let from = "hotel";
    let departure = dayStart(trip, day);
    for (const stop of booked.filter((stop) => stop.day === day).sort((left, right) => left.fixedTime!.localeCompare(right.fixedTime!))) {
      const at = minuteAt(trip, day, stop.fixedTime!);
      jobs.push({ day, from, to: stop.id, departure, deadline: at - stop.buffer });
      from = stop.id; departure = at + stop.duration;
    }
    if (from !== "hotel" && trip.returnToHotel) jobs.push({ day, from, to: "hotel", departure, deadline: returnDeadline(trip, day) });
  }
  // Two modes per connection, each possibly retried on a published timetable.
  const budget = new RequestBudget(4 * (booked.length + trip.days));
  const warnings = ["Direct Google route estimates are advisory; alternative routes may exist. The adjusted plan still requires full route verification."];
  const connections = await mapConcurrent(jobs, async (job) => {
    const modes = travelModes(trip, trip.stops.find((stop) => stop.id === job.to));
    const delta = instantForMinute(trip, job.day, job.departure).epochMilliseconds - Date.now();
    if (modes.includes("TRANSIT") && (delta < -7 * 86_400_000 || delta > 100 * 86_400_000)) warnings.push(`Day ${job.day + 1}: transit estimates are unavailable outside Google's date horizon.`);
    const options = (await Promise.all(modes.map((mode) => computeLeg(trip, job.day, job.from, job.to, mode, job.departure, places, budget, false))))
      .filter((edge): edge is TravelEdge => edge !== null && Number.isFinite(edge.minutes) && allowsTravelEdge(trip, edge)).sort((left, right) => left.minutes - right.minutes);
    return { day: job.day, from: job.from, to: job.to, availableMinutes: Math.round(job.deadline - job.departure), minutes: options[0]?.minutes ?? null, mode: options[0]?.mode ?? null };
  });
  return { connections, warnings: [...new Set(warnings)] };
}

export type PlanningStage = {
  stage: "grouping" | "group-access" | "route-repair" | "sampled-solve" | "later-transit-solve" | "regroup-solve" | "day-diagnostic" | "verification";
  outcome: "ok" | "conflict" | "incomplete" | "error";
  elapsedMs: number;
  stops: number;
  edges: number;
  solver: SolverStage[];
  matrix?: ReturnType<RequestBudget["matrixDiagnostics"]>;
  groups?: GroupRouteEvidence[];
  code?: PlanningFailureCode;
};

export async function planWithGoogle(input: Trip, options: { onStage?: (stage: PlanningStage) => void; signal?: AbortSignal } = {}) {
  if (options.signal?.aborted) throw new HttpError(499, "The planning request was cancelled.");
  const coupled = Boolean(input.dayGroups?.length || input.stops.some((stop) => (stop.durationOptions?.length ?? 0) > 1));
  // OR-Tools does not model opening hours, time-of-day targets or alternatives; decided once place details are known.
  let useOrTools = false;
  let joint = coupled;
  let initialSchedule: Schedule | undefined;
  let debugProblem: { trip: Trip; edges: TravelEdge[] } | undefined;
  // Cleared once verification shows a chosen estimate was wrong; later rounds search only routes Google returned.
  let trustEstimates = true;
  // Why each verification round failed, kept for the development capture.
  const verificationIssues: string[] = [];
  let samples: RouteSamples | undefined = undefined;
  let searchOrder: string[] = [];
  let matrixDiagnostics: (() => ReturnType<RequestBudget["matrixDiagnostics"]>) | undefined = undefined;
  let groupDiagnostics: (() => GroupRouteEvidence[]) | undefined = undefined;
  const stages: PlanningStage[] = [];
  const measure = async <Result>(stage: PlanningStage["stage"], candidate: Trip, edges: TravelEdge[], action: (solver: SolverStage[]) => Promise<Result>) => {
    const started = performance.now();
    const solver: SolverStage[] = [];
    let outcome: PlanningStage["outcome"] = "ok";
    let code: PlanningFailureCode | undefined;
    try { return await action(solver); }
    catch (error) {
      code = error instanceof PlanningError || error instanceof PlanningFailure ? error.code : undefined;
      outcome = error instanceof PlanningError ? error.reason : code === "missing-data" || code === "search-incomplete" || code === "budget-exhausted" ? "incomplete" : "error";
      throw error;
    }
    finally {
      const result = { stage, outcome, elapsedMs: Math.round(performance.now() - started), stops: candidate.stops.length, edges: edges.length, solver, ...(code ? { code } : {}), ...(matrixDiagnostics ? { matrix: matrixDiagnostics() } : {}), ...(groupDiagnostics ? { groups: groupDiagnostics() } : {}) };
      stages.push(result); options.onStage?.(result);
    }
  };
  const solve = (stage: PlanningStage["stage"], candidate: Trip, edges: TravelEdge[], seconds = 5) => measure(stage, candidate, edges, async (solver) => {
    const prepared = joint ? { ...candidate, stops: [...candidate.stops].sort((left, right) => Number(Boolean(right.fixedTime)) - Number(Boolean(left.fixedTime)) || (left.fixedTime && right.fixedTime ? left.day! - right.day! || left.fixedTime.localeCompare(right.fixedTime) : 0) || searchOrder.indexOf(left.id) - searchOrder.indexOf(right.id)) } : candidate;
    const run = (travel: TravelEdge[]) => { debugProblem = { trip: prepared, edges: travel }; return (useOrTools ? solveTripWithOrTools : solveTrip)(prepared, travel, seconds, { onStage: (result) => solver.push(result), initialSchedule: candidate === input ? initialSchedule : undefined, places, ...(useOrTools ? { signal: options.signal, timeoutMs: budget.deadline - Date.now() } : {}) }); };
    // Nearby pairs Google was not asked about get search-only estimates, so short walks between neighbours are never
    // missing from the search; verification replaces every chosen leg with a real route at its departure time.
    const sampled = new Set(edges.map((edge) => `${edge.day}|${edge.from}|${edge.to}|${edge.mode}`));
    const searchEdges = trustEstimates ? withEstimates(prepared, places, samples ?? { has: (day, from, to, mode) => sampled.has(`${day}|${from}|${to}|${mode}`) }, edges, { neighbours: 4, walkOnlyKm: 2.5 }) : edges;
    try { return await run(searchEdges); }
    catch (error) {
      if (!samples || !(error instanceof PlanningError) || error.code === "hard-input-conflict" || budget.deadline - Date.now() < 20_000) throw error;
      // Day by day solves several small problems, each with its own polish, so it gets more time than one joint solve.
      const byDaysSeconds = Math.max(seconds, Math.min(15, (budget.deadline - Date.now()) / 1000 - 25));
      // After a verification failure the day-by-day solves keep their estimates for unsampled pairs, but cautious ones.
      const cautiousEstimates = !trustEstimates;
      try { debugProblem = { trip: prepared, edges: searchEdges }; return await solveTripByDays(prepared, searchEdges, byDaysSeconds, { onStage: (result) => solver.push(result), places, cautiousEstimates }); }
      catch (dayError) {
        if (!(dayError instanceof PlanningError) || dayError.code === "hard-input-conflict") throw error;
        const estimated = withEstimates(prepared, places, samples, edges, { neighbours: 8, cautious: cautiousEstimates });
        debugProblem = { trip: prepared, edges: estimated };
        return solveTripByDays(prepared, estimated, Math.max(seconds, Math.min(15, (budget.deadline - Date.now()) / 1000 - 25)), { onStage: (result) => solver.push(result), places, cautiousEstimates });
      }
    }
  });
  if (!input.hotelPlaceId || input.stops.some((stop) => !stop.placeId)) throw new HttpError(400, "Confirm the hotel and every place on the map before planning.");
  if (!input.stops.length) throw new HttpError(400, "Add at least one place to visit.");
  const ids = ["hotel", ...input.stops.map((stop) => stop.id)];
  const places: Record<string, Place> = {};
  const details = await mapConcurrent([input.hotelPlaceId, ...input.stops.map((stop) => stop.placeId!)], (id) => placeDetails(id, options.signal)).catch((error) => {
    if (!(error instanceof InvalidPlaceIdError)) throw error;
    const name = error.placeId === input.hotelPlaceId ? input.hotel || "The hotel" : input.stops.find((stop) => stop.placeId === error.placeId)?.name;
    throw name ? new HttpError(422, `${name} has a map link Google no longer recognises. Open it, find it on the map again, then plan.`) : error;
  });
  ids.forEach((id, index) => { places[id] = details[index]; });
  if (directDeparture(input)) places.departure = await placeDetails(input.departure!.placeId!, options.signal);
  if (places.hotel.timeZone && places.hotel.timeZone !== input.timeZone) throw new HttpError(400, `The hotel timezone is ${places.hotel.timeZone}. Update the trip timezone before planning.`);
  useOrTools = !coupled && Boolean(process.env.TRAVELLER_ROUTING_PYTHON) && !usesVisitTiming(input, { places });
  joint = useOrTools || coupled;
  const grouped = !joint && input.stops.length > jointPlanningLimit;
  let trip: Trip;
  try { trip = grouped ? await measure("grouping", input, [], () => assignDays(input, Object.fromEntries(Object.entries(places).map(([id, place]) => [id, place.location])), places)) : input; }
  catch (error) { if (error instanceof PlanningError) throw new HttpError(422, error.message); throw error; }
  const budget = new RequestBudget(Math.max(100, 6 * (trip.stops.length + trip.days)), options.signal);
  budget.endpoint = (day, to) => endpointKey(trip, day, to, "to");
  matrixDiagnostics = () => budget.matrixDiagnostics();
  if (trip.dayGroups?.length) groupDiagnostics = () => groupRouteEvidence(trip, budget);
  const failure = (code: PlanningFailureCode, message: string) => new PlanningFailure(code, message, coupled && code !== "hard-input-conflict" ? provisionalOutline(trip, budget, code, message) : undefined);
  try {
  const warnings = ["Google's regular opening hours were applied where available; holiday and special hours were not checked. Confirm venue hours and ticket conditions.", "Transit schedules and fares can change. Refresh before departure."];
  if (grouped) warnings.push("Visits were grouped around bookings and daily limits. A better arrangement may exist.");
  const activeIds = ["hotel", ...trip.stops.map((stop) => stop.id)];
  const dayIds = Array.from({ length: trip.days }, (_, day) => activeIds.filter((id) => id === "hotel" || stopAllowedOnDay(trip, trip.stops.find((stop) => stop.id === id)!, day)));
  const allAssigned = trip.stops.every((stop) => stop.day !== null);
  const transitNeeded = trip.stops.some((stop) => travelModes(trip, stop).includes("TRANSIT")) || (trip.returnToHotel && travelModes(trip).includes("TRANSIT"));
  if (joint && transitNeeded && dayIds.some((_, day) => {
    const delta = instantAt(trip, day, trip.dailyStart).epochMilliseconds - Date.now();
    return delta < -7 * 86_400_000 || delta > 100 * 86_400_000;
  })) warnings.push("Transit outside Google's routing horizon was not sampled; only eligible walking connections are available on those days.");
  const walkingRows = allAssigned ? dayIds.reduce((total, nodes) => total + nodes.length, 0) : activeIds.length;
  const transitReserve = transitNeeded ? dayIds.reduce((total, nodes) => total + 3 * (nodes.length - 1), 0) : 0;
  const walkingTargets = Math.max(1, Math.floor(Math.max(0, 1000 - transitReserve) / walkingRows));
  const distance = (from: string, to: string) => (places[from].location.lat - places[to].location.lat) ** 2 + ((places[from].location.lng - places[to].location.lng) * Math.cos(places[from].location.lat * Math.PI / 180)) ** 2;
  // A greedy nearest-neighbour tour: consecutive places on it are close, and linking each to its tour neighbours keeps
  // every sampled graph connected even when many places are equally near.
  const tour: string[] = [];
  for (let current = "hotel", remaining = trip.stops.map((stop) => stop.id); remaining.length;) {
    current = remaining.reduce((closest, id) => distance(current, id) < distance(current, closest) ? id : closest);
    tour.push(current); remaining = remaining.filter((id) => id !== current);
  }
  const connectedTargets = (nodes: string[], from: string, targets: string[]) => {
    const ring = nodes.filter((id) => id !== "hotel").sort((left, right) => tour.indexOf(left) - tour.indexOf(right));
    const position = ring.indexOf(from);
    const origin = trip.stops.find((stop) => stop.id === from);
    const bookings = trip.stops.filter((stop) => stop.fixedTime && nodes.includes(stop.id) && (from === "hotel" || stop.day === origin?.day))
      .sort((left, right) => left.day! - right.day! || left.fixedTime!.localeCompare(right.fixedTime!));
    const nextBooking = from === "hotel" ? bookings[0]?.id : origin?.fixedTime ? bookings[bookings.findIndex((stop) => stop.id === from) + 1]?.id : undefined;
    const byDistance = [...targets].sort((left, right) => distance(from, left) - distance(from, right));
    const preferred = [nextBooking, "hotel", ...(position >= 0 ? [ring[(position + 1) % ring.length], ring[(position + ring.length - 1) % ring.length]] : []), ...byDistance.slice(0, 2)];
    return [...new Set([...preferred.filter((target): target is string => target !== undefined && targets.includes(target)), ...byDistance])];
  };
  let walking: TravelEdge[];
  let edges: TravelEdge[];
  if (joint) {
    const access: TravelEdge[] = [];
    if (trip.dayGroups?.length) await measure("group-access", trip, access, async () => {
      access.push(...await sampleGroupAccess(trip, places, budget));
      for (const group of trip.dayGroups!.filter((candidate) => candidate.assumedTravelMinutes)) {
        for (const day of groupAllowedDays(trip, group)) for (const id of group.stopIds) for (const [from, to] of [["hotel", id], ...(trip.returnToHotel ? [[id, "hotel"]] : [])]) {
          const assumed = assumedGroupEdge(trip, day, from, to);
          if (assumed && !access.some((edge) => edge.day === day && edge.from === from && edge.to === to && edge.mode === "TRANSIT" && allowsTravelEdge(trip, edge))) access.push(assumed);
        }
      }
      const evidence = groupRouteEvidence(trip, budget);
      const missing = trip.dayGroups!.some((group, groupIndex) => !group.assumedTravelMinutes && group.exclusive && trip.stops.some((stop) => group.stopIds.includes(stop.id) && !stop.optional) && !groupAllowedDays(trip, group).some((day) => evidence.filter((entry) => entry.groupIndex === groupIndex && entry.day === day).every((entry) => entry.available > 0)));
      if (missing) throw failure("missing-data", "The bounded day-trip access samples did not provide outbound and return connections on a common allowed day. This is missing route evidence, not proof that the trip is impossible. Visit durations were not reduced. If Google does not have the transit timetable for these dates yet, set an assumed travel time for the day trip.");
    });
    ({ walking, edges, order: searchOrder } = await sampleJointRoutes(trip, places, budget, access));
  } else if (allAssigned) {
    walking = [];
    for (let day = 0; day < trip.days; day++) {
      walking.push(...(await mapConcurrent(dayIds[day], (from) => matrixRow(trip, day, from, connectedTargets(dayIds[day], from, dayIds[day].filter((to) => to !== from)).slice(0, walkingTargets), "WALK", places, budget))).flat());
    }
    edges = [...walking];
  } else {
    walking = (await mapConcurrent(activeIds, (from) => matrixRow(trip, 0, from, connectedTargets(activeIds, from, activeIds.filter((to) => to !== from)).slice(0, walkingTargets), "WALK", places, budget))).flat();
    if (directDeparture(trip)) walking.push(...(await mapConcurrent(dayIds[trip.days - 1].filter((from) => from !== "hotel"), (from) => matrixRow(trip, trip.days - 1, from, ["hotel"], "WALK", places, budget))).flat());
    edges = Array.from({ length: trip.days }, (_, day) => walking.filter((edge) => sharesWalk(trip, edge, day)).map((edge) => ({ ...edge, day }))).flat();
  }
  const hotelTargets = dayIds.reduce((total, nodes) => total + nodes.length - 1, 0);
  const transitTargets = Math.max(0, Math.floor((1000 - budget.matrix - hotelTargets) / Math.max(1, hotelTargets)));
  if (!joint) for (let day = 0; day < trip.days; day++) {
    const transitStops = trip.stops.filter((stop) => (stop.day === null || stop.day === day) && travelModes(trip, stop).includes("TRANSIT"));
    const transitReturn = trip.returnToHotel && travelModes(trip).includes("TRANSIT");
    if (!transitStops.length && !transitReturn) continue;
    const delta = instantAt(trip, day, trip.dailyStart).epochMilliseconds - Date.now();
    if (delta < -7 * 86_400_000 || delta > 100 * 86_400_000) {
      if (transitStops.some((stop) => travelModes(trip, stop).length === 1) || (transitReturn && travelModes(trip).length === 1)) throw new PlanningFailure("missing-data", "Transit-only travel falls outside Google's routing horizon. Change the dates or transport preference.");
      warnings.push(`Day ${day + 1}: transit is outside the available date range; walking only.`);
      continue;
    }
    const rows = await mapConcurrent(dayIds[day], (from) => {
      const targets = dayIds[day].filter((to) => to !== from && (to === "hotel" ? transitReturn : transitStops.some((stop) => stop.id === to))).sort((left, right) => {
        const leftRequired = travelModes(trip, trip.stops.find((stop) => stop.id === left)).length === 1 ? 1 : 0;
        const rightRequired = travelModes(trip, trip.stops.find((stop) => stop.id === right)).length === 1 ? 1 : 0;
        const duration = (to: string) => walking.find((edge) => edge.from === from && edge.to === to)?.minutes ?? 1000;
        return rightRequired - leftRequired || duration(right) - duration(left);
      });
      return matrixRow(trip, day, from, from === "hotel" ? targets : connectedTargets(dayIds[day], from, targets).slice(0, transitTargets), "TRANSIT", places, budget);
    });
    edges.push(...rows.flat());
  }
  samples = joint ? new RouteSamples(trip, edges) : undefined;
  if (samples) edges = await samplePinnedPairs(trip, places, budget, samples, 120);
  const connectivityLimit = Math.min(1000, budget.matrix + 100);
  let sampledLaterTransit = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (samples && sampledRouteGaps(trip, edges).length) {
      const store = samples;
      try {
        await measure("route-repair", trip, edges, async () => {
          const repaired = await repairRouteCoverage(trip, places, budget, store, connectivityLimit);
          edges.splice(0, edges.length, ...repaired);
          const gaps = sampledRouteGaps(trip, edges);
          if (gaps.length) throw new PlanningError(`Route coverage is incomplete after bounded connection repair. ${gaps.join(" ")} Visit durations were not reduced to conceal missing routes.`, "incomplete", true, "missing-data");
        });
      } catch (error) {
        if (error instanceof PlanningError) throw failure("missing-data", error.message);
        throw error;
      }
    }
    let schedule: Schedule | undefined;
    try { schedule = await solve("sampled-solve", trip, edges); } catch (error) {
      let failure = error;
      if (!sampledLaterTransit && transitNeeded && error instanceof PlanningError && (joint || error.reason === "conflict") && !error.detailed && budget.deadline - Date.now() > 15_000) {
        sampledLaterTransit = true;
        const jobs = dayIds.flatMap((nodes, day) => nodes.filter((from) => from !== "hotel").flatMap((from) => {
          const origin = trip.stops.find((stop) => stop.id === from)!;
          const departure = origin.fixedTime ? minuteAt(trip, day, origin.fixedTime) + origin.duration : Math.round((dayStart(trip, day) + dayEnd(trip, day)) / 2);
          const delta = instantForMinute(trip, day, departure).epochMilliseconds - Date.now();
          if (delta < -7 * 86_400_000 || delta > 100 * 86_400_000) return [];
          const targets = nodes.filter((to) => to !== from && allowsVisitPair(trip, from, to) && (to === "hotel" ? trip.returnToHotel && travelModes(trip).includes("TRANSIT") : travelModes(trip, trip.stops.find((stop) => stop.id === to)).includes("TRANSIT")))
            .sort((left, right) => (walking.find((edge) => edge.from === from && edge.to === left)?.minutes ?? Infinity) - (walking.find((edge) => edge.from === from && edge.to === right)?.minutes ?? Infinity));
          return targets.length ? [{ day, from, departure, targets: connectedTargets(nodes, from, targets) }] : [];
        }));
        const limitedJobs = joint ? jobs.slice(0, Math.min(200, 1000 - budget.matrix)) : jobs;
        const targetLimit = Math.floor(Math.min(200, 1000 - budget.matrix) / Math.max(1, limitedJobs.length));
        if (targetLimit > 0 && limitedJobs.length) {
          const sampled = (await mapConcurrent(limitedJobs, (job) => matrixRow(trip, job.day, job.from, job.targets.slice(0, targetLimit), "TRANSIT", places, budget, job.departure))).flat();
          for (const edge of sampled) {
            if (samples) { samples.add(edge); continue; }
            const matches = (known: TravelEdge) => known.day === edge.day && known.from === edge.from && known.to === edge.to && known.mode === edge.mode;
            if (edges.some((known) => matches(known) && known.minutes <= edge.minutes)) continue;
            edges = edges.filter((known) => !matches(known)); edges.push(edge);
          }
          if (samples) {
            for (const job of limitedJobs) samples.setDeparture(job.day, job.from, job.departure);
            edges = samples.select();
          }
          warnings.push("Routes checked using later transit departures. Final routes verified at scheduled times.");
          try { schedule = await solve("later-transit-solve", trip, edges, 2); }
          catch (repairError) { failure = repairError; }
        }
      }
      if (!schedule && grouped && trip !== input && failure instanceof PlanningError && !failure.detailed) {
        const repairEdges = [...edges, ...Array.from({ length: input.days }, (_, day) => walking.filter((edge) => sharesWalk(trip, edge, day) && !edges.some((known) => known.day === day && known.from === edge.from && known.to === edge.to && known.mode === "WALK")).map((edge) => ({ ...edge, day }))).flat()];
        try {
          schedule = await solve("regroup-solve", input, repairEdges, 2);
          trip = input; edges = repairEdges;
          warnings.push("Day grouping repaired using walking routes. Departure times checked again.");
        } catch (repairError) { failure = repairError; }
      }
      if (!schedule) {
        // Check each day's assigned visits exactly (after any fixes already offered) and add per-visit fixes for the
        // days that still cannot fit, so one round of suggestions is enough. An incomplete search can hide such a day.
        if (failure instanceof PlanningError && !failure.detailed && budget.deadline - Date.now() > 5000) {
          const base = failure.fixes.length ? applyPlanningFixes(input, failure.fixes) : input;
          const sampled = new Set(edges.map((edge) => `${edge.day}|${edge.from}|${edge.to}|${edge.mode}`));
          const extra = await blockedDayFixes(base, withEstimates(base, places, samples ?? { has: (day, from, to, mode) => sampled.has(`${day}|${from}|${to}|${mode}`) }, edges), places, budget.deadline - 3000);
          if (extra.fixes.length) throw new PlanningFailure(failure.code, `${failure.fixes.length ? failure.message : "No schedule fits the visits assigned to these days."} ${extra.blocked.join(" ")} Route candidates are budget-limited; this is not proof that no alternative exists.`, undefined, [...failure.fixes, ...extra.fixes]);
        }
        if (failure instanceof PlanningError && failure.reason === "conflict" && !failure.detailed && !failure.fixes.length && !input.dayGroups?.length && input.days > 1 && input.stops.every((stop) => stop.day !== null)) {
          const blockedDays: string[] = [];
          for (let day = 0; day < input.days; day++) {
            if (budget.deadline - Date.now() < 2000) break;
            const stops = input.stops.filter((stop) => stop.day === day);
            const required = stops.filter((stop) => !stop.optional);
            if (!required.length) continue;
            try {
              await solve("day-diagnostic", tripForDay(input, day, { stops: stops.map((stop) => ({ ...stop, day: 0 })) }), edges.filter((edge) => edge.day === day).map((edge) => ({ ...edge, day: 0 })), 0.5);
            } catch (dayError) {
              if (dayError instanceof PlanningError && dayError.reason === "conflict") blockedDays.push(`Day ${day + 1} (${tripDate(input, day)}): ${required.length} required visits, ${required.reduce((total, stop) => total + stop.duration, 0)} min of visits within ${input.dailyStart}-${input.dailyEnd}, cannot fit with the sampled routes and retained bookings.`);
            }
          }
          if (blockedDays.length) throw new HttpError(422, `${blockedDays.join(" ")} Time flexibility keeps assigned days and required visits unchanged. Review the day assignments, durations, daily hours, or optional-visit choices for these days. Route candidates are budget-limited; this is not proof that no alternative exists.`);
        }
        if (failure instanceof PlanningError) {
          const failures = stages.filter((stage) => stage.outcome !== "ok");
          const history = failures.length > 1 ? ` Search stages: ${failures.map((stage) => `${stage.stage}: ${stage.outcome === "conflict" ? stage.stage === "verification" ? "actual-departure validation failed" : "infeasible on sampled routes" : stage.outcome === "incomplete" ? "search incomplete" : "error"}`).join("; ")}.` : "";
          throw new PlanningFailure(failure.code, failure.detailed ? failure.message : `${failure.message}${history} Day grouping and route candidates are budget-limited; this is not proof that no alternative exists.`, undefined, failure.fixes);
        }
        throw failure;
      }
    }
    initialSchedule = schedule;
    const usedEstimates = schedule.days.some((day) => day.returnLeg?.estimated || day.visits.some((visit) => visit.leg.estimated));
    try { await measure("verification", trip, edges, async () => {
    await Promise.all(schedule.days.map(async (day) => {
      // From the hotel when the day starts, or earlier on a morning that starts early for its café.
      const first = day.visits[0];
      let departure = first ? Math.min(dayStart(trip, day.day), first.start - first.leg.minutes) : dayStart(trip, day.day);
      let from = "hotel";
      for (const visit of day.visits) {
        const stop = trip.stops.find((candidate) => candidate.id === visit.stopId)!;
        const modes = travelModes(trip, stop);
        const found = (await Promise.all(modes.map((mode) => computeLeg(trip, day.day, from, stop.id, mode, departure, places, budget)))).filter((edge): edge is TravelEdge => edge !== null && allowsTravelEdge(trip, edge));
        const assumedLeg = assumedGroupEdge(trip, day.day, from, stop.id);
        const options = found.length || !assumedLeg ? found : [assumedLeg];
        if (samples) {
          samples.setDeparture(day.day, from, departure);
          for (const mode of modes) samples.record(day.day, from, stop.id, mode, departure, options.find((edge) => edge.mode === mode) ?? null);
        } else {
          edges = edges.filter((edge) => !(edge.day === day.day && edge.from === from && edge.to === stop.id && modes.includes(edge.mode)));
          edges.push(...options);
        }
        const best = options.sort((left, right) => left.minutes - right.minutes)[0];
        if (!best) { visit.leg.minutes = Number.POSITIVE_INFINITY; break; }
        const selectedDuration = visit.end - visit.start;
        visit.leg = { ...best, alternatives: options.filter((option) => option !== best) };
        visit.start = stop.fixedTime ? minuteAt(trip, day.day, stop.fixedTime) : Math.max(visit.start, departure + best.minutes);
        visit.end = visit.start + selectedDuration;
        departure = visit.end;
        from = stop.id;
      }
      if (trip.returnToHotel && day.visits.length && Number.isFinite(day.visits.at(-1)?.leg.minutes)) {
        const found = (await Promise.all(travelModes(trip).map((mode) => computeLeg(trip, day.day, from, "hotel", mode, departure, places, budget)))).filter((edge): edge is TravelEdge => edge !== null && allowsTravelEdge(trip, edge));
        const assumedLeg = assumedGroupEdge(trip, day.day, from, "hotel");
        const options = found.length || !assumedLeg ? found : [assumedLeg];
        if (samples) {
          samples.setDeparture(day.day, from, departure);
          for (const mode of travelModes(trip)) samples.record(day.day, from, "hotel", mode, departure, options.find((edge) => edge.mode === mode) ?? null);
        } else {
          edges = edges.filter((edge) => !(edge.day === day.day && edge.from === from && edge.to === "hotel"));
          edges.push(...options);
        }
        const best = options.sort((left, right) => left.minutes - right.minutes)[0];
        day.returnLeg = best ? { ...best, alternatives: options.filter((option) => option !== best) } : undefined;
      }
    }));
    const issues = validateSchedule(trip, schedule, undefined, places);
    if (schedule.days.some((day) => day.returnLeg?.estimated || day.visits.some((visit) => visit.leg.estimated))) issues.push("An estimated leg was not replaced by a Google route.");
    if (visitsOutsideHours(trip, schedule, places).length) issues.push("Actual travel moved a visit outside its opening hours.");
    if (issues.length) { verificationIssues.push(issues.join(" ")); throw new PlanningError("Actual-departure verification failed.", "conflict", false, "verification-failed"); }
    }); } catch (error) {
      if (!(error instanceof PlanningError)) throw error;
      if (usedEstimates) trustEstimates = false;
      if (samples) edges = samples.select();
      continue;
    }
    if (!validateSchedule(trip, schedule, undefined, places).length) {
      schedule.omitted.push(...input.stops.filter((stop) => !trip.stops.some((retained) => retained.id === stop.id)).map((stop) => stop.id));
      const errors = validateSchedule(input, schedule, undefined, places);
      if (errors.length) throw new HttpError(422, errors.join(" "));
      const fits = squeezeIns(input, schedule, samples ? samples.select() : edges, places);
      if (fits.length) schedule.squeezeIns = fits;
      const changes = schedule.days.flatMap((day) => day.visits).map((visit) => input.stops.find((stop) => stop.id === visit.stopId)!.duration - (visit.end - visit.start)).filter((minutes) => minutes > 0);
      if (changes.length) warnings.push(`${changes.length} visit${changes.length === 1 ? "" : "s"} shortened by ${changes.reduce((total, minutes) => total + minutes, 0)} minutes in total, within your approved duration choices.`);
      const assumedLegs = schedule.days.flatMap((day) => [...day.visits.map((visit) => visit.leg), ...(day.returnLeg ? [day.returnLeg] : [])]).filter((leg) => leg.assumed).length;
      const proxyLegs = schedule.days.flatMap((day) => [...day.visits.map((visit) => visit.leg), ...(day.returnLeg ? [day.returnLeg] : [])]).filter((leg) => leg.timetableDate);
      if (proxyLegs.length) warnings.push(`${proxyLegs.length} transit leg${proxyLegs.length === 1 ? " uses" : "s use"} the same weekday's timetable (${[...new Set(proxyLegs.map((leg) => leg.timetableDate))].sort().join(", ")}), not confirmed service on your trip dates. Holiday changes may not be reflected. Refresh travel times closer to departure.`);
      const closed = input.stops.filter((stop) => places[stop.id]?.closed);
      for (const stop of closed) warnings.push(`${stop.name} is marked ${places[stop.id].closed} closed on Google Maps. Check it, or find the place on the map again.`);
      if (assumedLegs) warnings.push(`${assumedLegs} day-trip leg${assumedLegs === 1 ? " uses" : "s use"} your assumed travel time because Google returned no transit route for those dates. Check the train timetable and refresh the plan closer to the trip.`);
      schedule.warnings = [...new Set([...schedule.warnings, ...warnings])];
      // Development only: keep the last solved problem so a surprising itinerary can be replayed offline.
      if (process.env.NODE_ENV === "development" && debugProblem) await writeFile("/tmp/traveller-plan-last.json", JSON.stringify({ ...debugProblem, places, stages })).catch(() => undefined);
      return { status: "verified" as const, schedule, places, verified: true as const };
    }
  }
  // Name what the last check found, so the traveller knows which visit or day to give more room.
  const lastCheck = verificationIssues.at(-1) ? ` With actual departure times: ${verificationIssues.at(-1)}${/outside sightseeing hours/.test(verificationIssues.at(-1)!) ? ` Try a later Sightseeing ends than ${input.dailyEnd} or fewer visits that day.` : ""}` : "";
  throw failure("verification-failed", joint ? `No itinerary passed actual-departure verification within the repair budget.${lastCheck} This does not prove the trip is impossible; no itinerary was changed.` : `Transit timing changed enough to break the schedule.${lastCheck} Add more time between bookings or assign fewer sights to each day.`);
  } catch (error) {
    if (error instanceof PlanningFailure && process.env.NODE_ENV === "development" && debugProblem) {
      await writeFile("/tmp/traveller-plan-debug.json", JSON.stringify({ ...debugProblem, places, stages, failure: error.message, verificationIssues })).catch(() => undefined);
    }
    // A failure with one-click fixes stays an error so the fixes reach the user instead of a provisional outline.
    if (error instanceof PlanningFailure) throw error.provisional || !coupled || error.fixes.length ? error : failure(error.code, error.message);
    if (error instanceof HttpError && (error.status >= 500 || error.status === 429)) throw failure("provider-error", error.message);
    if (error instanceof HttpError && error.status === 422 && coupled) throw failure(stages.findLast((stage) => stage.code)?.code ?? "search-incomplete", error.message);
    throw error;
  }
}
