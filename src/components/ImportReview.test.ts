import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { newTrip, type Trip } from "@/lib/trip";
import { ImportReview } from "./ImportReview";

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
  container = document.getElementById("root") as unknown as HTMLElement;
  // linkedom has no modal dialogs.
  Object.defineProperty(Object.getPrototypeOf(document.createElement("dialog")), "showModal", { value() { this.setAttribute("open", ""); }, configurable: true });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("navigator", window.navigator);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("Node", window.Node);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const brussels: Trip = { ...newTrip(), city: "Brussels", hotel: "Courtyard by Marriott Brussels EU", startDate: "2026-12-28", days: 4, timeZone: "Europe/Brussels" };
const arrival = { mode: "TRAIN", date: "2026-12-28", time: "13:06", place: "Brussels-Midi", reference: null, source: "13:06 (Arrival): Arrive at Brussels-Midi" };
const departure = { mode: "TRAIN", date: "2026-12-31", time: "10:14", place: "Brussels-Midi", reference: "Eurostar 9422", source: "10:14 – 11:35: Travel via Eurostar to Paris Gare du Nord." };
const place = { name: "Grand Place", date: "2026-12-28", time: null, duration: 60, source: "15:00 Grand Place", warning: "" };

const button = (label: string) => [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement | undefined;
const checkbox = (label: string) => container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;
// linkedom inputs don't fire React's change events, so call the handler React attached to the element.
const change = (element: Element, target: Partial<HTMLInputElement>) => act(async () => {
  const props = (element as unknown as Record<string, { onChange: (event: unknown) => void }>)[Object.keys(element).find((key) => key.startsWith("__reactProps$"))!];
  props.onChange({ target });
});
const settle = async () => { for (let index = 0; index < 10; index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };

// Types an itinerary, consents and extracts it against a mocked /api/import that returns the given batch.
async function extract(trip: Trip, result: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(result)));
  const onImport = vi.fn();
  await act(async () => root.render(createElement(ImportReview, { trip, canExtract: true, extraction: { standard: { provider: "openrouter", model: "test/model" }, youtube: null }, onImport, onClose: vi.fn() })));
  await change(container.querySelector("textarea")!, { value: "Day 1 ..." });
  expect(container.querySelector(".consent")!.textContent).toBe("Send the selected text to the agent for extraction. Retention policies apply.");
  await change(container.querySelector(".consent input")!, { checked: true });
  await act(async () => { button("Extract itinerary")!.click(); });
  await settle();
  return onImport;
}

describe("importing arrival and departure", () => {
  it("offers the itinerary's arrival and departure alongside its places", async () => {
    const onImport = await extract(brussels, { places: [place], arrival, departure, leftOut: 3 });
    expect(container.textContent).toContain("This itinerary has 3 more places than one import takes.");
    const section = container.querySelector(".review-transfers")!;
    expect(section.textContent).toContain("Arrival Train · 13:06 · Brussels-Midi");
    expect(section.textContent).toContain("Departure Eurostar 9422 · 10:14 · Brussels-Midi");
    expect(section.textContent).toContain("Travel via Eurostar to Paris Gare du Nord.");
    // Each row shows its own mode, not a plane for everything.
    expect([...section.querySelectorAll(".review-transfer svg")].map((icon) => icon.getAttribute("class"))).toEqual([expect.stringContaining("lucide-train-front"), expect.stringContaining("lucide-train-front")]);
    expect(checkbox("Use this arrival")!.checked).toBe(true);
    await act(async () => { button("Confirm 1 place")!.click(); });
    expect(onImport).toHaveBeenCalledTimes(1);
    const [stops, , transfers] = onImport.mock.calls[0];
    expect(stops.map((stop: { name: string }) => stop.name)).toEqual(["Grand Place"]);
    expect(transfers).toEqual({ arrival: { mode: "TRAIN", time: "13:06", place: "Brussels-Midi" }, departure: { mode: "TRAIN", time: "10:14", place: "Brussels-Midi", reference: "Eurostar 9422" } });
  });

  it("offers the itinerary's day trips and hours, and passes them on", async () => {
    const day2 = (name: string, plannedTime: string, dayTrip: string | null) => ({ name, date: "2026-12-29", time: null, plannedTime, duration: 30, source: name, warning: "", dayTrip });
    const onImport = await extract(brussels, { places: [day2("Rozenhoedkaai", "09:15", "Bruges"), day2("Markt", "09:30", "Bruges"), day2("Gravensteen", "13:25", "Ghent"), day2("Alibaba", "20:00", null)] });
    expect(container.textContent).toContain("Bruges 2 places · Day 2 (Tue 29 Dec)");
    expect(container.textContent).toContain("Ghent 1 place · Day 2 (Tue 29 Dec)");
    expect(container.textContent).toContain("Use the itinerary's hours, 09:00–21:00");
    expect(container.textContent).toContain("Around 09:15 in the itinerary, not a booking · Bruges day trip");
    await change(checkbox("Plan Ghent as a day trip")!, { checked: false });
    await act(async () => { button("Confirm 4 places")!.click(); });
    const [stops, , changes] = onImport.mock.calls[0];
    expect(stops.map((stop: { plannedTime?: string; fixedTime: string | null }) => [stop.plannedTime, stop.fixedTime])).toEqual([["09:15", null], ["09:30", null], ["13:25", null], ["20:00", null]]);
    expect(changes.dayGroups).toEqual([{ id: expect.any(String), name: "Bruges", stopIds: [stops[0].id, stops[1].id], allowedDays: [1], exclusive: false }]);
    expect(changes).toMatchObject({ dailyStart: "09:00", dailyEnd: "21:00" });
  });

  it("leaves an existing departure alone unless chosen, and can import travel details on their own", async () => {
    const trip = { ...brussels, departure: { mode: "FLIGHT" as const, time: "18:00", place: "Brussels Airport" } };
    const onImport = await extract(trip, { places: [], arrival: { ...arrival, date: "2026-12-27" }, departure });
    expect(container.textContent).toContain("Replaces Flight · 18:00 · Brussels Airport.");
    expect(container.textContent).toContain("Arrives Sun 27 Dec, but Brussels starts Mon 28 Dec.");
    expect(checkbox("Use this arrival")!.disabled).toBe(true);
    expect(checkbox("Use this departure")!.checked).toBe(false);
    expect(button("Confirm 0 places")!.disabled).toBe(true);
    await change(checkbox("Use this departure")!, { checked: true });
    await act(async () => { button("Use departure")!.click(); });
    expect(onImport.mock.calls[0][0]).toEqual([]);
    expect(onImport.mock.calls[0][2]).toEqual({ departure: { mode: "TRAIN", time: "10:14", place: "Brussels-Midi", reference: "Eurostar 9422" } });
  });
});
