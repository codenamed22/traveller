import { describe, expect, it } from "vitest";
import { newStop, newTrip, type Stop, type Trip } from "./trip";
import { alternativeGroups, capCategory, describeTiming, isRequiredStop, openingIntervals, placeTiming, relaxAlternatives, sunsetMinute, textTiming, timeTarget, visitTiming } from "./visit-slots";

const stop = (name: string, source: string, patch: Partial<Stop> = {}): Stop => ({ ...newStop(name), source, ...patch });
const amsterdam = (stops: Stop[]): Trip => ({ ...newTrip(), city: "Amsterdam", hotel: "Hotel", startDate: "2026-12-24", days: 4, timeZone: "Europe/Amsterdam", dailyStart: "08:00", dailyEnd: "21:00", stops });

describe("time-of-day inference from itinerary notes", () => {
  it.each([
    ["Bouillon d'Amsterdam", "Dinner: Bouillon d'Amsterdam for a budget French bistro main (€12).", { kind: "meal", slot: "dinner" }],
    ["Taco Lindo West", "Lunch: Viral, authentic tacos at Taco Lindo West (€10).", { kind: "meal", slot: "lunch" }],
    ["Elevate Coffee Lab", "Coffee 2: Elevate Coffee Lab in Amsterdam-Zuid (€7).", { kind: "coffee" }],
    ["Vondelpark", "Crisp morning walk through the free Vondelpark into the museum district.", { kind: "walk", slot: "morning" }],
    ["Trajectum Lumen", "Walk the free Trajectum Lumen light trail.", { kind: "walk", slot: "evening" }],
    ["Stadskasteel Oudaen", "Lunch: Stadskasteel Oudaen for a house-brewed castle beer and bar snack (€12).", { kind: "meal", slot: "lunch" }],
    ["Leeman Döner", "Fresh Turkish lahmacun or döner wrap at Leeman Döner (€5 - €9).", { kind: "snack" }],
    ["Toki Specialty Coffee", "17:50 – 18:35 | Toki Specialty Coffee Walk 8 mins into Jordaan for coffee at Toki (45 mins)", { kind: "coffee", plannedTime: "17:50" }],
  ])("classifies %s", (name, source, expected) => {
    expect(textTiming({ name, source })).toEqual(expected);
  });

  it("does not read prices as times and ignores itinerary times shared by several places", () => {
    expect(textTiming({ name: "Kras Haring", source: "€3.50 raw herring at Kras Haring" }).plannedTime).toBeUndefined();
    const shared = "10:00 – 11:00 | Fufu or Ukiyo";
    const trip = amsterdam([stop("Fufu", shared), stop("Ukiyo", shared)]);
    expect(visitTiming(trip, trip.stops[0]).plannedTime).toBeUndefined();
  });

  it("falls back to Google place types and lets explicit choices win", () => {
    expect(placeTiming({ primaryType: "cafe", types: ["restaurant"] })).toEqual({ kind: "coffee" });
    expect(placeTiming({ types: ["french_restaurant", "point_of_interest"] })).toEqual({ kind: "meal" });
    const unnamed = stop("Le Bon", "");
    const trip = amsterdam([unnamed, stop("Explicit", "Dinner: Explicit", { slot: "lunch" })]);
    expect(visitTiming(trip, unnamed, { id: "p", name: "Le Bon", address: "", location: { lat: 52.37, lng: 4.89 }, types: ["bar"] })).toMatchObject({ kind: "nightlife", kindSource: "place", slot: "evening", slotSource: "place" });
    expect(describeTiming(trip, trip.stops[1])).toEqual({ label: "Lunch 11:45–14:00", source: "set" });
  });
});

