import { describe, expect, it } from "vitest";
import { createJourney, duplicateJourney, journeySchema } from "./journey";
import { suggestedCard, suggestedTransitApp, transitApp, uberUrl, withTransitApp, withTransportCard } from "./transport";
import type { Place, RouteLeg } from "./trip";

const place = (id: string, name: string, lat: number, lng: number): Place => ({ id, name, address: `${name}, Paris`, location: { lat, lng } });
const places = { hotel: place("g-hotel", "Hôtel & Spa", 48.876, 2.357), arrival: place("g-cdg", "Charles de Gaulle Airport", 49.009, 2.547), departure: place("g-nord", "Gare du Nord", 48.880, 2.355) };
const taxi: RouteLeg = { day: 2, from: "hotel", to: "arrival", mode: "DRIVE", minutes: 25, meters: 27_200 };

describe("public transport apps", () => {
  it("knows each city's own app, by its name in any common form", () => {
    expect(suggestedTransitApp("Paris")).toEqual({ name: "Bonjour RATP", url: "https://apps.apple.com/app/id507107090" });
    expect(suggestedTransitApp("Amsterdam, Netherlands")?.name).toBe("GVB");
    expect(suggestedTransitApp("Bruxelles")?.name).toBe("STIB-MIVB");
    expect(suggestedTransitApp("Lyon")).toBeNull();
  });

  it("prefers the traveller's own app, and leaves an empty setting out", () => {
    const journey = createJourney("Winter", "2026-12-24", [{ city: "Paris", days: 2, startDate: null, timeZone: "Europe/Paris" }]);
    const paris = journey.cities[0];
    expect(transitApp(paris)?.name).toBe("Bonjour RATP");
    const own = withTransitApp(undefined, paris.id, { name: "", url: "https://www.iledefrance-mobilites.fr/" });
    expect(transitApp(paris, own)).toEqual({ name: "Transport app", url: "https://www.iledefrance-mobilites.fr/" });
    // A name typed before the link keeps the city's app until there is one.
    expect(transitApp(paris, withTransitApp(undefined, paris.id, { name: "IDFM", url: "" }))?.name).toBe("Bonjour RATP");
    expect(withTransitApp(own, paris.id, { name: " ", url: "" })).toBeUndefined();
  });

  it("only saves an https link, and keeps the app in a copy of the trip", () => {
    const journey = createJourney("Winter", "2026-12-24", [{ city: "Paris", days: 2, startDate: null, timeZone: "Europe/Paris" }]);
    const id = journey.cities[0].id;
    expect(journeySchema.safeParse({ ...journey, transport: { [id]: { app: { name: "IDFM", url: "http://example.com" } } } }).error?.issues[0].message).toBe("Use an https link for the transport app.");
    const kept = journeySchema.parse({ ...journey, transport: { [id]: { app: { name: "IDFM", url: "https://example.com/app" } } } });
    expect(duplicateJourney(kept).transport).toEqual(kept.transport);
  });

  it("keeps the card in a copy of the trip, without what was recorded or looked up for it", () => {
    const journey = createJourney("Winter", "2026-12-24", [{ city: "Paris", days: 2, startDate: null, timeZone: "Europe/Paris" }]);
    const id = journey.cities[0].id;
    const card = suggestedCard("Paris, France");
    // Paris is counted in euros: a metro ride and a bus ride cost differently.
    expect(card).toEqual({ kind: "balance", name: "Navigo Easy", currency: "EUR", travellers: 1, ridePrice: 2.55, dayPass: 12.3, airportPrice: 14 });
    expect(suggestedCard("Amsterdam")).toMatchObject({ kind: "tap", dailyCap: 10.5 });
    expect(suggestedCard("Lyon")).toMatchObject({ kind: "tickets", name: "", ridePrice: 0 });
    const fares = { "2026-12-24|back": { from: "x", to: "hotel", lines: "8", amount: 2.55, currency: "EUR", at: 1 } };
    const kept = journeySchema.parse({ ...journey, transport: { [id]: { card, entries: [{ id: crypto.randomUUID(), at: 1, kind: "ride" }], fares } } });
    expect(duplicateJourney(kept).transport).toEqual({ [id]: { card } });
    expect(withTransportCard(kept.transport, id, undefined)).toBeUndefined();
    expect(journeySchema.safeParse({ ...journey, transport: { [id]: { card: { ...card, currency: "eu" } } } }).error?.issues[0].message).toBe("Use a three-letter currency code, such as EUR.");
  });
});

describe("Uber links", () => {
  it("drops off at the leg's end, picking up as planned or wherever the phone is", () => {
    const planned = new URL(uberUrl(taxi, places)!);
    expect(planned.origin + planned.pathname).toBe("https://m.uber.com/ul/");
    expect(planned.searchParams.get("action")).toBe("setPickup");
    expect(planned.searchParams.get("pickup[latitude]")).toBe("48.876");
    expect(planned.searchParams.get("pickup[nickname]")).toBe("Hôtel & Spa");
    expect(planned.searchParams.get("dropoff[longitude]")).toBe("2.547");
    expect(planned.searchParams.get("dropoff[formatted_address]")).toBe("Charles de Gaulle Airport, Paris");
    const here = new URL(uberUrl(taxi, places, { fromHere: true })!);
    expect(here.searchParams.get("pickup")).toBe("my_location");
    expect(here.searchParams.has("pickup[latitude]")).toBe(false);
    // The last leg of a direct departure day ends at the station.
    const station = new URL(uberUrl({ ...taxi, mode: "TRANSIT", from: "g-louvre", to: "hotel" }, { ...places, "g-louvre": place("g-l", "Louvre", 48.861, 2.336) }, { toDeparture: true })!);
    expect(station.searchParams.get("dropoff[nickname]")).toBe("Gare du Nord");
    expect(uberUrl({ ...taxi, to: "unknown" }, places)).toBeNull();
  });
});
