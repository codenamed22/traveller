import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { asJourney } from "./journey";
import type { DayProgress } from "./day-recovery";
import { newStop, newTrip } from "./trip";
import { sharedTrip, sharedTrips } from "./shared-trips";

const mocks = vi.hoisted(() => ({ where: vi.fn(), rows: [] as unknown[] }));
vi.mock("server-only", () => ({}));
vi.mock("@/db", () => ({ database: () => ({ select: () => ({ from: () => ({ where: (condition: unknown) => { mocks.where(condition); const result = Promise.resolve(mocks.rows); return Object.assign(result, { limit: () => result, orderBy: () => ({ limit: () => result }) }); } }) }) }) }));

const trip = { ...newTrip(), title: "Amsterdam", city: "Amsterdam", startDate: "2026-12-24", days: 3, stops: [newStop("Sango Coffee")] };
const journey = { ...asJourney(trip), execution: { [trip.id]: { "2026-12-24": {} as DayProgress } } };

beforeEach(() => { mocks.where.mockReset(); mocks.rows = []; });

describe("shared trips", () => {
  it("opens a trip only when it is shared or belongs to the viewer, without day progress or the owner's email", async () => {
    mocks.rows = [{ data: journey, plan: null, owner: "owner@example.com", updatedAt: new Date("2026-10-14T08:00:00Z") }];
    const view = await sharedTrip(trip.id, "friend@example.com");
    const condition = new PgDialect().sqlToQuery(mocks.where.mock.calls[0][0]);
    expect(condition.sql).toContain('"shared" = $2 or "trips"."owner" = $3');
    expect(condition.params).toEqual([trip.id, true, "friend@example.com"]);
    expect(view).toEqual({ id: trip.id, title: "Amsterdam", cities: journey.cities, plans: {}, updatedAt: "2026-10-14T08:00:00.000Z", isOwner: false });
    expect(JSON.stringify(view)).not.toContain("owner@example.com");
    expect((await sharedTrip(trip.id, "owner@example.com"))!.isOwner).toBe(true);
    mocks.rows = [];
    expect(await sharedTrip(trip.id, "friend@example.com")).toBeNull();
  });

  it("lists shared trips with their cities and dates only", async () => {
    mocks.rows = [{ data: trip, plan: null, updatedAt: new Date("2026-10-14T08:00:00Z") }];
    expect(await sharedTrips()).toEqual([{ id: trip.id, title: "Amsterdam", updatedAt: "2026-10-14T08:00:00.000Z", cities: [{ city: "Amsterdam", startDate: "2026-12-24", endDate: "2026-12-26" }] }]);
    expect(new PgDialect().sqlToQuery(mocks.where.mock.calls[0][0]).params).toEqual([true]);
  });
});
