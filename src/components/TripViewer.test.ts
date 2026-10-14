import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { minuteAt, newStop, newTrip, persistedPlan, type Place, type Schedule, type TravelEdge, type Trip } from "@/lib/trip";
import type { SharedView } from "@/lib/shared-trips";
import { TripViewer } from "./TripViewer";

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: { href: string; children: unknown }) => createElement("a", { href, ...props }, children as never) }));
vi.mock("next-auth/react", () => ({ signOut: vi.fn(), signIn: vi.fn() }));

let root: Root;
let container: HTMLElement;
const fetchSpy = vi.fn();

beforeEach(() => {
  const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
  container = document.getElementById("root") as unknown as HTMLElement;
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("navigator", window.navigator);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("Node", window.Node);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchSpy);
  Object.defineProperty(window, "location", { value: { pathname: "/shared/x", search: "", hash: "" }, configurable: true });
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const place = (id: string, name: string): Place => ({ id, name, address: `${name}, Amsterdam`, location: { lat: 52.37, lng: 4.89 } });

function view(): SharedView {
  const sango = { ...newStop("Sango Coffee"), placeId: "g-sango", duration: 45, source: "Best pour-over in town" };
  const cruise = { ...newStop("Light Festival Cruise"), placeId: "g-cruise", day: 0, fixedTime: "18:15", duration: 75 };
  const rum = { ...newStop("Rum Baba"), optional: true, duration: 45 };
  const trip: Trip = { ...newTrip(), title: "Amsterdam", city: "Amsterdam", hotel: "Motel One", hotelPlaceId: "g-hotel", startDate: "2026-12-24", days: 2, timeZone: "Europe/Amsterdam", dailyStart: "09:00", dailyEnd: "21:00", returnToHotel: true, stops: [sango, cruise, rum], arrival: { mode: "FLIGHT", time: "13:20", place: "Amsterdam Schiphol", reference: "QR 273" } };
  const leg = (from: string, to: string, minutes: number): TravelEdge => ({ day: 0, from, to, mode: "WALK", minutes, meters: 1200 });
  const at = (time: string) => minuteAt(trip, 0, time);
  const schedule: Schedule = { generatedAt: "2026-10-14T06:00:00Z", warnings: [], omitted: [rum.id], squeezeIns: [{ stopId: rum.id, day: 0, after: sango.id, start: at("16:55"), end: at("17:40"), extraMinutes: 12 }], days: [
    { day: 0, date: "2026-12-24", visits: [{ stopId: sango.id, start: at("16:00"), end: at("16:45"), leg: leg("hotel", sango.id, 20) }, { stopId: cruise.id, start: at("18:15"), end: at("19:30"), leg: leg(sango.id, cruise.id, 12) }], returnLeg: leg(cruise.id, "hotel", 25) },
    { day: 1, date: "2026-12-25", visits: [] },
  ] };
  const places = { hotel: place("g-hotel", "Motel One"), [sango.id]: place("g-sango", "Sango Coffee"), [cruise.id]: place("g-cruise", "Cruise dock") };
  const brussels: Trip = { ...newTrip(), city: "Brussels", startDate: "2026-12-26", days: 1, stops: [newStop("Grand Place")] };
  return { id: trip.id, title: "Amsterdam & Brussels", cities: [trip, brussels], plans: { [trip.id]: persistedPlan(schedule, trip, places) }, updatedAt: "2026-10-14T08:00:00Z", isOwner: false };
}

const buttons = () => [...container.querySelectorAll("button")];
const click = (text: string) => act(async () => buttons().find((button) => button.textContent?.includes(text))!.click());

describe("shared trip viewer", () => {
  it("shows the accepted itinerary read-only, with no editing, planning or paid calls", async () => {
    await act(async () => root.render(createElement(TripViewer, { view: view(), email: "friend@example.com" })));
    const text = container.textContent ?? "";
    expect(text).toContain("View only");
    expect(text).toContain("Land at Amsterdam Schiphol 13:20");
    expect(text).toContain("Sango Coffee16:00 - 16:45 · 45 min");
    expect(text).toContain("Light Festival Cruise18:15 - 19:30");
    expect(text).toContain("Back to Motel One19:55");
    expect(text).toContain("Rum Baba · could fit Day 1 (Thu 24 Dec) after Sango Coffee");
    expect(text).not.toContain("Open planner");
    expect(container.querySelectorAll("input, textarea, select")).toHaveLength(0);
    expect(buttons().filter((button) => /Plan my days|Save|Refresh|Import|New trip|Remove/.test(button.textContent ?? ""))).toHaveLength(0);
    // Walk and transit choices are shown but cannot be changed.
    expect(container.querySelectorAll(".transport-options button:not([disabled])")).toHaveLength(0);
    await click("Sango Coffee");
    expect(container.textContent).toContain("Best pour-over in town");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("says when a city has no accepted plan yet", async () => {
    await act(async () => root.render(createElement(TripViewer, { view: { ...view(), isOwner: true }, email: "owner@example.com" })));
    expect(container.textContent).toContain("Open planner");
    await click("Brussels");
    expect(container.textContent).toContain("Not planned yet");
    expect(container.textContent).toContain("Grand Place");
  });
});