describe("soft time targets", () => {
  it("prefers explicit slot, then the original itinerary time, then note cues", () => {
    const trip = amsterdam([
      stop("Sango", "14:45 – 15:30 | Sango Specialty Coffee Coffee: Sango pour-over (€6)."),
      stop("Bouillon", "Dinner: Bouillon"),
      stop("Booked", "Dinner", { day: 0, fixedTime: "19:00" }),
      stop("Any", "Dinner: but whenever", { slot: "any" }),
    ]);
    expect(timeTarget(trip, trip.stops[0], 0)).toMatchObject({ start: 13 * 60 + 45, end: 15 * 60 + 45, weight: 1, source: "itinerary" });
    expect(timeTarget(trip, trip.stops[1], 0)).toMatchObject({ start: 18 * 60, end: 20 * 60 + 30, weight: 5, source: "note" });
    expect(timeTarget(trip, trip.stops[2], 0)).toBeNull();
    expect(timeTarget(trip, trip.stops[3], 0)).toBeNull();
  });

  it("starts evening windows at the local sunset", () => {
    const trip = amsterdam([]);
    const sunset = sunsetMinute(trip, 0, { lat: 52.37, lng: 4.9 })!;
    expect(sunset).toBeGreaterThan(16 * 60 + 15);
    expect(sunset).toBeLessThan(16 * 60 + 45);
  });

  it("keeps outdoor walks within daylight unless they are meant for the evening", () => {
    const location = { lat: 52.37, lng: 4.9 };
    const trip = { ...amsterdam([
      stop("Vondelpark", "Crisp morning walk through the free Vondelpark."),
      stop("Canal stroll", "Stroll along the canals."),
      stop("Trajectum Lumen", "Walk the free Trajectum Lumen light trail."),
    ]), hotelLocation: location };
    const sunset = sunsetMinute(trip, 0, location)!;
    const morning = timeTarget(trip, trip.stops[0], 0)!;
    expect(morning.start).toBeGreaterThan(9 * 60);
    expect(morning.end).toBe(11 * 60 + 30);
    expect(morning.label).toContain("daylight");
    const anyTime = timeTarget(trip, trip.stops[1], 0)!;
    expect(anyTime.label).toMatch(/^Daylight/);
    expect(anyTime.end).toBeLessThanOrEqual(sunset);
    expect(timeTarget(trip, trip.stops[2], 0)!.start).toBe(sunset);
  });

  it("drops an original itinerary time that overlaps a booking that day", () => {
    const trip = amsterdam([
      stop("Sango", "14:45 – 15:30 | Sango Specialty Coffee Coffee: Sango pour-over (€6)."),
      stop("Booked tour", "Tour", { day: 0, fixedTime: "14:30", duration: 90 }),
    ]);
    expect(timeTarget(trip, trip.stops[0], 0)?.source).not.toBe("itinerary");
    expect(timeTarget(trip, trip.stops[0], 1)).toMatchObject({ source: "itinerary", start: 13 * 60 + 45 });
  });

  it("caps meals by slot and coffee by kind", () => {
    const trip = amsterdam([stop("A", "Lunch: A"), stop("B", "Coffee: B"), stop("C", "Fresh döner at C")]);
    expect(trip.stops.map((entry) => capCategory(trip, entry))).toEqual(["lunch", "coffee", null]);
  });
});

describe("opening hours", () => {
  const trip = amsterdam([]); // 2026-12-24 is a Thursday (Google day 4)
  it("returns same-day and overnight intervals and marks closed days", () => {
    expect(openingIntervals(trip, 0, { hours: [{ open: { day: 4, hour: 12, minute: 0 }, close: { day: 4, hour: 14, minute: 30 } }, { open: { day: 4, hour: 18, minute: 0 }, close: { day: 5, hour: 1, minute: 0 } }] })).toEqual([[720, 870], [1080, 1500]]);
    expect(openingIntervals(trip, 1, { hours: [{ open: { day: 4, hour: 18, minute: 0 }, close: { day: 5, hour: 1, minute: 0 } }] })).toEqual([[0, 60]]);
    expect(openingIntervals(trip, 2, { hours: [{ open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 17, minute: 0 } }] })).toEqual([]);
  });
  it("treats unknown and round-the-clock hours as unrestricted", () => {
    expect(openingIntervals(trip, 0, {})).toBeNull();
    expect(openingIntervals(trip, 0, { hours: [{ open: { day: 0, hour: 0, minute: 0 } }] })).toBeNull();
  });
});

describe("alternative groups", () => {
  it("groups places listed as alternatives in one note, but not places joined by 'and'", () => {
    const centraal = "Return to Amsterdam Centraal and grab a €4 Surinamese chicken sandwich at De Hapjeshoek or €3.50 raw herring at Kras Haring (€8).";
    const crawl = "Coffee crawl at Fufu, Ukiyo, or Keen (60 mins total)";
    const trip = amsterdam([
      stop("Five Ways", "Coffee: Filter coffee at Five Ways or Rum Baba (€6)."), stop("Rum Baba", "Coffee: Filter coffee at Five Ways or Rum Baba (€6)."),
      stop("Amsterdam Centraal", centraal), stop("De Hapjeshoek", centraal), stop("Kras Haring", centraal),
      stop("Fufu", crawl), stop("Ukiyo", crawl),
      stop("Separate", "Either X or Y", { alternativeGroup: null }), stop("Other", "Either X or Y", { alternativeGroup: null }),
    ]);
    const names = alternativeGroups(trip).map((group) => group.stopIds.map((id) => trip.stops.find((entry) => entry.id === id)!.name));
    expect(names).toEqual([["Five Ways", "Rum Baba"], ["De Hapjeshoek", "Kras Haring"], ["Fufu", "Ukiyo"]]);
  });

  it("makes members individually optional while bookings stay required", () => {
    const trip = amsterdam([stop("A", "", { alternativeGroup: "g" }), stop("B", "", { alternativeGroup: "g", day: 0, fixedTime: "10:00" }), stop("C", "")]);
    const groups = alternativeGroups(trip);
    expect(groups).toEqual([{ key: "g", stopIds: [trip.stops[0].id, trip.stops[1].id], required: true, inferred: false }]);
    expect(trip.stops.map((entry) => isRequiredStop(entry, groups))).toEqual([false, true, true]);
    expect(relaxAlternatives(trip, groups).stops.map((entry) => [entry.optional, entry.alternativeGroup])).toEqual([[true, null], [false, null], [false, null]]);
  });
});
