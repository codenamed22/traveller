import { Temporal } from "@js-temporal/polyfill";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newDayProgress, type RecoveryRequest } from "@/lib/day-recovery";
import { newStop, newTrip } from "@/lib/trip";
import { HttpError } from "@/lib/server";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({ requireOwner: vi.fn(), reserveUsage: vi.fn(), recover: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn(), allowedEmail: vi.fn(), authConfigured: vi.fn() }));
vi.mock("@/lib/server", async (original) => ({ ...await original<typeof import("@/lib/server")>(), requireOwner: mocks.requireOwner, reserveUsage: mocks.reserveUsage }));
vi.mock("@/lib/google-maps", () => ({ recoverDayWithGoogle: mocks.recover }));

function input(): RecoveryRequest {
  const trip = { ...newTrip(), city: "Amsterdam", hotel: "Hotel", hotelPlaceId: "hotel", timeZone: "UTC", startDate: Temporal.Now.plainDateISO("UTC").toString(), dailyStart: "00:00", dailyEnd: "23:59", stops: [{ ...newStop("Canal"), placeId: "canal" }] };
  const stopIds = trip.stops.map((stop) => stop.id);
  return { trip, day: 0, stopIds, progress: newDayProgress(trip, 0, stopIds), mode: "route", origin: { id: "hotel" }, departureAt: Temporal.Now.instant().toString(), operationId: crypto.randomUUID(), targetId: stopIds[0], permissions: { skipIds: [], minimumDurations: {} } };
}
function request(body: unknown) { return new Request("http://localhost/api/day-recovery", { method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body) }); }
beforeEach(() => { vi.resetAllMocks(); mocks.requireOwner.mockResolvedValue("owner@example.com"); mocks.reserveUsage.mockResolvedValue(undefined); mocks.recover.mockResolvedValue({ status: "unresolved", message: "No route." }); });

describe("day recovery boundary", () => {
  it("authenticates and reserves only the requested operation cost without saving", async () => {
    const body = input();
    const response = await POST(request(body));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.reserveUsage).toHaveBeenCalledWith("owner@example.com", 3, body.operationId);
    body.mode = "replan";
    await POST(request(body));
    expect(mocks.reserveUsage).toHaveBeenLastCalledWith("owner@example.com", 30, body.operationId);
  });
  it("rejects changed progress, future dates, and unconfirmed places before paid work", async () => {
    const body = input();
    body.progress.planKey = "stale";
    expect((await POST(request(body))).status).toBe(422);
    expect(mocks.reserveUsage).not.toHaveBeenCalled();
    const missing = input(); missing.trip.stops[0].placeId = null; missing.progress = newDayProgress(missing.trip, 0, missing.stopIds);
    expect((await POST(request(missing))).status).toBe(422);
    const future = input(); future.trip.startDate = Temporal.Now.plainDateISO("UTC").add({ days: 1 }).toString(); future.progress = newDayProgress(future.trip, 0, future.stopIds);
    expect((await POST(request(future))).status).toBe(422);
    expect(mocks.reserveUsage).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated and duplicate operations without calling Google", async () => {
    mocks.requireOwner.mockRejectedValueOnce(new HttpError(401, "Sign in."));
    expect((await POST(request(input()))).status).toBe(401);
    expect(mocks.reserveUsage).not.toHaveBeenCalled();
    mocks.reserveUsage.mockRejectedValueOnce(new HttpError(409, "Already submitted."));
    expect((await POST(request(input()))).status).toBe(409);
    expect(mocks.recover).not.toHaveBeenCalled();
  });
});