import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({ owner: vi.fn(), reserve: vi.fn(), nearby: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn(), allowedEmail: vi.fn(), authConfigured: vi.fn() }));
vi.mock("@/lib/google-maps", () => ({ nearbyMeals: mocks.nearby }));
vi.mock("@/lib/server", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/server")>(), requireOwner: mocks.owner, reserveUsage: mocks.reserve }));

const lunch = { meal: "lunch", location: { lat: 48.86, lng: 2.33 }, date: "2026-12-29", start: "12:25", end: "13:25" };
const send = (body: unknown) => POST(new Request("http://localhost/api/places/nearby", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.owner.mockResolvedValue("owner@example.com");
  mocks.reserve.mockResolvedValue(undefined);
});

describe("POST /api/places/nearby", () => {
  it("counts a unit and answers with the places, kept nowhere", async () => {
    const places = [{ id: "a", name: "Bistro", address: "Paris", location: { lat: 48.861, lng: 2.331 }, rating: 4.6, reviews: 300, walkMinutes: 2 }];
    mocks.nearby.mockResolvedValue(places);
    const response = await send(lunch);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ places });
    expect(mocks.reserve).toHaveBeenCalledWith("owner@example.com", 1);
    expect(mocks.nearby).toHaveBeenCalledWith(lunch, expect.anything());
  });

  it("refuses what it can't ask about", async () => {
    const response = await send({ ...lunch, end: "11:00" });
    expect(response.status).toBe(400);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.nearby).not.toHaveBeenCalled();
  });
});
