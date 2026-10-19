import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { minuteAt, newStop, newTrip, persistedPlan, type Place, type Schedule, type TravelEdge } from "@/lib/trip";
import type { NativeTripMode } from "@/lib/native-trip-mode";
import { TripPlanner } from "./TripPlanner";

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: { href: string; children: unknown }) => createElement("a", { href, ...props }, children as never) }));
vi.mock("next-auth/react", () => ({ signOut: vi.fn(), signIn: vi.fn() }));

let root: Root;
let container: HTMLElement;

// Just enough of the browser for the planner signed in: history, storage and modal dialogs.
beforeEach(() => {
  const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
  container = document.getElementById("root") as unknown as HTMLElement;
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(key, value);
  Object.defineProperty(window, "location", { value: { pathname: "/", search: "", hash: "" }, configurable: true });
  Object.defineProperty(window, "history", { value: { pushState() {}, replaceState() {}, back() {} }, configurable: true });
  const stored = new globalThis.Map<string, string>();
  Object.defineProperty(window, "localStorage", { value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value), removeItem: (key: string) => void stored.delete(key) }, configurable: true });
  Object.getPrototypeOf(document.createElement("dialog")).showModal = function (this: Element) { this.setAttribute("open", ""); };
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

const saved = (title: string, city: string) => {
  const trip = { ...newTrip(), city, hotel: "Hotel", startDate: "2026-12-24", days: 2, timeZone: "Europe/Paris" };
  return { data: { id: crypto.randomUUID(), title, cities: [trip], plans: {} }, revision: 3, plan: null, shared: false, updatedAt: "2026-10-15T16:00:00Z" };
};
const config = { auth: true, email: "me@example.com", database: true, maps: false, routes: true, ai: false, extraction: {}, timing: false, assistant: null };
const button = (label: string) => [...container.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label") === label) as HTMLElement;
const settle = async () => { for (let index = 0; index < 10; index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };

describe("My trips", () => {
  it("marks the trip already open, returns to it as it was, and opens another", async () => {
    const open = saved("Christmas", "Paris");
    const other = saved("Spring", "Rome");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ trips: [open, other] })));
    await act(async () => root.render(createElement(TripPlanner, { initialTrip: newTrip(), initialSaved: open, initialList: null, config } as never)));
    await act(async () => button("My trips").click());
    await settle();
    const rows = [...container.querySelectorAll(".saved-trip")] as HTMLElement[];
    expect(rows.map((row) => row.getAttribute("aria-current"))).toEqual(["true", null]);
    expect(rows[0].textContent).toContain("Open now");
    await act(async () => rows[0].click());
    expect(container.querySelector(".saved-trips")).toBeNull();
    expect(container.textContent).not.toContain("Trip loaded");
    await act(async () => button("My trips").click());
    await settle();
    await act(async () => (container.querySelectorAll(".saved-trip")[1] as HTMLElement).click());
    expect((container.querySelector(".trip-title") as HTMLInputElement).value).toBe("Spring");
    expect(container.textContent).toContain("Trip loaded");
  });

  it("duplicates a trip as a new saved trip, listed first", async () => {
    const open = saved("Christmas", "Paris");
    const other = saved("Spring", "Rome");
    const saves: { url: string; body: { journey: { id: string; title: string; cities: unknown[] }; revision: number } }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") { saves.push({ url, body: JSON.parse(String(init.body)) }); return Response.json({ revision: 1 }); }
      return Response.json({ trips: [open, other] });
    }));
    await act(async () => root.render(createElement(TripPlanner, { initialTrip: newTrip(), initialSaved: open, initialList: null, config } as never)));
    await act(async () => button("My trips").click());
    await settle();
    await act(async () => button("Duplicate Spring").click());
    await settle();
    expect(saves).toHaveLength(1);
    const copy = saves[0].body.journey;
    expect(saves[0]).toMatchObject({ url: `/api/trips/${copy.id}`, body: { revision: 0, journey: { title: "Spring (copy)", cities: other.data.cities } } });
    expect(copy.id).not.toBe(other.data.id);
    expect([...container.querySelectorAll(".saved-trip strong")].map((title) => title.textContent)).toEqual(["Spring (copy)", "Christmas", "Spring"]);
  });
});

