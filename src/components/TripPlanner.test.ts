import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { minuteAt, newStop, newTrip, persistedPlan, type Place, type Schedule, type TravelEdge } from "@/lib/trip";
import type { NativeTripMode } from "./nativeTripMode";
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
  Object.defineProperty(window, "localStorage", { value: { getItem: () => null, setItem() {}, removeItem() {} }, configurable: true });
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
      const posted: { type: string; snapshot: NativeTripMode }[] = [];
      Object.assign(window, { webkit: { messageHandlers: { travellerTripMode: { postMessage: (message: never) => posted.push(message) } } } });
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ revision: 2 })));
      const { coffee, amsterdam, entry } = planned();
      await act(async () => root.render(createElement(TripPlanner, { initialTrip: newTrip(), initialSaved: entry, initialList: null, config } as never)));
      await act(async () => (container.querySelector(".trip-mode-pill") as HTMLElement).click());
      expect(container.querySelector(".trip-mode")).toBeNull();
      expect(posted.map((message) => message.type)).toEqual(["open"]);
      expect(posted[0].snapshot).toMatchObject({ title: "Christmas", startKey: `${amsterdam.id}:0`, canTrack: true, days: [{ visits: [{ name: "Sango Coffee", status: "pending" }] }] });

      const native = (window as unknown as { travellerNative: { record: (...args: unknown[]) => string; undo: (...args: unknown[]) => boolean; closed: () => void } }).travellerNative;
      let message = "";
      await act(async () => { message = native.record("done", amsterdam.id, 0, coffee.id); });
      expect(message).toBe("Sango Coffee marked done");
      expect(posted.at(-1)).toMatchObject({ type: "update", snapshot: { days: [{ visits: [{ status: "done", doneLabel: "09:15–10:00" }] }] } });
      await act(async () => { native.undo(amsterdam.id, "2026-12-24"); });
      expect(posted.at(-1)?.snapshot.days[0].visits[0].status).toBe("pending");
      expect(native.undo(amsterdam.id, "2026-12-24")).toBe(false);
      // Once the app closes trip mode, trip changes stay here.
      const count = posted.length;
      await act(async () => { native.closed(); native.record("skip", amsterdam.id, 0, coffee.id); });
      expect(posted).toHaveLength(count);
    } finally { vi.useRealTimers(); }
  });
});
