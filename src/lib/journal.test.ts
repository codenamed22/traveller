import { describe, expect, it } from "vitest";
import { duplicateJourney, journeySchema, type Journey } from "./journey";
import { applyJournalAction, journalEntry, withJournal } from "./journal";
import { newStop, newTrip } from "./trip";

function fixture() {
  const fort = newStop("Golconda Fort");
  const city = { ...newTrip(), city: "Hyderabad", hotel: "Taj Krishna", startDate: "2026-11-20", days: 2, timeZone: "Asia/Kolkata", stops: [fort] };
  const journey: Journey = { id: crypto.randomUUID(), title: "Hyderabad", cities: [city], plans: {} };
  return { journey, city, fort };
}

describe("journal", () => {
  it("keeps a note and favourites for each day, leaving out empty ones", () => {
    const { journey, city, fort } = fixture();
    const save = (current: Journey, action: Parameters<typeof applyJournalAction>[1]) => {
      const change = applyJournalAction(current, action);
      return { next: withJournal(current, change.cityId, change.date, change.entry), message: change.message };
    };
    const noted = save(journey, { kind: "note", cityId: city.id, day: 1, text: "Biryani at Paradise" });
    expect(noted.message).toBe("Note saved");
    expect(noted.next.journal).toEqual({ [city.id]: { "2026-11-21": { note: "Biryani at Paradise" } } });
    const loved = save(noted.next, { kind: "favourite", cityId: city.id, day: 1, stopId: fort.id, on: true });
    expect(loved.message).toBe("Golconda Fort added to favourites");
    expect(journalEntry(loved.next, city.id, "2026-11-21")).toEqual({ note: "Biryani at Paradise", favourites: [fort.id] });
    expect(journeySchema.parse(loved.next).journal).toEqual(loved.next.journal);

    const unloved = save(loved.next, { kind: "favourite", cityId: city.id, day: 1, stopId: fort.id, on: false });
    expect(unloved.message).toBe("Golconda Fort removed from favourites");
    const cleared = save(unloved.next, { kind: "note", cityId: city.id, day: 1, text: "  " });
    expect(cleared.message).toBe("Note removed");
    expect(cleared.next).not.toHaveProperty("journal");
  });

  it("refuses days and visits that aren't in the trip", () => {
    const { journey, city } = fixture();
    expect(() => applyJournalAction(journey, { kind: "note", cityId: city.id, day: 2, text: "x" })).toThrow("That day isn't in this trip.");
    expect(() => applyJournalAction(journey, { kind: "favourite", cityId: city.id, day: 0, stopId: crypto.randomUUID(), on: true })).toThrow("That visit isn't in this trip.");
  });

  it("is checked for shape only, so a removed visit doesn't stop the trip saving, and a copy leaves it out", () => {
    const { journey, city } = fixture();
    const kept = journeySchema.parse({ ...journey, journal: { [city.id]: { "2026-11-20": { favourites: [crypto.randomUUID()] } } } });
    expect(kept.journal).toBeDefined();
    expect(journeySchema.safeParse({ ...journey, journal: { [city.id]: { "2026-11-20": { note: "x".repeat(2001) } } } }).success).toBe(false);
    expect(duplicateJourney(kept)).not.toHaveProperty("journal");
  });
});
