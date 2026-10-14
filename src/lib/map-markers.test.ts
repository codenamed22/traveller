import { describe, expect, it } from "vitest";
import { placeMarkerLabel } from "./map-markers";

describe("map place marker labels", () => {
  it("uses itinerary rank instead of list order", () => {
    expect(placeMarkerLabel("second-visited", 0, ["first-visited", "second-visited", "third-visited"])).toBe("2");
  });

  it("marks unscheduled places without assigning them a visit number", () => {
    expect(placeMarkerLabel("omitted-stop", 3, ["first-visited", "second-visited"])).toBe("·");
  });

  it("keeps list order numbering before a plan exists", () => {
    expect(placeMarkerLabel("stop", 2)).toBe("3");
  });
});