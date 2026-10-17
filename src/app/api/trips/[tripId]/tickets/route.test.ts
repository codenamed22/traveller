import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as list, POST } from "./route";
import { DELETE, GET } from "./[ticketId]/route";
import type { Journey } from "@/lib/journey";
import { newStop, newTrip } from "@/lib/trip";

// Each select answers with the next queued rows, whichever way the query ends.
const mocks = vi.hoisted(() => ({ owner: vi.fn(), rows: [] as unknown[][], values: vi.fn(), returning: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn(), allowedEmail: vi.fn(), authConfigured: vi.fn() }));
vi.mock("@/db", () => ({
  database: () => ({
    select: () => {
      const done = Promise.resolve(mocks.rows.shift() ?? []);
      const query = { from: () => query, where: () => query, limit: () => done, orderBy: () => done, then: done.then.bind(done) };
      return query;
    },
    insert: () => ({ values: mocks.values }),
    delete: () => ({ where: () => ({ returning: mocks.returning }) }),
  }),
}));
vi.mock("@/lib/server", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/server")>(), requireOwner: mocks.owner }));

function fixture() {
  const museum = newStop("Rijksmuseum");
  const amsterdam = { ...newTrip(), city: "Amsterdam", hotel: "Motel One", startDate: "2026-12-24", days: 1, timeZone: "Europe/Amsterdam", stops: [museum] };
  const journey: Journey = { id: crypto.randomUUID(), title: "Christmas", cities: [amsterdam], plans: {} };
  return { journey, amsterdam, museum };
}
const pdf = new TextEncoder().encode("%PDF-1.7\nticket");
function upload(tripId: string, fields: Record<string, string>, file: Blob = new Blob([pdf], { type: "application/pdf" }), name = "Rijksmuseum.pdf", headers: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", file, name);
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return POST(new Request(`http://localhost/api/trips/${tripId}/tickets`, { method: "POST", body: form, headers }), { params: Promise.resolve({ tripId }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rows = [];
  mocks.owner.mockResolvedValue("owner@example.com");
  mocks.values.mockResolvedValue(undefined);
});

describe("adding a ticket", () => {
  it("keeps a PDF for a visit, named and checked by its contents", async () => {
    const { journey, amsterdam, museum } = fixture();
    mocks.rows = [[{ data: journey, plan: null }], [{ count: 2 }], [{ bytes: "1000" }]];
    const response = await upload(journey.id, { cityId: amsterdam.id, target: "stop", stopId: museum.id });
    expect(response.status).toBe(201);
    const { ticket } = await response.json();
    expect(ticket).toMatchObject({ tripId: journey.id, cityId: amsterdam.id, target: "stop", stopId: museum.id, name: "Rijksmuseum.pdf", mime: "application/pdf", size: pdf.byteLength });
    expect(ticket.sha256).toMatch(/^[0-9a-f]{64}$/);
    const saved = mocks.values.mock.calls[0][0];
    expect(saved).toMatchObject({ id: ticket.id, owner: "owner@example.com" });
    expect(new Uint8Array(saved.data)).toEqual(pdf);
  });

  it("keeps one for leaving a city, whatever the browser called the file", async () => {
    const { journey, amsterdam } = fixture();
    mocks.rows = [[{ data: journey, plan: null }], [{ count: 0 }], [{ bytes: null }]];
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const response = await upload(journey.id, { cityId: amsterdam.id, target: "departure" }, new Blob([png], { type: "application/octet-stream" }), "/");
    expect(await response.json()).toMatchObject({ ticket: { target: "departure", stopId: null, mime: "image/png", name: "Ticket.png" } });
  });

  it("refuses files that aren't a PDF, JPEG or PNG, and visits the saved trip doesn't have", async () => {
    const { journey, amsterdam, museum } = fixture();
    const fake = await upload(journey.id, { cityId: amsterdam.id, target: "stop", stopId: museum.id }, new Blob(["<html>"], { type: "application/pdf" }));
    expect([fake.status, (await fake.json()).error]).toEqual([415, "Add a PDF, JPEG or PNG."]);
    mocks.rows = [[{ data: journey, plan: null }]];
    const unknown = await upload(journey.id, { cityId: amsterdam.id, target: "stop", stopId: crypto.randomUUID() });
    expect([unknown.status, (await unknown.json()).error]).toEqual([400, "Save the trip before adding tickets."]);
    mocks.rows = [[]];
    const unsaved = await upload(journey.id, { cityId: amsterdam.id, target: "arrival" });
    expect(unsaved.status).toBe(404);
    // A visit's ticket names its visit, and an arrival's doesn't.
    expect((await upload(journey.id, { cityId: amsterdam.id, target: "stop" })).status).toBe(400);
    expect(mocks.values).not.toHaveBeenCalled();
  });

  it("stops at 30 a trip, at the account's storage, and before reading a body that's too large", async () => {
    const { journey, amsterdam } = fixture();
    mocks.rows = [[{ data: journey, plan: null }], [{ count: 30 }], [{ bytes: "0" }]];
    expect((await (await upload(journey.id, { cityId: amsterdam.id, target: "arrival" })).json()).error).toBe("A trip can have up to 30 tickets.");
    mocks.rows = [[{ data: journey, plan: null }], [{ count: 0 }], [{ bytes: String(150_000_000 - 5) }]];
    expect((await (await upload(journey.id, { cityId: amsterdam.id, target: "arrival" })).json()).error).toBe("Ticket storage is full. Delete tickets from past trips first.");
    const large = await upload(journey.id, { cityId: amsterdam.id, target: "arrival" }, undefined, undefined, { "content-length": "5000000" });
    expect(large.status).toBe(413);
    expect(mocks.values).not.toHaveBeenCalled();
  });
});

describe("a saved ticket", () => {
  const params = (tripId: string, ticketId: string) => ({ params: Promise.resolve({ tripId, ticketId }) });

  it("lists without files, opens in the browser, and isn't sent again while unchanged", async () => {
    const tripId = crypto.randomUUID(), ticketId = crypto.randomUUID();
    mocks.rows = [[{ id: ticketId, name: "Eurostar.pdf" }]];
    expect(await (await list(new Request("http://localhost"), { params: Promise.resolve({ tripId }) })).json()).toEqual({ tickets: [{ id: ticketId, name: "Eurostar.pdf" }] });
    mocks.rows = [[{ name: "Eurostar 9114.pdf", mime: "application/pdf", sha256: "abc", data: Buffer.from(pdf) }]];
    const response = await GET(new Request("http://localhost"), params(tripId, ticketId));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(pdf);
    expect(Object.fromEntries(response.headers)).toMatchObject({ "content-type": "application/pdf", "content-disposition": "inline; filename*=UTF-8''Eurostar%209114.pdf", etag: "\"abc\"", "x-content-type-options": "nosniff" });
    mocks.rows = [[{ name: "Eurostar 9114.pdf", mime: "application/pdf", sha256: "abc", data: Buffer.from(pdf) }]];
    expect((await GET(new Request("http://localhost", { headers: { "If-None-Match": "\"abc\"" } }), params(tripId, ticketId))).status).toBe(304);
    mocks.rows = [[]];
    expect((await GET(new Request("http://localhost"), params(tripId, ticketId))).status).toBe(404);
  });

  it("can be deleted by its owner", async () => {
    const tripId = crypto.randomUUID(), ticketId = crypto.randomUUID();
    mocks.returning.mockResolvedValueOnce([{ id: ticketId }]).mockResolvedValueOnce([]);
    const remove = () => DELETE(new Request("http://localhost", { method: "DELETE" }), params(tripId, ticketId));
    expect((await remove()).status).toBe(204);
    expect((await remove()).status).toBe(404);
  });
});
