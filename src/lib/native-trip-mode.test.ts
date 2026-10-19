import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";
import type { Journey } from "@/lib/journey";
import { minuteAt, mustSeePriority, newStop, newTrip, persistedPlan, type Place, type Schedule, type TravelEdge, type Trip } from "@/lib/trip";
import { markDone, markSkipped, tripModeDays } from "@/lib/trip-mode";
import { parseForecast } from "./weather";
import { nativeStore, nativeTripMode } from "./native-trip-mode";

const place = (id: string, name: string, lat = 52.37): Place => ({ id, name, address: `${name} street`, location: { lat, lng: 4.89 } });
const leg = (from: string, to: string, minutes: number, extra: Partial<TravelEdge> = {}): TravelEdge => ({ day: 0, from, to, mode: "WALK", minutes, meters: 900, ...extra });
// 10:00 in Amsterdam on 24 December is 09:00 UTC.
const christmasEve = Temporal.Instant.from("2026-12-24T09:00:00Z");

function fixture() {
  const coffee = { ...newStop("Sango Coffee"), placeId: "g-sango", duration: 45, note: "Ask for the filter", source: "09:30 – 10:15 | Sango\nBest **pour-over** in town" };
  const museum = { ...newStop("Rijksmuseum"), placeId: "g-rijks", day: 0, fixedTime: "11:00", duration: 120 };
  const dinner = { ...newStop("FUKU"), placeId: "g-fuku", duration: 60 };
  const extra = { ...newStop("Albert Cuyp"), optional: true };
  const amsterdam: Trip = {
    ...newTrip(), city: "Amsterdam", hotel: "Motel One", startDate: "2026-12-24", days: 2, timeZone: "Europe/Amsterdam", dailyStart: "09:00", dailyEnd: "21:00",
    stops: [coffee, museum, dinner, extra], arrival: { mode: "TRAIN", time: "08:30", place: "Amsterdam Centraal", reference: "ICE 123", bufferMinutes: 15, transferMinutes: 20 },
  };
  const at = (day: number, time: string) => minuteAt(amsterdam, day, time);
  const transit = leg(coffee.id, museum.id, 20, { mode: "TRANSIT", polyline: "_p~iF~ps|U_ulLnnqC", steps: [{ instruction: "Walk to Dam", mode: "WALK" }, { instruction: "Tram", mode: "TRANSIT", line: "2", from: "Dam", to: "Rijksmuseum" }], fare: "€3.40" });
  const schedule: Schedule = { generatedAt: "2026-10-14T06:00:00Z", warnings: [], omitted: [extra.id], days: [
    { day: 0, date: "2026-12-24", visits: [{ stopId: coffee.id, start: at(0, "09:30"), end: at(0, "10:15"), leg: leg("hotel", coffee.id, 15) }, { stopId: museum.id, start: at(0, "11:00"), end: at(0, "13:00"), leg: transit }], returnLeg: leg(museum.id, "hotel", 25) },
    { day: 1, date: "2026-12-25", visits: [{ stopId: dinner.id, start: at(1, "18:00"), end: at(1, "19:00"), leg: leg("hotel", dinner.id, 10) }], returnLeg: leg(dinner.id, "hotel", 10) },
  ] };
  const places = { hotel: place("g-hotel", "Motel One", 52.36), [coffee.id]: place("g-sango", "Sango Coffee"), [museum.id]: place("g-rijks", "Rijksmuseum", 52.359), [dinner.id]: place("g-fuku", "FUKU") };
  const journey: Journey = { id: crypto.randomUUID(), title: "Christmas", cities: [amsterdam], plans: { [amsterdam.id]: persistedPlan(schedule, amsterdam, places) } };
  return { journey, amsterdam, coffee, museum };
}

