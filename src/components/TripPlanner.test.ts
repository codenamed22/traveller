import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { newTrip } from "@/lib/trip";
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
