import { afterEach, describe, expect, it, vi } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import { instantAt, minuteAt, newStop, newTrip, planningPreferences, type Trip } from "./trip";

vi.mock("server-only", () => ({}));
vi.mock("./server", () => ({ HttpError: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { checkBookingTravel, getPlacePhoto, planWithGoogle, recoverDayWithGoogle, refreshSavedPlanWithGoogle, RequestBudget, samplePinnedPairs, savedPlanRefreshErrors, PlanningFailure, type PlanningStage } from "./google-maps";
import { liveRouteKey, newDayProgress, validateDayRecovery, type RecoveryRequest } from "./day-recovery";
import { validateSchedule } from "./schedule-validation";
import * as dayAssignment from "./days";
import * as planner from "./planner";
import { RouteSamples } from "./route-samples";
import * as ortools from "./ortools";

function fixture(): Trip {
  const trip = { ...newTrip(), city: "Paris", hotel: "Hotel", hotelPlaceId: "hotel-place", timeZone: "Europe/Paris", days: 1,
    stops: [{ ...newStop("Museum"), placeId: "museum-place" }] };
  return { ...trip, planning: { ...planningPreferences(trip), mode: "WALK" } };
}

function mockGoogle(walkingSeconds = 600, transitSeconds = 900) {
  vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("places.googleapis.com")) return Response.json({ id: url.split("/").at(-1), displayName: { text: "Confirmed place" }, location: { latitude: 48.86, longitude: 2.33 }, timeZone: { id: "Europe/Paris" } });
    const body = JSON.parse(init!.body as string);
    requests.push(body);
    if (url.includes("computeRouteMatrix")) return Response.json(body.destinations.map((_: unknown, destinationIndex: number) => ({ destinationIndex, condition: "ROUTE_EXISTS", duration: "600s", distanceMeters: 800 })));
    return Response.json({ routes: [{ duration: `${body.travelMode === "WALK" ? walkingSeconds : transitSeconds}s`, distanceMeters: 800 }] });
  }));
  return requests;
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("on-demand place photos", () => {
  it("resolves only the requested first-four photo and never returns provider resource names", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "private-test-key");
    const requestOptions: RequestInit[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestOptions.push(init ?? {});
      const url = String(input);
      if (url.includes("/media?")) return Response.json({ photoUri: "https://lh3.googleusercontent.com/photo" });
      return Response.json({ id: "museum-id", photos: Array.from({ length: 7 }, (_, index) => ({
        name: `places/museum-id/photos/photo-${index}`, widthPx: 1200, heightPx: 800,
        authorAttributions: [{ displayName: "Photographer", uri: "https://example.com/author", photoUri: "https://lh3.googleusercontent.com/avatar" }],
        googleMapsUri: "https://maps.google.com/maps?cid=123", flagContentUri: "https://example.com/report",
      })) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getPlacePhoto("museum-id", 2);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestOptions[0].headers).toMatchObject({ "X-Goog-Api-Key": "private-test-key", "X-Goog-FieldMask": "id,photos" });
    expect(requestOptions[1].headers).toMatchObject({ "X-Goog-Api-Key": "private-test-key" });
    expect(requestOptions[1].headers).not.toHaveProperty("X-Goog-FieldMask");
    expect(String(fetchMock.mock.calls[1][0])).toContain("photo-2/media?maxWidthPx=960&maxHeightPx=720&skipHttpRedirect=true");
    expect(result).toMatchObject({ placeId: "museum-id", index: 2, total: 4, photo: { uri: "https://lh3.googleusercontent.com/photo", authors: [{ displayName: "Photographer" }], googleMapsUri: "https://maps.google.com/maps?cid=123" } });
    expect(JSON.stringify(result)).not.toContain("photo-2");
    await expect(getPlacePhoto("museum-id", 4)).rejects.toThrow("first four");
  });

  it("does not request media when no photo exists and rejects mismatched place responses", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "private-test-key");
    const fetchMock = vi.fn(async () => Response.json({ id: "museum-id", photos: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getPlacePhoto("museum-id", 0)).resolves.toEqual({ placeId: "museum-id", index: 0, total: 0, photo: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ id: "other-place", photos: [] }));
    await expect(getPlacePhoto("museum-id", 0)).rejects.toThrow("different place");
  });

  it("rejects a photo URL outside Google's image hosts", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "private-test-key");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).includes("/media?")
      ? Response.json({ photoUri: "https://attacker.example/photo" })
      : Response.json({ id: "museum-id", photos: [{ name: "places/museum-id/photos/photo", googleMapsUri: "https://maps.google.com/maps?cid=123" }] })));
    await expect(getPlacePhoto("museum-id", 0)).rejects.toThrow("invalid photo URL");
  });
});

describe("time-of-day planning with Google place details", () => {
  it("fetches opening hours and types, enforces hours and dinner slots, and bypasses OR-Tools", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    vi.stubEnv("TRAVELLER_ROUTING_PYTHON", "/nonexistent/python");
    const fieldMasks: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("places.googleapis.com")) {
        const id = url.split("/").at(-1)!;
        fieldMasks.push(String((init?.headers as Record<string, string>)["X-Goog-FieldMask"]));
        const hours = id === "bistro-place" ? { regularOpeningHours: { periods: Array.from({ length: 7 }, (_, day) => ({ open: { day, hour: 12, minute: 0 }, close: { day, hour: 23, minute: 0 } })) } } : {};
        return Response.json({ id, displayName: { text: id }, location: { latitude: 48.86, longitude: 2.33 }, timeZone: { id: "Europe/Paris" }, primaryType: id === "bistro-place" ? "french_restaurant" : "museum", ...hours });
      }
      const body = JSON.parse(init!.body as string);
      if (url.includes("computeRouteMatrix")) return Response.json(body.destinations.map((_: unknown, destinationIndex: number) => ({ destinationIndex, condition: "ROUTE_EXISTS", duration: "600s", distanceMeters: 800 })));
      return Response.json({ routes: [{ duration: "600s", distanceMeters: 800 }] });
    }));
    const bistro = { ...newStop("Bistro"), placeId: "bistro-place", slot: "any" as const, duration: 60 };
    const dinner = { ...newStop("Le Chef"), placeId: "chef-place", source: "Dinner: Le Chef tasting menu." };
    const trip = { ...fixture(), dailyStart: "09:00", dailyEnd: "22:00", stops: [{ ...newStop("Museum"), placeId: "museum-place" }, bistro, dinner] };
    const result = await planWithGoogle(trip);
    expect(validateSchedule(trip, result.schedule)).toEqual([]);
    expect(fieldMasks.every((mask) => mask.includes("regularOpeningHours") && mask.includes("primaryType") && mask.includes("types"))).toBe(true);
    expect(result.places[bistro.id].hours).toHaveLength(7);
    const start = (id: string) => result.schedule.days[0].visits.find((visit) => visit.stopId === id)!.start;
    expect(start(bistro.id)).toBeGreaterThanOrEqual(12 * 60);
    expect(start(dinner.id)).toBeGreaterThanOrEqual(18 * 60);
    expect(result.schedule.warnings.join(" ")).toContain("regular opening hours were applied");
  });

  it("returns opening-hour fixes as an error, not a provisional outline, for trips with day groups", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("places.googleapis.com")) {
        const id = url.split("/").at(-1)!;
        const hours = id === "bistro-place" ? { regularOpeningHours: { periods: Array.from({ length: 7 }, (_, day) => ({ open: { day, hour: 12, minute: 0 }, close: { day, hour: 14, minute: 0 } })) } } : {};
        return Response.json({ id, displayName: { text: id }, location: { latitude: 48.86, longitude: 2.33 }, timeZone: { id: "Europe/Paris" }, ...hours });
      }
      const body = JSON.parse(init!.body as string);
      if (url.includes("computeRouteMatrix")) return Response.json(body.destinations.map((_: unknown, destinationIndex: number) => ({ destinationIndex, condition: "ROUTE_EXISTS", duration: "600s", distanceMeters: 800 })));
      return Response.json({ routes: [{ duration: "600s", distanceMeters: 800 }] });
    }));
    // The bistro opens 12:00–14:00, but Day 1's 12:00 booking leaves only 13:10–14:00 for a 60-minute visit.
    const bistro = { ...newStop("Bistro"), placeId: "bistro-place", slot: "any" as const, duration: 60, day: 0 };
    const garden = { ...newStop("Garden"), placeId: "garden-place" };
    const tower = { ...newStop("Tower"), placeId: "tower-place" };
    const trip: Trip = { ...fixture(), days: 2, dailyStart: "09:00", dailyEnd: "20:00", stops: [{ ...newStop("Museum"), placeId: "museum-place", day: 0, fixedTime: "12:00", duration: 60 }, bistro, garden, tower],
      dayGroups: [{ id: crypto.randomUUID(), name: "Gardens", stopIds: [garden.id, tower.id], allowedDays: [0, 1], exclusive: false }] };
    const failure = await planWithGoogle(trip).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlanningFailure);
    expect((failure as PlanningFailure).provisional).toBeUndefined();
    expect((failure as PlanningFailure).fixes).toEqual([expect.objectContaining({ stopId: bistro.id, action: "optimize-day" })]);
  });
});

