import { describe, expect, it } from "vitest";
import { candidatesToStops, duplicateCandidateIndexes, importResultSchema, manualCandidates, mapsQuery, mergeDuplicateDetails, youtubeUrl } from "./import";
import { newStop, newTrip, stopSchema } from "./trip";

describe("itinerary import", () => {
  it("preserves each source and requires review of plain text dates", () => {
    expect(manualCandidates("- Louvre\n10:00 Museum")[1]).toMatchObject({ name: "10:00 Museum", time: null, source: "10:00 Museum" });
  });
  it("preserves bookings and rejects undated or out-of-trip bookings", () => {
    const trip = { ...newTrip(), startDate: "2026-10-12", days: 3 };
    const candidate = { name: "Museum", date: "2026-10-13", time: "10:00", duration: 90, source: "Tuesday 10am museum", warning: "" };
    expect(candidatesToStops([candidate], trip)[0]).toMatchObject({ day: 1, fixedTime: "10:00", duration: 90, optional: false });
    expect(() => candidatesToStops([{ ...candidate, date: null }], trip)).toThrow("Assign a date");
    expect(() => candidatesToStops([{ ...candidate, date: "2026-11-01" }], trip)).toThrow("outside");
  });
  it("parses documented Maps queries without scraping saved lists", () => {
    expect(mapsQuery(new URL("https://www.google.com/maps/search/?api=1&query=Louvre"))).toBe("Louvre");
    expect(mapsQuery(new URL("https://example.com/"))).toBeNull();
    expect(() => mapsQuery(new URL("https://www.google.com/maps/placelists/list/abc"))).toThrow("not supported");
  });
  it.each([
    "https://www.youtube.com/watch?v=abcdefghijk&list=other&t=90",
    "https://youtu.be/abcdefghijk?si=tracking",
    "https://m.youtube.com/shorts/abcdefghijk",
    "https://www.youtube.com/embed/abcdefghijk",
    "https://youtube.com/live/abcdefghijk",
  ])("normalizes a single video without tracking or playlist parameters: %s", (url) => {
    expect(youtubeUrl(url)).toBe("https://www.youtube.com/watch?v=abcdefghijk");
  });
  it.each([
    "https://youtube.com/playlist?list=abc", "https://youtube.com/@travel",
    "https://youtube.com/watch?v=short", "http://youtube.com/watch?v=abcdefghijk",
    "https://user:password@youtube.com/watch?v=abcdefghijk", "https://youtube.com:444/watch?v=abcdefghijk",
  ])("rejects unsupported YouTube links: %s", (url) => {
    expect(() => youtubeUrl(url)).toThrow();
  });
  it("does not classify other hosts as video inputs", () => {
    expect(youtubeUrl("https://youtube.com.example.com/watch?v=abcdefghijk")).toBeNull();
    expect(youtubeUrl("https://example.com/places")).toBeNull();
  });
  it("flags repeated suggestions across sources without changing the existing list", () => {
    const stops = [newStop("Louvre Museum")];
    const candidates = manualCandidates(" louvre   museum \nGarden\nGARDEN\nOther Museum");
    expect([...duplicateCandidateIndexes(candidates, stops)]).toEqual([0, 2]);
    expect(stops).toHaveLength(1);
    expect(candidates).toHaveLength(4);
  });
  it("copies non-default details from skipped duplicates onto the existing stop", () => {
    const trip = { ...newTrip(), startDate: "2026-10-12", days: 3 };
    const stop = newStop("Louvre Museum");
    const place = { name: "louvre museum", date: "2026-10-13", time: "10:00", duration: 90, source: "", warning: "" };
    const result = mergeDuplicateDetails([{ place, included: false }], [stop], trip);
    expect(result.stops[0]).toMatchObject({ day: 1, fixedTime: "10:00", duration: 90 });
    expect(result.merged).toBe(1);
    const kept = mergeDuplicateDetails([{ place, included: false }], [{ ...stop, duration: 30 }], trip);
    expect(kept.stops[0].duration).toBe(30);
  });
  it("retains safe source links and makes only non-booked ideas optional", () => {
    const trip = { ...newTrip(), startDate: "2026-10-12" };
    const sourceUrl = "https://www.youtube.com/watch?v=abcdefghijk";
    const candidate = { ...manualCandidates("Museum")[0], sourceUrl };
    const [idea] = candidatesToStops([candidate], trip, { ideas: true });
    expect(stopSchema.parse(idea)).toMatchObject({ sourceUrl, optional: true, day: null, fixedTime: null });
    expect(candidatesToStops([{ ...candidate, date: "2026-10-13", time: "10:00" }], trip, { ideas: true })[0].optional).toBe(false);
    expect(importResultSchema.safeParse({ places: [{ ...candidate, sourceUrl: "javascript:alert(1)" }] }).success).toBe(false);
    expect(importResultSchema.safeParse({ places: [{ ...candidate, sourceUrl: "not a URL" }] }).success).toBe(false);
    expect(stopSchema.safeParse(newStop("Old draft without a source URL")).success).toBe(true);
  });
});