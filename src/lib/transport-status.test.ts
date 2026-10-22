import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";
import type { Journey } from "./journey";
import { withProgress } from "./native-actions";
import { applyTransportAction, mergeTransportEntries, withTransportCard, type RideFare, type TransportAction, type TransportCard, type TransportEntry } from "./transport";
import { adviceText, dayPassUntil, faresToCheck, formatAmount, passAdvice, rideDays, topUpPrice, transportSpend, transportStatus, withFares } from "./transport-status";
import { minuteAt, newStop, newTrip, persistedPlan, type Schedule, type TravelEdge, type Trip } from "./trip";
import { markDone, markPending, tripModeDays } from "./trip-mode";

const leg = (from: string, to: string, minutes: number, extra: Partial<TravelEdge> = {}): TravelEdge => ({ day: 0, from, to, mode: "TRANSIT", minutes, meters: 3000, steps: [{ instruction: "", mode: "TRANSIT", line: "1" }], ...extra });
const navigo: TransportCard = { kind: "tickets", name: "Navigo Easy", currency: "EUR", travellers: 2, ridePrice: 2.55, dayPass: 12.3, airportPrice: 14 };
const euros: TransportCard = { kind: "balance", name: "Navigo Easy", currency: "EUR", travellers: 2, ridePrice: 2.55, dayPass: 12.3, airportPrice: 14 };
const ovpay: TransportCard = { kind: "tap", name: "Bank card", currency: "EUR", travellers: 1, ridePrice: 1.16, perKm: 0.217, dailyCap: 10.5, airportPrice: 5.5 };

// Paris over two days: the metro to the Louvre, a walk to the Tuileries, the metro to Orsay and back; the next day the
// metro to Montmartre and a walk back.
function fixture(card: TransportCard = navigo) {
  const louvre = { ...newStop("Louvre"), duration: 120 };
  const tuileries = { ...newStop("Tuileries"), duration: 30 };
  const orsay = { ...newStop("Musée d'Orsay"), duration: 90 };
  const montmartre = { ...newStop("Montmartre"), duration: 90 };
  const paris: Trip = { ...newTrip(), city: "Paris", hotel: "Hôtel du Nord", startDate: "2026-12-29", days: 2, timeZone: "Europe/Paris", stops: [louvre, tuileries, orsay, montmartre] };
  const at = (day: number, time: string) => minuteAt(paris, day, time);
  const schedule: Schedule = { generatedAt: "2026-10-14T06:00:00Z", warnings: [], omitted: [], days: [
    { day: 0, date: "2026-12-29", visits: [
      { stopId: louvre.id, start: at(0, "09:30"), end: at(0, "11:30"), leg: leg("hotel", louvre.id, 20, { meters: 4000 }) },
      { stopId: tuileries.id, start: at(0, "11:40"), end: at(0, "12:10"), leg: leg(louvre.id, tuileries.id, 10, { mode: "WALK", meters: 700 }) },
      { stopId: orsay.id, start: at(0, "12:40"), end: at(0, "14:10"), leg: leg(tuileries.id, orsay.id, 15, { steps: [{ instruction: "", mode: "TRANSIT", line: "72" }] }) },
    ], returnLeg: leg(orsay.id, "hotel", 25, { meters: 5000 }) },
    { day: 1, date: "2026-12-30", visits: [{ stopId: montmartre.id, start: at(1, "10:00"), end: at(1, "11:30"), leg: leg("hotel", montmartre.id, 20) }], returnLeg: leg(montmartre.id, "hotel", 30, { mode: "WALK", meters: 2200 }) },
  ] };
  const place = (id: string, name: string, lat: number) => ({ id: `place-${name}`, name, address: "Paris", location: { lat, lng: 2.33 } });
  const places = { hotel: place("hotel", "Hôtel du Nord", 48.87), ...Object.fromEntries([louvre, tuileries, orsay, montmartre].map((stop, index) => [stop.id, place(stop.id, stop.name, 48.86 - index / 100)])) };
  const journey: Journey = { id: crypto.randomUUID(), title: "New Year", cities: [paris], plans: { [paris.id]: persistedPlan(schedule, paris, places) }, transport: withTransportCard(undefined, paris.id, card) };
  return { journey, paris, louvre, tuileries, orsay, montmartre, at };
}