describe("departure-specific route samples", () => {
  it("refreshes a saved order without assignment, route matrices or solver search", async () => {
    const requests = mockGoogle();
    const trip = fixture();
    trip.stops.push({ ...newStop("Park"), placeId: "park-place" });
    const plan = { days: [{ day: 0, stopIds: trip.stops.map((stop) => stop.id).reverse() }], omitted: [] };
    const original = structuredClone(plan);
    const solve = vi.spyOn(planner, "solveTrip");
    const assign = vi.spyOn(dayAssignment, "assignDays");
    const result = await refreshSavedPlanWithGoogle(trip, plan);
    expect(result.schedule.days[0].visits.map((visit) => visit.stopId)).toEqual(plan.days[0].stopIds);
    expect(validateSchedule(trip, result.schedule)).toEqual([]);
    expect(result.schedule.days[0].returnLeg?.to).toBe("hotel");
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.origin && !request.origins)).toBe(true);
    expect(solve).not.toHaveBeenCalled(); expect(assign).not.toHaveBeenCalled();
    expect(plan).toEqual(original);
    trip.stops[0].fixedTime = "09:05"; trip.stops[0].day = 0;
    await expect(refreshSavedPlanWithGoogle(trip, plan)).rejects.toMatchObject({ code: "verification-failed" });
    expect(plan).toEqual(original);
    trip.stops[0].day = 1;
    expect(savedPlanRefreshErrors(trip, plan).join(" ")).toContain("assigned day changed");
  });
  it("keeps a saved plan intact on missing route evidence and rejects cancellation before fetching", async () => {
    mockGoogle();
    const trip = fixture();
    trip.hotelLocation = { lat: 48.85, lng: 2.35 }; trip.stops[0].location = { lat: 48.86, lng: 2.34 };
    const plan = { days: [{ day: 0, stopIds: [trip.stops[0].id] }], omitted: [] };
    const original = structuredClone(plan);
    const fetchMock = vi.fn(async () => Response.json({ routes: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController(); controller.abort();
    await expect(refreshSavedPlanWithGoogle(trip, plan, controller.signal)).rejects.toMatchObject({ status: 499 });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(refreshSavedPlanWithGoogle(trip, plan)).rejects.toMatchObject({ code: "missing-data" });
    expect(plan).toEqual(original);
    expect(savedPlanRefreshErrors(trip, { ...plan, days: [{ day: 0, stopIds: [trip.stops[0].id, trip.stops[0].id] }] }).join(" ")).toContain("repeated visits");
  });
  it("counts completed visits in capacity and checks the skip-all hotel return", async () => {
    mockGoogle();
    vi.spyOn(Temporal.Now, "instant").mockReturnValue(Temporal.Instant.from("2026-10-13T12:00:00Z"));
    const trip = { ...fixture(), timeZone: "UTC", startDate: "2026-10-13", dailyStart: "08:00", dailyEnd: "21:00", stops: [
      { ...newStop("Completed A"), placeId: "A", duration: 10 }, { ...newStop("Completed B"), placeId: "B", duration: 10 },
      { ...newStop("Remaining C"), placeId: "C", duration: 10 }, { ...newStop("Remaining D"), placeId: "D", duration: 10 },
    ] };
    trip.planning = { ...planningPreferences(trip), maxStopsPerDay: 3 };
    const stopIds = trip.stops.map((stop) => stop.id);
    const progress = newDayProgress(trip, 0, stopIds);
    progress.completed = [{ stopId: stopIds[0], start: 600, end: 610 }, { stopId: stopIds[1], start: 620, end: 630 }];
    const request: RecoveryRequest = { trip, day: 0, stopIds, progress, origin: { id: stopIds[1] }, departureAt: "2026-10-13T12:00:00Z", mode: "replan", operationId: crypto.randomUUID(), permissions: { skipIds: stopIds.slice(2), minimumDurations: {} } };
    const result = await recoverDayWithGoogle(request);
    expect(result.status).toBe("recovery-checked");
    expect(result.options![0].day.visits).toHaveLength(1);
    expect(result.options![0].skipped).toHaveLength(1);
    expect(validateDayRecovery(request, result.options![0])).toEqual([]);
    trip.planning.maxStopsPerDay = 2; progress.planKey = newDayProgress(trip, 0, stopIds).planKey;
    const full = await recoverDayWithGoogle(request);
    expect(full.status).toBe("recovery-checked");
    expect(full.options![0].day.visits).toEqual([]);
    expect(full.options![0].skipped).toEqual(stopIds.slice(2));
    expect(full.options![0].day.returnLeg?.from).toBe("current");
    expect(full.options![0].day.returnLeg?.minutes).toBe(10);
    expect(validateDayRecovery(request, full.options![0])).toEqual([]);
  });
  it("selects an allowed fresh mode within the shared call cap", async () => {
    const requests = mockGoogle(600, 1200);
    const trip = { ...fixture(), timeZone: "UTC", startDate: "2026-10-13", dailyStart: "08:00", dailyEnd: "21:00", stops: [{ ...newStop("Booked museum"), placeId: "museum-place", day: 0, fixedTime: "12:25", buffer: 10 }] };
    vi.spyOn(Temporal.Now, "instant").mockReturnValue(Temporal.Instant.from("2026-10-13T12:00:00Z"));
    trip.planning = { ...planningPreferences(trip), mode: "AUTO" };
    const stopIds = trip.stops.map((stop) => stop.id);
    const request: RecoveryRequest = { trip, day: 0, stopIds, progress: newDayProgress(trip, 0, stopIds), origin: { id: "hotel" }, departureAt: "2026-10-13T12:00:00Z", mode: "replan", operationId: crypto.randomUUID(), permissions: { skipIds: [], minimumDurations: {} } };
    const solve = vi.spyOn(planner, "solveTrip");
    const result = await recoverDayWithGoogle(request);
    expect(result.status).toBe("recovery-checked");
    expect(validateDayRecovery(request, result.options![0])).toEqual([]);
    expect(requests.filter((entry) => entry.origin)).toHaveLength(4);
    expect(solve).toHaveBeenCalledTimes(1);
    expect(result.options![0].day.visits[0].leg.mode).toBe("WALK");
    request.preferredRoute = { to: stopIds[0], key: liveRouteKey({ ...result.options![0].day.visits[0].leg, mode: "TRANSIT" }) };
    const protectedChoice = await recoverDayWithGoogle(request);
    expect(protectedChoice.status).toBe("unresolved");
    expect(protectedChoice.options?.length ?? 0).toBe(0);
  });
  it("corrects a changed hotel return by resolving the same variant with refreshed evidence", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    vi.spyOn(Temporal.Now, "instant").mockReturnValue(Temporal.Instant.from("2026-10-13T12:00:00Z"));
    const trip = { ...fixture(), timeZone: "UTC", startDate: "2026-10-13", dailyStart: "08:00", dailyEnd: "12:55", stops: [{ ...newStop("A"), placeId: "A", duration: 10 }, { ...newStop("B"), placeId: "B", duration: 10 }] };
    const stopIds = trip.stops.map((stop) => stop.id);
    const minutes = (from: string, to: string, fresh: boolean) => fresh && from === "B" && to === trip.hotelPlaceId ? 200 : from === trip.hotelPlaceId && to === "B" || from === "B" && to === "A" ? 2 : 1;
    let routeCalls = 0; let elements = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      if (url.includes("computeRouteMatrix")) { elements += body.destinations.length; return Response.json(body.destinations.map((entry: { waypoint: { placeId: string } }, destinationIndex: number) => ({ destinationIndex, condition: "ROUTE_EXISTS", duration: `${minutes(body.origins[0].waypoint.placeId, entry.waypoint.placeId, false) * 60}s`, distanceMeters: 100 }))); }
      routeCalls++; return Response.json({ routes: [{ duration: `${minutes(body.origin.placeId, body.destination.placeId, true) * 60}s`, distanceMeters: 100 }] });
    }));
    const request: RecoveryRequest = { trip, day: 0, stopIds, progress: newDayProgress(trip, 0, stopIds), origin: { id: "hotel" }, departureAt: "2026-10-13T12:00:00Z", mode: "replan", operationId: crypto.randomUUID(), permissions: { skipIds: [], minimumDurations: {} } };
    const solve = vi.spyOn(planner, "solveTrip");
    const result = await recoverDayWithGoogle(request);
    expect(result.status).toBe("recovery-checked");
    expect(solve).toHaveBeenCalledTimes(2);
    expect(result.options![0].day.visits.map((visit) => visit.stopId)).toEqual([stopIds[1], stopIds[0]]);
    expect(validateDayRecovery(request, result.options![0])).toEqual([]);
    expect(routeCalls).toBeLessThanOrEqual(18); expect(elements).toBeLessThanOrEqual(250);
  });
  it("retains an independently checked proposal if a later alternative fails", async () => {
    mockGoogle();
    vi.spyOn(Temporal.Now, "instant").mockReturnValue(Temporal.Instant.from("2026-10-13T12:00:00Z"));
    const trip = { ...fixture(), timeZone: "UTC", startDate: "2026-10-13", dailyStart: "08:00", dailyEnd: "21:00" };
    const stopIds = trip.stops.map((stop) => stop.id);
    const request: RecoveryRequest = { trip, day: 0, stopIds, progress: newDayProgress(trip, 0, stopIds), origin: { id: "hotel" }, departureAt: "2026-10-13T12:00:00Z", mode: "replan", operationId: crypto.randomUUID(), permissions: { skipIds: stopIds, minimumDurations: { [stopIds[0]]: 10 } } };
    const schedule = { generatedAt: request.departureAt, omitted: [], warnings: [], days: [{ day: 0, date: trip.startDate, visits: [{ stopId: stopIds[0], start: 730, end: 740, leg: { day: 0, from: "current", to: stopIds[0], mode: "WALK" as const, minutes: 10, meters: 800 } }], returnLeg: { day: 0, from: stopIds[0], to: "hotel", mode: "WALK" as const, minutes: 10, meters: 800 } }] };
    vi.spyOn(planner, "solveTrip").mockRejectedValueOnce(new planner.PlanningError("Search incomplete", "incomplete")).mockResolvedValueOnce(schedule).mockResolvedValueOnce({ ...schedule, omitted: stopIds, days: [{ ...schedule.days[0], visits: [], returnLeg: { ...schedule.days[0].returnLeg, from: "current" } }] });
    request.origin = { id: "hotel", location: { lat: 48.86, lng: 2.33 } };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      if (url.includes("computeRouteMatrix")) return Response.json(body.destinations.map((_: unknown, destinationIndex: number) => ({ destinationIndex, condition: "ROUTE_EXISTS", duration: "600s", distanceMeters: 800 })));
      if (body.origin?.location && body.destination?.placeId === trip.hotelPlaceId) return Response.json({ error: { message: "Unavailable" } }, { status: 500 });
      return Response.json({ routes: [{ duration: "600s", distanceMeters: 800 }] });
    }));
    const result = await recoverDayWithGoogle(request);
    expect(result.status).toBe("recovery-checked");
    expect(result.options).toHaveLength(1);
    expect(validateDayRecovery(request, result.options![0])).toEqual([]);
    expect(result.message).toContain("retained");
    const cancelled = new AbortController(); cancelled.abort();
    await expect(recoverDayWithGoogle(request, cancelled.signal)).rejects.toMatchObject({ status: 499 });
  });
  it("checks actual-day alternatives from coordinates without substitute timetables", async () => {
    const requests = mockGoogle();
    const trip = { ...fixture(), timeZone: "UTC", startDate: Temporal.Now.plainDateISO("UTC").toString(), dailyStart: "00:00", dailyEnd: "23:59" };
    trip.planning = { ...planningPreferences(trip), mode: "TRANSIT" };
    const stopIds = trip.stops.map((stop) => stop.id);
    const request: RecoveryRequest = { trip, day: 0, stopIds, progress: newDayProgress(trip, 0, stopIds), origin: { id: "hotel", location: { lat: 52.3, lng: 4.8 } }, departureAt: Temporal.Now.instant().toString(), mode: "route", targetId: stopIds[0], operationId: crypto.randomUUID(), permissions: { skipIds: [], minimumDurations: {} } };
    const result = await recoverDayWithGoogle(request);
    expect(result.status).toBe("route-checked");
    expect(result.routes?.[0].timetableDate).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ origin: { location: { latLng: { latitude: 52.3, longitude: 4.8 } } }, computeAlternativeRoutes: true });
    expect(Temporal.Instant.from(requests[0].departureTime as string).epochMilliseconds).toBe(Temporal.Instant.from(request.departureAt).epochMilliseconds);
    request.mode = "replan";
    request.origin = { id: "hotel" };
    const recovery = await recoverDayWithGoogle(request);
    expect(recovery.status).toBe("recovery-checked");
    expect(validateDayRecovery(request, recovery.options![0])).toEqual([]);
    expect(requests.filter((entry) => entry.origins).reduce((sum, entry) => sum + (entry.destinations as unknown[]).length, 0)).toBeLessThanOrEqual(250);
  });
  it("selects the nearest departure sample instead of the fastest observation", () => {
    const trip = fixture();
    const morning = { day: 0, from: "hotel", to: trip.stops[0].id, mode: "TRANSIT" as const, minutes: 60, meters: 2000, sampledDeparture: 480 };
    const samples = new RouteSamples(trip, [morning, { ...morning, minutes: 10, sampledDeparture: 720 }]);
    samples.setDeparture(0, "hotel", 485);
    expect(samples.select()[0].minutes).toBe(60);
    samples.setDeparture(0, "hotel", 715);
    expect(samples.select()[0].minutes).toBe(10);
    samples.select()[0].minutes = Infinity;
    expect(samples.select()[0].minutes).toBe(10);
    samples.record(0, "hotel", morning.to, "TRANSIT", 720, null);
    expect(samples.at(0, "hotel", morning.to, "TRANSIT", 720)).toBeNull();
    expect(samples.at(0, morning.to, "hotel", "TRANSIT", 720)).toBeUndefined();
    expect(samples.select()).toEqual([]);
    samples.setDeparture(0, "hotel", 480);
    expect(samples.select()[0].minutes).toBe(60);
  });
});

