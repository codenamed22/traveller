import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { PATCH, PUT } from "./route";
import { createJourney } from "@/lib/journey";
import { newTrip } from "@/lib/trip";

const mocks = vi.hoisted(() => ({ owner: vi.fn(), insert: vi.fn(), update: vi.fn(), values: vi.fn(), set: vi.fn(), where: vi.fn(), conflict: vi.fn(), returning: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn(), allowedEmail: vi.fn(), authConfigured: vi.fn() }));
vi.mock("@/db", () => ({ database: () => ({ insert: mocks.insert, update: mocks.update }) }));
vi.mock("@/lib/server", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/server")>(), requireOwner: mocks.owner }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.owner.mockResolvedValue("owner@example.com");
  mocks.insert.mockReturnValue({ values: mocks.values });
  mocks.values.mockReturnValue({ onConflictDoNothing: mocks.conflict });
  mocks.conflict.mockReturnValue({ returning: mocks.returning });
  mocks.update.mockReturnValue({ set: mocks.set });
  mocks.set.mockReturnValue({ where: mocks.where });
  mocks.where.mockReturnValue({ returning: mocks.returning });
  mocks.returning.mockResolvedValue([{ revision: 1 }]);
});

async function save(id: string, payload: unknown) {
  return PUT(new Request(`http://localhost/api/trips/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }), { params: Promise.resolve({ tripId: id }) });
}

describe("journey persistence", () => {
  it("stores all city drafts in one owner-scoped row before hotels are selected", async () => {
    const journey = createJourney("Europe", "2026-10-20", [
      { city: "Paris", timeZone: "Europe/Paris", days: 3, startDate: null },
      { city: "Amsterdam", timeZone: "Europe/Amsterdam", days: 2, startDate: null },
    ]);
    expect((await save(journey.id, { journey, revision: 0 })).status).toBe(200);
    expect(mocks.values).toHaveBeenCalledWith({ id: journey.id, owner: "owner@example.com", data: journey, plan: null });
  });
  it("still accepts the existing single-city save contract", async () => {
    const trip = { ...newTrip(), city: "Paris", hotel: "Hotel" };
    expect((await save(trip.id, { trip, revision: 0, plan: null })).status).toBe(200);
    expect(mocks.values).toHaveBeenCalledWith({ id: trip.id, owner: "owner@example.com", data: trip, plan: null });
  });
  it("checks owner, revision, and journey identity on updates", async () => {
    const journey = createJourney("Europe", "2026-10-20", [{ city: "Paris", timeZone: "Europe/Paris", days: 3, startDate: null }]);
    mocks.returning.mockResolvedValue([]);
    expect((await save(journey.id, { journey, revision: 2 })).status).toBe(409);
    const condition = new PgDialect().sqlToQuery(mocks.where.mock.calls[0][0]);
    expect(condition.params).toEqual([journey.id, "owner@example.com", 2]);
    expect((await save(crypto.randomUUID(), { journey, revision: 0 })).status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
describe("sharing for viewing", () => {
  const share = (id: string, body: unknown) => PATCH(new Request(`http://localhost/api/trips/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ tripId: id }) });

  it("changes only the owner's own trip and leaves its revision alone", async () => {
    const id = crypto.randomUUID();
    mocks.returning.mockResolvedValue([{ shared: true }]);
    const response = await share(id, { shared: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shared: true });
    expect(mocks.set).toHaveBeenCalledWith({ shared: true });
    expect(new PgDialect().sqlToQuery(mocks.where.mock.calls[0][0]).params).toEqual([id, "owner@example.com"]);
  });

  it("refuses unsaved trips, bad input and viewers", async () => {
    mocks.returning.mockResolvedValue([]);
    expect((await share(crypto.randomUUID(), { shared: true })).status).toBe(404);
    expect((await share(crypto.randomUUID(), { shared: "yes" })).status).toBe(400);
    expect((await share(crypto.randomUUID(), { shared: true, revision: 3 })).status).toBe(400);
    expect((await share("not-a-trip", { shared: true })).status).toBe(400);
    const { HttpError } = await import("@/lib/server");
    mocks.owner.mockRejectedValue(new HttpError(403, "This account can view shared trips only."));
    expect((await share(crypto.randomUUID(), { shared: true })).status).toBe(403);
  });
});
