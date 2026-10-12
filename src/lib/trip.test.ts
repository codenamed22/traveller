import { describe, expect, it } from "vitest";
import { changeStartDate, formatMinute, minuteAt, newStop, newTrip, stopSchema, tripSchema, tripDate } from "./trip";

describe("trip constraints", () => {
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