describe("tickets", () => {
  it("keeps tickets for a visit and for leaving the city, and gives them to the app", async () => {
    const messages: { type: string; snapshot?: NativeTripMode }[] = [];
    Object.assign(window, { webkit: { messageHandlers: { travellerTripMode: { postMessage: (message: never) => messages.push(message) } } }, confirm: () => true });
    const museum = newStop("Rijksmuseum");
    const amsterdam = { ...newTrip(), city: "Amsterdam", hotel: "Motel One", startDate: "2026-12-24", days: 1, timeZone: "Europe/Amsterdam", stops: [museum], departure: { mode: "TRAIN" as const, time: "18:00", place: "Amsterdam Centraal" } };
    const entry = { data: { id: crypto.randomUUID(), title: "Christmas", cities: [amsterdam], plans: {} }, revision: 2, plan: null, shared: false, updatedAt: "2026-10-15T16:00:00Z" };
    const meta = { tripId: entry.data.id, cityId: amsterdam.id, size: 9, sha256: "a".repeat(64) };
    const train = { ...meta, id: crypto.randomUUID(), target: "departure", stopId: null, name: "Eurostar.pdf", mime: "application/pdf" };
    const calls: { url: string; method: string; body?: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body });
      if (url.endsWith("/tickets") && init?.method === "POST") {
        const form = init.body as FormData;
        return Response.json({ ticket: { ...meta, id: crypto.randomUUID(), target: form.get("target"), stopId: form.get("stopId"), name: (form.get("file") as File).name, mime: "image/jpeg" } }, { status: 201 });
      }
      if (url.endsWith("/tickets")) return Response.json({ tickets: [train] });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ trips: [] });
    }));
    await act(async () => root.render(createElement(TripPlanner, { initialTrip: newTrip(), initialSaved: entry, initialList: null, config } as never)));
    await settle();
    const links = () => [...container.querySelectorAll(".ticket a")].map((link) => [link.textContent, link.getAttribute("href")]);
    expect(links()).toEqual([["Eurostar.pdf", `/api/trips/${entry.data.id}/tickets/${train.id}`]]);
    expect(container.querySelector(".transfer-fields:last-of-type .ticket")).not.toBeNull();

    await act(async () => (container.querySelector(".stop-summary") as HTMLElement).click());
    const input = container.querySelector(".stop-details input[type=file]") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File(["\xff\xd8\xff"], "Museum.jpg", { type: "image/jpeg" })], configurable: true });
    await act(async () => { input.dispatchEvent(new window.Event("change", { bubbles: true })); });
    await settle();
    const form = calls.find((call) => call.method === "POST")!.body as FormData;
    expect([form.get("cityId"), form.get("target"), form.get("stopId")]).toEqual([amsterdam.id, "stop", museum.id]);
    expect(container.querySelector(".stop-details .ticket a")?.textContent).toBe("Museum.jpg");

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2100)); });
    const sent = messages.filter((message) => message.type === "sync").at(-1)!.snapshot!;
    expect(sent.tickets?.map((ticket) => [ticket.name, ticket.target, ticket.stopId])).toEqual([["Eurostar.pdf", "departure", undefined], ["Museum.jpg", "stop", museum.id]]);

    await act(async () => button("Delete Eurostar.pdf").click());
    await settle();
    expect(calls.at(-1)).toMatchObject({ url: `/api/trips/${entry.data.id}/tickets/${train.id}`, method: "DELETE" });
    expect(links().map(([name]) => name)).toEqual(["Museum.jpg"]);
  });
});

