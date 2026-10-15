import { describe, expect, it } from "vitest";
import { candidatesToStops, dayTripGroup, duplicateCandidateIndexes, extractedCandidate, importDayTrips, importResultSchema, itineraryHours, manualCandidates, mapsQuery, mergeDuplicateDetails, transferProposal, youtubeUrl, type ImportCandidate, type TransferCandidate } from "./import";
import { newStop, newTrip, stopSchema } from "./trip";
import { duplicateStopPairs, mergeDuplicateStops, mergeReviewedDuplicate } from "./duplicates";

describe("time-of-day import fields", () => {
  it("maps kind, slot, itinerary time and shared alternative labels onto stops", () => {
    const trip = { ...newTrip(), startDate: "2026-10-13", days: 2 };
    const base = { date: null, time: null, duration: null, source: "", warning: "" };
    const stops = candidatesToStops([
      { ...base, name: "Five Ways", kind: "coffee", alternativeGroup: "coffee-a" },
      { ...base, name: "Rum Baba", kind: "coffee", alternativeGroup: "coffee-a" },
      { ...base, name: "Solo", alternativeGroup: "lonely" },
      { ...base, name: "Bouillon", kind: "meal", slot: "dinner", plannedTime: "19:00" },
      { ...base, name: "Booked", date: "2026-10-13", time: "10:00", slot: "morning", plannedTime: "09:00" },
    ], trip);
    expect(stops[0].alternativeGroup).toBeDefined();
    expect(stops[0].alternativeGroup).toBe(stops[1].alternativeGroup);
    expect(stops[0].alternativeGroup).not.toBe("coffee-a");
    expect(stops[2].alternativeGroup).toBeUndefined();
    expect(stops[3]).toMatchObject({ kind: "meal", slot: "dinner", plannedTime: "19:00" });
    expect(stops[4].slot).toBeUndefined();
    expect(stops[4].plannedTime).toBeUndefined();
  });
});