describe("Google-backed configurable planning", () => {
  it("plans with distance estimates where samples are sparse, but returns only Google-checked legs", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    const trip = { ...fixture(), dailyStart: "09:00", dailyEnd: "18:00", stops: Array.from({ length: 6 }, (_, index) => ({ ...newStop(`Visit ${index}`), placeId: `visit-${index}`, duration: 30, ...(index === 0 ? { durationOptions: [30, 27, 24] } : {}) })) };
    const routeRequests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("places.googleapis.com")) {
        const id = url.split("/").at(-1)!;
        return Response.json({ id, displayName: { text: id }, location: { latitude: 48.86 + (Number(id.split("-")[1]) || 0) * 0.001, longitude: 2.33 }, timeZone: { id: "Europe/Paris" } });
      }
      const body = JSON.parse(init!.body as string);
      if (url.includes("computeRouteMatrix")) {
        const hotelRow = body.origins[0].waypoint.placeId === trip.hotelPlaceId;
        return Response.json(body.destinations.map((target: { waypoint: { placeId: string } }, destinationIndex: number) => hotelRow || target.waypoint.placeId === trip.hotelPlaceId ? { destinationIndex, condition: "ROUTE_EXISTS", duration: "600s", distanceMeters: 800 } : { destinationIndex, condition: "ROUTE_NOT_FOUND" }));
      }
      routeRequests.push(body);
      return Response.json({ routes: [{ duration: "300s", distanceMeters: 400 }] });
    }));
    const result = await planWithGoogle(trip);
    expect(validateSchedule(trip, result.schedule)).toEqual([]);
    expect(result.schedule.days[0].visits).toHaveLength(6);
    const legs = result.schedule.days.flatMap((day) => [...day.visits.map((visit) => visit.leg), ...(day.returnLeg ? [day.returnLeg] : [])]);
    expect(legs.every((leg) => !leg.estimated && leg.minutes === 5)).toBe(true);
    expect(routeRequests.length).toBeGreaterThanOrEqual(7);
  });
  it("plans far-future transit with the same weekday's published timetable and labels it", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    const trip = { ...fixture(), startDate: Temporal.Now.plainDateISO("Europe/Paris").add({ days: 60 }).toString(), stops: [{ ...newStop("Museum"), placeId: "museum-place" }] };
    trip.planning = { ...planningPreferences(trip), mode: "TRANSIT" };
    const departures: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("places.googleapis.com")) return Response.json({ id: url.split("/").at(-1), displayName: { text: "Place" }, location: { latitude: 48.86, longitude: 2.33 }, timeZone: { id: "Europe/Paris" } });
      const body = JSON.parse(init!.body as string);
      departures.push(body.departureTime);
      const published = !String(body.departureTime).startsWith(trip.startDate);
      if (url.includes("computeRouteMatrix")) return Response.json(body.destinations.map((_: unknown, destinationIndex: number) => published ? { destinationIndex, condition: "ROUTE_EXISTS", duration: "900s", distanceMeters: 4000 } : { destinationIndex, condition: "ROUTE_NOT_FOUND" }));
      return Response.json({ routes: published ? [{ duration: "900s", distanceMeters: 4000 }] : [] });
    }));
    const result = await planWithGoogle(trip);
    expect(validateSchedule(trip, result.schedule)).toEqual([]);
    const proxy = result.schedule.days[0].visits[0].leg.timetableDate!;
    expect(Temporal.PlainDate.from(proxy).dayOfWeek).toBe(Temporal.PlainDate.from(trip.startDate).dayOfWeek);
    expect(Temporal.PlainDate.compare(proxy, Temporal.Now.plainDateISO("Europe/Paris").add({ days: 8 }))).toBeLessThan(0);
    expect(result.schedule.days[0].returnLeg?.timetableDate).toBe(proxy);
    expect(result.schedule.warnings.join(" ")).toContain("not confirmed service on your trip dates");
    expect(result.schedule.warnings.join(" ")).toContain("Refresh travel times closer to departure");
    expect(departures.some((value) => value?.startsWith(trip.startDate))).toBe(true);
  });
  it("uses an explicit assumed day-trip travel time only where Google returns no route", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    const trip = { ...fixture(), days: 2, stops: [
      { ...newStop("Amsterdam visit"), placeId: "amsterdam" },
      { ...newStop("Utrecht canal"), placeId: "utrecht-canal" },
      { ...newStop("Utrecht lunch"), placeId: "utrecht-lunch" },
    ] } as Trip;
    trip.planning = { ...planningPreferences(trip), mode: "AUTO" };
    const group = { id: crypto.randomUUID(), name: "Utrecht", stopIds: trip.stops.slice(1).map((stop) => stop.id), allowedDays: [0, 1], exclusive: true };
    const far = (from: string, to: string) => [from, to].includes(trip.hotelPlaceId!) && [from, to].some((id) => id.startsWith("utrecht"));
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("places.googleapis.com")) return Response.json({ id: url.split("/").at(-1), displayName: { text: "Place" }, location: { latitude: 52.37, longitude: 4.89 }, timeZone: { id: "Europe/Paris" } });
      const body = JSON.parse(init!.body as string);
      if (url.includes("computeRouteMatrix")) return Response.json(body.destinations.map((target: { waypoint: { placeId: string } }, destinationIndex: number) => {
        if (!far(body.origins[0].waypoint.placeId, target.waypoint.placeId)) return { destinationIndex, condition: "ROUTE_EXISTS", duration: "600s", distanceMeters: 800 };
        return body.travelMode === "WALK" ? { destinationIndex, condition: "ROUTE_EXISTS", duration: "30000s", distanceMeters: 40000 } : { destinationIndex, condition: "ROUTE_NOT_FOUND" };
      }));
      if (body.travelMode === "TRANSIT" && far(body.origin.placeId, body.destination.placeId)) return Response.json({ routes: [] });
      return Response.json({ routes: [{ duration: body.travelMode === "WALK" && far(body.origin.placeId, body.destination.placeId) ? "30000s" : "600s", distanceMeters: body.travelMode === "WALK" && far(body.origin.placeId, body.destination.placeId) ? 40000 : 800 }] });
    }));
    await expect(planWithGoogle({ ...trip, dayGroups: [group] })).rejects.toThrow("set an assumed travel time");
    const assumed = { ...trip, dayGroups: [{ ...group, assumedTravelMinutes: 60 }] };
    const original = structuredClone(assumed);
    const result = await planWithGoogle(assumed);
    expect(validateSchedule(assumed, result.schedule)).toEqual([]);
    const day = result.schedule.days.find((entry) => entry.visits.some((visit) => visit.stopId === trip.stops[1].id))!;
    expect(day.visits).toHaveLength(2);
    expect(day.visits[0].leg).toMatchObject({ from: "hotel", minutes: 60, assumed: true });
    expect(day.returnLeg).toMatchObject({ to: "hotel", minutes: 60, assumed: true });
    expect(day.visits[1].leg.assumed).toBeUndefined();
    expect(result.schedule.days.find((entry) => entry !== day)!.visits[0].leg.assumed).toBeUndefined();
    expect(result.schedule.warnings.join(" ")).toContain("2 day-trip legs use your assumed travel time");
    expect(assumed).toEqual(original);
  });
  it.each([false, true])("plans the 33-stop Amsterdam shape with one exclusive Utrecht day using mocked routes (unpublished trip-date timetable: %s)", async (unpublished) => {
    const durations = [30, 45, 45, 60, 45, 45, 45, 45, 45, 90, 30, 90, 45, 45, 45, 150, 45, 45, 45, 45, 45, 45, 45, 45, 45, 75, 90, 60, 60, 60, 45, 30, 45];
    const eateries = new Set([3, 5, 8, 12, 13, 14, 16, 17, 19, 22, 23, 28, 29, 30, 32]);
    const utrecht = new Set([18, 19, 20, 28, 29]);
    const names = new Map([[18, "Oudegracht"], [19, "Stadskasteel Oudaen"], [20, "Trajectum Lumen"], [28, "Fufu"], [29, "Ukiyo"]]);
    const trip: Trip = { ...fixture(), city: "Amsterdam", timeZone: "Europe/Amsterdam", days: 4, dailyStart: "08:00", dailyEnd: "21:00", ...(unpublished ? { startDate: Temporal.Now.plainDateISO("Europe/Amsterdam").add({ days: 75 }).toString() } : {}), stops: durations.map((duration, index) => ({ ...newStop(names.get(index) ?? `Amsterdam visit ${index}`), placeId: `place-${index}`, duration, ...(eateries.has(index) ? { durationOptions: [duration, Math.ceil(duration * 0.9), Math.ceil(duration * 0.8)] } : {}) })) };
    trip.planning = { ...planningPreferences(trip), mode: "AUTO" };
    trip.dayGroups = [{ id: crypto.randomUUID(), name: "Utrecht", stopIds: trip.stops.filter((_, index) => utrecht.has(index)).map((stop) => stop.id), allowedDays: [0, 1, 2, 3], exclusive: true }];
    const original = structuredClone(trip);
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    let elements = 0;
    let routeRequests = 0;
    const tripDates = Array.from({ length: trip.days }, (_, day) => Temporal.PlainDate.from(trip.startDate).add({ days: day }).toString());
    const inUtrecht = (id: string) => utrecht.has(Number(id.replace("place-", "")));
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("places.googleapis.com")) {
        const id = url.split("/").at(-1)!;
        return Response.json({ id, displayName: { text: id }, location: { latitude: inUtrecht(id) ? 52.09 : 52.37 + (Number(id.replace("place-", "")) || 0) * 0.0001, longitude: inUtrecht(id) ? 5.12 : 4.89 }, timeZone: { id: "Europe/Amsterdam" } });
      }
      const body = JSON.parse(init!.body as string);
      const from = body.origin?.placeId ?? body.origins[0].waypoint.placeId;
      const route = (to: string) => ({ duration: inUtrecht(from) !== inUtrecht(to) ? "5400s" : "600s", distanceMeters: inUtrecht(from) !== inUtrecht(to) ? 45000 : 800 });
      const missing = unpublished && body.travelMode === "TRANSIT" && tripDates.some((date) => String(body.departureTime).startsWith(date));
      if (body.destinations) {
        elements += body.destinations.length;
        return Response.json(body.destinations.map((target: { waypoint: { placeId: string } }, destinationIndex: number) => missing ? { destinationIndex, condition: "ROUTE_NOT_FOUND" } : { destinationIndex, condition: "ROUTE_EXISTS", ...route(target.waypoint.placeId) }));
      }
      routeRequests++;
      return Response.json({ routes: missing ? [] : [route(body.destination.placeId)] });
    }));
    const stages: PlanningStage[] = [];
    const result = await planWithGoogle(trip, { onStage: (stage) => stages.push(stage) }).catch((error) => { throw new Error(`${String(error)} ${JSON.stringify(stages)}`, { cause: error }); });
    expect(validateSchedule(trip, result.schedule)).toEqual([]);
    expect(result.schedule.days.flatMap((day) => day.visits)).toHaveLength(33);
    expect(result.schedule.days.find((day) => day.visits.some((visit) => visit.stopId === trip.stops[18].id))!.visits).toHaveLength(5);
    expect(result.schedule.optimization).toMatchObject({ weightedDurationLoss: 0, durationOptimal: true });
    expect(result.schedule.days.every((day) => day.returnLeg && day.visits.every((visit) => visit.leg.polyline !== undefined || visit.leg.steps !== undefined))).toBe(true);
    expect(elements).toBeLessThanOrEqual(1000);
    if (unpublished) {
      const utrechtDay = result.schedule.days.find((day) => day.visits.some((visit) => visit.stopId === trip.stops[18].id))!;
      expect(utrechtDay.visits[0].leg).toMatchObject({ from: "hotel", mode: "TRANSIT" });
      expect(utrechtDay.visits[0].leg.timetableDate).toBeDefined();
      expect(result.schedule.warnings.join(" ")).toContain("same weekday's timetable");
      expect(routeRequests).toBeLessThanOrEqual(Math.max(100, 6 * (33 + 4)));
    }
    expect(durations.reduce((total, duration) => total + duration, 0)).toBe(1770);
    expect(trip).toEqual(original);
  }, 20_000);
  it.each([true, false])("checks group access first and keeps missing travel provisional: %s", async (available) => {
    const requests = mockGoogle();
    const trip = { ...fixture(), days: 2, stops: [
      { ...newStop("Amsterdam visit"), placeId: "amsterdam" },
      { ...newStop("Utrecht canal"), placeId: "utrecht-canal" },
      { ...newStop("Utrecht lunch"), placeId: "utrecht-lunch", durationOptions: [45, 41, 36] },
    ], dayGroups: [] as NonNullable<Trip["dayGroups"]> };
    trip.planning = { ...planningPreferences(trip), mode: "AUTO" };
    trip.dayGroups = [{ id: crypto.randomUUID(), name: "Utrecht", stopIds: trip.stops.slice(1).map((stop) => stop.id), allowedDays: [0, 1], exclusive: true }];
    const original = structuredClone(trip);
    if (!available) {
      const fetchGoogle = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (!String(url).includes("computeRouteMatrix")) return fetchGoogle(url, init);
        const body = JSON.parse(init!.body as string);
        requests.push(body);
        return Response.json(body.destinations.map((_: unknown, destinationIndex: number) => ({ destinationIndex, condition: "ROUTE_NOT_FOUND" })));
      });
    }
    const solve = vi.spyOn(planner, "solveTrip");
    const native = vi.spyOn(ortools, "solveTripWithOrTools");
    vi.stubEnv("TRAVELLER_ROUTING_PYTHON", "/not-enabled-for-coupled-requests");
    const stages: PlanningStage[] = [];
    if (available) {
      const result = await planWithGoogle(trip, { onStage: (stage) => stages.push(stage) });
      expect(validateSchedule(trip, result.schedule)).toEqual([]);
      expect(result.schedule.days.find((day) => day.visits.some((visit) => visit.stopId === trip.stops[1].id))!.visits).toHaveLength(2);
      expect(result.schedule.optimization?.weightedDurationLoss).toBe(0);
    } else {
      const failure = await planWithGoogle(trip, { onStage: (stage) => stages.push(stage) }).catch((error) => error);
      expect(failure).toBeInstanceOf(PlanningFailure);
      expect(failure).toMatchObject({ code: "missing-data", provisional: { status: "provisional", verified: false } });
      expect(stages[0]).toMatchObject({ outcome: "incomplete", code: "missing-data" });
      expect(failure.provisional).not.toHaveProperty("schedule");
      expect(failure.provisional.outline.flatMap((item: { stopIds: string[] }) => item.stopIds)).toHaveLength(3);
      expect(failure.provisional.unresolved).toContainEqual(expect.objectContaining({ direction: "return", outcome: "noRoute" }));
      expect(solve).not.toHaveBeenCalled();
      expect(requests.every((request) => request.destinations)).toBe(true);
    }
    expect(native).not.toHaveBeenCalled();
    expect(stages[0].stage).toBe("group-access");
    expect(stages[0].groups).toHaveLength(4);
    expect(JSON.stringify(stages)).not.toContain("utrecht-");
    expect(requests[0]).toMatchObject({ travelMode: "TRANSIT", origins: [{ waypoint: { placeId: trip.hotelPlaceId } }] });
    expect(requests.filter((request) => request.destinations).reduce((total, request) => total + (request.destinations as unknown[]).length, 0)).toBeLessThanOrEqual(1000);
    expect(trip).toEqual(original);
  });
  it.each([true, false])("repairs route coverage before relaxation, with available repair routes: %s", async (available) => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    const trip = { ...fixture(), days: available ? 1 : 4, stops: Array.from({ length: available ? 1 : 33 }, (_, index) => ({ ...newStop(`Cafe ${index}`), placeId: `cafe-${index}`, duration: 60, durationOptions: [60, 54, 48] })) };
    trip.planning = { ...planningPreferences(trip), mode: "AUTO" };
    const original = structuredClone(trip);
    const stages: PlanningStage[] = [];
    const solver = vi.spyOn(planner, "solveTrip");
    let elements = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("places.googleapis.com")) return Response.json({ id: url.split("/").at(-1), displayName: { text: "Confirmed place" }, location: { latitude: 48.86, longitude: 2.33 }, timeZone: { id: "Europe/Paris" } });
      const body = JSON.parse(init!.body as string);
      if (url.includes("computeRouteMatrix")) {
        elements += body.destinations.length;
        const morning = Array.from({ length: trip.days }, (_, day) => instantAt(trip, day, trip.dailyStart).toString()).includes(body.departureTime);
        return Response.json(body.destinations.map((_: unknown, destinationIndex: number) => {
          if (body.travelMode === "WALK") return { destinationIndex, condition: "ROUTE_EXISTS", duration: "3600s", distanceMeters: 5000 };
          if (available && !morning) return { destinationIndex, condition: "ROUTE_EXISTS", duration: "600s", distanceMeters: 5000 };
          return body.origins[0].waypoint.placeId === trip.hotelPlaceId ? { destinationIndex, status: { code: 14 } } : { destinationIndex, condition: "ROUTE_NOT_FOUND" };
        }));
      }
      return Response.json({ routes: [{ duration: "600s", distanceMeters: body.travelMode === "WALK" ? 5000 : 800 }] });
    }));
    if (available) {
      const result = await planWithGoogle(trip, { onStage: (stage) => stages.push(stage) });
      expect(result.verified).toBe(true);
      expect(validateSchedule(trip, result.schedule)).toEqual([]);
      expect(result.schedule.days[0].visits[0].end - result.schedule.days[0].visits[0].start).toBe(60);
      expect(stages.map((stage) => stage.stage)).toEqual(["route-repair", "sampled-solve", "verification"]);
      expect(elements).toBe(6);
    } else {
      await expect(planWithGoogle(trip, { onStage: (stage) => stages.push(stage) })).rejects.toThrow("after bounded connection repair");
      expect(solver).not.toHaveBeenCalled();
      expect(elements).toBe(1000);
      expect(stages[0].outcome).toBe("incomplete");
    }
    expect(stages[0].matrix).toMatchObject({ elements });
    expect(stages[0].matrix!.noRoute).toBeGreaterThan(0);
    expect(stages[0].matrix!.providerError).toBeGreaterThan(0);
    expect(stages[0].matrix!.excluded).toBeGreaterThan(0);
    expect(stages[0].matrix!.statusCodes[14]).toBeGreaterThan(0);
    expect(JSON.stringify(stages)).not.toContain("cafe-");
    expect(trip).toEqual(original);
  });
  it("relaxes selected durations within one route acquisition and verifies the chosen lengths", async () => {
    const requests = mockGoogle();
    const trip = { ...fixture(), dailyEnd: "11:14", stops: [
      { ...newStop("Lunch"), placeId: "lunch", duration: 60, durationOptions: [60, 54, 48], priority: 5 },
      { ...newStop("Cafe"), placeId: "cafe", duration: 60, durationOptions: [60, 54, 48] },
    ] };
    const original = structuredClone(trip);
    const stages: PlanningStage[] = [];
    const result = await planWithGoogle(trip, { onStage: (stage) => stages.push(stage) });
    expect(result.verified).toBe(true);
    expect(validateSchedule(trip, result.schedule)).toEqual([]);
    const durations = new Map(result.schedule.days[0].visits.map((visit) => [visit.stopId, visit.end - visit.start]));
    expect(trip.stops.map((stop) => durations.get(stop.id))).toEqual([60, 54]);
    expect(stages.flatMap((stage) => stage.solver.map((solver) => solver.objective))).toEqual(["duration", "travel"]);
    expect(requests.filter((request) => request.destinations)).toHaveLength(3);
    expect(requests.filter((request) => request.origin)).toHaveLength(3);
    expect(result.schedule.warnings.join(" ")).toContain("1 visit shortened by 6 minutes");
    expect(trip).toEqual(original);
  });
  it.skipIf(!process.env.TRAVELLER_BENCHMARK_PYTHON)("repairs slower actual departures without moving a protected booking", async () => {
    vi.stubEnv("TRAVELLER_ROUTING_PYTHON", process.env.TRAVELLER_BENCHMARK_PYTHON);
    const requests = mockGoogle(1200, 1200);
    const trip = { ...fixture(), dailyEnd: "13:00", stops: [
      { ...newStop("Flexible before"), placeId: "first", duration: 30 },
      { ...newStop("Protected booking"), placeId: "second", day: 0, fixedTime: "10:00", duration: 30, buffer: 5 },
      { ...newStop("Flexible after"), placeId: "third", duration: 30 },
    ] };
    trip.planning = { ...planningPreferences(trip), mode: "TRANSIT" };
    const original = structuredClone(trip);
    const starts = [550, 600, 640];
    const candidate = { days: [{ day: 0, date: trip.startDate, visits: trip.stops.map((stop, index) => ({ stopId: stop.id, start: starts[index], end: starts[index] + stop.duration, leg: { day: 0, from: index ? trip.stops[index - 1].id : "hotel", to: stop.id, mode: "TRANSIT" as const, minutes: 10, meters: 800 } })), returnLeg: { day: 0, from: trip.stops[2].id, to: "hotel", mode: "TRANSIT" as const, minutes: 10, meters: 800 } }], omitted: [], warnings: [], generatedAt: new Date().toISOString() };
    expect(validateSchedule(trip, candidate)).toEqual([]);
    vi.spyOn(ortools, "solveTripWithOrTools").mockResolvedValueOnce(candidate);
    const stages: PlanningStage[] = [];
    const result = await planWithGoogle(trip, { onStage: (stage) => stages.push(stage) });
    const verifications = stages.filter((stage) => stage.stage === "verification");
    expect(verifications[0].outcome).toBe("conflict");
    expect(verifications.at(-1)!.outcome).toBe("ok");
    expect(verifications.length).toBeLessThanOrEqual(3);
    expect(result.verified).toBe(true);
    expect(validateSchedule(trip, result.schedule)).toEqual([]);
    expect(result.schedule.days[0].visits[0]).toMatchObject({ stopId: trip.stops[1].id, start: 600 });
    expect(result.schedule.days[0].visits.every((visit) => visit.leg.sampledDeparture !== undefined)).toBe(true);
    expect(requests.filter((request) => request.origin)).toHaveLength(4 * verifications.length);
    expect(trip).toEqual(original);
  });
  it.skipIf(!process.env.TRAVELLER_BENCHMARK_PYTHON).each([[25, "AUTO"], [33, "TRANSIT"], [60, "TRANSIT"], [60, "AUTO"], [60, "WALK"]] as const)("jointly plans %i stops in %s mode through the real sampler and native solver", async (count, mode) => {
    vi.stubEnv("TRAVELLER_ROUTING_PYTHON", process.env.TRAVELLER_BENCHMARK_PYTHON);
    const requests = mockGoogle(600, 600);
    const days = count <= 33 ? 4 : 7;
    const trip = { ...fixture(), days, dailyStart: "08:00", dailyEnd: "21:00", stops: Array.from({ length: count }, (_, index) => ({ ...newStop(`Visit ${index}`), placeId: `place-${String(index).padStart(2, "0")}`, duration: [30, 45, 60, 90][index % 4], day: index < days ? index : null, fixedTime: index < days ? "10:00" : null, buffer: 10 })) };
    trip.planning = { ...planningPreferences(trip), mode, maxStopsPerDay: 12 };
    trip.stops.reverse();
    const original = structuredClone(trip);
    const grouping = vi.spyOn(dayAssignment, "assignDays");
    const stages: PlanningStage[] = [];
    const result = await planWithGoogle(trip, { onStage: (stage) => stages.push(stage) });
    expect(result.verified).toBe(true);
    expect(validateSchedule(trip, result.schedule)).toEqual([]);
    expect(result.schedule.days.flatMap((day) => day.visits)).toHaveLength(count);
    expect(grouping).not.toHaveBeenCalled();
    expect(stages.flatMap((stage) => stage.solver)).toContainEqual(expect.objectContaining({ engine: "ortools", outcome: "feasible" }));
    expect(requests.filter((request) => request.destinations).reduce((total, request) => total + (request.destinations as unknown[]).length, 0)).toBeLessThanOrEqual(1000);
    expect(requests.filter((request) => request.origin)).toHaveLength((mode === "AUTO" ? 2 : 1) * (count + days));
    expect(trip).toEqual(original);
  }, 20_000);
  it.skipIf(!process.env.TRAVELLER_BENCHMARK_PYTHON)("uses walking candidates outside the transit horizon without a transit request", async () => {
    vi.stubEnv("TRAVELLER_ROUTING_PYTHON", process.env.TRAVELLER_BENCHMARK_PYTHON);
    const requests = mockGoogle();
    const trip = { ...fixture(), startDate: "2099-01-01", days: 4, stops: Array.from({ length: 60 }, (_, index) => ({ ...newStop(`Visit ${index}`), placeId: `place-${index}`, duration: 5 })) };
    trip.planning = { ...planningPreferences(trip), mode: "AUTO" };
    const result = await planWithGoogle(trip);
    expect(validateSchedule(trip, result.schedule)).toEqual([]);
    expect(result.schedule.warnings.join(" ")).toContain("routing horizon");
    expect(requests.every((request) => request.travelMode === "WALK")).toBe(true);
    expect(requests.filter((request) => request.destinations).reduce((total, request) => total + (request.destinations as unknown[]).length, 0)).toBeLessThanOrEqual(1000);
  });
  it("preserves the initial conflict when regrouping ends with an incomplete search", async () => {
    const requests = mockGoogle();
    const trip = { ...fixture(), days: 2, stops: Array.from({ length: 26 }, (_, index) => ({ ...newStop(`Place ${index}`), placeId: `place-${index}`, duration: 5 })) };
    vi.spyOn(dayAssignment, "assignDays").mockResolvedValueOnce({ ...trip, stops: trip.stops.map((stop) => ({ ...stop, day: 0 })) });
    vi.spyOn(planner, "solveTrip").mockRejectedValueOnce(new planner.PlanningError("Initial sampled graph failed.", "conflict"))
      .mockRejectedValueOnce(new planner.PlanningError("Fallback time limit.", "incomplete"));
    const stages: PlanningStage[] = [];
    await expect(planWithGoogle(trip, { onStage: (stage) => stages.push(stage) })).rejects.toThrow("sampled-solve: infeasible on sampled routes; regroup-solve: search incomplete");
    expect(stages.map(({ stage, outcome }) => ({ stage, outcome }))).toEqual([
      { stage: "grouping", outcome: "ok" }, { stage: "sampled-solve", outcome: "conflict" }, { stage: "regroup-solve", outcome: "incomplete" },
    ]);
    expect(JSON.stringify(stages)).not.toContain("place-");
    expect(stages.every((stage) => stage.elapsedMs >= 0)).toBe(true);
    expect(requests.filter((request) => request.destinations).reduce((total, request) => total + (request.destinations as unknown[]).length, 0)).toBe(702);
    expect(requests.some((request) => request.origin)).toBe(false);
  });
  it("identifies the failing assigned day using cached routes without more Google requests", async () => {
    const trip = { ...fixture(), days: 2, dailyStart: "09:00", dailyEnd: "11:00", stops: [
      { ...newStop("First-day visit"), placeId: "first", day: 0, duration: 30 },
      { ...newStop("Second-day long visit"), placeId: "second", day: 1, duration: 100 },
      { ...newStop("Second-day short visit"), placeId: "third", day: 1, duration: 10 },
    ] };
    const requests = mockGoogle();
    await expect(planWithGoogle(trip)).rejects.toThrow("Day 2");
    expect(requests.filter((request) => request.destinations).reduce((total, request) => total + (request.destinations as unknown[]).length, 0)).toBe(8);
    expect(requests.some((request) => request.origin)).toBe(false);
  });
  it.each([600, 3600])("verifies later transit samples against actual routes of %i seconds", async (actualSeconds) => {
    const stages: PlanningStage[] = [];
    const options = { onStage: (stage: PlanningStage) => stages.push(stage) };
    const trip = { ...fixture(), dailyStart: "09:00", dailyEnd: "18:00", stops: Array.from({ length: 9 }, (_, index) => ({ ...newStop(`Visit ${index}`), placeId: `place-${index}`, day: 0 })) };
    trip.stops[0] = { ...trip.stops[0], fixedTime: "09:20", buffer: 10 };
    trip.planning = { ...planningPreferences(trip), mode: "AUTO" };
    const original = structuredClone(trip);
    mockGoogle();
    const requests: Record<string, unknown>[] = [];
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes("places.googleapis.com")) return Response.json({ id: String(url).split("/").at(-1), displayName: { text: "Place" }, location: { latitude: 48.86, longitude: 2.33 }, timeZone: { id: "Europe/Paris" } });
      const body = JSON.parse(init!.body as string);
      requests.push(body);
      if (String(url).includes("computeRouteMatrix")) {
        const morning = body.departureTime === instantAt(trip, 0, trip.dailyStart).toString();
        const hotel = body.origins[0].waypoint.placeId === trip.hotelPlaceId;
        return Response.json(body.destinations.map((_: unknown, destinationIndex: number) => ({ destinationIndex, condition: "ROUTE_EXISTS", duration: morning && !hotel ? "3600s" : "600s", distanceMeters: body.travelMode === "WALK" ? 2000 : 800 })));
      }
      return Response.json({ routes: [{ duration: `${actualSeconds}s`, distanceMeters: body.travelMode === "WALK" ? 2000 : 800 }] });
    });
    if (actualSeconds === 600) {
      const result = await planWithGoogle(trip, options);
      expect(result.verified).toBe(true);
      expect(validateSchedule(trip, result.schedule)).toEqual([]);
      expect(result.schedule.days[0].visits).toHaveLength(9);
      expect(result.schedule.warnings.join(" ")).toContain("later transit");
    } else await expect(planWithGoogle(trip, options)).rejects.toThrow(/No schedule fits|Transit timing/);
    expect(stages).toContainEqual(expect.objectContaining({ stage: "verification", outcome: actualSeconds === 600 ? "ok" : "conflict" }));
    const later = requests.filter((request) => request.destinations && request.travelMode === "TRANSIT" && request.departureTime !== instantAt(trip, 0, trip.dailyStart).toString());
    expect(later).toHaveLength(9);
    expect(later.every((request) => (request.origins as { waypoint: { placeId: string } }[])[0].waypoint.placeId !== trip.hotelPlaceId)).toBe(true);
    expect(later.some((request) => request.departureTime === instantAt(trip, 0, "10:05").toString())).toBe(true);
    expect(requests.filter((request) => request.destinations).reduce((total, request) => total + (request.destinations as unknown[]).length, 0)).toBeLessThanOrEqual(1000);
    // One verification round per schedule; a schedule that relied on nearby estimates may cost one extra round
    // before estimates are distrusted for the rest of the run.
    const verified = requests.filter((request) => request.origin).length;
    expect(verified % 20).toBe(0);
    expect(verified).toBeLessThanOrEqual(40);
    expect(trip).toEqual(original);
  }, 20_000);
  it("checks only fixed-booking legs at departure with no Places, matrix, or optimizer requests", async () => {
    const requests = mockGoogle();
    const trip = { ...fixture(), stops: [
      { ...newStop("First"), placeId: "first", day: 0, fixedTime: "10:00" },
      { ...newStop("Second"), placeId: "second", day: 0, fixedTime: "11:00" },
      newStop("Unconfirmed flexible visit"),
    ] };
    trip.planning = { ...planningPreferences(trip), mode: "AUTO" };
    const original = structuredClone(trip);
    const result = await checkBookingTravel(trip);
    expect(result.connections).toHaveLength(3);
    expect(result.connections[1]).toMatchObject({ from: trip.stops[0].id, to: trip.stops[1].id, availableMinutes: 0, minutes: 10, mode: "WALK" });
    expect(requests).toHaveLength(6);
    expect(requests.filter((request) => request.travelMode === "TRANSIT").every((request) => request.departureTime)).toBe(true);
    expect(vi.mocked(fetch).mock.calls.every(([url, init]) => String(url).includes("computeRoutes") && (init?.headers as Record<string, string>)["X-Goog-FieldMask"] === "routes.duration,routes.distanceMeters")).toBe(true);
    expect(trip).toEqual(original);
  });
  it("checks far-future booking gaps on a published timetable without exhausting its budget", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    const trip = { ...fixture(), startDate: Temporal.Now.plainDateISO("Europe/Paris").add({ days: 75 }).toString(), days: 4, stops: Array.from({ length: 24 }, (_, index) => ({ ...newStop(`Booking ${index}`), placeId: `booking-${index}`, day: index % 4, fixedTime: `${String(9 + Math.floor(index / 4)).padStart(2, "0")}:00`, duration: 30 })) };
    trip.planning = { ...planningPreferences(trip), mode: "AUTO" };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      const unpublished = body.travelMode === "TRANSIT" && Array.from({ length: 4 }, (_, day) => Temporal.PlainDate.from(trip.startDate).add({ days: day }).toString()).some((date) => String(body.departureTime).startsWith(date));
      return Response.json({ routes: unpublished ? [] : [{ duration: body.travelMode === "WALK" ? "1800s" : "600s", distanceMeters: 1400 }] });
    }));
    const check = await checkBookingTravel(trip);
    expect(check.connections).toHaveLength(28);
    expect(check.connections.every((leg) => leg.minutes === 10 && leg.mode === "TRANSIT")).toBe(true);
  });
  it("reports unavailable estimates rather than bypassing transport constraints", async () => {
    mockGoogle();
    const trip = fixture();
    trip.stops[0] = { ...trip.stops[0], day: 0, fixedTime: "10:00" };
    trip.planning = { ...planningPreferences(trip), maxWalkMinutes: 5 };
    expect((await checkBookingTravel(trip)).connections.every((leg) => leg.minutes === null)).toBe(true);
    vi.mocked(fetch).mockClear();
    trip.planning = { ...planningPreferences(trip), mode: "TRANSIT" };
    trip.startDate = "2099-01-01";
    const check = await checkBookingTravel(trip);
    expect(check.connections.every((leg) => leg.minutes === null)).toBe(true);
    expect(check.warnings.join(" ")).toContain("date horizon");
    expect(fetch).not.toHaveBeenCalled();
    trip.stops[0].fixedTime = null;
    expect(await checkBookingTravel(trip)).toEqual({ connections: [], warnings: [] });
  });
  it("samples chronological booking connections even when imported in a different order", async () => {
    mockGoogle();
    const requests: Record<string, unknown>[] = [];
    const trip = { ...fixture(), stops: Array.from({ length: 25 }, (_, index) => {
      const at = 9 * 60 + 5 + ((index * 7) % 25) * 10;
      return { ...newStop(`Booking ${index}`), placeId: `place-${index}`, duration: 5, buffer: 0, day: 0, fixedTime: `${Math.floor(at / 60).toString().padStart(2, "0")}:${(at % 60).toString().padStart(2, "0")}` };
    }) };
    trip.planning = { ...planningPreferences(trip), mode: "AUTO" };
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes("places.googleapis.com")) return Response.json({ id: String(url).split("/").at(-1), displayName: { text: "Place" }, location: { latitude: 48.86, longitude: 2.33 }, timeZone: { id: "Europe/Paris" } });
      const body = JSON.parse(init!.body as string);
      requests.push(body);
      if (String(url).includes("computeRouteMatrix")) return Response.json(body.destinations.map((_: unknown, destinationIndex: number) => ({ destinationIndex, condition: "ROUTE_EXISTS", duration: "300s", distanceMeters: body.travelMode === "WALK" ? 2000 : 800 })));
      return Response.json({ routes: [{ duration: "300s", distanceMeters: body.travelMode === "WALK" ? 2000 : 800 }] });
    });
    const result = await planWithGoogle(trip);
    expect(validateSchedule(trip, result.schedule)).toEqual([]);
    expect(result.schedule.days[0].visits.map((visit) => visit.stopId)).toEqual([...trip.stops].sort((left, right) => left.fixedTime.localeCompare(right.fixedTime)).map((stop) => stop.id));
    expect(requests.filter((request) => request.destinations).reduce((total, request) => total + (request.destinations as unknown[]).length, 0)).toBeLessThanOrEqual(1000);
  }, 20_000);
  it("repairs a failed grouping using cached walking links without another matrix", async () => {
    const requests = mockGoogle();
    const trip = { ...fixture(), days: 2, stops: Array.from({ length: 26 }, (_, index) => ({ ...newStop(`Place ${index}`), placeId: `place-${index}`, duration: 5 })) };
    vi.spyOn(dayAssignment, "assignDays").mockResolvedValueOnce({ ...trip, stops: trip.stops.map((stop) => ({ ...stop, day: 0 })) });
    const result = await planWithGoogle(trip);
    expect(validateSchedule(trip, result.schedule)).toEqual([]);
    expect(result.schedule.warnings.some((warning) => warning.includes("repaired"))).toBe(true);
    expect(requests.filter((request) => request.destinations).reduce((total, request) => total + (request.destinations as unknown[]).length, 0)).toBe(702);
  }, 20_000);
  it.each([26, 60])("verifies a %i-stop trip within the Google request budget", async (count) => {
    const requests = mockGoogle();
    const trip = { ...fixture(), days: 7, stops: Array.from({ length: count }, (_, index) => ({ ...newStop(`Place ${index}`), placeId: `place-${index}`, duration: 30 })) };
    trip.stops[0] = { ...trip.stops[0], day: 2, fixedTime: "10:00" };
    const result = await planWithGoogle(trip);
    expect(result.verified).toBe(true);
    expect(validateSchedule(trip, result.schedule)).toEqual([]);
    expect(result.schedule.days.flatMap((day) => day.visits)).toHaveLength(count);
    expect(requests.filter((request) => request.destinations).reduce((total, request) => total + (request.destinations as unknown[]).length, 0)).toBeLessThanOrEqual(1000);
  }, 20_000);
  it("keeps a feasible transit path when all 25 flexible visits are beyond the walking limit", async () => {
    mockGoogle();
    const trip = { ...fixture(), days: 7, stops: Array.from({ length: 25 }, (_, index) => ({ ...newStop(`Place ${index}`), placeId: `place-${index}`, duration: 5 })) };
    trip.planning = { ...planningPreferences(trip), mode: "TRANSIT" };
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes("places.googleapis.com")) return Response.json({ id: String(url).split("/").at(-1), displayName: { text: "Place" }, location: { latitude: 48.86, longitude: 2.33 }, timeZone: { id: "Europe/Paris" } });
      const body = JSON.parse(init!.body as string);
      if (String(url).includes("computeRouteMatrix")) return Response.json(body.destinations.map((_: unknown, destinationIndex: number) => ({ destinationIndex, condition: "ROUTE_EXISTS", duration: "300s", distanceMeters: body.travelMode === "WALK" ? 2000 : 800 })));
      return Response.json({ routes: [{ duration: "300s", distanceMeters: 800 }] });
    });
    const result = await planWithGoogle(trip);
    expect(validateSchedule(trip, result.schedule)).toEqual([]);
  }, 20_000);
  it("uses only walking requests for walking-only days and hotel returns", async () => {
    const requests = mockGoogle();
    const result = await planWithGoogle(fixture());
    expect(result.verified).toBe(true);
    expect(result.schedule.days[0].returnLeg?.mode).toBe("WALK");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.travelMode === "WALK")).toBe(true);
  });
  it("sends transit preferences at actual departure and refuses over-limit refreshed walks", async () => {
    const requests = mockGoogle(1200);
    const trip = fixture();
    trip.planning = { ...planningPreferences(trip), mode: "AUTO", maxWalkMinutes: 10, transitPreference: "FEWER_TRANSFERS" };
    const result = await planWithGoogle(trip);
    expect(result.schedule.days[0].visits[0].leg.mode).toBe("TRANSIT");
    expect(result.schedule.days[0].returnLeg?.mode).toBe("TRANSIT");
    const legs = requests.filter((request) => request.origin && request.travelMode === "TRANSIT");
    expect(legs).toHaveLength(2);
    expect(legs.every((request) => request.departureTime && (request.transitPreferences as { routingPreference: string }).routingPreference === "FEWER_TRANSFERS")).toBe(true);
  });
  it("rejects transit-only defaults beyond Google's date horizon", async () => {
    mockGoogle();
    const trip = fixture();
    trip.startDate = "2099-01-01";
    trip.planning = { ...planningPreferences(trip), mode: "TRANSIT" };
    await expect(planWithGoogle(trip)).rejects.toThrow("routing horizon");
  });
});

