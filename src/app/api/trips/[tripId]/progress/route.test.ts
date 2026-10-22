import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { POST } from "./route";
import type { Journey } from "@/lib/journey";
import { minuteAt, newStop, newTrip, persistedPlan, type Schedule, type TravelEdge } from "@/lib/trip";

const mocks = vi.hoisted(() => ({ owner: vi.fn(), select: vi.fn(), from: vi.fn(), selectWhere: vi.fn(), limit: vi.fn(), update: vi.fn(), set: vi.fn(), where: vi.fn(), returning: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn(), allowedEmail: vi.fn(), authConfigured: vi.fn() }));
vi.mock("@/db", () => ({ database: () => ({ select: mocks.select, update: mocks.update }) }));
vi.mock("@/lib/server", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/server")>(), requireOwner: mocks.owner }));

const leg = (from: string, to: string): TravelEdge => ({ day: 0, from, to, mode: "WALK", minutes: 15, meters: 900 });
function fixture() {
  const coffee = { ...newStop("Sango Coffee"), duration: 45 };
  const museum = { ...newStop("Rijksmuseum"), duration: 60 };
  const amsterdam = { ...newTrip(), city: "Amsterdam", hotel: "Motel One", startDate: "2026-12-24", days: 1, timeZone: "Europe/Amsterdam", stops: [coffee, museum] };
  const schedule: Schedule = { generatedAt: "2026-10-14T06:00:00Z", warnings: [], omitted: [], days: [{ day: 0, date: "2026-12-24", visits: [
    { stopId: coffee.id, start: minuteAt(amsterdam, 0, "09:30"), end: minuteAt(amsterdam, 0, "10:15"), leg: leg("hotel", coffee.id) },
    { stopId: museum.id, start: minuteAt(amsterdam, 0, "11:00"), end: minuteAt(amsterdam, 0, "12:00"), leg: leg(coffee.id, museum.id) },
  ], returnLeg: leg(museum.id, "hotel") }] };
  const journey: Journey = { id: crypto.randomUUID(), title: "Christmas", cities: [amsterdam], plans: { [amsterdam.id]: persistedPlan(schedule, amsterdam) } };
  return { journey, amsterdam, coffee, museum };
}
const send = (id: string, body: unknown) => POST(new Request(`http://localhost/api/trips/${id}/progress`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ tripId: id }) });

beforeEach(() => {
  vi.resetAllMocks();
  // 12:30 in Amsterdam on Christmas Eve.
  vi.useFakeTimers({ now: new Date("2026-12-24T11:30:00Z"), toFake: ["Date"] });
  mocks.owner.mockResolvedValue("owner@example.com");
  mocks.select.mockReturnValue({ from: mocks.from });
  mocks.from.mockReturnValue({ where: mocks.selectWhere });
  mocks.selectWhere.mockReturnValue({ limit: mocks.limit });
  mocks.update.mockReturnValue({ set: mocks.set });
  mocks.set.mockReturnValue({ where: mocks.where });
  mocks.where.mockReturnValue({ returning: mocks.returning });
});
afterEach(() => vi.useRealTimers());