describe("native trip mode snapshot", () => {
  it("lays out each day with times, legs and directions, ready to draw", () => {
    const { journey, amsterdam, coffee, museum } = fixture();
    const snapshot = nativeTripMode(journey, christmasEve, { canTrack: true, photos: true });
    expect(snapshot).toMatchObject({ version: 1, level: 2, journeyId: journey.id, title: "Christmas", startKey: `${amsterdam.id}:0`, canTrack: true, photos: true, cities: [{ name: "Amsterdam", dates: "Thu 24 Dec – Fri 25 Dec" }] });
    const [today, tomorrow] = snapshot.days;
    expect(today).toMatchObject({
      label: "Day 1 · Thu 24 Dec", city: "Amsterdam", timeZone: "Europe/Amsterdam", stale: false, replanned: false,
      hotel: { name: "Motel One", location: { lat: 52.36, lng: 4.89 } }, end: { title: "Back to Motel One", short: "Back to Motel One" },
      summary: { stops: 2, travel: "1 h", leaveLabel: "09:15", backLabel: "13:25" },
      arrival: { title: "Arrive at Amsterdam Centraal 08:30 · ICE 123" }, omitted: ["Albert Cuyp"], doneElsewhere: [],
    });
    expect(tomorrow.arrival).toBeUndefined();
    // The train arrives 08:30 in Amsterdam (07:30 UTC).
    expect(today.arrival?.at).toBe(Date.parse("2026-12-24T07:30:00Z"));
    // Midnight to midnight in Amsterdam, so the app can tell today and count minutes without time zone rules.
    expect(today.startsAt).toBe(Date.parse("2026-12-23T23:00:00Z"));
    expect(today.endsAt).toBe(Date.parse("2026-12-24T23:00:00Z"));
    expect(today.visits[0]).toMatchObject({
      stopId: coffee.id, name: "Sango Coffee", placeId: "g-sango", location: { lat: 52.37, lng: 4.89 }, startLabel: "09:30", endLabel: "10:15", leaveLabel: "09:15",
      booked: false, status: "pending", note: "Ask for the filter", sourceNote: "Best pour-over in town", alternatives: [],
      leg: { mode: "WALK", minutes: 15, label: "15 min walk", detail: "Walk · 15 min · 0.9 km", from: { lat: 52.36, lng: 4.89 }, to: { lat: 52.37, lng: 4.89 }, steps: [] },
    });
    // The same times as instants, so the app counts down without time zone rules.
    expect(today.visits[0]).toMatchObject({ startAt: Date.parse("2026-12-24T08:30:00Z"), endAt: Date.parse("2026-12-24T09:15:00Z"), leaveAt: Date.parse("2026-12-24T08:15:00Z") });
    expect(today.visits[0].doneStartAt).toBeUndefined();
    expect(today.visits[1]).toMatchObject({ stopId: museum.id, booked: true, leg: { mode: "TRANSIT", label: "20 min by transit", polyline: "_p~iF~ps|U_ulLnnqC", steps: ["Walk to Dam", "2 Dam to Rijksmuseum"], fare: "€3.40" } });
    expect(today.visits[1].leg.directions).toContain("origin_place_id=g-sango");
    expect(today.visits[1].leg.directionsFromHere).not.toContain("origin");
    expect(today.visits[1].leg.directionsFromHere).toContain("travelmode=transit");
    expect(today.returnLeg).toMatchObject({ label: "25 min walk", to: { lat: 52.36, lng: 4.89 } });
    // The snapshot crosses into Swift as JSON.
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("stars must-sees, including one marked after planning", () => {
    const { journey, amsterdam, museum } = fixture();
    const marked = { ...journey, cities: [{ ...amsterdam, stops: amsterdam.stops.map((stop) => stop.id === museum.id ? { ...stop, priority: mustSeePriority } : stop) }] };
    const [today] = nativeTripMode(marked, christmasEve, { canTrack: true, photos: false }).days;
    expect(today.visits.map((visit) => visit.mustSee)).toEqual([undefined, true]);
  });

  it("carries the day's note and favourites, and says the traveller can keep them", () => {
    const { journey, amsterdam, coffee } = fixture();
    const kept = { ...journey, journal: { [amsterdam.id]: { "2026-12-24": { note: "Snow on the canals", favourites: [coffee.id] } } } };
    const snapshot = nativeTripMode(kept, christmasEve, { canTrack: true, photos: false });
    const [today, tomorrow] = snapshot.days;
    expect(snapshot.journal).toBe(true);
    expect(today.note).toBe("Snow on the canals");
    expect(today.visits.map((visit) => visit.favourite)).toEqual([true, undefined]);
    expect(tomorrow).not.toHaveProperty("note");
    expect(nativeTripMode(kept, christmasEve, { canTrack: false, photos: false })).not.toHaveProperty("journal");
  });

  it("carries the day's forecast and the chance of rain during outdoor visits", () => {
    const { journey, amsterdam, coffee, museum } = fixture();
    // The museum's garden, say: a park. Rain is likely all morning.
    const plan = journey.plans[amsterdam.id];
    const outdoors = { ...journey, plans: { [amsterdam.id]: { ...plan, snapshot: { ...plan.snapshot!, places: { ...plan.snapshot!.places, [museum.id]: { ...plan.snapshot!.places[museum.id], types: ["park"] } } } } } };
    const hours = ["09", "10", "11", "12"].map((hour) => `2026-12-24T${hour}:00`);
    const forecast = parseForecast({
      daily: { time: ["2026-12-24"], weather_code: [63], temperature_2m_max: [6], temperature_2m_min: [2], precipitation_probability_max: [80] },
      hourly: { time: hours, precipitation_probability: [80, 80, 80, 80] },
    }, "Europe/Amsterdam", 1);
    const snapshot = nativeTripMode(outdoors, christmasEve, { canTrack: true, photos: false, forecasts: { [amsterdam.id]: forecast }, swap: true });
    const [today, tomorrow] = snapshot.days;
    expect(today.weather).toEqual({ label: "Rain", icon: "rain", max: 6, min: 2, rain: 80 });
    expect(tomorrow.weather).toBeUndefined();
    // The coffee is indoors.
    expect(today.visits.map((visit) => [visit.stopId, visit.rain])).toEqual([[coffee.id, undefined], [museum.id, 80]]);
    expect(snapshot.swap).toBe(true);
    expect(nativeTripMode(journey, christmasEve, { canTrack: true, photos: false })).not.toHaveProperty("swap");
  });

  it("gives the app every other saved trip still to come, and the ids of all of them", () => {
    const { journey } = fixture();
    const held = { ...fixture().journey, title: "Open in the page" };
    const past = { ...fixture().journey, title: "Last year", cities: fixture().journey.cities.map((city) => ({ ...city, startDate: "2025-12-24" })) };
    const unplanned = { ...journey, id: crypto.randomUUID(), plans: {} };
    const entries = [journey, held, past, unplanned].map((data) => ({ data, plan: null }));
    const ticket = { id: crypto.randomUUID(), tripId: journey.id, cityId: journey.cities[0].id, target: "departure" as const, stopId: null, name: "Eurostar.pdf", mime: "application/pdf" as const, size: 9, sha256: "a" };
    const { snapshots, ids } = nativeStore(entries, held.id, christmasEve, [ticket, { ...ticket, id: crypto.randomUUID(), tripId: held.id }]);
    expect(snapshots.map((snapshot) => snapshot.journeyId)).toEqual([journey.id]);
    expect(snapshots[0].photos).toBe(false);
    expect(ids).toEqual([journey.id, held.id, past.id, unplanned.id]);
    // Each trip's own tickets, without the trip id or an empty visit.
    expect(snapshots[0].tickets).toEqual([{ id: ticket.id, cityId: ticket.cityId, target: "departure", name: "Eurostar.pdf", mime: "application/pdf", size: 9, sha256: "a" }]);
    expect(nativeTripMode(journey, christmasEve, { canTrack: true, photos: false })).not.toHaveProperty("tickets");
  });

  it("shows progress recorded with the trip mode rules", () => {
    const { journey, amsterdam, coffee, museum } = fixture();
    const [entry] = tripModeDays(journey.cities, journey.plans, undefined, christmasEve);
    const done = markDone(entry, coffee.id, minuteAt(amsterdam, 0, "10:20"));
    const withDone = { ...journey, execution: { [amsterdam.id]: { [entry.date]: done } } };
    const [afterDone] = nativeTripMode(withDone, christmasEve, { canTrack: true, photos: false }).days;
    expect(afterDone.visits.map((visit) => [visit.status, visit.doneLabel])).toEqual([["done", "09:35–10:20"], ["pending", undefined]]);
    expect(afterDone.visits[0]).toMatchObject({ doneStartAt: Date.parse("2026-12-24T08:35:00Z"), doneEndAt: Date.parse("2026-12-24T09:20:00Z") });
    const [entryAfter] = tripModeDays(withDone.cities, withDone.plans, withDone.execution, christmasEve);
    const skipped = markSkipped(entryAfter, amsterdam.stops.find((stop) => stop.id === museum.id)!);
    const [afterSkip] = nativeTripMode({ ...journey, execution: { [amsterdam.id]: { [entry.date]: skipped } } }, christmasEve, { canTrack: true, photos: false }).days;
    expect(afterSkip.visits.map((visit) => visit.status)).toEqual(["done", "skipped"]);
  });

  it("starts on the chosen day when the trip isn't on today", () => {
    const { journey, amsterdam } = fixture();
    const snapshot = nativeTripMode(journey, Temporal.Instant.from("2026-11-01T09:00:00Z"), { start: { cityId: amsterdam.id, day: 1 }, canTrack: false, photos: false });
    expect(snapshot.startKey).toBe(`${amsterdam.id}:1`);
    expect(nativeTripMode({ ...journey, plans: {} }, christmasEve, { canTrack: true, photos: false })).toMatchObject({ startKey: null, days: [] });
  });

  // Paris changes its clocks on these Sundays: the countdown must use the hour on the wall, not the hours since midnight.
  it.each([
    ["the clocks go back", "2026-10-25", "2026-10-25T09:00:00Z"],
    ["the clocks go forward", "2027-03-28", "2027-03-28T08:00:00Z"],
  ])("gives the right instants on the day %s", (_, date, tenOClock) => {
    const louvre = { ...newStop("Louvre"), placeId: "g-louvre", duration: 120 };
    const paris: Trip = { ...newTrip(), city: "Paris", hotel: "Hotel", startDate: date, days: 1, timeZone: "Europe/Paris", stops: [louvre] };
    const schedule: Schedule = { generatedAt: "2026-10-14T06:00:00Z", warnings: [], omitted: [], days: [
      { day: 0, date, visits: [{ stopId: louvre.id, start: minuteAt(paris, 0, "10:00"), end: minuteAt(paris, 0, "12:00"), leg: leg("hotel", louvre.id, 20) }], returnLeg: leg(louvre.id, "hotel", 20) },
    ] };
    const journey: Journey = { id: crypto.randomUUID(), title: "Paris", cities: [paris], plans: { [paris.id]: persistedPlan(schedule, paris, { hotel: place("g-hotel", "Hotel"), [louvre.id]: place("g-louvre", "Louvre") }) } };
    const [day] = nativeTripMode(journey, Temporal.Instant.from(tenOClock), { canTrack: true, photos: false }).days;
    expect(day.visits[0]).toMatchObject({ startLabel: "10:00", leaveLabel: "09:40", startAt: Date.parse(tenOClock), leaveAt: Date.parse(tenOClock) - 20 * 60_000, endAt: Date.parse(tenOClock) + 120 * 60_000 });
  });

  it("says when to leave the hotel for the last day's train", () => {
    const louvre = { ...newStop("Louvre"), placeId: "g-louvre", duration: 120 };
    // A 18:00 train, 30 min at the station and 30 min to get there: leave the hotel at 17:00 (16:00 UTC in winter).
    const paris: Trip = { ...newTrip(), city: "Paris", hotel: "Hotel", startDate: "2026-12-31", days: 1, timeZone: "Europe/Paris", stops: [louvre], departure: { mode: "TRAIN", time: "18:00", place: "Gare du Nord", bufferMinutes: 30, transferMinutes: 30 } };
    const schedule: Schedule = { generatedAt: "2026-10-14T06:00:00Z", warnings: [], omitted: [], days: [
      { day: 0, date: "2026-12-31", visits: [{ stopId: louvre.id, start: minuteAt(paris, 0, "10:00"), end: minuteAt(paris, 0, "12:00"), leg: leg("hotel", louvre.id, 20) }], returnLeg: leg(louvre.id, "hotel", 20) },
    ] };
    const journey: Journey = { id: crypto.randomUUID(), title: "Paris", cities: [paris], plans: { [paris.id]: persistedPlan(schedule, paris, { hotel: place("g-hotel", "Hotel"), [louvre.id]: place("g-louvre", "Louvre") }) } };
    const [day] = nativeTripMode(journey, Temporal.Instant.from("2026-12-31T08:00:00Z"), { canTrack: true, photos: false }).days;
    expect(day.departure).toMatchObject({ title: "Train leaves Gare du Nord 18:00", at: Date.parse("2026-12-31T17:00:00Z"), leaveAt: Date.parse("2026-12-31T16:00:00Z") });
  });
});
