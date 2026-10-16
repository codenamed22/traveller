import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { saveFile } from "./save-file";

let clicked: { href: string; download: string }[];

beforeEach(() => {
  const { document, window } = parseHTML("<html><body></body></html>");
  clicked = [];
  // linkedom has no click navigation; record what would be downloaded.
  Object.getPrototypeOf(document.createElement("a")).click = function (this: HTMLAnchorElement) { clicked.push({ href: this.href, download: this.download }); };
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: () => "blob:traveller/1", revokeObjectURL: vi.fn() }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("saving files", () => {
  it("downloads through a link in a browser", async () => {
    await saveFile("BEGIN:VCALENDAR", "text/calendar", "christmas.ics");
    expect(clicked).toEqual([{ href: "blob:traveller/1", download: "christmas.ics" }]);
  });

  it("hands the file to the iPhone app, which opens the share sheet", async () => {
    const postMessage = vi.fn();
    Object.assign(window, { webkit: { messageHandlers: { travellerSave: { postMessage } } } });
    await saveFile("Grüße ✓", "text/plain", "notes.txt");
    expect(clicked).toEqual([]);
    expect(postMessage).toHaveBeenCalledWith({ filename: "notes.txt", type: "text/plain", base64: Buffer.from("Grüße ✓").toString("base64") });
  });
});