const instant = (value: string) => Temporal.Instant.from(value);
const entry = (kind: TransportEntry["kind"], at: string, extra: Partial<TransportEntry> = {}): TransportEntry => ({ id: crypto.randomUUID(), at: Date.parse(at), kind, ...extra });
function record(journey: Journey, cityId: string, ...entries: TransportEntry[]) {
  return entries.reduce((current, each) => applyTransportAction(current, { kind: "transport-entry", cityId, entry: each }, instant("2026-12-31T00:00:00Z")).journey, journey);
}
function done(journey: Journey, cityId: string, stopId: string, minute: number, now: Temporal.Instant) {
  const day = tripModeDays(journey.cities, journey.plans, journey.execution, now).find((candidate) => candidate.isToday)!;
  return withProgress(journey, cityId, day.date, markDone(day, stopId, minute));
}

describe("rides worked out from the plan", () => {
  it("counts the metro into each visit done and the way back once nothing's left, and knows what's still to come", () => {
    const { journey, paris, louvre, tuileries, orsay, at } = fixture();
    const noon = instant("2026-12-29T11:00:00Z");
    let progress = done(journey, paris.id, louvre.id, at(0, "11:30"), noon);
    const [first, tomorrow] = rideDays(progress, paris.id, noon);
    let today = first;
    // Done at 11:30 after the planned two hours, so set off on the 20-minute metro at 09:10 (08:10 UTC).
    expect(today.counted).toEqual([{ at: Date.parse("2026-12-29T08:10:00Z"), km: 4, stopId: louvre.id, key: `2026-12-29|${louvre.id}`, name: "Louvre", from: "hotel", to: louvre.id, lines: "1" }]);
    expect(today.planned.map((ride) => ride.stopId ?? "back")).toEqual([orsay.id, "back"]);
    // The walk back from Montmartre is no ride.
    expect(tomorrow.planned.map((ride) => ride.stopId)).toEqual([tomorrow.entry.plan.visits[0].stopId]);
    progress = done(progress, paris.id, tuileries.id, at(0, "12:10"), noon);
    progress = done(progress, paris.id, orsay.id, at(0, "14:10"), noon);
    [today] = rideDays(progress, paris.id, noon);
    expect(today.counted.map((ride) => ride.stopId ?? "back")).toEqual([louvre.id, orsay.id, "back"]);
    expect(today.planned).toEqual([]);
  });

  it("leaves out a departure day's last leg to the station", () => {
    const { journey, paris } = fixture();
    const leaving = { ...paris, returnToHotel: true, departure: { mode: "TRAIN" as const, place: "Gare du Nord", placeId: "g-nord", time: "16:00", direct: true } };
    const plan = journey.plans[paris.id];
    const days = rideDays({ ...journey, cities: [leaving], plans: { [paris.id]: { ...plan, snapshot: { ...plan.snapshot!, trip: leaving } } } }, paris.id, instant("2026-12-29T08:00:00Z"));
    // Montmartre's metro still counts; the walk to the station never would, and a ride there wouldn't either.
    expect(days[1].planned.map((ride) => ride.back ?? false)).toEqual([false]);
    const byMetro = { ...plan.snapshot!.schedule, days: plan.snapshot!.schedule.days.map((day) => day.day === 1 ? { ...day, returnLeg: { ...day.returnLeg!, mode: "TRANSIT" as const } } : day) };
    const metroBack = rideDays({ ...journey, cities: [leaving], plans: { [paris.id]: { ...plan, snapshot: { ...plan.snapshot!, trip: leaving, schedule: byMetro } } } }, paris.id, instant("2026-12-29T08:00:00Z"));
    expect(metroBack[1].planned.map((ride) => ride.back ?? false)).toEqual([false]);
    expect(rideDays({ ...journey, plans: { [paris.id]: { ...plan, snapshot: { ...plan.snapshot!, schedule: byMetro } } } }, paris.id, instant("2026-12-29T08:00:00Z"))[1].planned.map((ride) => ride.back ?? false)).toEqual([false, true]);
  });
});

