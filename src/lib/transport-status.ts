import { Temporal } from "@js-temporal/polyfill";
import type { Journey } from "./journey";
import { travelledLegs } from "./recap";
import { endpointKey, instantForMinute, type TravelEdge, type Trip } from "./trip";
import { tripModeDays, visitStatus, type TripModeDay } from "./trip-mode";
import { maxRideFares, withCity, type RideFare, type TransportCard, type TransportEntry } from "./transport";

// A ride on public transport: when it set off (epoch ms), how far it went, the visit it went to or the way back, and
// the route (where from and to, and the lines taken) that Google's fare is for. `key` names it on its day.
export type Ride = { at: number; km: number; key: string; name: string; from: string; to: string; lines: string; stopId?: string; back?: true };
export const rideKey = (date: string, about: { stopId?: string; back?: true }) => `${date}|${about.back ? "back" : about.stopId}`;
export const routeLines = (edge: TravelEdge) => (edge.steps ?? []).flatMap((step) => step.line ? [step.line] : []).join("+");
// The parts of a journey the card's status comes from; trip mode has these without the rest.
export type CardJourney = { cities: Trip[]; plans: Journey["plans"]; execution?: Journey["execution"]; transport?: Journey["transport"] };
export type RideDay = { entry: TripModeDay; counted: Ride[]; planned: Ride[] };

// Rides by public transport on each planned day of a city, worked out from the plan and never stored. Counted: the
// leg into each visit done and the way back once the day is over, as the recap counts them (travelledLegs). Still to
// come: today's visits not yet made and the way back, and every day ahead. Walks, the airport or station legs (taxi
// or not) and a departure day's last leg to the station aren't counted; an airport ride is added by hand.
export function rideDays(journey: CardJourney, cityId: string, now: Temporal.Instant): RideDay[] {
  const city = journey.cities.find((candidate) => candidate.id === cityId);
  if (!city) return [];
  const original = journey.plans[cityId]?.snapshot?.schedule.days;
  return tripModeDays([city], journey.plans, journey.execution, now).map((entry) => {
    const toDeparture = endpointKey(entry.trip, entry.day, "hotel", "to") === "departure";
    const name = (id: string) => entry.cityTrip.stops.find((stop) => stop.id === id)?.name ?? entry.trip.stops.find((stop) => stop.id === id)?.name ?? entry.places[id]?.name ?? "Visit";
    const ride = (edge: TravelEdge, trip: Trip, minute: number, about: { stopId?: string; back?: true }): Ride[] => {
      if (edge.mode !== "TRANSIT" || (about.back && toDeparture)) return [];
      try {
        return [{
          at: instantForMinute(trip, entry.day, Math.max(0, minute)).epochMilliseconds, km: edge.meters / 1000, key: rideKey(entry.date, about),
          name: about.back ? "Back to the hotel" : name(about.stopId!), from: edge.from, to: edge.to, lines: routeLines(edge), ...about,
        }];
      } catch { return []; }
    };
    const counted = entry.started ? travelledLegs(entry, original?.find((day) => day.day === entry.day))
      .flatMap((leg) => ride(leg.edge, entry.cityTrip, leg.minute, leg.back ? { back: true } : { stopId: leg.stopId })) : [];
    const planned: Ride[] = [];
    if (entry.isToday || !entry.started) {
      const pending = entry.plan.visits.filter((visit) => visitStatus(entry.progress, visit.stopId) === "pending");
      for (const visit of pending) planned.push(...ride(visit.leg, entry.trip, visit.start - visit.leg.minutes, { stopId: visit.stopId }));
      const last = entry.plan.visits.at(-1);
      if (entry.plan.returnLeg && last && pending.length) planned.push(...ride(entry.plan.returnLeg, entry.trip, last.end, { back: true }));
    }
    return { entry, counted, planned };
  });
}

const round = (value: number) => Math.round(value * 100) / 100;

function localDate(at: number, timeZone: string) {
  try { return Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(timeZone).toPlainDate().toString(); } catch { return ""; }
}

type DayTotals = { uncapped: number; fares: number; rides: number };

// Google's fare for one traveller on the ride, while it's for the ride's route and in the card's money.
export function googleFare(card: TransportCard, fares: Record<string, RideFare> | undefined, ride: Ride) {
  const found = fares?.[ride.key];
  return found?.amount !== undefined && found.currency === card.currency && found.from === ride.from && found.to === ride.to && found.lines === ride.lines ? found.amount : undefined;
}

