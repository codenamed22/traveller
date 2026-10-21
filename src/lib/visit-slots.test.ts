import { describe, expect, it } from "vitest";
import { dayStart, minuteAt, newStop, newTrip, type Place, type Stop, type Trip } from "./trip";
import { afterDark, alternativeGroups, capCategory, describeTiming, earliestStart, isRequiredStop, mealCover, mealGaps, mealWindowsToCover, morningCafe, morningCafeDay, openingIntervals, placeTiming, relaxAlternatives, sunsetMinute, textTiming, timeTarget, visitHours, visitTiming } from "./visit-slots";

const stop = (name: string, source: string, patch: Partial<Stop> = {}): Stop => ({ ...newStop(name), source, ...patch });
const amsterdam = (stops: Stop[]): Trip => ({ ...newTrip(), city: "Amsterdam", hotel: "Hotel", startDate: "2026-12-24", days: 4, timeZone: "Europe/Amsterdam", dailyStart: "08:00", dailyEnd: "21:00", stops });

describe("time-of-day inference from itinerary notes", () => {
  it.each([
    ["Bouillon d'Amsterdam", "Dinner: Bouillon d'Amsterdam for a budget French bistro main (€12).", { kind: "meal", slot: "dinner" }],
    ["Taco Lindo West", "Lunch: Viral, authentic tacos at Taco Lindo West (€10).", { kind: "meal", slot: "lunch" }],
    ["Elevate Coffee Lab", "Coffee 2: Elevate Coffee Lab in Amsterdam-Zuid (€7).", { kind: "coffee" }],
    ["Vondelpark", "Crisp morning walk through the free Vondelpark into the museum district.", { kind: "walk", slot: "morning" }],
    ["Trajectum Lumen", "Walk the free Trajectum Lumen light trail.", { kind: "walk", slot: "evening" }],
    ["Gentse Winterfeesten", "Wander the **Gentse Winterfeesten** light displays along the Lys River *(2 hours)*.", { kind: "walk", slot: "evening" }],
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
    expect(timeTarget(trip, trip.stops[0], 0)).toMatchObject({ start: 13 * 60 + 45, end: 15 * 60 + 45, weight: 0.05, source: "itinerary" });
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

  it("keeps after-dark places in the evening when the itinerary slots them in daylight", () => {
    const location = { lat: 51.21, lng: 3.22 };
    const trip = { ...amsterdam([
      stop("Markt Square", "Walk the Winter Glow Light Trail to Markt Square (60 mins).", { plannedTime: "09:30", duration: 60 }),
      stop("Winterfeesten", "Gentse Winterfeesten light displays.", { plannedTime: "19:00", duration: 120 }),
      stop("Belfry", "Climb the Belfry.", { plannedTime: "09:30" }),
    ]), hotelLocation: location };
    const sunset = sunsetMinute(trip, 0, location)!;
    expect(timeTarget(trip, trip.stops[0], 0)).toMatchObject({ start: sunset, source: "note" });
    expect(describeTiming(trip, trip.stops[0])?.label).toBe("Evening, after sunset");
    expect(timeTarget(trip, trip.stops[1], 0)).toMatchObject({ start: 18 * 60, source: "itinerary" });
    expect(timeTarget(trip, trip.stops[2], 0)).toMatchObject({ start: 8 * 60 + 30, source: "itinerary" });
  });

  it("holds light trails and night markets to after sunset, unless another time of day is chosen", () => {
    const location = { lat: 51.21, lng: 3.22 };
    const trail = stop("Markt Square", "Walk the *Winter Glow Light Trail* to Markt Square.");
    const trip = { ...amsterdam([trail]), hotelLocation: location };
    const sunset = sunsetMinute(trip, 0, location)!;
    expect(visitHours(trip, 0, trail)).toEqual([[Math.ceil(sunset), 2880]]);
    expect(visitHours(trip, 0, trail, { id: "p", name: "Markt", address: "", location, hours: [{ open: { day: 4, hour: 9, minute: 0 }, close: { day: 4, hour: 19, minute: 0 } }] })).toEqual([[Math.ceil(sunset), 19 * 60]]);
    expect(afterDark(stop("Night market", "Browse the night market stalls."))).toBe(true);
    expect(afterDark({ ...trail, slot: "afternoon" })).toBe(false);
    expect(afterDark(stop("Evening stroll", "An evening walk along the canals."))).toBe(false);
    expect(visitHours(trip, 0, stop("Museum", "Rijksmuseum"))).toBeNull();
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

  it("counts a meal in the evening as the day's dinner", () => {
    const trip = amsterdam([stop("Mangez et Cassez-Vous", "Smash burger", { kind: "meal", slot: "evening" }), stop("Bar", "Cocktails", { kind: "nightlife", slot: "evening" })]);
    expect(trip.stops.map((entry) => capCategory(trip, entry))).toEqual(["dinner", null]);
  });

  it("keeps meals two hours apart and a snack an hour from a meal, but not from another snack", () => {
    const roti = stop("Roopram Roti", "Grab a massive Surinamese roti at Roopram Roti (€12).");
    const fries = stop("Fries", "A cone of fries");
    const dinner = stop("Bouillon d'Amsterdam", "Dinner: Bouillon d'Amsterdam for a budget French bistro main (€12).");
    const lunch = stop("Oudaen", "Lunch: Stadskasteel Oudaen");
    const trip = amsterdam([roti, fries, dinner, lunch]);
    const visit = (entry: Stop, start: number, end: number) => ({ stopId: entry.id, start, end });
    expect(mealGaps(trip, [visit(lunch, 840, 885), visit(fries, 960, 980), visit(roti, 1000, 1060), visit(dinner, 1080, 1125)])).toEqual([
      { first: roti.id, second: dinner.id, gap: 20, shortfall: 40, required: 60 },
    ]);
    expect(mealGaps(trip, [visit(lunch, 840, 885), visit(fries, 900, 920), visit(dinner, 960, 1005)])).toEqual([
      { first: lunch.id, second: fries.id, gap: 15, shortfall: 45, required: 60 },
      { first: lunch.id, second: dinner.id, gap: 75, shortfall: 45, required: 120 },
      { first: fries.id, second: dinner.id, gap: 40, shortfall: 20, required: 60 },
    ]);
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

describe("morning café and the day's meals", () => {
  it("starts mornings at a café or breakfast place, not one set for later in the day", () => {
    const trip = amsterdam([
      stop("Toki", "Coffee: Toki"),
      stop("Lot Sixty One", "Brunch: Lot Sixty One"),
      stop("Back to Black", ""),
      stop("Rum Baba", "Coffee at Rum Baba", { slot: "afternoon" }),
      stop("Bakers", "Coffee at Bakers", { preferredTimeWindow: { start: "14:00", end: "16:00", sources: ["https://example.com/bakers"] } }),
      stop("Moeders", "Dinner: Moeders"),
    ]);
    const cafe: Place = { id: "back-to-black", name: "Back to Black", address: "", location: { lat: 52.36, lng: 4.88 }, primaryType: "cafe" };
    expect(trip.stops.map((entry, index) => morningCafe(trip, entry, index === 2 ? cafe : undefined))).toEqual([true, true, true, false, false, false]);
  });
  it("counts days that start by 11:00 with time to spare, and starts only those early, never before arriving", () => {
    const trip: Trip = { ...amsterdam([]), days: 3, arrival: { mode: "FLIGHT", time: "13:20", place: "Schiphol" }, departure: { mode: "TRAIN", time: "09:30", place: "Centraal" } };
    expect([0, 1, 2].map((day) => morningCafeDay(trip, day))).toEqual([false, true, false]);
    expect(earliestStart(trip, 1)).toBe(minuteAt(trip, 1, "08:00") - 60);
    const early: Trip = { ...trip, arrival: { mode: "TRAIN", time: "07:00", place: "Centraal" } };
    expect(morningCafeDay(early, 0)).toBe(true);
    expect(earliestStart(early, 0)).toBe(dayStart(early, 0));
  });
  it("wants lunch and dinner on days that take them in, unless a long booking or a booked meal covers one", () => {
    const park = stop("Efteling", "", { day: 1, fixedTime: "10:40", duration: 540 });
    const trip: Trip = { ...amsterdam([park]), days: 3, arrival: { mode: "FLIGHT", time: "13:20", place: "Schiphol" }, departure: { mode: "TRAIN", time: "13:30", place: "Centraal" } };
    // Landing at 13:20 is too late for lunch; the park covers both meals; leaving at 13:30 means eating on the way.
    expect([0, 1, 2].map((day) => mealWindowsToCover(trip, day).map((window) => window.meal))).toEqual([["dinner"], [], []]);
    const booked = { ...trip, stops: [park, stop("Moeders", "Dinner: Moeders", { day: 0, fixedTime: "19:00", duration: 90 })] };
    expect(mealWindowsToCover(booked, 0)).toEqual([]);
    expect(mealWindowsToCover({ ...trip, arrival: undefined, departure: undefined }, 2).map((window) => window.meal)).toEqual(["lunch", "dinner"]);
  });
  it("tells which meal a restaurant can be", () => {
    const trip = amsterdam([stop("Foodhallen", "Lunch: Foodhallen"), stop("Moeders", "Dinner: Moeders"), stop("Blauw", "Restaurant Blauw"), stop("Lot Sixty One", "Brunch: Lot Sixty One"), stop("Toki", "Coffee: Toki")]);
    expect(trip.stops.map((entry) => mealCover(trip, entry))).toEqual(["lunch", "dinner", "either", null, null]);
  });
});
