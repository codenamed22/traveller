import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { newStop, newTrip, type Trip } from "@/lib/trip";
import { HttpError } from "@/lib/server";

const mocks = vi.hoisted(() => ({ requireOwner: vi.fn(), reserveUsage: vi.fn(), planWithGoogle: vi.fn(), checkBookingTravel: vi.fn(), refreshSavedPlanWithGoogle: vi.fn(), savedPlanRefreshErrors: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn(), allowedEmail: vi.fn(), authConfigured: vi.fn() }));
vi.mock("@/lib/server", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/server")>(), requireOwner: mocks.requireOwner, reserveUsage: mocks.reserveUsage }));
vi.mock("@/lib/google-maps", () => ({ planWithGoogle: mocks.planWithGoogle, checkBookingTravel: mocks.checkBookingTravel, refreshSavedPlanWithGoogle: mocks.refreshSavedPlanWithGoogle, savedPlanRefreshErrors: mocks.savedPlanRefreshErrors }));

function request(trip: Trip, mode?: "check") {
  return new Request("http://localhost/api/plan", { method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ trip, operationId: crypto.randomUUID(), ...(mode ? { mode } : {}) }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireOwner.mockResolvedValue("owner@example.com");
  mocks.reserveUsage.mockResolvedValue(undefined);
  mocks.planWithGoogle.mockResolvedValue({ verified: true });
  mocks.checkBookingTravel.mockResolvedValue({ connections: [], warnings: [] });
  mocks.refreshSavedPlanWithGoogle.mockResolvedValue({ verified: true });
  mocks.savedPlanRefreshErrors.mockReturnValue([]);
});

describe("planning request boundaries", () => {
  it("refreshes a saved order under the cheaper quota without optimization", async () => {
    const trip = { ...newTrip(), city: "Paris", hotel: "Hotel", hotelPlaceId: "hotel", days: 1, stops: [{ ...newStop("Museum"), placeId: "museum" }] };
    const plan = { days: [{ day: 0, stopIds: [trip.stops[0].id] }], omitted: [] };
    const refreshRequest = () => new Request("http://localhost/api/plan", { method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ trip, plan, mode: "refresh", operationId: crypto.randomUUID() }) });
    const response = await POST(refreshRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.reserveUsage).toHaveBeenCalledWith("owner@example.com", 3, expect.any(String));
    expect(mocks.refreshSavedPlanWithGoogle).toHaveBeenCalledWith(trip, plan, expect.any(AbortSignal));
    expect(mocks.planWithGoogle).not.toHaveBeenCalled();
    trip.stops = Array.from({ length: 11 }, (_, index) => ({ ...newStop(`Museum ${index}`), placeId: `museum-${index}` }));
    plan.days[0].stopIds = trip.stops.map((stop) => stop.id);
    expect((await POST(refreshRequest())).status).toBe(200);
    expect(mocks.reserveUsage).toHaveBeenLastCalledWith("owner@example.com", 6, expect.any(String));
    mocks.reserveUsage.mockClear();
    mocks.savedPlanRefreshErrors.mockReturnValueOnce(["The saved itinerary no longer matches the trip days."]);
    expect((await POST(refreshRequest())).status).toBe(422);
    expect(mocks.reserveUsage).not.toHaveBeenCalled();
    mocks.requireOwner.mockRejectedValueOnce(new HttpError(401, "Sign in first."));
    expect((await POST(refreshRequest())).status).toBe(401);
    expect(mocks.reserveUsage).not.toHaveBeenCalled();
  });
  it("returns an untimed provisional outline without exposing a schedule", async () => {
    const stop = newStop("Day-trip visit");
    const provisional = { status: "provisional", verified: false, code: "missing-data", message: "Return travel is unavailable in the sampled data.", outline: [{ stopIds: [stop.id], allowedDays: [0] }], unresolved: [{ day: 0, direction: "return", outcome: "noRoute" }], warnings: [] };
    mocks.planWithGoogle.mockRejectedValueOnce(Object.assign(new HttpError(422, provisional.message), { provisional }));
    const response = await POST(request({ ...newTrip(), city: "Amsterdam", hotel: "Hotel", stops: [stop] }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ ...provisional, diagnostics: [] });
    expect(mocks.reserveUsage).toHaveBeenCalledWith("owner@example.com", 30, expect.any(String));
  });
  it("includes ordered, noncached stage diagnostics when planning fails", async () => {
    const stages = [
      { stage: "sampled-solve", outcome: "conflict", elapsedMs: 12, stops: 33, edges: 200, solver: [] },
      { stage: "regroup-solve", outcome: "incomplete", elapsedMs: 2000, stops: 33, edges: 300, solver: [] },
    ];
    mocks.planWithGoogle.mockImplementationOnce(async (_trip, options) => {
      stages.forEach(options.onStage);
      throw new HttpError(422, "Fallback time limit.");
    });
    const response = await POST(request({ ...newTrip(), city: "Paris", hotel: "Hotel", stops: [newStop("Museum")] }));
    expect(response.status).toBe(422);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Fallback time limit.", diagnostics: stages });
    expect(mocks.reserveUsage).toHaveBeenCalledTimes(1);
  });
  it("uses the cheaper authenticated check before optimization even for overlapping bookings", async () => {
    const trip: Trip = { ...newTrip(), city: "Paris", hotel: "Hotel", hotelPlaceId: "hotel", stops: [
      { ...newStop("First"), placeId: "first", day: 0, fixedTime: "10:00" },
      { ...newStop("Second"), placeId: "second", day: 0, fixedTime: "10:00" },
    ] };
    expect((await POST(request(trip, "check"))).status).toBe(200);
    expect(mocks.checkBookingTravel).toHaveBeenCalledWith(trip);
    expect(mocks.reserveUsage).toHaveBeenCalledWith("owner@example.com", 3, expect.any(String));
    expect(mocks.planWithGoogle).not.toHaveBeenCalled();
    mocks.reserveUsage.mockClear();
    trip.hotelPlaceId = null;
    expect((await POST(request(trip, "check"))).status).toBe(400);
    expect(mocks.reserveUsage).not.toHaveBeenCalled();
    trip.stops = [];
    expect((await POST(request(trip, "check"))).status).toBe(200);
    expect(mocks.reserveUsage).not.toHaveBeenCalled();
  });
  it("rejects overlapping imported times before reserving quota or fetching routes", async () => {
    const trip: Trip = { ...newTrip(), city: "Amsterdam", hotel: "Hotel", startDate: "2026-12-24", timeZone: "Europe/Amsterdam", stops: [
      { ...newStop("Sango Specialty Coffee"), day: 0, fixedTime: "14:45" },
      { ...newStop("Sango"), day: 0, fixedTime: "15:13" },
    ] };
    const response = await POST(request(trip));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toContain("60 min needed, 28 available");
    expect(body.code).toBe("hard-input-conflict");
    expect(mocks.reserveUsage).not.toHaveBeenCalled();
    expect(mocks.planWithGoogle).not.toHaveBeenCalled();
    trip.stops[0] = { ...trip.stops[0], fixedTime: null };
    expect((await POST(request(trip))).status).toBe(200);
    expect(mocks.reserveUsage).toHaveBeenCalledTimes(1);
    expect(mocks.planWithGoogle).toHaveBeenCalledWith(trip, { onStage: expect.any(Function), signal: expect.any(AbortSignal) });
  });
  it("accepts valid 60-stop trips with large source evidence", async () => {
    const trip = { ...newTrip(), city: "Paris", hotel: "Hotel", stops: Array.from({ length: 60 }, (_, index) => ({ ...newStop(`Place ${index}`), source: "a".repeat(1000), sourceUrl: `https://example.com/${"a".repeat(2900)}` })) };
    expect(new TextEncoder().encode(JSON.stringify(trip)).byteLength).toBeGreaterThan(100_000);
    expect((await POST(request(trip))).status).toBe(200);
    expect(mocks.planWithGoogle).toHaveBeenCalledWith(trip, { onStage: expect.any(Function), signal: expect.any(AbortSignal) });
    expect(mocks.reserveUsage).toHaveBeenCalledWith("owner@example.com", 30, expect.any(String));
  });
  it("rejects excess stops before buying routes", async () => {
    const trip = { ...newTrip(), city: "Paris", hotel: "Hotel", stops: Array.from({ length: 61 }, () => newStop("Museum")) };
    expect((await POST(request(trip))).status).toBe(400);
    expect(mocks.reserveUsage).not.toHaveBeenCalled();
    expect(mocks.planWithGoogle).not.toHaveBeenCalled();
  });
  it("retains a bounded request body", async () => {
    const trip = { ...newTrip(), city: "Paris", hotel: "Hotel", stops: [{ ...newStop("Museum"), source: "a".repeat(3_500_000) }] };
    expect((await POST(request(trip))).status).toBe(413);
    expect(mocks.reserveUsage).not.toHaveBeenCalled();
    expect(mocks.planWithGoogle).not.toHaveBeenCalled();
  });
});