// The card's balance and what was spent, from the entries and the counted rides. A ride costs each traveller what was
// entered for it, or else a ticket, or Google's fare for its route, or the card's fare (plus distance); nothing while a
// pass is valid. What the card shows replaces every change before it, rides at the same moment included. A bank card's
// rides are capped each day; an airport ride's own fare is paid besides the card (taken off it for money on a card) and
// never capped.
function totals(card: TransportCard, entries: TransportEntry[], counted: Ride[], timeZone: string, fares?: Record<string, RideFare>) {
  const live = entries.filter((entry) => !entry.voided);
  const passes = live.filter((entry) => entry.kind === "pass" && entry.validUntil);
  const edits = new globalThis.Map<string, TransportEntry>();
  for (const entry of live) {
    if (entry.kind !== "fare" || !entry.ride) continue;
    const last = edits.get(entry.ride);
    if (!last || last.at <= entry.at) edits.set(entry.ride, entry);
  }
  const free = (at: number) => passes.some((pass) => at >= pass.at && at < pass.validUntil!);
  const base = (ride: Ride) => round((card.kind === "tickets" ? 1 : googleFare(card, fares, ride) ?? card.ridePrice + (card.perKm ?? 0) * ride.km) * card.travellers);
  const edit = (ride: Ride) => edits.get(ride.key)?.amount;
  const price = (ride: Ride) => edit(ride) !== undefined ? round(edit(ride)! * card.travellers) : base(ride);
  const cost = (ride: Ride) => free(ride.at) ? 0 : price(ride);
  // A ride added by hand, which the plan knows nothing of.
  const manual = (at: number) => free(at) ? 0 : card.kind === "tickets" ? card.travellers : round(card.ridePrice * card.travellers);
  const days = new globalThis.Map<string, DayTotals>();
  const day = (at: number) => {
    const key = localDate(at, timeZone);
    let value = days.get(key);
    if (!value) days.set(key, value = { uncapped: 0, fares: 0, rides: 0 });
    return value;
  };
  const changes: { at: number; set?: number; add?: number }[] = [];
  let spent = 0;
  const ride = (at: number, price: number, count: number) => {
    changes.push({ at, add: -price });
    const totals = day(at);
    totals.uncapped += price; totals.rides += count;
  };
  for (const each of counted) ride(each.at, cost(each), 1);
  for (const entry of live) {
    if (entry.kind === "topup") {
      changes.push({ at: entry.at, add: entry.amount ?? 0 });
      spent += entry.paid ?? (card.kind === "tickets" ? (entry.amount ?? 0) * card.ridePrice : entry.amount ?? 0);
    } else if (entry.kind === "set") changes.push({ at: entry.at, set: entry.amount ?? 0 });
    else if (entry.kind === "pass") spent += entry.paid ?? 0;
    else if (entry.paid !== undefined) {
      if (card.kind === "balance") changes.push({ at: entry.at, add: -entry.paid }); else spent += entry.paid;
      const totals = day(entry.at);
      totals.fares += entry.paid; totals.rides += 1;
    } else if (entry.kind === "ride") ride(entry.at, manual(entry.at) * (entry.amount ?? 1), entry.amount ?? 1);
  }
  const capped = (value: number) => Math.max(0, card.dailyCap !== undefined ? Math.min(card.dailyCap * card.travellers, value) : value);
  if (card.kind === "tap") for (const totals of days.values()) spent += capped(totals.uncapped);
  changes.sort((left, right) => left.at - right.at || Number(left.set !== undefined) - Number(right.set !== undefined));
  let balance = 0;
  let lastSet: number | undefined;
  for (const change of changes) {
    if (change.set !== undefined) { balance = change.set; lastSet = change.at; } else balance += change.add!;
  }
  return { balance: round(balance), spent: round(spent), days, lastSet, cost, price, base, manual, capped };
}

// `price` is what the ride costs all the travellers, a pass aside; `cost` what it takes off the card (nothing while a
// pass is valid, or for a counted ride already in what the card showed after it).
export type PricedRide = Ride & { cost: number; price: number; counted: boolean };
// One planned day: its rides with what each costs, how many were taken and are still to come, and the money spent that
// day: a bank card's rides, capped, and airport fares. `spentUncapped` is what the rides came to before any cap, in the
// card's tickets or money.
export type TransportDay = { key: string; date: string; isToday: boolean; rides: PricedRide[]; count: number; planned: number; spent: number; spentUncapped: number; fares: number };
export type TransportStatus = {
  card: TransportCard;
  // Tickets or money on the card; a bank card has none.
  balance?: number;
  spent: number;
  // Tickets or money to add for today's rides still to come, and tomorrow's from 18:00.
  toAdd?: number;
  today?: TransportDay;
  days: TransportDay[];
  // Each entry with what it did to the balance and to what was spent, and a ride's cost before the cap, so the iPhone
  // app can take one back without a connection.
  entries: { entry: TransportEntry; effect: number; spent: number; cost?: number }[];
};

