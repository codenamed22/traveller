import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({ owner: vi.fn(), reserve: vi.fn(), fares: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn(), allowedEmail: vi.fn(), authConfigured: vi.fn() }));
vi.mock("@/lib/google-maps", () => ({ transitFares: mocks.fares }));
vi.mock("@/lib/server", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/server")>(), requireOwner: mocks.owner, reserveUsage: mocks.reserve }));

const leg = (key: string) => ({ key, lines: "8", origin: { lat: 48.84, lng: 2.4 }, destination: { lat: 48.86, lng: 2.35 }, departure: "2026-12-29T08:10:00Z" });
const send = (body: unknown) => POST(new Request("http://localhost/api/fares", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.owner.mockResolvedValue("owner@example.com");
  mocks.reserve.mockResolvedValue(undefined);
});

describe("POST /api/fares", () => {
  it("counts a unit for every five rides and answers with Google's fares", async () => {
    mocks.fares.mockResolvedValue({ "2026-12-29|back": { amount: 2.55, currency: "EUR" } });
    const response = await send({ legs: Array.from({ length: 6 }, (_, index) => leg(`2026-12-2${index}|back`)) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ fares: { "2026-12-29|back": { amount: 2.55, currency: "EUR" } } });
    expect(mocks.reserve).toHaveBeenCalledWith("owner@example.com", 2);
  });

  it("refuses what it can't ask about", async () => {
    const response = await send({ legs: [] });
    expect(response.status).toBe(400);
    expect(mocks.fares).not.toHaveBeenCalled();
  });
});
