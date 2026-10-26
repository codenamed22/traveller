import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";
import { applyDayRecovery, dayMembers, keptAdded, liveCheckIsFresh, newDayProgress, pendingIds, recoveryContext, recoveryInputErrors, recoveryPlanKey, recoveryRequestSchema, remainingIds, validateDayRecovery, type RecoveryOption, type RecoveryRequest } from "./day-recovery";
import { newStop, newTrip } from "./trip";
import { solveTrip } from "./planner";
import { journeySchema } from "./journey";

function fixture(): RecoveryRequest {
  const trip = { ...newTrip(), city: "Amsterdam", hotel: "Hotel", startDate: "2026-10-13", timeZone: "UTC", dailyStart: "08:00", dailyEnd: "21:00", stops: [newStop("Coffee"), { ...newStop("Museum"), duration: 60, day: 0, fixedTime: "14:00" }, newStop("Canal")] };
  const stopIds = trip.stops.map((stop) => stop.id);
  return { trip, day: 0, stopIds, progress: newDayProgress(trip, 0, stopIds), departureAt: "2026-10-13T12:00:00Z", origin: { id: trip.stops[0].id }, permissions: { skipIds: [], minimumDurations: {} }, mode: "replan", operationId: crypto.randomUUID() };
}
const now = Temporal.Instant.from("2026-10-13T12:00:00Z");

