import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { newTrip, type Trip } from "@/lib/trip";
import { TransferFields } from "./TransferFields";

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

describe("arrival airport", () => {
  it("can be found on the map before anything is typed, and shows when it is confirmed", async () => {
    const onFind = vi.fn();
    const trip: Trip = { ...newTrip(), city: "Amsterdam", startDate: "2026-12-24", timeZone: "Europe/Amsterdam", arrival: { mode: "FLIGHT", time: "13:20", place: "" } };
    await act(async () => root.render(createElement(TransferFields, { trip, kind: "arrival", onChange: () => undefined, onFind })));
    const button = () => container.querySelector("button[aria-label='Find airport on map']") as unknown as { disabled: boolean; title: string; click: () => void };
    expect(button().disabled).toBe(false);
    expect(button().title).toBe("Find on map");
    await act(async () => button().click());
    expect(onFind).toHaveBeenCalledTimes(1);
    const confirmed = { ...trip, arrival: { ...trip.arrival!, place: "Amsterdam Airport Schiphol", placeId: "schiphol-id" } };
    await act(async () => root.render(createElement(TransferFields, { trip: confirmed, kind: "arrival", onChange: () => undefined, onFind })));
    expect(button().title).toBe("Confirmed on the map; search again");
  });
});