describe("a card of tickets", () => {
  it("takes a ticket for each traveller per ride, and gives them back when Done is taken back", () => {
    const { journey, paris, louvre, tuileries, orsay, at } = fixture();
    const noon = instant("2026-12-29T11:00:00Z");
    let trip = record(journey, paris.id, entry("topup", "2026-12-29T07:00:00Z", { amount: 10, paid: 17.35 }));
    trip = done(trip, paris.id, louvre.id, at(0, "11:30"), noon);
    const status = transportStatus(trip, paris.id, noon)!;
    expect(status).toMatchObject({ balance: 8, spent: 17.35, today: { count: 1, planned: 2 } });
    expect(status.toAdd).toBeUndefined();
    trip = done(trip, paris.id, tuileries.id, at(0, "12:10"), noon);
    trip = done(trip, paris.id, orsay.id, at(0, "14:10"), noon);
    expect(transportStatus(trip, paris.id, noon)).toMatchObject({ balance: 4, today: { count: 3, planned: 0 } });
    const day = tripModeDays(trip.cities, trip.plans, trip.execution, noon)[0];
    trip = withProgress(trip, paris.id, day.date, markPending(day, orsay.id));
    expect(transportStatus(trip, paris.id, noon)).toMatchObject({ balance: 8, today: { count: 1, planned: 2 } });
  });

  it("starts again from what the card shows, with the rides before it already in it", () => {
    const { journey, paris, louvre, orsay, tuileries, at } = fixture();
    const noon = instant("2026-12-29T11:00:00Z");
    let trip = record(journey, paris.id, entry("topup", "2026-12-29T07:00:00Z", { amount: 10 }));
    trip = done(trip, paris.id, louvre.id, at(0, "11:30"), noon);
    trip = record(trip, paris.id, entry("set", "2026-12-29T10:45:00Z", { amount: 5 }));
    let status = transportStatus(trip, paris.id, noon)!;
    expect(status.balance).toBe(5);
    // The Louvre's ride is in what the card showed; Orsay's isn't yet.
    expect(status.today!.rides.map((ride) => [ride.stopId ?? "back", ride.counted, ride.cost])).toEqual([[louvre.id, true, 0], [orsay.id, false, 2], ["back", false, 2]]);
    trip = done(trip, paris.id, tuileries.id, at(0, "12:10"), noon);
    trip = done(trip, paris.id, orsay.id, at(0, "14:10"), noon);
    status = transportStatus(trip, paris.id, noon)!;
    expect(status.balance).toBe(1);
    // Ten tickets bought without a price count at a ticket each.
    expect(status.spent).toBe(25.5);
  });

  it("says how many to add for the rides still to come today, and tomorrow's from 18:00", () => {
    const { journey, paris } = fixture();
    const trip = record(journey, paris.id, entry("topup", "2026-12-29T07:00:00Z", { amount: 1 }));
    // Three rides today for two: six tickets, one on the card.
    expect(transportStatus(trip, paris.id, instant("2026-12-29T08:00:00Z"))!.toAdd).toBe(5);
    // From 18:00, tomorrow's ride for two as well; today's still count until the day is over.
    expect(transportStatus(trip, paris.id, instant("2026-12-29T17:30:00Z"))!.toAdd).toBe(7);
  });

  it("rides free on a day pass, which counts as spent, and an airport ride is paid besides the card", () => {
    const { journey, paris, louvre, at } = fixture();
    const noon = instant("2026-12-29T11:00:00Z");
    let trip = record(journey, paris.id,
      entry("topup", "2026-12-29T07:00:00Z", { amount: 10, paid: 17.35 }),
      entry("pass", "2026-12-29T08:00:00Z", { paid: 24.6, validUntil: dayPassUntil("Europe/Paris", instant("2026-12-29T08:00:00Z")) }),
      entry("ride", "2026-12-29T08:30:00Z", { paid: 28 }));
    trip = done(trip, paris.id, louvre.id, at(0, "11:30"), noon);
    const status = transportStatus(trip, paris.id, noon)!;
    expect(status).toMatchObject({ balance: 10, spent: 69.95 });
    expect(status.today!.count).toBe(2);
    expect(status.days[1].rides[0].cost).toBe(2);
  });

  it("tells what each entry did, so one can be taken back without a connection", () => {
    const { journey, paris } = fixture();
    const topUp = entry("topup", "2026-12-29T07:00:00Z", { amount: 10, paid: 17.35 });
    const extra = entry("ride", "2026-12-29T08:00:00Z");
    const trip = record(journey, paris.id, topUp, extra);
    const status = transportStatus(trip, paris.id, instant("2026-12-29T09:00:00Z"))!;
    expect(status.entries.map(({ effect, spent, cost }) => ({ effect, spent, cost }))).toEqual([{ effect: 10, spent: 17.35, cost: undefined }, { effect: -2, spent: 0, cost: 2 }]);
  });
});

