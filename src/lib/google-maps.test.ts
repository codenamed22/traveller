import { afterEach, describe, expect, it, vi } from "vitest";
import { newStop, newTrip, planningPreferences, type Trip } from "./trip";

vi.mock("server-only", () => ({}));
vi.mock("./server", () => ({ HttpError: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { planWithGoogle } from "./google-maps";

function fixture(): Trip {
  const trip = { ...newTrip(), city: "Paris", hotel: "Hotel", hotelPlaceId: "hotel-place", timeZone: "Europe/Paris", days: 1,
    stops: [{ ...newStop("Museum"), placeId: "museum-place" }] };
  return { ...trip, planning: { ...planningPreferences(trip), mode: "WALK" } };
}

function mockGoogle(walkingSeconds = 600) {
  vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("places.googleapis.com")) return Response.json({ id: url.split("/").at(-1), displayName: { text: "Confirmed place" }, location: { latitude: 48.86, longitude: 2.33 }, timeZone: { id: "Europe/Paris" } });
    const body = JSON.parse(init!.body as string);
    requests.push(body);
    if (url.includes("computeRouteMatrix")) return Response.json(body.destinations.map((_: unknown, destinationIndex: number) => ({ destinationIndex, condition: "ROUTE_EXISTS", duration: "600s", distanceMeters: 800 })));
    return Response.json({ routes: [{ duration: `${body.travelMode === "WALK" ? walkingSeconds : 900}s`, distanceMeters: 800 }] });
  }));
  return requests;
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Google-backed configurable planning", () => {
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