describe("direct departures", () => {
  it("requests the final leg to the confirmed station, never back to the hotel", async () => {
    const requests = mockGoogle();
    const trip: Trip = { ...fixture(), dailyStart: "08:00", dailyEnd: "21:00", returnToHotel: true, stops: [{ ...newStop("Coffee"), placeId: "coffee-place", duration: 45 }], departure: { mode: "TRAIN", time: "11:10", place: "Centraal", placeId: "station-place", direct: true } };
    const result = await planWithGoogle(trip);
    expect(validateSchedule(trip, result.schedule)).toEqual([]);
    expect(result.places.departure).toMatchObject({ id: "station-place" });
    const destinations = requests.flatMap((body) => [(body.destination as { placeId?: string } | undefined)?.placeId, ...((body.destinations as { waypoint: { placeId: string } }[] | undefined) ?? []).map((entry) => entry.waypoint.placeId)]).filter(Boolean);
    expect(destinations).toContain("station-place");
    expect(destinations).not.toContain("hotel-place");
    const day = result.schedule.days[0];
    expect(day.returnLeg).toMatchObject({ to: "hotel" });
    expect(day.visits[0].end + day.returnLeg!.minutes).toBeLessThanOrEqual(minuteAt(trip, 0, "10:50"));
  });
});