describe("a bank card tapped in and out", () => {
  it("charges the fare and distance for each ride, capped each day, with an airport fare besides", () => {
    const { journey, paris, louvre, tuileries, orsay, at } = fixture(ovpay);
    const noon = instant("2026-12-29T11:00:00Z");
    let trip = done(journey, paris.id, louvre.id, at(0, "11:30"), noon);
    let status = transportStatus(trip, paris.id, noon)!;
    // 1.16 + 4 km × 0.217.
    expect(status).toMatchObject({ spent: 2.03, today: { spent: 2.03, spentUncapped: 2.03, count: 1 } });
    expect(status.balance).toBeUndefined();
    trip = record(trip, paris.id, ...Array.from({ length: 8 }, (_, index) => entry("ride", `2026-12-29T1${index % 2}:0${index}:00Z`)), entry("ride", "2026-12-29T07:00:00Z", { paid: 5.5 }));
    trip = done(trip, paris.id, tuileries.id, at(0, "12:10"), noon);
    trip = done(trip, paris.id, orsay.id, at(0, "14:10"), noon);
    status = transportStatus(trip, paris.id, noon)!;
    expect(status.today).toMatchObject({ count: 12, spent: 16, fares: 5.5 });
    expect(status.today!.spentUncapped).toBeGreaterThan(10.5);
    expect(status.spent).toBe(16);
  });

  it("has no balance to top up or set", () => {
    const { journey, paris } = fixture(ovpay);
    expect(() => record(journey, paris.id, entry("topup", "2026-12-29T07:00:00Z", { amount: 10 }))).toThrow("A bank card has no balance.");
  });
});

describe("recording on the card", () => {
  it("keeps an entry once, however often it's sent, and a removed one stays removed", () => {
    const { journey, paris } = fixture();
    const now = instant("2026-12-29T09:00:00Z");
    const ride = entry("ride", "2026-12-29T08:00:00Z");
    const add: TransportAction = { kind: "transport-entry", cityId: paris.id, entry: ride };
    const once = applyTransportAction(journey, add, now);
    expect(once).toMatchObject({ changed: true, message: "Ride added" });
    expect(applyTransportAction(once.journey, add, now)).toMatchObject({ changed: false });
    const removed = applyTransportAction(once.journey, { kind: "transport-void", cityId: paris.id, entryId: ride.id }, now);
    expect(removed).toMatchObject({ changed: true, message: "Ride removed" });
    expect(applyTransportAction(removed.journey, add, now).changed).toBe(false);
    expect(transportStatus(removed.journey, paris.id, now)!.balance).toBe(0);
  });

  it("refuses entries for a city without a card, from the future, or that don't make sense", () => {
    const { journey, paris } = fixture();
    const now = instant("2026-12-29T09:00:00Z");
    const add = (each: TransportEntry, cityId = paris.id) => () => applyTransportAction(journey, { kind: "transport-entry", cityId, entry: each }, now);
    expect(add(entry("ride", "2026-12-29T08:00:00Z"), crypto.randomUUID())).toThrow("Set up a transport card for this city first.");
    expect(add(entry("ride", "2026-12-29T10:00:00Z"))).toThrow("An entry can't be ahead of time.");
    expect(add(entry("topup", "2026-12-29T08:00:00Z", { amount: 0 }))).toThrow("Enter how much was added.");
    expect(add(entry("ride", "2026-12-29T08:00:00Z", { amount: 1.5 }))).toThrow("That ride isn't valid.");
    expect(add(entry("pass", "2026-12-29T08:00:00Z", { paid: 12 }))).toThrow("A pass needs the time it ends.");
  });

  it("merges what two devices recorded, removed if either removed it", () => {
    const { journey, paris } = fixture();
    const first = entry("ride", "2026-12-29T08:00:00Z"), second = entry("topup", "2026-12-29T08:10:00Z", { amount: 10 }), third = entry("ride", "2026-12-29T08:20:00Z");
    const server = record(journey, paris.id, first, second);
    let laptop = record(journey, paris.id, first, third);
    laptop = applyTransportAction(laptop, { kind: "transport-void", cityId: paris.id, entryId: first.id }, instant("2026-12-31T00:00:00Z")).journey;
    const merged = mergeTransportEntries(server, laptop).transport![paris.id].entries!;
    expect(merged.map((each) => [each.id, Boolean(each.voided)])).toEqual([[first.id, true], [second.id, false], [third.id, false]]);
  });

  it("shows amounts as the card counts them, and prices tickets at a ticket each", () => {
    expect(formatAmount(navigo, 1)).toBe("1 ticket");
    expect(formatAmount(navigo, 14)).toBe("14 tickets");
    expect(formatAmount(navigo, 6.4, "money")).toBe("€6.40");
    expect(topUpPrice(navigo, 10)).toBe(25.5);
    expect(topUpPrice(navigo, 3)).toBe(7.65);
    expect(topUpPrice(euros, 20)).toBe(20);
    expect(dayPassUntil("Europe/Paris", instant("2026-12-29T08:00:00Z"))).toBe(Date.parse("2026-12-29T23:00:00Z"));
  });
});

