import { describe, expect, it } from "vitest";
import { applyScheduleDurations, persistedPlan, planningKey, plannedStopIds, arrivalTimes, bookingConflictDetails, changeStartDate, dayEnd, dayStart, departureTimes, directDeparture, endpointKey, returnDeadline, tripForDay, durationChoices, formatMinute, minuteAt, newStop, newTrip, resolvePlanningConstraints, stopSchema, suggestDayTrips, tripSchema, tripDate, type Schedule } from "./trip";
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
    // A group with no day left names the visit in the way.
    const pinned = tripSchema.safeParse({ ...trip, stops: stops.map((stop, index) => index === 0 ? { ...stop, day: 0 } : stop) });
    expect(pinned.error?.issues.map((issue) => issue.message)).toContain("Utrecht can't go on any day: Canal is set to Day 1, but Utrecht is only allowed on Day 2, Day 3. Change one of them in Plan my days.");
    const crowded = tripSchema.safeParse({ ...trip, stops: [...stops, { ...newStop("Museum"), day: 1 }, { ...newStop("Park"), day: 2 }] });
    expect(crowded.error?.issues.map((issue) => issue.message)).toContain("Utrecht can't go on any day: it needs a day to itself, and every day it's allowed on already has other places. Move them, or allow another day in Plan my days.");
    const apart = tripSchema.safeParse({ ...trip, stops: stops.map((stop, index) => index < 2 ? { ...stop, day: index + 1 } : stop) });
    expect(apart.error?.issues.map((issue) => issue.message)).toContain("Utrecht can't go on one day: Canal is set to Day 2, Lunch is set to Day 3. Put them on the same day, or let the planner pick.");
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
    // A start at a fractional minute (a computed sunset) leaves the length a hair off a whole number.
    schedule.days[0].visits[0] = { ...schedule.days[0].visits[0], start: 1007.8012434, end: 1007.8012434 + 54.000000001 };
    expect(applyScheduleDurations(candidate, schedule).stops[0].duration).toBe(54);
    schedule.days[0].visits[0] = { ...schedule.days[0].visits[0], start: 0, end: 30 };
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

  it("starts the first day after arrival and ends the last day in time for departure", () => {
    const trip = { ...newTrip(), city: "Amsterdam", hotel: "Motel One", startDate: "2026-12-24", days: 4, timeZone: "Europe/Amsterdam", dailyStart: "08:00", dailyEnd: "21:00",
      arrival: { mode: "FLIGHT" as const, time: "13:20", place: "Amsterdam Schiphol", reference: "QR 273" },
      departure: { mode: "TRAIN" as const, time: "17:00", place: "Amsterdam Centraal", transferMinutes: 25 } };
    expect(tripSchema.safeParse(trip).success).toBe(true);
    // 13:20 + 45 min at the airport + 45 min to the hotel + 15 min to drop bags.
    expect(arrivalTimes(trip)).toMatchObject({ buffer: 45, transfer: 45, ready: minuteAt(trip, 0, "15:05") });
    expect(formatMinute(trip, 0, dayStart(trip, 0))).toBe("15:05");
    expect(dayStart(trip, 1)).toBe(minuteAt(trip, 1, "08:00"));
    expect(dayEnd(trip, 0)).toBe(minuteAt(trip, 0, "21:00"));
    // 17:00 train − 20 min at the station − 25 min transfer − 15 min to collect bags.
    expect(departureTimes(trip)).toMatchObject({ day: 3, leaveHotel: minuteAt(trip, 3, "16:15") });
    expect(formatMinute(trip, 3, dayEnd(trip, 3))).toBe("16:00");
    expect(returnDeadline(trip, 3)).toBe(dayEnd(trip, 3));
    expect(returnDeadline(trip, 2)).toBeGreaterThan(minuteAt(trip, 2, "21:00"));
    const late = { ...trip, arrival: { ...trip.arrival, time: "22:30" } };
    expect(dayEnd(late, 0)).toBe(dayStart(late, 0));
    expect(tripForDay(trip, 0)).toMatchObject({ days: 1, startDate: "2026-12-24", arrival: trip.arrival });
    expect(tripForDay(trip, 0).departure).toBeUndefined();
    expect(tripForDay(trip, 3)).toMatchObject({ startDate: "2026-12-27", departure: trip.departure });
    expect(tripForDay(trip, 3).arrival).toBeUndefined();
    const booked = { ...trip, stops: [{ ...newStop("Cruise"), day: 0, fixedTime: "11:00", duration: 60 }, { ...newStop("Dinner"), day: 3, fixedTime: "16:30", duration: 60 }] };
    expect(bookingConflictDetails(booked).map((conflict) => conflict.message)).toEqual([
      expect.stringContaining("before you can start after arriving at 13:20 (about 15:05"),
      expect.stringContaining("17:00 departure"),
    ]);
  });
  it("rejects a one-day stay that departs before it arrives", () => {
    const trip = { ...newTrip(), city: "Utrecht", startDate: "2026-12-27", days: 1, arrival: { mode: "TRAIN" as const, time: "15:00", place: "Utrecht Centraal" }, departure: { mode: "TRAIN" as const, time: "14:00", place: "Utrecht Centraal" } };
    expect(tripSchema.safeParse(trip).success).toBe(false);
  });
  it("ends a direct departure day at the station instead of back at the hotel", () => {
    const base = { ...newTrip(), city: "Amsterdam", hotel: "Motel One", startDate: "2026-12-24", days: 5, timeZone: "Europe/Amsterdam", dailyStart: "08:00", dailyEnd: "21:00", returnToHotel: true };
    const trip = { ...base, departure: { mode: "TRAIN" as const, time: "11:10", place: "Amsterdam Centraal", placeId: "centraal", direct: true } };
    expect(tripSchema.safeParse(trip).success).toBe(true);
    expect(directDeparture(trip)).toBe(true);
    // At the station 20 minutes before the 11:10 train; the last leg goes there from the final visit.
    expect(formatMinute(trip, 4, dayEnd(trip, 4))).toBe("10:50");
    expect(returnDeadline(trip, 4)).toBe(minuteAt(trip, 4, "10:50"));
    expect(endpointKey(trip, 4, "hotel", "to")).toBe("departure");
    expect(endpointKey(trip, 4, "hotel", "from")).toBe("hotel");
    expect(endpointKey(trip, 3, "hotel", "to")).toBe("hotel");
    expect(endpointKey(tripForDay(trip, 4), 0, "hotel", "to")).toBe("departure");
    // Without a confirmed station, or without daily returns, it falls back to collecting bags at the hotel.
    for (const fallback of [{ ...trip, departure: { ...trip.departure, placeId: undefined } }, { ...trip, returnToHotel: false }]) {
      expect(directDeparture(fallback)).toBe(false);
      expect(formatMinute(fallback, 4, dayEnd(fallback, 4))).toBe("10:15");
    }
    // A late flight: back at the hotel by 19:59 (23:59 − 3 h − 45 min − 15 min for bags), never the usual 23:00.
    const late = { ...base, departure: { mode: "FLIGHT" as const, time: "23:59", place: "Schiphol" } };
    expect(returnDeadline(late, 4)).toBe(minuteAt(late, 4, "19:59"));
  });
});

