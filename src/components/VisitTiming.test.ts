import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { newStop, newTrip, type Trip } from "@/lib/trip";
import { alternativeGroups } from "@/lib/visit-slots";
import { VisitTimingFields } from "./VisitTiming";

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
  container = document.getElementById("root") as unknown as HTMLElement;
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

describe("alternatives", () => {
  it("can be planned separately and brought back together", async () => {
    const note = "specialty coffee at **BarkBoy** or **Bouche** *(45 mins)*.";
    const bouche = { ...newStop("Bouche"), source: note, alternativeGroup: "group-1" };
    const barkBoy = { ...newStop("BarkBoy"), source: note, alternativeGroup: "group-1" };
    const trip: Trip = { ...newTrip(), city: "Brussels", startDate: "2026-12-28", timeZone: "Europe/Brussels", stops: [bouche, barkBoy] };
    const onChange = vi.fn();
    const render = (current: Trip) => act(async () => root.render(createElement(VisitTimingFields, { trip: current, stop: current.stops[1], groups: alternativeGroups(current), onChange })));
    const button = (label: string) => [...container.querySelectorAll("button")].find((entry) => entry.textContent === label) as unknown as { click: () => void } | undefined;
    await render(trip);
    expect(container.textContent).toContain("Alternative to Bouche");
    await act(async () => button("Plan separately")!.click());
    expect(onChange).toHaveBeenLastCalledWith({ alternativeGroup: null });

    await render({ ...trip, stops: [bouche, { ...barkBoy, alternativeGroup: null }] });
    expect(container.textContent).toContain("Listed with Bouche as alternatives in the itinerary, now planned separately.");
    await act(async () => button("Plan as alternatives")!.click());
    expect(onChange).toHaveBeenLastCalledWith({ alternativeGroup: "group-1" });
  });
});
