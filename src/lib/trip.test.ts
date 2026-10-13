import { describe, expect, it } from "vitest";
import { applyScheduleDurations, changeStartDate, durationChoices, formatMinute, minuteAt, newStop, newTrip, resolvePlanningConstraints, stopSchema, suggestDayTrips, tripSchema, tripDate, type Schedule } from "./trip";
import { validateSchedule } from "./schedule-validation";

describe("trip constraints", () => {
  it("suggests distant nearby visits as a day trip without changing the trip", () => {
    const stops = [newStop("Dam Square"), newStop("Oudegracht"), newStop("Fufu"), newStop("Ukiyo"), newStop("Zaanse Schans")];
    const trip = { ...newTrip(), stops };
    const original = structuredClone(trip);
    const places = {
      hotel: { location: { lat: 52.37, lng: 4.89 } },
      [stops[0].id]: { location: { lat: 52.373, lng: 4.893 }, address: "Dam, 1012 JS Amsterdam, Netherlands" },
      [stops[1].id]: { location: { lat: 52.09, lng: 5.12 }, address: "Oudegracht 158, 3511 AZ Utrecht, Netherlands" },
      [stops[2].id]: { location: { lat: 52.092, lng: 5.118 }, address: "Voorstraat 1, 3512 AJ Utrecht, Netherlands" },
      [stops[3].id]: { location: { lat: 52.088, lng: 5.125 }, address: "Lijnmarkt 2, 3511 KG Utrecht, Netherlands" },
      [stops[4].id]: { location: { lat: 52.474, lng: 4.817 }, address: "Schansend 7, 1509 AW Zaandam, Netherlands" },
    };
    expect(suggestDayTrips(trip, places)).toEqual([{ name: "Utrecht", stopIds: stops.slice(1, 4).map((stop) => stop.id), distanceKm: 35, from: "hotel" }]);
    const amsterdam = [newStop("Vondelpark"), newStop("Jordaan"), newStop("De Pijp")];
    const withoutHotel: Record<string, { location: { lat: number; lng: number }; address?: string }> = { ...places, ...Object.fromEntries(amsterdam.map((stop, index) => [stop.id, { location: { lat: 52.36 + index * 0.005, lng: 4.88 } }])) };
    delete withoutHotel.hotel;
    expect(suggestDayTrips({ ...trip, stops: [...stops, ...amsterdam] }, withoutHotel)).toEqual([{ name: "Utrecht", stopIds: stops.slice(1, 4).map((stop) => stop.id), distanceKm: 34, from: "places" }]);
    expect(suggestDayTrips({ ...trip, dayGroups: [{ id: crypto.randomUUID(), name: "Utrecht", stopIds: [stops[1].id], allowedDays: [0], exclusive: true }] }, places)[0].stopIds).toEqual(stops.slice(2, 4).map((stop) => stop.id));
    expect(suggestDayTrips(trip, {})).toEqual([]);
    expect(trip).toEqual(original);
  });
  it("validates explicit day groups and independently rejects split or mixed exclusive days", () => {
    const stops = [newStop("Canal"), newStop("Lunch"), { ...newStop("Amsterdam sight"), day: 0 }];
    const group = { id: crypto.randomUUID(), name: "Utrecht", stopIds: stops.slice(0, 2).map((stop) => stop.id), allowedDays: [1, 2], exclusive: true };
    const trip = tripSchema.parse({ ...newTrip(), city: "Amsterdam", hotel: "Hotel", timeZone: "UTC", days: 3, stops, dayGroups: [group] });
    const schedule: Schedule = { generatedAt: "2026-10-12T00:00:00Z", warnings: [], omitted: [], days: Array.from({ length: 3 }, (_, day) => {
      const members = day === 1 ? stops.slice(0, 2) : day === 0 ? [stops[2]] : [];
      const visits = members.map((stop, index) => ({ stopId: stop.id, start: 540 + 60 * index, end: 585 + 60 * index, leg: { day, from: index ? members[index - 1].id : "hotel", to: stop.id, minutes: 0, meters: 0, mode: "WALK" as const } }));
      return { day, date: tripDate(trip, day), visits, ...(members.length ? { returnLeg: { day, from: members.at(-1)!.id, to: "hotel", minutes: 0, meters: 0, mode: "WALK" as const } } : {}) };
    }) };
    expect(validateSchedule(trip, schedule)).toEqual([]);
    const split = structuredClone(schedule);
    split.days[2].visits.push(split.days[1].visits.pop()!);
    expect(validateSchedule(trip, split)).toContain("Utrecht: grouped visits must stay on one day.");
    const mixed = structuredClone(schedule);
    mixed.days[1].visits.push(mixed.days[0].visits.pop()!);
    expect(validateSchedule(trip, mixed)).toContain("Utrecht: this day is reserved for the group.");
    for (const dayGroups of [[{ ...group, stopIds: [crypto.randomUUID()] }], [group, { ...group, id: crypto.randomUUID() }], [{ ...group, allowedDays: [3] }], [{ ...group, allowedDays: [0] }]]) {
      expect(tripSchema.safeParse({ ...trip, dayGroups }).success).toBe(false);
    }
    expect(tripSchema.safeParse({ ...trip, stops: stops.map((stop, index) => index < 2 ? { ...stop, day: index + 1, fixedTime: "10:00" } : stop) }).success).toBe(false);
    const reassigned = resolvePlanningConstraints({ ...trip, dayGroups: [{ ...group, allowedDays: [0] }] }, { keepTimeIds: [], movableDayIds: [stops[2].id], optionalIds: [] });
    expect(reassigned.dayGroups).toEqual([{ ...group, allowedDays: [0] }]);
    expect(reassigned.stops[2].day).toBeNull();
    expect(trip.stops[2].day).toBe(0);
    expect(tripSchema.safeParse({ ...trip, dayGroups: undefined }).success).toBe(true);
  });
  it("keeps selective duration permissions separate from original durations and locked bookings", () => {
    const trip = { ...newTrip(), city: "Paris", hotel: "Hotel", stops: [{ ...newStop("Lunch"), duration: 60 }, { ...newStop("Small visit"), duration: 15 }, { ...newStop("Ticket"), day: 0, fixedTime: "10:00" }] };
    const choices = { keepTimeIds: [trip.stops[2].id], movableDayIds: [], optionalIds: [], durationRules: { [trip.stops[0].id]: "eatery20" as const, [trip.stops[1].id]: "short" as const, [trip.stops[2].id]: "eatery20" as const } };
    const candidate = resolvePlanningConstraints(trip, choices);
    expect(candidate.stops.map((stop) => stop.duration)).toEqual([60, 15, 45]);
    expect(candidate.stops.map((stop) => stop.durationOptions)).toEqual([[60, 54, 48], [15, 10], undefined]);
    expect(candidate.stops[2]).toEqual(trip.stops[2]);
    expect(durationChoices(45, "eatery10")).toEqual([45, 41]);
    expect(() => durationChoices(30, "short")).toThrow("15-minute");
    expect(stopSchema.safeParse({ ...trip.stops[2], durationOptions: [45, 36] }).success).toBe(false);
    expect(stopSchema.safeParse({ ...trip.stops[0], durationOptions: [60, 30] }).success).toBe(false);
    expect(resolvePlanningConstraints(trip, choices)).toEqual(candidate);
    const schedule = { days: [{ visits: [{ stopId: trip.stops[0].id, start: 0, end: 54 }, { stopId: trip.stops[1].id, start: 0, end: 10 }] }] } as Schedule;
    expect(applyScheduleDurations(candidate, schedule).stops.map((stop) => stop.duration)).toEqual([54, 10, 45]);
    expect(applyScheduleDurations(candidate, schedule).stops.every((stop) => stop.durationOptions === undefined)).toBe(true);
    schedule.days[0].visits[0].end = 30;
    expect(() => applyScheduleDurations(candidate, schedule)).toThrow("not approved");
  });
  it("preserves actual booking dates when the trip start changes", () => {
    const trip = { ...newTrip(), startDate: "2026-10-12", days: 3, stops: [{ ...newStop("Museum"), day: 1, fixedTime: "10:00" }] };
    const changed = changeStartDate(trip, "2026-10-13");
    expect(changed.stops[0].day).toBe(0);
    expect(tripDate(changed, changed.stops[0].day!)).toBe("2026-10-13");
    expect(() => changeStartDate(trip, "2026-10-14")).toThrow("outside the new dates");
  });
  it("requires a fixed booking to have a day and remain mandatory", () => {
    const stop = { ...newStop("Museum"), fixedTime: "10:00" };
    expect(stopSchema.safeParse(stop).success).toBe(false);
    expect(stopSchema.safeParse({ ...stop, day: 0 }).success).toBe(true);
    expect(stopSchema.safeParse({ ...stop, day: 0, optional: true }).success).toBe(false);
  });

  it("rejects stops outside the trip and duplicate identities", () => {
    const trip = { ...newTrip(), city: "Paris", hotel: "Hotel", days: 1 };
    const stop = { ...newStop("Museum"), day: 1 };
    expect(tripSchema.safeParse({ ...trip, stops: [stop] }).success).toBe(false);
    expect(tripSchema.safeParse({ ...trip, stops: [{ ...stop, day: 0 }, { ...stop, day: 0 }] }).success).toBe(false);
  });

  it("uses elapsed minutes across DST and rejects ambiguous local times", () => {
    const trip = { ...newTrip(), startDate: "2026-03-29", timeZone: "Europe/Paris" };
    expect(minuteAt(trip, 0, "04:00")).toBe(180);
    expect(formatMinute(trip, 0, 180)).toBe("04:00");
    expect(() => minuteAt(trip, 0, "02:30")).toThrow();
    expect(() => minuteAt({ ...trip, startDate: "2026-10-25" }, 0, "02:30")).toThrow();
  });
});