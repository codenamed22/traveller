import { describe, expect, it } from "vitest";
import { nearbyRequestSchema, openThrough, pickNearby, type NearbyCandidate } from "./nearby";

// Open every day from 12:00 to 22:00 (Google counts days from Sunday, 0).
const lunchHours = Array.from({ length: 7 }, (_, day) => ({ open: { day, hour: 12, minute: 0 }, close: { day, hour: 22, minute: 0 } }));
const request = nearbyRequestSchema.parse({ meal: "lunch", location: { lat: 48.86, lng: 2.33 }, date: "2026-12-29", start: "12:25", end: "13:25" });
const candidate = (name: string, extra: Partial<NearbyCandidate> = {}): NearbyCandidate => ({ id: `id-${name}`, name, address: `${name}, Paris`, location: { lat: 48.862, lng: 2.33 }, hours: lunchHours, rating: 4.5, reviews: 500, ...extra });

describe("places to eat nearby", () => {
  it("knows a place is open for the meal by its hours that day", () => {
    expect(openThrough(lunchHours, "2026-12-29", "12:25", "13:25")).toBe(true);
    expect(openThrough(lunchHours, "2026-12-29", "08:25", "09:10")).toBe(false);
    expect(openThrough(lunchHours, "2026-12-29", "21:30", "22:30")).toBe(false);
    // Closed on Tuesdays, 29 December 2026 among them.
    expect(openThrough(lunchHours.filter((period) => period.open.day !== 2), "2026-12-29", "12:25", "13:25")).toBe(false);
    // Open all the time, or till after midnight.
    expect(openThrough([{ open: { day: 0, hour: 0, minute: 0 } }], "2026-12-29", "08:00", "09:00")).toBe(true);
    expect(openThrough([{ open: { day: 2, hour: 18, minute: 0 }, close: { day: 3, hour: 2, minute: 0 } }], "2026-12-29", "23:00", "23:59")).toBe(true);
    // Hours unknown: not known to be open.
    expect(openThrough(undefined, "2026-12-29", "12:25", "13:25")).toBe(false);
  });

  it("keeps the three best places open then, rated 4.2 or more by at least 50, still trading", () => {
    const found = pickNearby([
      candidate("Few reviews", { rating: 4.9, reviews: 20 }),
      candidate("Low rating", { rating: 4.1, reviews: 3000 }),
      candidate("Closed down", { closed: "permanently" }),
      candidate("Dinner only", { hours: lunchHours.map((period) => ({ ...period, open: { ...period.open, hour: 18 } })) }),
      candidate("Popular", { rating: 4.5, reviews: 4000, priceLevel: "PRICE_LEVEL_MODERATE" }),
      candidate("Loved by a few", { rating: 4.9, reviews: 60 }),
      candidate("Good", { rating: 4.4, reviews: 900, location: { lat: 48.87, lng: 2.33 } }),
      candidate("Fine", { rating: 4.3, reviews: 200 }),
      candidate("Popular", { rating: 4.5, reviews: 4000 }),
    ], request);
    expect(found.map((place) => place.name)).toEqual(["Popular", "Good", "Loved by a few"]);
    expect(found[0]).toMatchObject({ id: "id-Popular", rating: 4.5, reviews: 4000, price: "Moderate", walkMinutes: 3 });
    // About 1.1 km away.
    expect(found[1].walkMinutes).toBe(17);
  });

  it("asks only about a meal on one day, ending after it starts", () => {
    expect(nearbyRequestSchema.safeParse({ ...request, end: "12:00" }).success).toBe(false);
    expect(nearbyRequestSchema.safeParse({ ...request, meal: "snack" }).success).toBe(false);
    expect(nearbyRequestSchema.safeParse({ ...request, radius: 5000 }).success).toBe(false);
  });
});