describe("itinerary import", () => {
  it.each([
    ["Sango", "Sango Specialty Coffee"],
    ["The Begijnhof", "Begijnhof"],
    ["The Nine Little Streets", "Nine Little Streets (Negen Straatjes)"],
    ["Toki Specialty Coffee", "Toki"],
  ])("flags the reported alias %s / %s in both the city and import review", (firstName, secondName) => {
    const first = { ...newStop(firstName), placeId: "confirmed-place" };
    const second = newStop(secondName);
    expect(duplicateStopPairs([first, second])).toHaveLength(1);
    expect([...duplicateCandidateIndexes(manualCandidates(secondName), [first])]).toEqual([0]);
    expect([...duplicateCandidateIndexes(manualCandidates(`${firstName}\n${secondName}`), [])]).toEqual([1]);
    expect(duplicateStopPairs([first, { ...second, placeId: "different-confirmed-place" }])).toEqual([]);
  });
  it("does not collapse different parenthetical location qualifiers", () => {
    expect(duplicateStopPairs([newStop("Museum (East)"), newStop("Museum (West)")])).toEqual([]);
    expect([...duplicateCandidateIndexes(manualCandidates("Museum (West)"), [newStop("Museum (East)")])]).toEqual([]);
  });
  it("flags aliases of the same confirmed place even when bookings and source notes differ", () => {
    const first = { ...newStop("Sango"), placeId: "sango-place", day: 0, fixedTime: "15:13", source: "First itinerary" };
    const second = { ...newStop("Sango Specialty Coffee"), placeId: "sango-place", day: 1, fixedTime: "10:00", duration: 30, source: "Second itinerary" };
    expect(duplicateStopPairs([first, second])).toEqual([{ first, second, match: "Same confirmed Google place" }]);
    expect(mergeDuplicateStops([first, second]).removed).toEqual([]);
    const merged = mergeReviewedDuplicate([first, second], second.id, first.id);
    expect(merged).toEqual([{ ...second, source: "Second itinerary\nFirst itinerary" }]);
    expect(first.fixedTime).toBe("15:13");
  });
  it("flags matching unconfirmed names but never merges distinct confirmed branches", () => {
    const first = { ...newStop("Sango Coffee"), placeId: "first-branch" };
    const second = { ...newStop(" SANGO   COFFEE "), placeId: "second-branch" };
    expect(duplicateStopPairs([first, second])).toEqual([]);
    expect(() => mergeReviewedDuplicate([first, second], first.id, second.id)).toThrow("no longer match");
    const unconfirmed = { ...second, placeId: null };
    expect(duplicateStopPairs([first, unconfirmed])).toHaveLength(1);
    expect(mergeReviewedDuplicate([first, unconfirmed], unconfirmed.id, first.id)[0]).toMatchObject({ id: unconfirmed.id, placeId: first.placeId });
  });
  it("flags Sango name aliases without a second place ID but respects distinct confirmed locations", () => {
    const first = { ...newStop("Sango"), placeId: "sango-place" };
    const second = newStop("Sango Specialty Coffee");
    expect(duplicateStopPairs([first, second])).toEqual([{ first, second, match: "Possible name alias; location needs review" }]);
    expect(duplicateStopPairs([first, { ...second, placeId: "different-place" }])).toEqual([]);
    expect(duplicateStopPairs([newStop("Coffee"), newStop("Other Coffee")])).toEqual([]);
  });
  it("preserves both source links and rejects evidence overflow without removing visits", () => {
    const first = { ...newStop("Sango"), source: "First note", sourceUrl: "https://example.com/first" };
    const second = { ...newStop("Sango"), source: "Second note", sourceUrl: "https://example.com/second" };
    expect(mergeReviewedDuplicate([first, second], first.id, second.id)[0]).toMatchObject({ source: "First note\nSecond note\nhttps://example.com/second", sourceUrl: first.sourceUrl });
    const long = { ...second, source: "x".repeat(1000) };
    expect(() => mergeReviewedDuplicate([first, long], first.id, long.id)).toThrow("neither visit was changed");
    expect(long.source).toHaveLength(1000);
  });
  it("deduplicates only identical visits without losing bookings or source evidence", () => {
    const stop = { ...newStop("Museum"), day: 0, fixedTime: "10:00" };
    const copy = { ...stop, id: crypto.randomUUID(), name: " MUSEUM " };
    const differentDay = { ...copy, id: crypto.randomUUID(), day: 1 };
    const differentDuration = { ...copy, id: crypto.randomUUID(), duration: 90 };
    const differentSource = { ...copy, id: crypto.randomUUID(), source: "Second ticket" };
    const stops = [stop, copy, differentDay, differentDuration, differentSource];
    expect(mergeDuplicateStops(stops)).toEqual({ stops: [stop, differentDay, differentDuration, differentSource], removed: [copy.name] });
    expect(stops).toHaveLength(5);
  });
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
  it("proposes missing booking details without overwriting any existing duration", () => {
    const trip = { ...newTrip(), startDate: "2026-10-12", days: 3 };
    const stop = newStop("Louvre Museum");
    const place = { name: "louvre museum", date: "2026-10-13", time: "10:00", duration: 90, source: "", warning: "" };
    const result = mergeDuplicateDetails([{ place, included: false }], [stop], trip);
    expect(result.stops[0]).toMatchObject({ day: 1, fixedTime: "10:00", duration: 45 });
    expect(result.merged).toBe(1);
    expect(result.changes[0]).toContain("day: unassigned -> 2026-10-13");
    expect(stop.day).toBeNull();
    const kept = mergeDuplicateDetails([{ place, included: false }], [{ ...stop, duration: 30 }], trip);
    expect(kept.stops[0].duration).toBe(30);
  });
  it.each([
    { date: "2026-11-01", time: "10:00", duration: 90 },
    { date: "2026-10-14", time: "10:00", duration: 90 },
    { date: null, time: "10:00", duration: 90 },
    { date: "2026-02-30", time: null, duration: 90 },
    { date: null, time: null, duration: -5 },
  ])("does not merge conflicting or invalid duplicate details: %j", (patch) => {
    const trip = { ...newTrip(), startDate: "2026-10-12", days: 3 };
    const stop = { ...newStop("Museum"), day: 1 };
    const result = mergeDuplicateDetails([{ place: { ...manualCandidates("Museum")[0], ...patch }, included: false }], [stop], trip);
    expect(result.stops).toEqual([stop]);
    expect(result.merged).toBe(0);
    expect(result.issues).toHaveLength(1);
  });
  it("fills only missing fields in an earlier candidate and refuses ambiguous existing visits", () => {
    const trip = { ...newTrip(), startDate: "2026-10-12", days: 3 };
    const place = { ...manualCandidates("Museum")[0], date: "2026-10-13", time: "10:00", duration: 90 };
    const result = mergeDuplicateDetails([{ place: manualCandidates("Museum")[0], included: true }, { place, included: false }], [], trip);
    expect(result.entries[0].place).toMatchObject({ date: place.date, time: place.time, duration: 90 });
    const ambiguous = mergeDuplicateDetails([{ place, included: false }], [newStop("Museum"), newStop("Museum")], trip);
    expect(ambiguous.merged).toBe(0);
    expect(ambiguous.issues[0]).toContain("multiple existing visits");
  });
  it("preserves merged source evidence and handles invalid draft values without throwing", () => {
    const trip = { ...newTrip(), startDate: "2026-10-12", days: 3 };
    const stop = { ...newStop("Museum"), source: "Original note", sourceUrl: "https://example.com/original" };
    const place = { ...manualCandidates("Museum")[0], date: "2026-10-13", time: "10:00", source: "Ticket at 10:00", sourceUrl: "https://example.com/ticket" };
    const result = mergeDuplicateDetails([{ place, included: false }], [stop], trip);
    expect(result.stops[0].source).toBe("Original note\nTicket at 10:00\nhttps://example.com/ticket");
    expect(result.stops[0].sourceUrl).toBe(stop.sourceUrl);
    const invalid = { ...stop, duration: 0 };
    expect(mergeDuplicateDetails([{ place, included: false }], [invalid], trip).stops).toEqual([invalid]);
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
describe("arrival and departure import", () => {
  const brussels = { ...newTrip(), city: "Brussels", startDate: "2026-12-28", days: 4, timeZone: "Europe/Brussels" };
  const eurostar: TransferCandidate = { mode: "TRAIN", date: "2026-12-31", time: "10:14", place: "Brussels-Midi", reference: " Eurostar 9422 ", source: "10:14 – 11:35: Travel via Eurostar to Paris Gare du Nord." };

  it("offers a departure on the city's last day", () => {
    expect(transferProposal(brussels, "departure", eurostar)).toEqual({ transfer: { mode: "TRAIN", time: "10:14", place: "Brussels-Midi", reference: "Eurostar 9422" }, label: "Eurostar 9422 · 10:14 · Brussels-Midi", same: false, replaces: undefined });
    const arrival = transferProposal(brussels, "arrival", { ...eurostar, date: null, time: "13:06", reference: null });
    expect(arrival.label).toBe("Train · 13:06 · Brussels-Midi");
    expect(arrival.blocked).toBeUndefined();
  });

  it("blocks a date outside the city's stay", () => {
    expect(transferProposal(brussels, "arrival", eurostar).blocked).toBe("Arrives Thu 31 Dec, but Brussels starts Mon 28 Dec. Change the city's dates to use it.");
    expect(transferProposal(brussels, "departure", { ...eurostar, date: "2027-01-01" }).blocked).toContain("but Brussels ends Thu 31 Dec");
  });

  it("notices an identical transfer and names the one it replaces, keeping a confirmed station", () => {
    const set = { ...brussels, departure: { mode: "TRAIN" as const, time: "10:14", place: "Brussels-Midi", reference: "Eurostar 9422", placeId: "g-midi" } };
    expect(transferProposal(set, "departure", eurostar).same).toBe(true);
    const later = transferProposal(set, "departure", { ...eurostar, time: "12:14", reference: "Eurostar 9430" });
    expect(later).toMatchObject({ same: false, replaces: "Eurostar 9422 · 10:14 · Brussels-Midi", transfer: { placeId: "g-midi" } });
    expect(transferProposal(set, "departure", { ...eurostar, place: "Brussels-Central" }).transfer.placeId).toBeUndefined();
  });
});

describe("itinerary day trips and hours", () => {
  const brussels = { ...newTrip(), city: "Brussels, Belgium", startDate: "2026-12-28", days: 4, timeZone: "Europe/Brussels", dailyStart: "09:00", dailyEnd: "18:00" };
  const place = (name: string, date: string | null, plannedTime: string | null, duration: number, dayTrip: string | null = null): ImportCandidate => ({ name, date, time: null, plannedTime, duration, source: name, warning: "", dayTrip });

  it("keeps a booked time as a booking and anything else as a planned time", () => {
    const base = { name: "Atomium", date: "2026-12-30", time: "11:00", duration: 60, source: "", warning: "" };
    expect(extractedCandidate({ ...base, booked: true }, brussels.city)).toMatchObject({ time: "11:00", plannedTime: null, dayTrip: null });
    expect(extractedCandidate({ ...base, booked: false, dayTrip: " Bruges " }, brussels.city)).toMatchObject({ time: null, plannedTime: "11:00", dayTrip: "Bruges" });
    expect(extractedCandidate({ ...base, booked: true, alternativeGroup: "a" }, brussels.city)).toMatchObject({ time: null, plannedTime: "11:00" });
    expect(extractedCandidate({ ...base, booked: false, dayTrip: "brussels" }, brussels.city).dayTrip).toBeNull();
  });

  it("groups the places in each town into one day trip on its day", () => {
    const places = [place("Grand-Place", "2026-12-28", "18:00", 30), place("Rozenhoedkaai", "2026-12-29", "09:15", 15, "Bruges"), place("Markt", "2026-12-29", "09:30", 60, "Bruges"), place("Gravensteen", "2026-12-29", "13:25", 30, "Ghent"), place("Leuven", null, null, 60, "Leuven"), place("Antwerp Zoo", "2026-12-29", null, 60, "Antwerp"), place("MAS", "2026-12-30", null, 60, "antwerp")];
    const trips = importDayTrips(places, brussels);
    expect(trips.map(({ name, indexes, day, blocked }) => ({ name, indexes, day, blocked }))).toEqual([
      { name: "Bruges", indexes: [1, 2], day: 1, blocked: undefined },
      { name: "Ghent", indexes: [3], day: 1, blocked: undefined },
      { name: "Leuven", indexes: [4], day: null, blocked: undefined },
      { name: "Antwerp", indexes: [5, 6], day: null, blocked: "Antwerp places fall on different days. Set up this day trip in Plan my days instead." },
    ]);
    expect(dayTripGroup(trips[0], ["a", "b"], brussels)).toMatchObject({ name: "Bruges", stopIds: ["a", "b"], allowedDays: [1], exclusive: false });
    expect(dayTripGroup(trips[2], ["c"], brussels).allowedDays).toEqual([0, 1, 2, 3]);
  });

  it("widens the city's hours to the itinerary's, only when it reaches beyond them", () => {
    const places = [place("Flea market", "2026-12-30", "08:30", 60), place("NONA", "2026-12-28", "18:45", 75), place("Alibaba", "2026-12-29", "20:00", 45), place("Unscheduled", null, null, 45)];
    expect(itineraryHours(places, brussels)).toEqual({ dailyStart: "08:30", dailyEnd: "20:45" });
    expect(itineraryHours([place("Museum", null, "10:00", 120)], brussels)).toBeNull();
    expect(itineraryHours([place("Late show", null, "23:10", 90)], brussels)).toEqual({ dailyStart: "09:00", dailyEnd: "23:45" });
    expect(itineraryHours([place("Unscheduled", null, null, 45)], brussels)).toBeNull();
  });
});
