import { describe, expect, it } from "vitest";
import { routineGaps } from "./gaps";
import { formatMinute, minuteAt, newStop, newTrip, type Place, type Schedule, type Stop, type TravelEdge, type Trip } from "./trip";

const leg = (from: string, to: string, minutes: number, mode: TravelEdge["mode"] = "TRANSIT"): TravelEdge => ({ day: 0, from, to, mode, minutes, meters: 2000 });
const place = (name: string, lat: number) => ({ id: `place-${name}`, name, address: "Paris", location: { lat, lng: 2.33 } });

// Paris over two days, out from 09:00 to 21:00: the Louvre, the Tuileries and Orsay, back by metro; the next morning
// Montmartre and a walk back.
function fixture(change: (stops: Record<string, Stop>) => void = () => {}) {
  const stops = { louvre: { ...newStop("Louvre"), duration: 120 }, tuileries: { ...newStop("Tuileries"), duration: 30 }, orsay: { ...newStop("Musée d'Orsay"), duration: 90 }, montmartre: { ...newStop("Montmartre"), duration: 90 } };
  change(stops);
  const trip: Trip = { ...newTrip(), city: "Paris", hotel: "Hôtel du Nord", startDate: "2026-12-29", days: 2, timeZone: "Europe/Paris", dailyEnd: "21:00", stops: Object.values(stops) };
  const at = (day: number, time: string) => minuteAt(trip, day, time);
  const schedule: Schedule = { generatedAt: "2026-10-14T06:00:00Z", warnings: [], omitted: [], days: [
    { day: 0, date: "2026-12-29", visits: [
      { stopId: stops.louvre.id, start: at(0, "09:30"), end: at(0, "11:30"), leg: leg("hotel", stops.louvre.id, 20) },
      { stopId: stops.tuileries.id, start: at(0, "11:40"), end: at(0, "12:10"), leg: leg(stops.louvre.id, stops.tuileries.id, 10, "WALK") },
      { stopId: stops.orsay.id, start: at(0, "12:40"), end: at(0, "14:10"), leg: leg(stops.tuileries.id, stops.orsay.id, 15) },
    ], returnLeg: leg(stops.orsay.id, "hotel", 25) },
    { day: 1, date: "2026-12-30", visits: [{ stopId: stops.montmartre.id, start: at(1, "10:00"), end: at(1, "11:30"), leg: leg("hotel", stops.montmartre.id, 20) }], returnLeg: leg(stops.montmartre.id, "hotel", 30, "WALK") },
  ] };
  const places: Record<string, Place> = { hotel: place("Hôtel du Nord", 48.87), ...Object.fromEntries(Object.values(stops).map((stop, index) => [stop.id, place(stop.name, 48.86 - index / 100)])) };
  return { trip, schedule, places, stops };
}

describe("meals a plan leaves out", () => {
  it("finds breakfast, lunch and dinner, when they'd be and where you'd be", () => {
    const { trip, schedule, places, stops } = fixture();
    const gaps = routineGaps(trip, schedule, places);
    const shown = gaps.map((gap) => ({ day: gap.day, meal: gap.meal, time: `${formatMinute(trip, gap.day, gap.start)}–${formatMinute(trip, gap.day, gap.end)}`, near: gap.nearName, after: gap.after }));
    expect(shown).toEqual([
      // Before setting off for the Louvre at 09:10, near the hotel.
      { day: 0, meal: "breakfast", time: "08:25–09:10", near: "Hôtel du Nord", after: null },
      // At Orsay by the middle of lunchtime.
      { day: 0, meal: "lunch", time: "12:25–13:25", near: "Musée d'Orsay", after: stops.tuileries.id },
      // Back at the hotel by dinner.
      { day: 0, meal: "dinner", time: "18:40–19:55", near: "Hôtel du Nord", after: stops.orsay.id },
      { day: 1, meal: "breakfast", time: "08:55–09:40", near: "Hôtel du Nord", after: null },
      { day: 1, meal: "lunch", time: "12:25–13:25", near: "Hôtel du Nord", after: stops.montmartre.id },
      { day: 1, meal: "dinner", time: "18:40–19:55", near: "Hôtel du Nord", after: stops.montmartre.id },
    ]);
    expect(gaps[1]).toMatchObject({ date: "2026-12-29", location: places[stops.orsay.id].location });
  });

  it("is filled by a café first, a meal in the window, or a meal place added to the day since", () => {
    const { trip, schedule, places } = fixture((all) => {
      all.louvre = { ...all.louvre, name: "Café Kitsuné", kind: "coffee" };
      all.tuileries = { ...all.tuileries, name: "Bistro lunch", kind: "meal", slot: "lunch" };
    });
    const dinner = { ...newStop("Le Train Bleu"), day: 0, kind: "meal" as const, slot: "dinner" as const };
    expect(routineGaps({ ...trip, stops: [...trip.stops, dinner] }, schedule, places).filter((gap) => gap.day === 0)).toEqual([]);
    expect(routineGaps(trip, schedule, places).filter((gap) => gap.day === 0).map((gap) => gap.meal)).toEqual(["dinner"]);
  });

  it("has no breakfast on the day you arrive, a day that starts at noon, or one that sets off in the afternoon", () => {
    const { trip, schedule, places } = fixture();
    const arriving: Trip = { ...trip, arrival: { mode: "TRAIN", place: "Gare du Nord", placeId: "g-nord", time: "08:00" } };
    expect(routineGaps(arriving, schedule, places).filter((gap) => gap.meal === "breakfast").map((gap) => gap.day)).toEqual([1]);
    expect(routineGaps({ ...trip, dailyStart: "12:00" }, schedule, places).some((gap) => gap.meal === "breakfast")).toBe(false);
    // Nor before a day's first visit in the afternoon.
    const late = { ...schedule, days: schedule.days.map((plan) => ({ ...plan, visits: plan.visits.map((visit) => ({ ...visit, start: visit.start + 6 * 60, end: visit.end + 6 * 60 })) })) };
    expect(routineGaps(trip, late, places).some((gap) => gap.meal === "breakfast")).toBe(false);
  });
});