export function transportStatus(journey: CardJourney, cityId: string, now: Temporal.Instant): TransportStatus | null {
  const city = journey.cities.find((candidate) => candidate.id === cityId);
  const setting = journey.transport?.[cityId];
  const card = setting?.card;
  if (!city || !card) return null;
  const entries = setting.entries ?? [];
  const byDay = rideDays(journey, cityId, now);
  const counted = byDay.flatMap((day) => day.counted);
  const all = totals(card, entries, counted, city.timeZone, setting.fares);
  const hasBalance = card.kind !== "tap";
  const days = byDay.map(({ entry, counted, planned }): TransportDay => {
    const stats = all.days.get(entry.date) ?? { uncapped: 0, fares: 0, rides: 0 };
    const priced = (ride: Ride, isCounted: boolean): PricedRide => ({
      ...ride, counted: isCounted, price: all.price(ride), cost: isCounted && hasBalance && all.lastSet !== undefined && ride.at <= all.lastSet ? 0 : all.cost(ride),
    });
    return {
      key: entry.key, date: entry.date, isToday: entry.isToday, rides: [...counted.map((ride) => priced(ride, true)), ...planned.map((ride) => priced(ride, false))],
      count: stats.rides, planned: planned.length, spent: round((hasBalance ? 0 : all.capped(stats.uncapped)) + stats.fares), spentUncapped: round(stats.uncapped), fares: round(stats.fares),
    };
  });
  const rides = new globalThis.Map(byDay.flatMap((day) => [...day.counted, ...day.planned]).map((ride) => [ride.key, ride]));
  let toAdd: number | undefined;
  if (hasBalance) {
    const local = now.toZonedDateTimeISO(city.timeZone);
    const today = local.toPlainDate().toString(), tomorrow = local.toPlainDate().add({ days: 1 }).toString();
    const needed = days.filter((day) => day.date === today || (local.hour >= 18 && day.date === tomorrow))
      .reduce((sum, day) => sum + day.rides.filter((ride) => !ride.counted).reduce((total, ride) => total + ride.cost, 0), 0);
    const short = needed - all.balance;
    if (short > 0) toAdd = card.kind === "tickets" ? Math.ceil(short) : round(short);
  }
  return {
    card, ...(hasBalance ? { balance: all.balance } : {}), spent: all.spent, ...(toAdd !== undefined ? { toAdd } : {}),
    ...(days.find((day) => day.isToday) ? { today: days.find((day) => day.isToday) } : {}), days,
    entries: entries.map((entry) => {
      // A ride's cost before the cap; a fare's, how far it moved its ride's price from Google's fare or the card's.
      const fareRide = entry.kind === "fare" ? rides.get(entry.ride ?? "") : undefined;
      const rideCost = entry.kind === "ride" && entry.paid === undefined ? all.manual(entry.at) * (entry.amount ?? 1)
        : entry.kind === "fare" ? fareRide ? round((entry.amount ?? 0) * card.travellers) - all.base(fareRide) : 0 : undefined;
      if (entry.voided) return { entry, effect: 0, spent: 0, ...(rideCost !== undefined ? { cost: 0 } : {}) };
      const without = totals(card, entries.filter((other) => other !== entry), counted, city.timeZone, setting.fares);
      return { entry, effect: round(all.balance - without.balance), spent: round(all.spent - without.spent), ...(rideCost !== undefined ? { cost: round(rideCost) } : {}) };
    }),
  };
}

// "14 tickets", "1 ticket" or "€6.40".
export function formatAmount(card: Pick<TransportCard, "kind" | "currency">, amount: number, unit: "balance" | "money" = "balance") {
  if (unit === "balance" && card.kind === "tickets") return `${amount} ${Math.abs(amount) === 1 ? "ticket" : "tickets"}`;
  try { return new Intl.NumberFormat("en-GB", { style: "currency", currency: card.currency }).format(amount); } catch { return `${amount.toFixed(2)} ${card.currency}`; }
}