describe("day recovery", () => {
  it("does not reinterpret actual progress after a city timezone edit", () => {
    const request = fixture();
    request.progress.completed = [{ stopId: request.stopIds[0], start: 600, end: 660 }];
    request.trip.timeZone = "Europe/Amsterdam";
    request.progress.planKey = recoveryPlanKey(request.trip, 0, request.stopIds);
    expect(recoveryInputErrors(request, now).join(" ")).toContain("Actual progress uses UTC");
    expect(request.progress.completed[0].end).toBe(660);
  });
  it("rejects stale or malformed live timestamps and excludes coordinates from saved fingerprints", () => {
    expect(liveCheckIsFresh("2026-10-13T12:00:00Z", "2026-10-13T12:10:00Z", now)).toBe(true);
    expect(liveCheckIsFresh("2026-10-13T11:57:00Z", "2026-10-13T12:10:00Z", now)).toBe(false);
    expect(liveCheckIsFresh("invalid", "invalid", now)).toBe(false);
    expect(liveCheckIsFresh("2026-10-13T12:10:00Z", "2026-10-13T12:10:00Z", now)).toBe(false);
    const request = fixture(); request.trip.hotelLocation = { lat: 52.321, lng: 4.789 };
    request.trip.stops[0].location = { lat: 52.456, lng: 4.123 };
    expect(recoveryPlanKey(request.trip, 0, request.stopIds)).not.toMatch(/52\.321|52\.456|hotelLocation|"location"/);
  });
  it("allows incomplete editor drafts to render without authorizing live requests", () => {
    const trip = newTrip();
    expect(() => newDayProgress(trip, 0, [])).not.toThrow();
    expect(recoveryRequestSchema.safeParse({ ...fixture(), trip, progress: newDayProgress(trip, 0, []) }).success).toBe(false);
  });
  it("canonicalizes client/server snapshots and preserves an undoable remainder", () => {
    const request = fixture();
    request.trip.stops[0].location = { lat: 52.1, lng: 4.1 };
    request.trip.dayGroups = [{ id: crypto.randomUUID(), name: "Amsterdam", stopIds: request.stopIds, allowedDays: [0], exclusive: true }];
    request.progress.planKey = recoveryPlanKey(request.trip, 0, request.stopIds);
    request.progress = applyDayRecovery(request.progress, { label: "Local", durations: {}, skipped: [], day: { day: 0, date: request.trip.startDate, visits: [] } });
    const parsed = recoveryRequestSchema.parse(JSON.parse(JSON.stringify(request)));
    expect(recoveryContext(parsed)).toBe(recoveryContext(request));
    expect(recoveryPlanKey(parsed.trip, 0, parsed.stopIds)).toBe(request.progress.planKey);
    expect(request.progress.undoAvailable).toBe(true);
    expect(request.progress.previousRemaining).toBeUndefined();
    const again = applyDayRecovery(request.progress, { label: "Local", durations: {}, skipped: [], day: { day: 0, date: request.trip.startDate, visits: [] } });
    expect(again.previousRemaining).toEqual(request.progress.remaining);
  });
  it("solves from the actual origin/time to the true hotel without changing the trip", async () => {
    const request = fixture();
    const original = structuredClone(request.trip);
    const stop = { ...request.trip.stops[1], day: 0 };
    const trip = { ...request.trip, days: 1, stops: [stop] };
    const travel = [{ day: 0, from: request.origin.id, to: stop.id, minutes: 15, meters: 1000, mode: "TRANSIT" as const }, { day: 0, from: stop.id, to: "hotel", minutes: 20, meters: 1000, mode: "TRANSIT" as const }];
    const schedule = await solveTrip(trip, travel, 1, { boundary: { startId: request.origin.id, startMinute: 720 } });
    expect(schedule.days[0].visits[0].start).toBe(840);
    expect(schedule.days[0].visits[0].leg.from).toBe(request.origin.id);
    expect(schedule.days[0].returnLeg?.to).toBe("hotel");
    expect(request.trip).toEqual(original);
    const empty = await solveTrip({ ...trip, stops: [] }, [{ ...travel[1], from: request.origin.id }], 1, { boundary: { startId: request.origin.id, startMinute: 720 } });
    expect(empty.days[0].returnLeg?.minutes).toBe(20);
  });
  it("round-trips progress in Journey without adding Google route content", () => {
    const request = fixture();
    const journey = { id: crypto.randomUUID(), title: "Trip", cities: [request.trip], plans: {}, execution: { [request.trip.id]: { [request.progress.date]: request.progress } } };
    expect(journeySchema.parse(JSON.parse(JSON.stringify(journey))).execution).toEqual(journey.execution);
    expect(journeySchema.parse({ ...journey, execution: undefined }).execution).toBeUndefined();
  });
  it("keeps actual overruns separate from preferences and never infers completed visits", () => {
    const request = fixture();
    expect(remainingIds(request.stopIds, request.progress)).toEqual(request.stopIds);
    request.progress.completed.push({ stopId: request.stopIds[0], start: 600, end: 675 });
    request.progress.skipped.push(request.stopIds[2]);
    expect(recoveryInputErrors(request, now)).toEqual([]);
    expect(remainingIds(request.stopIds, request.progress)).toEqual([request.stopIds[1]]);
    expect(request.trip.stops[0].duration).toBe(45);
  });
  it("protects booking buffers and requires explicit acknowledgement of a missed booking", () => {
    const request = fixture();
    request.departureAt = "2026-10-13T14:00:00Z";
    expect(recoveryInputErrors(request, now).join(" ")).toContain("booking can no longer");
    request.progress.skipped.push(request.stopIds[1]);
    expect(recoveryInputErrors(request, now).join(" ")).toContain("acknowledge");
    request.progress.missedBookings.push(request.stopIds[1]);
    expect(recoveryInputErrors(request, now)).toEqual([]);
  });
  it("validates approved shortening and hotel return without rewriting actual history", () => {
    const request = fixture();
    request.progress.completed.push({ stopId: request.stopIds[0], start: 600, end: 675 });
    request.permissions.skipIds = [request.stopIds[2]];
    const option: RecoveryOption = { label: "Skip Canal", durations: { [request.stopIds[1]]: 60 }, skipped: [request.stopIds[2]], day: { day: 0, date: request.trip.startDate, visits: [{ stopId: request.stopIds[1], start: 840, end: 900, leg: { day: 0, from: "current", to: request.stopIds[1], minutes: 20, meters: 1000, mode: "TRANSIT" } }], returnLeg: { day: 0, from: request.stopIds[1], to: "hotel", minutes: 30, meters: 1000, mode: "TRANSIT" } } };
    expect(validateDayRecovery(request, option)).toEqual([]);
    const applied = applyDayRecovery(request.progress, option);
    expect(applied.completed).toEqual(request.progress.completed);
    expect(applied.version).toBe(1);
    expect(request.progress.remaining).toBeUndefined();
    option.day.returnLeg!.assumed = true;
    expect(validateDayRecovery(request, option).join(" ")).toContain("actual date");
  });
  it("fits in a place from spare time, keeps it with the day once added, and lets go of it on undo", () => {
    const request = fixture();
    const park = { ...newStop("Park"), optional: true, spare: true as const, duration: 30 };
    const before = recoveryPlanKey(request.trip, 0, request.stopIds);
    request.trip.stops.push(park);
    // Keeping a place for spare time leaves today's progress as it is.
    expect(recoveryPlanKey(request.trip, 0, request.stopIds)).toBe(before);
    request.add = park.id;
    expect(recoveryInputErrors(request, now)).toEqual([]);
    expect(pendingIds(request)).toEqual([...request.stopIds, park.id]);
    expect(recoveryInputErrors({ ...request, add: request.stopIds[1] }, now)).toContain("Only a place not planned for today can be added.");
    expect(recoveryInputErrors({ ...request, add: crypto.randomUUID() }, now)).toContain("Only a place not planned for today can be added.");
    park.day = 1;
    expect(recoveryInputErrors(request, now)).toContain("Only a place not planned for today can be added.");
    park.day = null;
    const [coffee, museum, canal] = request.stopIds;
    const leg = (from: string, to: string) => ({ day: 0, from, to, minutes: 10, meters: 800, mode: "WALK" as const });
    const option: RecoveryOption = { label: "Keep every visit", skipped: [], durations: { [coffee]: 45, [park.id]: 30, [museum]: 60, [canal]: 45 }, day: { day: 0, date: request.trip.startDate, visits: [
      { stopId: coffee, start: 730, end: 775, leg: leg("current", coffee) },
      { stopId: park.id, start: 785, end: 815, leg: leg(coffee, park.id) },
      { stopId: museum, start: 840, end: 900, leg: leg(park.id, museum) },
      { stopId: canal, start: 910, end: 955, leg: leg(museum, canal) },
    ], returnLeg: leg(canal, "hotel") } };
    expect(validateDayRecovery(request, option)).toEqual([]);
    // Leaving the added place out is a missing visit unless skipping it was approved.
    const without = { ...option, day: { ...option.day, visits: option.day.visits.filter((visit) => visit.stopId !== park.id).map((visit, index, all) => ({ ...visit, leg: leg(index ? all[index - 1].stopId : "current", visit.stopId) })) } };
    expect(validateDayRecovery(request, without)).toContain("A remaining visit is missing.");
    const applied = applyDayRecovery(request.progress, option, undefined, park.id);
    expect(applied.added).toEqual([park.id]);
    expect(dayMembers(request.stopIds, applied)).toEqual([...request.stopIds, park.id]);
    // Once added, it's part of the day: a later replan needs no `add`, and adding it again is refused.
    const later = { ...request, add: undefined, progress: applied };
    expect(recoveryInputErrors(later, now)).toEqual([]);
    expect(pendingIds(later)).toContain(park.id);
    expect(recoveryInputErrors({ ...later, add: park.id }, now)).toContain("Only a place not planned for today can be added.");
    // Undo goes back to the plan without it; a visit done there keeps it.
    expect(keptAdded(applied, applied.previousRemaining)).toEqual({ added: undefined });
    expect(keptAdded({ ...applied, completed: [{ stopId: park.id, start: 785, end: 815 }] }, undefined)).toEqual({ added: [park.id] });
    expect(applyDayRecovery(request.progress, without, undefined, park.id).added).toBeUndefined();
  });
  it("requires a real direct hotel return even with no pending visits", () => {
    const request = fixture();
    request.progress.skipped = [...request.stopIds];
    request.progress.missedBookings = [request.stopIds[1]];
    const option: RecoveryOption = { label: "Return", durations: {}, skipped: [], day: { day: 0, date: request.trip.startDate, visits: [] } };
    expect(validateDayRecovery(request, option)).not.toEqual([]);
    option.day.returnLeg = { day: 0, from: "current", to: "hotel", minutes: 20, meters: 1000, mode: "TRANSIT" };
    expect(validateDayRecovery(request, option)).toEqual([]);
  });
});