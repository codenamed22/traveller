import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import type { DayProgress } from "@/lib/day-recovery";
import type { Journey } from "@/lib/journey";
import { minuteAt, newStop, newTrip, persistedPlan, type Place, type Schedule, type TravelEdge, type Trip } from "@/lib/trip";
import { parseForecast } from "@/lib/weather";
import { TripMode } from "./TripMode";

// The map stands in as a surface to tap, remembering where it was last told to centre.
const map = vi.hoisted(() => ({ centerOn: undefined as { lat: number; lng: number } | undefined }));
vi.mock("./TripMap", async () => {
  const { createElement: element } = await import("react");
  return { TripMap: ({ onMapClick, centerOn }: { onMapClick?: () => void; centerOn?: { lat: number; lng: number } }) => { map.centerOn = centerOn; return element("button", { type: "button", className: "test-map", onClick: onMapClick }, "Map"); } };
});

let root: Root;
let container: HTMLElement;
let win: Window & typeof globalThis;
const entries: string[] = [];

// Just enough of location and history for trip mode's back-button handling.
function browser(hash = "") {
  const location = { pathname: "/", search: "", hash };
  entries.splice(0, entries.length, hash);
  const pop = () => { location.hash = entries.at(-1) ?? ""; win.dispatchEvent(new win.Event("popstate")); };
  const history = {
    pushState: (_state: unknown, _title: string, url: string) => { entries.push(url); location.hash = url; },
    replaceState: (_state: unknown, _title: string, url: string) => { entries[entries.length - 1] = url.startsWith("#") ? url : ""; location.hash = entries.at(-1)!; },
    back: () => { entries.pop(); pop(); },
    go: (delta: number) => { entries.splice(entries.length + delta, -delta); pop(); },
  };
  Object.defineProperty(win, "location", { value: location, configurable: true });
  Object.defineProperty(win, "history", { value: history, configurable: true });
}