describe("direct departure walks", () => {
  it("never reuses a walk back to the hotel as the walk to the station", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    // The hotel is an hour's walk from everything; the station is a minute from everything.
    const seconds = (placeId: string) => placeId === "hotel-place" ? 3600 : placeId === "station-place" ? 60 : 600;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("places.googleapis.com")) return Response.json({ id: url.split("/").at(-1), displayName: { text: "Place" }, location: { latitude: 48.86, longitude: 2.33 }, timeZone: { id: "Europe/Paris" } });
      const body = JSON.parse(init!.body as string);
      if (url.includes("computeRouteMatrix")) return Response.json(body.destinations.map((target: { waypoint: { placeId: string } }, destinationIndex: number) => ({ destinationIndex, condition: "ROUTE_EXISTS", duration: `${seconds(target.waypoint.placeId)}s`, distanceMeters: 800 })));
      return Response.json({ routes: [{ duration: `${seconds(body.destination.placeId)}s`, distanceMeters: 800 }] });
    }));
    const [museum, hall, coffee] = [{ ...newStop("Museum"), placeId: "museum-place", day: 0 }, { ...newStop("Station hall"), placeId: "hall-place", day: 1, duration: 15 }, { ...newStop("Coffee"), placeId: "coffee-place" }];
    const trip: Trip = { ...fixture(), days: 2, dailyStart: "08:00", dailyEnd: "21:00", returnToHotel: true, stops: [museum, hall, coffee], departure: { mode: "TRAIN", time: "11:10", place: "Centraal", placeId: "station-place", direct: true } };
    const solve = vi.spyOn(planner, "solveTrip");
    const result = await planWithGoogle(trip);
    expect(validateSchedule(trip, result.schedule)).toEqual([]);
    expect(result.schedule.days[1].returnLeg).toMatchObject({ to: "hotel", minutes: 1 });
    // What the search saw, not just what verification fixed afterwards: on the departure day every walk "home" is the
    // one-minute walk to the station; on the first day it is the hour back to the hotel.
    const searched = solve.mock.calls.flatMap(([, travel]) => travel).filter((edge) => edge.mode === "WALK" && edge.to === "hotel" && !edge.estimated);
    expect(searched.filter((edge) => edge.day === 1).map((edge) => edge.minutes)).not.toContain(60);
    expect(searched.filter((edge) => edge.day === 1).length).toBeGreaterThan(0);
    expect(searched.filter((edge) => edge.day === 0).every((edge) => edge.minutes === 60)).toBe(true);
  });
});