describe("native trip mode in the iPhone app", () => {
  const place = (id: string, name: string): Place => ({ id, name, address: `${name} street`, location: { lat: 52.37, lng: 4.89 } });
  const leg = (from: string, to: string, minutes: number): TravelEdge => ({ day: 0, from, to, mode: "WALK", minutes, meters: 900 });
  function planned() {
    const coffee = { ...newStop("Sango Coffee"), placeId: "g-sango", duration: 45 };
    const amsterdam = { ...newTrip(), city: "Amsterdam", hotel: "Motel One", startDate: "2026-12-24", days: 1, timeZone: "Europe/Amsterdam", stops: [coffee] };
    const schedule: Schedule = { generatedAt: "2026-10-14T06:00:00Z", warnings: [], omitted: [], days: [
      { day: 0, date: "2026-12-24", visits: [{ stopId: coffee.id, start: minuteAt(amsterdam, 0, "09:30"), end: minuteAt(amsterdam, 0, "10:15"), leg: leg("hotel", coffee.id, 15) }], returnLeg: leg(coffee.id, "hotel", 15) },
    ] };
    const plans = { [amsterdam.id]: persistedPlan(schedule, amsterdam, { hotel: place("g-hotel", "Motel One"), [coffee.id]: place("g-sango", "Sango Coffee") }) };
    return { coffee, amsterdam, entry: { data: { id: crypto.randomUUID(), title: "Christmas", cities: [amsterdam], plans }, revision: 1, plan: null, shared: false, updatedAt: "2026-10-15T16:00:00Z" } };
  }

  it("hands trip mode to the app and records Done and Undo it sends back", async () => {
    // 10:00 in Amsterdam on Christmas Eve.
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-12-24T09:00:00Z"));
    try {
      // Trip mode's own messages; the app's background copies (`sync`) are checked on their own below.
      const messages: { type: string; snapshot: NativeTripMode }[] = [];
      const posted = { get list() { return messages.filter((message) => message.type !== "sync"); } };
      Object.assign(window, { webkit: { messageHandlers: { travellerTripMode: { postMessage: (message: never) => messages.push(message) } } } });
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ revision: 2 })));
      const { coffee, amsterdam, entry } = planned();
      await act(async () => root.render(createElement(TripPlanner, { initialTrip: newTrip(), initialSaved: entry, initialList: null, config } as never)));
      await act(async () => (container.querySelector(".trip-mode-pill") as HTMLElement).click());
      expect(container.querySelector(".trip-mode")).toBeNull();
      expect(posted.list.map((message) => message.type)).toEqual(["open"]);
      expect(posted.list[0].snapshot).toMatchObject({ title: "Christmas", startKey: `${amsterdam.id}:0`, canTrack: true, days: [{ visits: [{ name: "Sango Coffee", status: "pending" }] }] });

      // The app looks the calls up afresh each time, as they're rebuilt with every render.
      type Native = { features: string[]; record: (...args: unknown[]) => string; undo: (...args: unknown[]) => boolean; closed: () => void };
      const native = () => (window as unknown as { travellerNative: Native }).travellerNative;
      expect(native().features).toContain("record-at");
      let message = "";
      await act(async () => { message = native().record("done", amsterdam.id, 0, coffee.id); });
      expect(message).toBe("Sango Coffee marked done");
      expect(posted.list.at(-1)).toMatchObject({ type: "update", snapshot: { days: [{ visits: [{ status: "done", doneLabel: "09:15–10:00" }] }] } });
      await act(async () => { native().undo(amsterdam.id, "2026-12-24"); });
      expect(posted.list.at(-1)?.snapshot.days[0].visits[0].status).toBe("pending");
      expect(native().undo(amsterdam.id, "2026-12-24")).toBe(false);
      // A Done tapped without a connection arrives later with the time it was tapped.
      await act(async () => { native().record("done", amsterdam.id, 0, coffee.id, Date.parse("2026-12-24T08:40:00Z")); });
      expect(posted.list.at(-1)?.snapshot.days[0].visits[0]).toMatchObject({ status: "done", doneLabel: "08:55–09:40" });
      // Once the app closes trip mode, trip changes stay here.
      const count = posted.list.length;
      await act(async () => { native().closed(); native().record("skip", amsterdam.id, 0, coffee.id); });
      expect(posted.list).toHaveLength(count);
    } finally { vi.useRealTimers(); }
  });

  it("shows each day's forecast and rain on outdoor visits, and gives both to the app", async () => {
    // 10:00 in Amsterdam on Christmas Eve.
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-12-24T09:00:00Z"));
    try {
      const messages: { type: string; snapshot?: NativeTripMode }[] = [];
      Object.assign(window, { webkit: { messageHandlers: { travellerTripMode: { postMessage: (message: never) => messages.push(message) } } } });
      const forecast = {
        daily: { time: ["2026-12-24"], weather_code: [63], temperature_2m_max: [6.2], temperature_2m_min: [1.8], precipitation_probability_max: [80] },
        hourly: { time: ["2026-12-24T09:00", "2026-12-24T10:00"], precipitation_probability: [80, 60] },
      };
      const asked: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (url.startsWith("https://api.open-meteo.com/")) { asked.push(url); return Response.json(forecast); }
        return Response.json({ revision: 2, trips: [] });
      }));
      const { coffee, amsterdam, entry } = planned();
      // A walk in the park instead of coffee.
      const park = { ...coffee, name: "Vondelpark" };
      const outdoors = { ...entry, data: { ...entry.data, cities: [{ ...amsterdam, stops: [park] }], plans: Object.fromEntries(Object.entries(entry.data.plans).map(([id, plan]) => [id, { ...plan, snapshot: { ...plan.snapshot!, trip: { ...plan.snapshot!.trip, stops: [park] } } }])) } };
      await act(async () => root.render(createElement(TripPlanner, { initialTrip: newTrip(), initialSaved: outdoors, initialList: null, config } as never)));
      await settle();
      // Asked once, at the hotel, in the city's time zone.
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain("latitude=52.370&longitude=4.890&timezone=Europe%2FAmsterdam");
      expect(container.querySelector(".day-tabs .weather")?.textContent).toBe("6°");
      await act(async () => [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.startsWith("Itinerary"))!.click());
      // No agent here, so no Swap.
      expect(container.querySelector(".itinerary-content .rain-warning")?.textContent).toBe("80% rain");
      expect(container.querySelector(".route-notices")?.textContent).toContain("Weather: Open-Meteo");

      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2100)); });
      const sent = messages.filter((message) => message.type === "sync").at(-1)!.snapshot!;
      expect(sent.days[0].weather).toEqual({ label: "Rain", icon: "rain", max: 6, min: 2, rain: 80 });
      expect(sent.days[0].visits[0].rain).toBe(80);
      expect(sent.swap).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it("tells the app when the trip is saved, saves again once the connection is back, and sends every other trip", async () => {
    // 10:00 in Amsterdam on Christmas Eve.
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-12-24T09:00:00Z"));
    try {
      const messages: { type: string; saved?: boolean; snapshots?: NativeTripMode[]; ids?: string[] }[] = [];
      Object.assign(window, { webkit: { messageHandlers: { travellerTripMode: { postMessage: (message: never) => messages.push(message) } } } });
      const { coffee, amsterdam, entry } = planned();
      const other = { ...planned().entry, data: { ...planned().entry.data, title: "Boxing Day" } };
      let puts = 0;
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method !== "PUT") return Response.json({ trips: [entry, other] });
        // The first save finds no connection.
        if (++puts === 1) throw new TypeError("Load failed");
        return Response.json({ revision: 2 });
      }));
      await act(async () => root.render(createElement(TripPlanner, { initialTrip: newTrip(), initialSaved: entry, initialList: null, config } as never)));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2100)); });
      const store = messages.find((message) => message.type === "store")!;
      expect(store.snapshots!.map((snapshot) => snapshot.journeyId)).toEqual([other.data.id]);
      expect(store.ids).toEqual([entry.data.id, other.data.id]);
      expect(messages.filter((message) => message.type === "sync").map((message) => message.saved)).toEqual([true]);

      type Native = { record: (...args: unknown[]) => string };
      await act(async () => { (window as unknown as { travellerNative: Native }).travellerNative.record("done", amsterdam.id, 0, coffee.id); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2100)); });
      expect(puts).toBe(1);
      expect(container.textContent).toContain("Offline, not saved yet");
      expect(messages.filter((message) => message.type === "sync").map((message) => message.saved)).toEqual([true, false]);

      await act(async () => { window.dispatchEvent(new window.Event("online")); });
      // 1.5 s to save, then the copy for the app 2 s after that.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1700)); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2100)); });
      expect(puts).toBe(2);
      expect(container.textContent).not.toContain("not saved yet");
      expect(messages.filter((message) => message.type === "sync").map((message) => message.saved)).toEqual([true, false, true]);
    } finally { vi.useRealTimers(); }
  }, 15_000);

  it("gives the app a copy of the trip shortly after it loads or changes, and says when it's deleted", async () => {
    const messages: { type: string; snapshot?: NativeTripMode; journeyId?: string }[] = [];
    Object.assign(window, { webkit: { messageHandlers: { travellerTripMode: { postMessage: (message: never) => messages.push(message) } } } });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ revision: 2 })));
    const { entry } = planned();
    await act(async () => root.render(createElement(TripPlanner, { initialTrip: newTrip(), initialSaved: entry, initialList: null, config } as never)));
    expect(messages).toEqual([]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2100)); });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "sync", snapshot: { journeyId: entry.data.id, level: 2, days: [{ visits: [{ name: "Sango Coffee" }] }] } });

    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ trips: [entry] })));
    vi.stubGlobal("confirm", () => true);
    Object.assign(window, { confirm: () => true });
    await act(async () => button("My trips").click());
    await settle();
    await act(async () => (container.querySelector(".saved-trips button[aria-label^='Delete']") as HTMLElement).click());
    await settle();
    expect(messages.at(-1)).toEqual({ type: "removed", journeyId: entry.data.id });
  });
});