// What tickets, or money, cost to add.
export function topUpPrice(card: TransportCard, amount: number) {
  return round(card.kind === "tickets" ? amount * card.ridePrice : amount);
}

// A day pass bought now lasts until midnight in the city.
export function dayPassUntil(timeZone: string, now: Temporal.Instant) {
  return now.toZonedDateTimeISO(timeZone).toPlainDate().add({ days: 1 }).toZonedDateTime({ timeZone }).epochMilliseconds;
}

// A ride whose fare is worth asking Google for, with where it goes from and to and when to ask about.
export type FareLeg = { key: string; from: string; to: string; lines: string; origin: { lat: number; lng: number }; destination: { lat: number; lng: number }; departure: string };
const day = 86_400_000;

// Google prices a ride from the timetable: one already gone, or beyond the weeks timetables are published for, is asked
// about at the same time on that weekday in the week ahead.
function fareDeparture(at: number, timeZone: string, now: Temporal.Instant) {
  const time = Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(timeZone);
  const today = now.toZonedDateTimeISO(timeZone).toPlainDate();
  if (at > now.epochMilliseconds && Temporal.PlainDate.compare(time.toPlainDate(), today.add({ days: 21 })) <= 0) return time.toInstant().toString();
  return today.add({ days: ((time.dayOfWeek - today.dayOfWeek + 7) % 7) || 7 }).toZonedDateTime({ timeZone, plainTime: time.toPlainTime() }).toInstant().toString();
}

// The rides of a card paid in money whose Google fare is missing, for another route, or old: a day for today's and
// tomorrow's, a week for later ones. A day that's over keeps the fare it had. Today's come first.
export function faresToCheck(journey: CardJourney, cityId: string, now: Temporal.Instant, limit = 40): FareLeg[] {
  const city = journey.cities.find((candidate) => candidate.id === cityId);
  const setting = journey.transport?.[cityId];
  if (!city || !setting?.card || setting.card.kind === "tickets") return [];
  const today = now.toZonedDateTimeISO(city.timeZone).toPlainDate();
  const legs: (FareLeg & { order: number })[] = [];
  for (const { entry, counted, planned } of rideDays(journey, cityId, now)) {
    const ahead = Temporal.PlainDate.from(entry.date).since(today).days;
    for (const ride of [...counted, ...planned]) {
      const found = setting.fares?.[ride.key];
      if (found && found.from === ride.from && found.to === ride.to && found.lines === ride.lines && (ahead < 0 || now.epochMilliseconds - found.at < (ahead <= 1 ? day : 7 * day))) continue;
      const origin = entry.places[ride.from], destination = entry.places[ride.to];
      if (!origin || !destination) continue;
      legs.push({ key: ride.key, from: ride.from, to: ride.to, lines: ride.lines, origin: origin.location, destination: destination.location, departure: fareDeparture(ride.at, city.timeZone, now), order: ahead < 0 ? 1000 - ahead : ahead });
    }
  }
  return legs.sort((left, right) => left.order - right.order).slice(0, limit).map(({ order: _order, ...leg }) => { void _order; return leg; });
}

// The journey with what Google said each leg costs (no amount where it has no fare; a leg it didn't answer for is left
// as it was), keeping only the fares of rides the card still counts.
export function withFares(journey: Journey, cityId: string, legs: FareLeg[], found: Record<string, { amount?: number; currency?: string }>, now: Temporal.Instant): Journey {
  const setting = journey.transport?.[cityId];
  if (!setting?.card) return journey;
  const keys = new Set(rideDays(journey, cityId, now).flatMap((ride) => [...ride.counted, ...ride.planned].map((each) => each.key)));
  const fares: Record<string, RideFare> = Object.fromEntries(Object.entries(setting.fares ?? {}).filter(([key]) => keys.has(key)));
  for (const leg of legs) {
    const fare = found[leg.key];
    if (!fare || !keys.has(leg.key)) continue;
    fares[leg.key] = { from: leg.from, to: leg.to, lines: leg.lines, ...(fare.amount !== undefined && fare.currency ? { amount: fare.amount, currency: fare.currency } : {}), at: now.epochMilliseconds };
  }
  const kept = Object.fromEntries(Object.entries(fares).sort((left, right) => right[1].at - left[1].at).slice(0, maxRideFares));
  const { fares: _fares, ...rest } = setting;
  void _fares;
  return { ...journey, transport: withCity(journey.transport, cityId, { ...rest, ...(Object.keys(kept).length ? { fares: kept } : {}) }) };
}