describe("pinned visit routes", () => {
  it("asks Google for every unsampled pair of visits pinned to the same day, and nothing across days", async () => {
    const requests = mockGoogle();
    const [a, b, c] = ["A", "B", "C"].map((name) => ({ ...newStop(name), placeId: `${name}-place` }));
    const trip: Trip = { ...fixture(), days: 2, returnToHotel: true, stops: [{ ...a, day: 0 }, { ...b, day: 0 }, { ...c, day: 1 }] };
    const place = (id: string) => ({ id, name: id, address: "", location: { lat: 48.86, lng: 2.33 } });
    const places = { hotel: place("hotel-place"), [a.id]: place("A-place"), [b.id]: place("B-place"), [c.id]: place("C-place") };
    const walk = (day: number, from: string, to: string) => ({ day, from, to, mode: "WALK" as const, minutes: 10, meters: 800 });
    const samples = new RouteSamples(trip, [walk(0, "hotel", a.id), walk(0, a.id, "hotel"), walk(0, "hotel", b.id), walk(0, b.id, "hotel"), walk(1, "hotel", c.id), walk(1, c.id, "hotel")]);
    const edges = await samplePinnedPairs(trip, places, new RequestBudget(), samples, 120);
    expect(edges.some((edge) => edge.day === 0 && edge.from === a.id && edge.to === b.id)).toBe(true);
    expect(edges.some((edge) => edge.day === 0 && edge.from === b.id && edge.to === a.id)).toBe(true);
    const asked = requests.flatMap((body) => ((body.destinations as { waypoint: { placeId: string } }[] | undefined) ?? []).map((entry) => `${(body.origins as { waypoint: { placeId: string } }[])[0].waypoint.placeId}>${entry.waypoint.placeId}`));
    expect(asked.sort()).toEqual(["A-place>B-place", "B-place>A-place"]);
  });
});
