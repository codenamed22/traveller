import { z } from "zod";
import { timeSchema, type Place } from "./trip";
import { dateIntervals } from "./visit-slots";

// Somewhere to eat near where a day's plan has you when it leaves out a meal (routineGaps): cafés and bakeries for
// breakfast, restaurants for lunch and dinner. Asked of Google while choosing, never kept; the one added is kept like any
// confirmed place.
export const nearbyRequestSchema = z.object({
  meal: z.enum(["breakfast", "lunch", "dinner"]),
  location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict(),
  // The day, and when the meal would be on its clock.
  date: z.iso.date(), start: timeSchema, end: timeSchema,
}).strict().refine((input) => input.end > input.start, { message: "A meal must end after it starts.", path: ["end"] });
export type NearbyRequest = z.infer<typeof nearbyRequestSchema>;
export const nearbyTypes: Record<NearbyRequest["meal"], string[]> = {
  breakfast: ["cafe", "coffee_shop", "bakery", "breakfast_restaurant", "brunch_restaurant"],
  lunch: ["restaurant"], dinner: ["restaurant"],
};

export type NearbyCandidate = Place & { rating?: number; reviews?: number; priceLevel?: string };
export type NearbyPlace = { id: string; name: string; address: string; location: { lat: number; lng: number }; primaryType?: string; types?: string[]; rating: number; reviews: number; price?: string; walkMinutes: number };

const prices: Record<string, string> = { PRICE_LEVEL_INEXPENSIVE: "Inexpensive", PRICE_LEVEL_MODERATE: "Moderate", PRICE_LEVEL_EXPENSIVE: "Expensive", PRICE_LEVEL_VERY_EXPENSIVE: "Very expensive" };
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

// Open the whole time on that date, by its regular hours; a place without hours isn't known to be.
export function openThrough(hours: Place["hours"], date: string, start: string, end: string) {
  if (!hours?.length) return false;
  const intervals = dateIntervals(hours, date);
  return !intervals || intervals.some(([open, close]) => open <= minutes(start) && minutes(end) <= close);
}

// Straight-line distance at a walker's pace, with a fifth more for streets.
function walk(from: { lat: number; lng: number }, to: { lat: number; lng: number }) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const a = Math.sin(radians(to.lat - from.lat) / 2) ** 2 + Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(radians(to.lng - from.lng) / 2) ** 2;
  const meters = 2 * 6_371_000 * Math.asin(Math.sqrt(a));
  return Math.max(1, Math.round(meters * 1.2 / 80));
}

// The three best places open for the meal, still trading, rated 4.2 or more by at least 50 people: by rating, pulled
// towards 4 for places few have rated.
export function pickNearby(candidates: NearbyCandidate[], input: NearbyRequest, count = 3): NearbyPlace[] {
  const seen = new Set<string>();
  return candidates.flatMap((place): (NearbyPlace & { score: number })[] => {
    if (seen.has(place.id) || place.closed || place.rating === undefined || place.rating < 4.2 || (place.reviews ?? 0) < 50 || !openThrough(place.hours, input.date, input.start, input.end)) return [];
    seen.add(place.id);
    const reviews = place.reviews!;
    return [{
      id: place.id, name: place.name, address: place.address, location: place.location, ...(place.primaryType ? { primaryType: place.primaryType } : {}), ...(place.types ? { types: place.types } : {}),
      rating: place.rating, reviews, ...(place.priceLevel && prices[place.priceLevel] ? { price: prices[place.priceLevel] } : {}), walkMinutes: walk(input.location, place.location),
      score: (place.rating * reviews + 4 * 100) / (reviews + 100),
    }];
  }).sort((left, right) => right.score - left.score).slice(0, count).map(({ score: _score, ...place }) => { void _score; return place; });
}