describe("changes saved on the phone, sent later", () => {
  it("records each at the time it was tapped and saves the trip once, if nothing else saved it meanwhile", async () => {
    const { journey, amsterdam, coffee, museum } = fixture();
    mocks.limit.mockResolvedValue([{ data: journey, plan: null, revision: 4 }]);
    mocks.returning.mockResolvedValue([{ revision: 5 }]);
    const response = await send(journey.id, { actions: [
      { kind: "done", cityId: amsterdam.id, day: 0, stopId: coffee.id, at: Date.parse("2026-12-24T09:20:00Z") },
      { kind: "skip", cityId: amsterdam.id, day: 0, stopId: museum.id, at: Date.parse("2026-12-24T10:00:00Z") },
    ] });
    expect(await response.json()).toEqual({ revision: 5, results: [{ ok: true, message: "Sango Coffee marked done" }, { ok: true, message: "Rijksmuseum skipped" }] });
    const saved = mocks.set.mock.calls[0][0];
    expect(saved).toMatchObject({ plan: null, revision: 5 });
    expect(saved.data.execution[amsterdam.id]["2026-12-24"]).toMatchObject({ completed: [{ stopId: coffee.id, end: minuteAt(amsterdam, 0, "10:20") }], skipped: [museum.id] });
    expect(new PgDialect().sqlToQuery(mocks.where.mock.calls[0][0]).params).toEqual([journey.id, "owner@example.com", 4]);
  });

  it("keeps the day's note and favourites written on the phone", async () => {
    const { journey, amsterdam, coffee } = fixture();
    mocks.limit.mockResolvedValue([{ data: journey, plan: null, revision: 4 }]);
    mocks.returning.mockResolvedValue([{ revision: 5 }]);
    const response = await send(journey.id, { actions: [
      { kind: "note", cityId: amsterdam.id, day: 0, text: "Snow on the canals" },
      { kind: "favourite", cityId: amsterdam.id, day: 0, stopId: coffee.id, on: true },
      { kind: "favourite", cityId: amsterdam.id, day: 0, stopId: crypto.randomUUID(), on: true },
    ] });
    expect(await response.json()).toEqual({ revision: 5, results: [{ ok: true, message: "Note saved" }, { ok: true, message: "Sango Coffee added to favourites" }, { ok: false, message: "That visit isn't in this trip." }] });
    expect(mocks.set.mock.calls[0][0].data.journal).toEqual({ [amsterdam.id]: { "2026-12-24": { note: "Snow on the canals", favourites: [coffee.id] } } });
  });

  it("says which it couldn't keep, and saves nothing when nothing changed", async () => {
    const { journey, amsterdam, coffee } = fixture();
    mocks.limit.mockResolvedValue([{ data: journey, plan: null, revision: 4 }]);
    const response = await send(journey.id, { actions: [
      // Tapped the day before: too late to record.
      { kind: "done", cityId: amsterdam.id, day: 0, stopId: coffee.id, at: Date.parse("2026-12-23T12:00:00Z") },
      { kind: "reset", cityId: amsterdam.id, day: 0, stopId: coffee.id },
    ] });
    expect(await response.json()).toEqual({ revision: 4, results: [{ ok: false, message: "Only today's visits can be marked." }, { ok: true, message: "Sango Coffee isn't marked" }] });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("tries once more on a newer copy, then asks to try again later", async () => {
    const { journey, amsterdam, coffee } = fixture();
    mocks.limit.mockResolvedValueOnce([{ data: journey, plan: null, revision: 4 }]).mockResolvedValueOnce([{ data: journey, plan: null, revision: 5 }]);
    mocks.returning.mockResolvedValueOnce([]).mockResolvedValueOnce([{ revision: 6 }]);
    const action = { kind: "done", cityId: amsterdam.id, day: 0, stopId: coffee.id };
    expect(await (await send(journey.id, { actions: [action] })).json()).toMatchObject({ revision: 6 });
    mocks.limit.mockResolvedValue([{ data: journey, plan: null, revision: 6 }]);
    mocks.returning.mockResolvedValue([]);
    expect((await send(journey.id, { actions: [action] })).status).toBe(409);
  });

  it("keeps what was added to a transport card, once, and refuses a change it doesn't know on its own", async () => {
    const { journey, amsterdam, coffee } = fixture();
    const card = { kind: "tickets" as const, name: "Strippenkaart", currency: "EUR", travellers: 1, ridePrice: 3 };
    const ride = { id: crypto.randomUUID(), at: Date.parse("2026-12-24T11:00:00Z"), kind: "ride" as const };
    mocks.limit.mockResolvedValue([{ data: { ...journey, transport: { [amsterdam.id]: { card, entries: [ride] } } }, plan: null, revision: 4 }]);
    mocks.returning.mockResolvedValue([{ revision: 5 }]);
    const topUp = { id: crypto.randomUUID(), at: Date.parse("2026-12-24T11:10:00Z"), kind: "topup", amount: 10, paid: 30 };
    const response = await send(journey.id, { actions: [
      { kind: "delete", cityId: amsterdam.id, day: 0, stopId: coffee.id },
      { kind: "transport-entry", cityId: amsterdam.id, entry: ride },
      { kind: "transport-entry", cityId: amsterdam.id, entry: topUp },
      { kind: "transport-void", cityId: amsterdam.id, entryId: ride.id },
    ] });
    expect(await response.json()).toEqual({ revision: 5, results: [
      { ok: false, message: "That change isn't supported." }, { ok: true, message: "Ride added" }, { ok: true, message: "Topped up" }, { ok: true, message: "Ride removed" },
    ] });
    expect(mocks.set.mock.calls[0][0].data.transport[amsterdam.id].entries).toEqual([{ ...ride, voided: true }, topUp]);
  });

  it("only takes the owner's saved trips and well-formed changes", async () => {
    const { journey, amsterdam, coffee } = fixture();
    mocks.limit.mockResolvedValue([]);
    expect((await send(journey.id, { actions: [{ kind: "done", cityId: amsterdam.id, day: 0, stopId: coffee.id }] })).status).toBe(404);
    expect((await send(journey.id, { actions: [] })).status).toBe(400);
    expect((await send("not-a-trip", { actions: [{ kind: "done", cityId: amsterdam.id, day: 0, stopId: coffee.id }] })).status).toBe(400);
  });
});
