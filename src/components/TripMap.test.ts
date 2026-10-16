import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { newStop, newTrip, type Place } from "@/lib/trip";
import { TripMap } from "./TripMap";

// A stand-in for the Google map that records how the camera is moved.
const camera = vi.hoisted(() => ({ calls: [] as string[], zoom: 12 }));
vi.mock("@vis.gl/react-google-maps", async () => {
  const { createElement: element } = await import("react");
  const map = {
    fitBounds: () => camera.calls.push("fit"),
    panTo: (location: { lat: number; lng: number }) => camera.calls.push(`pan ${location.lat},${location.lng}`),
    panBy: (x: number, y: number) => camera.calls.push(`by ${x},${y}`),
    getZoom: () => camera.zoom,
    setZoom: (zoom: number) => { camera.zoom = zoom; camera.calls.push(`zoom ${zoom}`); },
  };
  const pass = ({ children }: { children?: ReactNode }) => element("div", null, children);
  return { APIProvider: pass, Map: pass, AdvancedMarker: pass, InfoWindow: pass, useMap: () => map };
});

let root: Root;
beforeEach(() => {
  const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(key, value);
  vi.stubGlobal("google", { maps: { LatLngBounds: class { extend() {} }, Polyline: class { setMap() {} } } });
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", "test-only-key");
  camera.calls = []; camera.zoom = 12;
  root = createRoot(document.getElementById("root") as unknown as HTMLElement);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const museum = { ...newStop("Museum"), placeId: "g-museum" };
const garden = { ...newStop("Garden"), placeId: "g-garden" };
const trip = { ...newTrip(), city: "Paris", stops: [museum, garden] };
const place = (id: string, lat: number): Place => ({ id, name: id, address: id, location: { lat, lng: 2.3 } });
const places = { hotel: place("hotel", 48.8), [museum.id]: place("g-museum", 48.86), [garden.id]: place("g-garden", 48.85) };

function show(props: { selected?: string | null; padding: { top: number; bottom: number; left: number; right: number }; fitToken?: number }) {
  return act(async () => root.render(createElement(TripMap, { trip, places, schedule: null, day: 0, selected: props.selected ?? null, onSelect: vi.fn(), photoFrames: {}, photoLoading: {}, photoErrors: {}, onPhotoRequest: vi.fn(), onPhotoRetry: vi.fn(), zoomOnSelect: true, popup: false, padding: props.padding, fitToken: props.fitToken ?? 0 })));
}

describe("trip map camera", () => {
  it("keeps an opened place in view as the sheet grows or shrinks, and fits the day only when asked", async () => {
    const peek = { top: 92, bottom: 224, left: 36, right: 64 };
    await show({ padding: peek });
    expect(camera.calls).toEqual(["fit"]);
    camera.calls = [];
    await show({ selected: museum.id, padding: peek });
    expect(camera.calls).toEqual(["zoom 16", "pan 48.86,2.3", "by 14,66"]);
    camera.calls = [];
    // The card grows for the photo: the place stays centred above it, with no zooming out.
    await show({ selected: museum.id, padding: { ...peek, bottom: 624 } });
    expect(camera.calls).toEqual(["pan 48.86,2.3", "by 14,266"]);
    camera.calls = [];
    // Back to the map: the place is let go, but the map stays on it as the card shrinks.
    await show({ padding: peek });
    expect(camera.calls).toEqual(["pan 48.86,2.3", "by 14,66"]);
    camera.calls = [];
    await show({ padding: peek, fitToken: 1 });
    expect(camera.calls).toEqual(["fit"]);
  });
});