describe("planning key", () => {
  it("matches a city to its plan right after the first plan, when the planning settings come last", () => {
    // The planning dialog adds `planning` to a city that had none; the accepted plan keeps the schema's own order.
    const city = { ...newTrip(), city: "Hyderabad", hotel: "Taj Krishna", timeZone: "Asia/Kolkata", stops: [{ ...newStop("Charminar"), placeId: "g-charminar" }] };
    const planned = { ...city, planning: { mode: "AUTO" as const, goal: "TRAVEL" as const, maxWalkMinutes: null, maxStopsPerDay: 25, transitPreference: "DEFAULT" as const } };
    const accepted = persistedPlan({ generatedAt: "2026-10-16T06:00:00Z", warnings: [], omitted: [], days: [] }, planned).snapshot!.trip;
    expect(Object.keys(accepted)).not.toEqual(Object.keys(planned));
    expect(planningKey(accepted)).toBe(planningKey(planned));
  });

  it("still tells a real change and ignores notes", () => {
    const city = { ...newTrip(), city: "Hyderabad", hotel: "Taj Krishna", timeZone: "Asia/Kolkata", stops: [newStop("Charminar")] };
    expect(planningKey({ ...city, stops: [{ ...city.stops[0], duration: 90 }] })).not.toBe(planningKey(city));
    expect(planningKey({ ...city, stops: [{ ...city.stops[0], note: "Go early" }] })).toBe(planningKey(city));
  });

  it("keeps an itinerary current when a place it includes becomes a must-see, but not one it left out", () => {
    const [charminar, golconda] = [newStop("Charminar"), { ...newStop("Golconda Fort"), optional: true }];
    const city = { ...newTrip(), city: "Hyderabad", hotel: "Taj Krishna", timeZone: "Asia/Kolkata", stops: [charminar, golconda] };
    const planned = plannedStopIds([{ visits: [{ stopId: charminar.id }] }]);
    const mustSee = (id: string) => ({ ...city, stops: city.stops.map((stop) => stop.id === id ? { ...stop, priority: 5 } : stop) });
    expect(planningKey(mustSee(charminar.id), planned)).toBe(planningKey(city, planned));
    expect(planningKey(mustSee(golconda.id), planned)).not.toBe(planningKey(city, planned));
    // Anything else about an included place still counts.
    expect(planningKey({ ...city, stops: [{ ...charminar, duration: 90 }, golconda] }, planned)).not.toBe(planningKey(city, planned));
  });
});
