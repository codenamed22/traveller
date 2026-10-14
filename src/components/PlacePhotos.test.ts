import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { PlacePhotos } from "./PlacePhotos";

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

describe("place photo carousel", () => {
  it("requests only selected frames and keeps credits and direct source links with each photo", async () => {
    const onRequest = vi.fn();
    const onRetry = vi.fn();
    const frames = {
      0: { uri: "https://lh3.googleusercontent.com/first", authors: [{ displayName: "First author", uri: "https://example.com/first", photoUri: "https://lh3.googleusercontent.com/avatar" }], googleMapsUri: "https://maps.google.com/?photo=first" },
      1: { uri: "https://lh3.googleusercontent.com/second", authors: [{ displayName: "Second author" }], googleMapsUri: "https://maps.google.com/?photo=second" },
    };
    await act(async () => root.render(createElement(PlacePhotos, {
      placeName: "Canal museum", variant: "carousel", total: 2, frames, loading: {}, errors: {}, onRequest, onRetry,
    })));

    expect(container.textContent).toContain("First author");
    expect(container.querySelector(".place-photo-author a")?.getAttribute("href")).toBe("https://example.com/first");
    expect(container.querySelector(".place-photo-source")?.getAttribute("href")).toBe("https://maps.google.com/?photo=first");
    await act(async () => { container.querySelector<HTMLImageElement>("img[alt='']")!.dispatchEvent(new window.Event("error")); });
    expect(container.textContent).toContain("First author");
    expect(container.querySelector(".place-photo-author img")).toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>("button[aria-label='Next photo']")!.dispatchEvent(new window.Event("click", { bubbles: true })); });
    expect(onRequest).toHaveBeenCalledExactlyOnceWith(1);
    expect(container.textContent).toContain("2 / 2");
    expect(container.textContent).toContain("Second author");
    expect(container.querySelector(".place-photo-source")?.getAttribute("href")).toBe("https://maps.google.com/?photo=second");
    expect(container.querySelector<HTMLButtonElement>("button[aria-label='Next photo']")?.disabled).toBe(true);
    await act(async () => { container.querySelector("img")!.dispatchEvent(new window.Event("error")); });
    expect(container.textContent).toContain("Photo unavailable");
    await act(async () => { container.querySelector<HTMLButtonElement>("button[aria-label='Retry photo']")!.dispatchEvent(new window.Event("click", { bubbles: true })); });
    expect(onRetry).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("shows loading, empty, disabled and retry states without fallback imagery", async () => {
    const onRetry = vi.fn();
    const base = { placeName: "Gallery", variant: "carousel" as const, frames: {}, errors: {}, onRequest: vi.fn(), onRetry };
    await act(async () => root.render(createElement(PlacePhotos, { ...base, loading: { 0: true } })));
    expect(container.textContent).toContain("Loading photo");
    await act(async () => root.render(createElement(PlacePhotos, { ...base, loading: {}, total: 0 })));
    expect(container.textContent).toContain("No photos available");
    await act(async () => root.render(createElement(PlacePhotos, { ...base, loading: {}, disabledMessage: "Confirm this place to view photos" })));
    expect(container.textContent).toContain("Confirm this place to view photos");
    await act(async () => root.render(createElement(PlacePhotos, { ...base, loading: {}, errors: { 0: true }, total: 1 })));
    await act(async () => { container.querySelector<HTMLButtonElement>("button[aria-label='Retry photo']")!.dispatchEvent(new window.Event("click", { bubbles: true })); });
    expect(onRetry).toHaveBeenCalledExactlyOnceWith(0);
  });
});