describe("fares from Google and fares entered", () => {
  const fare = (from: string, to: string, lines: string, amount: number | undefined, at = Date.parse("2026-12-29T07:00:00Z")): RideFare => ({ from, to, lines, ...(amount !== undefined ? { amount, currency: "EUR" } : {}), at });
  function withGoogle(journey: Journey, cityId: string, fares: Record<string, RideFare>): Journey {
    return { ...journey, transport: { ...journey.transport, [cityId]: { ...journey.transport![cityId], fares } } };
  }

  it("takes Google's fare off money on the card while it's for the ride's route, and the card's otherwise", () => {
    const { journey, paris, louvre, tuileries, orsay, at } = fixture(euros);
    const noon = instant("2026-12-29T11:00:00Z");
    let trip = record(journey, paris.id, entry("topup", "2026-12-29T07:00:00Z", { amount: 20 }));
    trip = withGoogle(trip, paris.id, {
      [`2026-12-29|${louvre.id}`]: fare("hotel", louvre.id, "1", 2.55),
      // Asked about the bus to Orsay from the Louvre, and the way back on line 9; both go another way now.
      [`2026-12-29|${orsay.id}`]: fare(louvre.id, orsay.id, "72", 2.05),
      "2026-12-29|back": fare(orsay.id, "hotel", "9", 2.05),
    });
    trip = done(trip, paris.id, louvre.id, at(0, "11:30"), noon);
    let status = transportStatus(trip, paris.id, noon)!;
    expect(status.balance).toBe(14.9);
    // Orsay's fare is for a ride from somewhere else, and the way back's for other lines: the card's fare for both.
    expect(status.today!.rides.map((ride) => ride.price)).toEqual([5.1, 5.1, 5.1]);
    trip = withGoogle(trip, paris.id, { ...trip.transport![paris.id].fares, [`2026-12-29|${orsay.id}`]: fare(tuileries.id, orsay.id, "72", 2.05) });
    status = transportStatus(trip, paris.id, noon)!;
    expect(status.today!.rides.map((ride) => ride.price)).toEqual([5.1, 4.1, 5.1]);
    // The bus and the way back for two come to 9.20, within the 14.90 left.
    expect(status.toAdd).toBeUndefined();
    // A fare in another currency isn't the card's.
    const pounds = withGoogle(trip, paris.id, { [`2026-12-29|${louvre.id}`]: { ...fare("hotel", louvre.id, "1", 1), currency: "GBP" } });
    expect(transportStatus(pounds, paris.id, noon)!.balance).toBe(14.9);
    trip = record(trip, paris.id, entry("set", "2026-12-29T10:58:00Z", { amount: 9 }));
    expect(transportStatus(trip, paris.id, noon)!.toAdd).toBe(0.2);
  });

  it("leaves a card of tickets at a ticket a ride", () => {
    const { journey, paris, louvre, at } = fixture(navigo);
    const noon = instant("2026-12-29T11:00:00Z");
    let trip = record(journey, paris.id, entry("topup", "2026-12-29T07:00:00Z", { amount: 10 }));
    trip = withGoogle(trip, paris.id, { [`2026-12-29|${louvre.id}`]: fare("hotel", louvre.id, "1", 4.6) });
    trip = done(trip, paris.id, louvre.id, at(0, "11:30"), noon);
    expect(transportStatus(trip, paris.id, noon)!.balance).toBe(8);
    expect(faresToCheck(trip, paris.id, noon)).toEqual([]);
  });

  it("uses the fare entered for a ride, latest first, until it's removed", () => {
    const { journey, paris, louvre, orsay, at } = fixture(euros);
    const noon = instant("2026-12-29T11:00:00Z");
    let trip = record(journey, paris.id, entry("topup", "2026-12-29T07:00:00Z", { amount: 20 }));
    trip = withGoogle(trip, paris.id, { [`2026-12-29|${louvre.id}`]: fare("hotel", louvre.id, "1", 2.55) });
    trip = done(trip, paris.id, louvre.id, at(0, "11:30"), noon);
    const first = entry("fare", "2026-12-29T10:50:00Z", { ride: `2026-12-29|${louvre.id}`, amount: 2.05 });
    const second = entry("fare", "2026-12-29T10:55:00Z", { ride: `2026-12-29|${louvre.id}`, amount: 0 });
    const orsayFare = entry("fare", "2026-12-29T10:56:00Z", { ride: `2026-12-29|${orsay.id}`, amount: 3 });
    trip = record(trip, paris.id, first);
    expect(transportStatus(trip, paris.id, noon)!.balance).toBe(15.9);
    trip = record(trip, paris.id, second, orsayFare);
    const status = transportStatus(trip, paris.id, noon)!;
    expect(status.balance).toBe(20);
    expect(status.today!.rides.map((ride) => [ride.price, ride.cost])).toEqual([[0, 0], [6, 6], [5.1, 5.1]]);
    // How far each moved its ride's price from Google's fare or the card's, for the phone to take one back.
    expect(status.entries.slice(1).map(({ effect, cost }) => [effect, cost])).toEqual([[0, -1], [4.1, -5.1], [0, 0.9]]);
    trip = applyTransportAction(trip, { kind: "transport-void", cityId: paris.id, entryId: second.id }, instant("2026-12-31T00:00:00Z")).journey;
    expect(transportStatus(trip, paris.id, noon)!.balance).toBe(15.9);
    expect(() => record(trip, paris.id, entry("fare", "2026-12-29T10:57:00Z", { amount: 2 }))).toThrow("Enter what the ride cost.");
    const tickets = fixture(navigo);
    expect(() => record(tickets.journey, tickets.paris.id, entry("fare", "2026-12-29T10:57:00Z", { ride: `2026-12-29|${louvre.id}`, amount: 1.5 }))).toThrow("Enter what the ride cost.");
  });

  it("asks Google about rides without a fare for their route, or an old one, today's first, and keeps a finished day's", () => {
    const { journey, paris, louvre, orsay, montmartre } = fixture(euros);
    const morning = instant("2026-12-29T07:00:00Z");
    let legs = faresToCheck(journey, paris.id, morning);
    expect(legs.map((each) => each.key)).toEqual([`2026-12-29|${louvre.id}`, `2026-12-29|${orsay.id}`, "2026-12-29|back", `2026-12-30|${montmartre.id}`]);
    expect(legs[0]).toMatchObject({ from: "hotel", to: louvre.id, lines: "1", departure: "2026-12-29T08:10:00Z" });
    expect(legs[0].origin).toEqual(journey.plans[paris.id].snapshot!.places.hotel.location);
    let trip = withFares(journey, paris.id, legs.slice(0, 3), { [legs[0].key]: { amount: 2.55, currency: "EUR" }, [legs[1].key]: {} }, morning);
    // What Google answered is kept, a fare or none; the way back it didn't answer for is asked again.
    expect(trip.transport![paris.id].fares).toEqual({ [legs[0].key]: fare("hotel", louvre.id, "1", 2.55, morning.epochMilliseconds), [legs[1].key]: { from: legs[1].from, to: orsay.id, lines: "72", at: morning.epochMilliseconds } });
    expect(faresToCheck(trip, paris.id, morning).map((each) => each.key)).toEqual(["2026-12-29|back", `2026-12-30|${montmartre.id}`]);
    // A day on, today's are old; once a day is over, it keeps them.
    trip = withFares(trip, paris.id, legs, Object.fromEntries(legs.map((each) => [each.key, {}])), morning);
    expect(faresToCheck(trip, paris.id, instant("2026-12-30T07:30:00Z")).map((each) => each.key)).toEqual([`2026-12-30|${montmartre.id}`]);
    // Far ahead, a ride is asked about on its weekday in the week ahead.
    legs = faresToCheck(journey, paris.id, instant("2026-10-22T10:00:00Z"));
    expect(legs[0].departure).toBe("2026-10-27T08:10:00Z");
  });

  it("keeps only the fares of rides still counted, and the latest of two devices'", () => {
    const { journey, paris, louvre } = fixture(euros);
    const morning = instant("2026-12-29T07:00:00Z");
    const stale = withGoogle(journey, paris.id, { "2026-12-28|back": fare("x", "hotel", "1", 2) });
    const legs = faresToCheck(stale, paris.id, morning);
    const trip = withFares(stale, paris.id, legs, { [legs[0].key]: { amount: 2.55, currency: "EUR" } }, morning);
    expect(Object.keys(trip.transport![paris.id].fares!)).toEqual([`2026-12-29|${louvre.id}`]);
    const newer = withGoogle(trip, paris.id, { [`2026-12-29|${louvre.id}`]: fare("hotel", louvre.id, "1", 2.6, morning.epochMilliseconds + 1) });
    expect(mergeTransportEntries(trip, newer).transport![paris.id].fares![`2026-12-29|${louvre.id}`].amount).toBe(2.6);
    expect(mergeTransportEntries(newer, trip).transport![paris.id].fares![`2026-12-29|${louvre.id}`].amount).toBe(2.6);
  });
});