beforeEach(() => {
  const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
  win = window as unknown as Window & typeof globalThis;
  container = document.getElementById("root") as unknown as HTMLElement;
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("navigator", window.navigator);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("Node", window.Node);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  browser();
  // 10:00 in Amsterdam on Christmas Eve.
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-12-24T09:00:00Z"));
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const place = (id: string, name: string): Place => ({ id, name, address: `${name} street`, location: { lat: 52.37, lng: 4.89 } });
const leg = (from: string, to: string, minutes: number): TravelEdge => ({ day: 0, from, to, mode: "WALK", minutes, meters: 900 });

function journey() {
  const coffee = { ...newStop("Sango Coffee"), placeId: "g-sango", duration: 45, source: "09:30 – 10:15 | Sango\\nBest pour-over in town" };
  const museum = { ...newStop("Rijksmuseum"), placeId: "g-rijks", day: 0, fixedTime: "11:00", duration: 120, source: "See the **Night Watch** first *(2 hours)*." };
  const dinner = { ...newStop("FUKU"), placeId: "g-fuku", duration: 60 };
  const amsterdam: Trip = { ...newTrip(), city: "Amsterdam", hotel: "Motel One", startDate: "2026-12-24", days: 2, timeZone: "Europe/Amsterdam", dailyStart: "09:00", dailyEnd: "21:00", stops: [coffee, museum, dinner] };
  const at = (day: number, time: string) => minuteAt(amsterdam, day, time);
  const schedule: Schedule = { generatedAt: "2026-10-14T06:00:00Z", warnings: [], omitted: [], days: [
    { day: 0, date: "2026-12-24", visits: [{ stopId: coffee.id, start: at(0, "09:30"), end: at(0, "10:15"), leg: leg("hotel", coffee.id, 15) }, { stopId: museum.id, start: at(0, "11:00"), end: at(0, "13:00"), leg: leg(coffee.id, museum.id, 20) }], returnLeg: leg(museum.id, "hotel", 25) },
    { day: 1, date: "2026-12-25", visits: [{ stopId: dinner.id, start: at(1, "18:00"), end: at(1, "19:00"), leg: leg("hotel", dinner.id, 10) }], returnLeg: leg(dinner.id, "hotel", 10) },
  ] };
  const places = { hotel: place("g-hotel", "Motel One"), [coffee.id]: place("g-sango", "Sango Coffee"), [museum.id]: place("g-rijks", "Rijksmuseum"), [dinner.id]: place("g-fuku", "FUKU") };
  const brussels: Trip = { ...newTrip(), city: "Brussels", startDate: "2026-12-26", days: 1, timeZone: "Europe/Brussels", stops: [newStop("Grand Place")] };
  return { amsterdam, cities: [amsterdam, brussels], plans: { [amsterdam.id]: persistedPlan(schedule, amsterdam, places) } };
}

// Keeps progress in state, as the planner does.
function Harness({ canTrack, onClose, record, photos = false }: { canTrack: boolean; onClose: () => void; record: (cityId: string, date: string, progress?: DayProgress) => void; photos?: boolean }) {
  const { cities, plans } = journey();
  const [data] = useState({ cities, plans });
  const [execution, setExecution] = useState<Journey["execution"]>({});
  return createElement(TripMode, { title: "Amsterdam & Brussels", cities: data.cities, plans: data.plans, execution, canTrack, onClose, photos, onProgress: canTrack ? (cityId: string, date: string, progress?: DayProgress) => {
    record(cityId, date, progress);
    setExecution((current) => { const city = { ...current?.[cityId] }; if (progress) city[date] = progress; else delete city[date]; return { ...current, [cityId]: city }; });
  } : undefined });
}

const text = () => container.textContent ?? "";
const button = (label: string) => [...container.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label)!;
const click = (label: string) => act(async () => button(label).click());

describe("trip mode", () => {
  it("opens on today with the next stop, directions from here, and Done with Undo", async () => {
    const record = vi.fn();
    await act(async () => root.render(createElement(Harness, { canTrack: true, onClose: vi.fn(), record })));
    expect(entries.at(-1)).toBe("#trip");
    expect(container.querySelector(".trip-mode-day strong")?.textContent).toBe("Day 1 · Thu 24 Dec");
    expect(text()).toContain("Amsterdam · Today");
    expect(container.querySelector(".trip-card")?.textContent).toContain("Next · 1 of 2Sango Coffee09:30–10:15Leave by 09:15 · 15 min walk · now");
    const directions = new URL(container.querySelector<HTMLAnchorElement>(".trip-card a")!.href);
    expect(directions.searchParams.has("origin")).toBe(false);
    expect(directions.searchParams.get("destination_place_id")).toBe("g-sango");
    await click("Done");
    expect(record).toHaveBeenLastCalledWith(expect.any(String), "2026-12-24", expect.objectContaining({ completed: [expect.objectContaining({ end: 600 })] }));
    expect(text()).toContain("Sango Coffee marked done");
    expect(container.querySelector(".trip-card")?.textContent).toContain("Next · 2 of 2Rijksmuseum11:00–13:00Booked");
    expect(container.querySelector(".trip-card")?.textContent).toContain("Leave by 10:40 · 20 min walk · in 40 min");
    await click("Undo");
    expect(record).toHaveBeenLastCalledWith(expect.any(String), "2026-12-24", undefined);
    expect(container.querySelector(".trip-card")?.textContent).toContain("Sango Coffee");
  });

  it("shows the day's weather and offers to swap a visit rain threatens", async () => {
    const { amsterdam, cities, plans } = journey();
    const museum = amsterdam.stops[1];
    const snapshot = plans[amsterdam.id].snapshot!;
    // The museum as a park, with rain likely from 11:00.
    const outdoors = { ...plans, [amsterdam.id]: { ...plans[amsterdam.id], snapshot: { ...snapshot, places: { ...snapshot.places, [museum.id]: { ...snapshot.places[museum.id], types: ["park"] } } } } };
    const forecast = parseForecast({
      daily: { time: ["2026-12-24"], weather_code: [63], temperature_2m_max: [6], temperature_2m_min: [2], precipitation_probability_max: [70] },
      hourly: { time: ["09", "10", "11", "12"].map((hour) => `2026-12-24T${hour}:00`), precipitation_probability: [10, 10, 70, 70] },
    }, "Europe/Amsterdam", 1);
    const onSwap = vi.fn();
    await act(async () => root.render(createElement(TripMode, { title: "Amsterdam", cities, plans: outdoors, canTrack: true, onClose: vi.fn(), forecasts: { [amsterdam.id]: forecast }, onSwap })));
    expect(container.querySelector(".trip-mode-day .weather")?.textContent).toBe("6°2°");
    // The coffee comes first, indoors; the timeline shows the rain on the museum.
    expect(container.querySelector(".trip-card .rain-warning")).toBeNull();
    expect(container.querySelector(".trip-timeline .rain-warning")?.textContent).toBe("70% rain");
    expect(text()).toContain("Weather: Open-Meteo");
    await act(async () => container.querySelectorAll<HTMLButtonElement>(".trip-timeline .itinerary-stop")[1].click());
    expect(container.querySelector(".trip-card .rain-warning")?.textContent).toBe("70% rainSwap?");
    await click("Swap?");
    expect(onSwap).toHaveBeenCalledWith(amsterdam.id, 0, museum.id);
  });

  it("opens a visit's ticket from its card and the train's from the timeline", async () => {
    const { amsterdam, cities, plans } = journey();
    const arriving = [{ ...amsterdam, arrival: { mode: "TRAIN" as const, time: "08:00", place: "Amsterdam Centraal" } }, cities[1]];
    // Planned with the train, as trip mode shows the day as planned.
    const planned = { ...plans, [amsterdam.id]: { ...plans[amsterdam.id], snapshot: { ...plans[amsterdam.id].snapshot!, trip: arriving[0] } } };
    const ticket = (target: "stop" | "arrival", stopId: string | null, name: string) => ({ id: crypto.randomUUID(), tripId: "6f1c2b7e-4d0a-4c5e-9a43-2f6b8d1e7c90", cityId: amsterdam.id, target, stopId, name, mime: "application/pdf" as const, size: 1, sha256: "" });
    const coffee = ticket("stop", amsterdam.stops[0].id, "Sango.pdf"), train = ticket("arrival", null, "Eurostar.pdf");
    await act(async () => root.render(createElement(TripMode, { title: "Amsterdam", cities: arriving, plans: planned, canTrack: true, onClose: vi.fn(), tickets: [coffee, train, ticket("stop", amsterdam.stops[1].id, "Rijks.pdf")] })));
    const link = (selector: string) => container.querySelector<HTMLAnchorElement>(`${selector} a[href^="/api/trips/"]`);
    expect([link(".trip-card")?.textContent, link(".trip-card")?.getAttribute("href")]).toEqual(["Ticket", `/api/trips/${coffee.tripId}/tickets/${coffee.id}`]);
    expect(link(".transfer-line.arrival")?.getAttribute("href")).toBe(`/api/trips/${train.tripId}/tickets/${train.id}`);
  });

  it("undoes a visit from its card, after the quick Undo has gone", async () => {
    const record = vi.fn();
    await act(async () => root.render(createElement(Harness, { canTrack: true, onClose: vi.fn(), record })));
    await click("Done");
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".itinerary-stop")].find((item) => item.textContent?.includes("Sango Coffee"))!.click());
    const card = container.querySelector(".trip-card")!;
    expect(card.textContent).toContain("Done 09:15–10:00");
    expect([...card.querySelectorAll("button")].map((item) => item.textContent)).not.toContain("Done");
    await act(async () => [...card.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Undo")!.click());
    expect(record).toHaveBeenLastCalledWith(expect.any(String), "2026-12-24", expect.objectContaining({ completed: [], version: 2 }));
    expect(text()).toContain("Sango Coffee no longer marked done");
    expect(container.querySelector(".trip-card")?.textContent).toContain("Leave by 09:15");
  });

  it("loads photos of a tapped place and shows its note without Markdown", async () => {
    const fetch = vi.fn(async () => Response.json({ placeId: "g-sango", index: 0, total: 2, photo: { uri: "https://lh3.googleusercontent.com/sango", authors: [{ displayName: "A traveller" }], googleMapsUri: "https://maps.google.com/?photo=sango" } }));
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(createElement(Harness, { canTrack: true, onClose: vi.fn(), record: vi.fn(), photos: true })));
    // The next-stop card stays compact until a place is tapped.
    expect(container.querySelector(".trip-card .place-photos")).toBeNull();
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".itinerary-stop")].find((item) => item.textContent?.includes("Sango Coffee"))!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/place-photos");
    expect(JSON.parse(String(options.body))).toMatchObject({ placeId: "g-sango", index: 0 });
    expect(container.querySelector(".trip-card img")?.getAttribute("src")).toContain("lh3.googleusercontent.com/sango");
    expect(container.querySelector(".trip-card")?.textContent).toContain("A traveller");
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".itinerary-stop")].find((item) => item.textContent?.includes("Rijksmuseum"))!.click());
    expect(container.querySelector(".trip-card-note")?.textContent).toBe("See the Night Watch first (2 hours).");
  });

  it("goes back to the map, centred on the open place, when the map is tapped", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ placeId: "g-sango", index: 0, total: 0 })));
    await act(async () => root.render(createElement(Harness, { canTrack: true, onClose: vi.fn(), record: vi.fn(), photos: true })));
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".itinerary-stop")].find((item) => item.textContent?.includes("Rijksmuseum"))!.click());
    expect(container.querySelector(".trip-card-note")).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>(".test-map")!.click());
    expect(container.querySelector(".trip-card-note")).toBeNull();
    expect(container.querySelector(".itinerary-stop.selected")).toBeNull();
    expect(map.centerOn).toMatchObject({ lat: 52.37, lng: 4.89 });
  });

  it("switches days from the menu and the arrows, and back closes the menu before trip mode", async () => {
    const onClose = vi.fn();
    await act(async () => root.render(createElement(Harness, { canTrack: true, onClose, record: vi.fn() })));
    await click("Trip menu");
    expect(entries.at(-1)).toBe("#trip-menu");
    const menu = container.querySelector(".trip-menu")!.textContent!;
    expect(menu).toContain("Day 1 · Thu 24 Dec2 stopsToday");
    expect(menu).toContain("AmsterdamThu 24 Dec – Fri 25 Dec");
    expect(menu).toContain("BrusselsSat 26 DecNot planned yet");
    await act(async () => [...container.querySelectorAll(".trip-menu-days button")].find((item) => item.textContent?.startsWith("Day 2"))!.dispatchEvent(new win.Event("click", { bubbles: true })));
    expect(container.querySelector(".trip-menu")).toBeNull();
    expect(entries.at(-1)).toBe("#trip");
    expect(container.querySelector(".trip-mode-day strong")?.textContent).toBe("Day 2 · Fri 25 Dec");
    expect(container.querySelector(".trip-card")?.textContent).toContain("Fri 25 Dec1 stop · 17:50–19:10");
    expect(button("Done")).toBeUndefined();
    await click("Previous day");
    expect(container.querySelector(".trip-mode-day strong")?.textContent).toBe("Day 1 · Thu 24 Dec");
    expect(button("Previous day").disabled).toBe(true);
    await click("Trip menu");
    await act(async () => win.history.back());
    expect(container.querySelector(".trip-menu")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => win.history.back());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is view only for shared trips and leaves through the close button", async () => {
    const onClose = vi.fn();
    await act(async () => root.render(createElement(Harness, { canTrack: false, onClose, record: vi.fn() })));
    expect(container.querySelector(".trip-card")?.textContent).toContain("Sango Coffee");
    expect(button("Done")).toBeUndefined();
    expect(button("Skip")).toBeUndefined();
    await click("Exit trip mode");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(entries).toEqual([""]);
  });
});