describe("day passes and what the card cost", () => {
  const advice = (journey: Journey, cityId: string, now: Temporal.Instant) => {
    const status = transportStatus(journey, cityId, now)!;
    return passAdvice(status, "Europe/Paris").map((each) => ({ date: each.date, text: adviceText(status.card, each) }));
  };

  it("says when a day pass costs less than a day's rides, counting today's still to come", () => {
    const { journey, paris, louvre, at } = fixture({ ...navigo, travellers: 1, dayPass: 7 });
    const before = instant("2026-12-28T10:00:00Z");
    // Three rides at a ticket each on the first day; one on the second.
    expect(advice(journey, paris.id, before)).toEqual([{ date: "2026-12-29", text: "3 rides ≈ €7.65; a day pass (€7.00) is cheaper" }]);
    // With the Louvre done, two rides are left today, less than a pass.
    const noon = instant("2026-12-29T11:00:00Z");
    expect(advice(done(journey, paris.id, louvre.id, at(0, "11:30"), noon), paris.id, noon)).toEqual([]);
    // For two, passes for both.
    const { journey: two, paris: city } = fixture({ ...navigo, dayPass: 3.5 });
    expect(advice(two, city.id, before)[0].text).toBe("3 rides ≈ €15.30; day passes (€7.00) are cheaper");
  });

  it("has nothing to say for a day a pass already covers, or a card without a pass price", () => {
    const { journey, paris } = fixture({ ...navigo, travellers: 1, dayPass: 7 });
    const morning = instant("2026-12-29T07:30:00Z");
    const covered = record(journey, paris.id, entry("pass", "2026-12-29T07:00:00Z", { paid: 7, validUntil: dayPassUntil("Europe/Paris", instant("2026-12-29T07:00:00Z")) }));
    expect(advice(covered, paris.id, morning)).toEqual([]);
    const { journey: none, paris: city } = fixture({ ...navigo, travellers: 1, dayPass: undefined });
    expect(advice(none, city.id, morning)).toEqual([]);
  });

  it("notes a day whose bank card rides reach the daily cap", () => {
    const { journey, paris } = fixture({ ...ovpay, dailyCap: 5 });
    const [first] = passAdvice(transportStatus(journey, paris.id, instant("2026-12-28T10:00:00Z"))!, "Europe/Paris");
    expect(first).toMatchObject({ date: "2026-12-29", rides: 3, cap: 5 });
    expect(adviceText(ovpay, first)).toMatch(/^3 rides ≈ €6\.\d\d, capped at €5\.00$/);
  });

  it("totals what each city's card cost", () => {
    const { journey, paris } = fixture();
    const now = instant("2026-12-29T10:00:00Z");
    expect(transportSpend(journey, now)).toEqual([]);
    const trip = record(journey, paris.id, entry("topup", "2026-12-29T07:00:00Z", { amount: 10, paid: 25.5 }), entry("ride", "2026-12-29T08:00:00Z", { paid: 28 }));
    expect(transportSpend(trip, now)).toEqual([{ cityId: paris.id, city: "Paris", spent: "€53.50" }]);
  });
});
