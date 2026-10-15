import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";
import { asJourney, type Journey } from "./journey";
import { exportFilename, exportNote, itineraryExport, itineraryHtml, itineraryIcs, itineraryRows, itineraryXlsx } from "./export";
import { minuteAt, newStop, newTrip, persistedPlan, type Place, type Schedule, type TravelEdge, type Trip } from "./trip";

const place = (id: string, name: string, address: string): Place => ({ id, name, address, location: { lat: 52.37, lng: 4.89 } });

function journey(): { journey: Journey; trip: Trip } {
  const cruise = { ...newStop("Light Festival Cruise"), placeId: "g-cruise", day: 0, fixedTime: "18:15", duration: 75, buffer: 15 };
  const sango = { ...newStop("Sango Coffee"), placeId: "g-sango", duration: 45, source: 'Coffee: pour-over, "best" in town <3 & cheap; €6', sourceUrl: "https://example.com/sango" };
  const trip: Trip = { ...newTrip(), title: "Amsterdam", city: "Amsterdam", hotel: "Motel One", hotelPlaceId: "g-hotel", startDate: "2026-12-24", days: 2, timeZone: "Europe/Amsterdam", dailyStart: "09:00", dailyEnd: "21:00", returnToHotel: true, stops: [cruise, sango] };
  const leg = (from: string, to: string, minutes: number, transit = false): TravelEdge => ({ day: 0, from, to, mode: transit ? "TRANSIT" : "WALK", minutes, meters: 1200, ...(transit ? { steps: [{ instruction: "Tram", mode: "TRANSIT", line: "Tram 5", from: "Centraal", to: "Rokin", departure: "2026-12-24T15:02:00Z" }] } : {}) });
  const start = (time: string) => minuteAt(trip, 0, time);
  const schedule: Schedule = { generatedAt: "2026-10-14T06:00:00Z", warnings: [], omitted: [], days: [
    { day: 0, date: "2026-12-24", visits: [
      { stopId: sango.id, start: start("16:00"), end: start("16:45"), leg: leg("hotel", sango.id, 20, true) },
      { stopId: cruise.id, start: start("18:15"), end: start("19:30"), leg: leg(sango.id, cruise.id, 12) },
    ], returnLeg: leg(cruise.id, "hotel", 25, true) },
    { day: 1, date: "2026-12-25", visits: [] },
  ] };
  const places = { hotel: place("g-hotel", "Motel One", "Europaboulevard 23, Amsterdam"), [sango.id]: place("g-sango", "Sango Coffee", "Spuistraat 1, Amsterdam"), [cruise.id]: place("g-cruise", "Cruise dock", "Rokin 1, Amsterdam") };
  const brussels: Trip = { ...newTrip(), city: "Brussels", startDate: "2026-12-26", days: 1, timeZone: "Europe/Brussels", stops: [newStop("Grand Place")] };
  const base = asJourney(trip, persistedPlan(schedule, trip, places));
  return { trip, journey: { ...base, title: "Amsterdam & Brussels", cities: [trip, brussels] } };
}

describe("itinerary export", () => {
  it("builds days from the accepted plan with departure, travel and return times", () => {
    const { journey: data, trip } = journey();
    const exported = itineraryExport(data, Temporal.Instant.from("2026-10-14T08:00:00Z"));
    const [amsterdam, brussels] = exported.cities;
    expect(amsterdam).toMatchObject({ city: "Amsterdam", hotel: "Motel One", planned: true, outOfDate: false, startDate: "2026-12-24", endDate: "2026-12-25" });
    expect(amsterdam.days).toHaveLength(1);
    expect(amsterdam.days[0]).toMatchObject({ label: "Day 1 · Thu 24 Dec", leave: "15:40", back: { time: "19:55" } });
    expect(amsterdam.days[0].visits.map((visit) => [visit.start, visit.end, visit.name, visit.booked])).toEqual([["16:00", "16:45", "Sango Coffee", false], ["18:15", "19:30", "Light Festival Cruise", true]]);
    expect(amsterdam.days[0].visits[0].travel).toMatchObject({ mode: "Transit", minutes: 20, lines: ["Tram 5 Centraal → Rokin (16:02)"] });
    // Google gives timetable times in UTC; the export shows the city's clock.
    expect(amsterdam.days[0].visits[0].mapsUrl).toContain("query_place_id=g-sango");
    expect(brussels).toMatchObject({ planned: false, days: [], notScheduled: [{ name: "Grand Place" }] });
    const edited = { ...data, cities: [{ ...trip, dailyEnd: "20:00" }, data.cities[1]] };
    expect(itineraryExport(edited).cities[0].outOfDate).toBe(true);
    expect(exportFilename(exported, "xlsx")).toBe("amsterdam-brussels.xlsx");
  });

  it("drops the original itinerary's clock times from notes", () => {
    expect(exportNote("17:50 – 18:35 | Toki Specialty Coffee\nWalk 8 mins into Jordaan for coffee at Toki (45 mins)")).toBe("Walk 8 mins into Jordaan for coffee at Toki (45 mins)");
    expect(exportNote("Walk 5 mins to the Nine Little Streets\n16:55 - 17:45 | The Nine Little Streets")).toBe("Walk 5 mins to the Nine Little Streets");
    expect(exportNote("Lunch at 12:30 is busy")).toBe("Lunch at 12:30 is busy");
  });

  it("escapes notes in the printable page and links each place to Google Maps", () => {
    const page = itineraryHtml(itineraryExport(journey().journey), false);
    expect(page).toContain("&quot;best&quot; in town &lt;3 &amp; cheap");
    expect(page).not.toContain("<3 &");
    expect(page).toContain("Back at Motel One around 19:55");
    expect(page).toContain('<span class="tag">Booked</span>');
    expect(page).toContain("Not planned yet.");
    expect(page).not.toContain("window.print(), 300");
    expect(itineraryHtml(itineraryExport(journey().journey))).toContain("window.print(), 300");
  });

  it("writes a valid xlsx package with one row per visit and return", () => {
    const exported = itineraryExport(journey().journey);
    expect(itineraryRows(exported).map((row) => row[5])).toEqual(["Place", "Sango Coffee", "Light Festival Cruise", "Back to Motel One"]);
    const bytes = itineraryXlsx(exported);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = bytes.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    const count = view.getUint16(end + 10, true);
    const files: Record<string, string> = {};
    for (let offset = 0, index = 0; index < count; index++) {
      expect(view.getUint32(offset, true)).toBe(0x04034b50);
      const [size, nameLength] = [view.getUint32(offset + 18, true), view.getUint16(offset + 26, true)];
      const name = new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + nameLength));
      files[name] = new TextDecoder().decode(bytes.slice(offset + 30 + nameLength, offset + 30 + nameLength + size));
      offset += 30 + nameLength + size;
    }
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["[Content_Types].xml", "xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml"]));
    expect(files["xl/workbook.xml"]).toContain('<sheet name="Itinerary"');
    const sheet = files["xl/worksheets/sheet1.xml"];
    expect(sheet).toContain("&quot;best&quot; in town &lt;3 &amp; cheap");
    expect(sheet).toContain('<hyperlink ref="M2" r:id="rId1"/>');
    expect(files["xl/worksheets/_rels/sheet1.xml.rels"]).toContain('Target="https://www.google.com/maps/search/?api=1&amp;query=Sango+Coffee&amp;query_place_id=g-sango" TargetMode="External"');
    expect(sheet).toContain("<v>45</v>");
    expect(files["xl/worksheets/sheet2.xml"]).toContain("City not planned yet");
  });

  it("writes calendar events in UTC with escaped, folded lines", () => {
    const calendar = itineraryIcs(itineraryExport(journey().journey, Temporal.Instant.from("2026-10-14T08:00:00Z")));
    const lines = calendar.split("\r\n");
    expect(calendar.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(lines.filter((line) => line === "BEGIN:VEVENT")).toHaveLength(2);
    // 16:00 in Amsterdam in December is 15:00 UTC.
    expect(lines).toContain("DTSTART:20261224T150000Z");
    expect(lines).toContain("SUMMARY:Light Festival Cruise (booked)");
    expect(lines).toContain("LOCATION:Spuistraat 1\\, Amsterdam");
    expect(lines.every((line) => new TextEncoder().encode(line).length <= 75)).toBe(true);
    const unfolded = calendar.replace(/\r\n /g, "");
    expect(unfolded).toContain("Coffee: pour-over\\, \"best\" in town <3 & cheap\\; €6");
  });

  it("adds the arrival and departure to every format and names alternatives that share a note", () => {
    const { journey: data, trip } = journey();
    const note = "13:00 – 14:00 | Lunch\nAlbert Cuyp Market or Roopram Roti for lunch";
    const market = { ...newStop("Albert Cuyp Market"), duration: 45, alternativeGroup: "lunch", source: note };
    const roti = { ...newStop("Roopram Roti"), duration: 45, alternativeGroup: "lunch", source: note };
    const travelled: Trip = { ...trip, stops: [...trip.stops, market, roti], arrival: { mode: "FLIGHT", time: "13:20", place: "Amsterdam Schiphol", reference: "QR 273" }, departure: { mode: "TRAIN", time: "17:00", place: "Amsterdam Centraal" } };
    const snapshot = data.plans[trip.id]!.snapshot!;
    const leg = (to: string): TravelEdge => ({ day: 0, from: "hotel", to, mode: "WALK", minutes: 10, meters: 800 });
    const schedule: Schedule = { ...snapshot.schedule, days: [{ ...snapshot.schedule.days[0], visits: [{ stopId: market.id, start: minuteAt(travelled, 0, "15:15"), end: minuteAt(travelled, 0, "15:45"), leg: leg(market.id) }, { stopId: roti.id, start: minuteAt(travelled, 0, "15:55"), end: minuteAt(travelled, 0, "16:40"), leg: leg(roti.id) }, ...snapshot.schedule.days[0].visits.slice(1)] }, snapshot.schedule.days[1]] };
    const exported = itineraryExport({ ...data, cities: [travelled, data.cities[1]], plans: { ...data.plans, [trip.id]: persistedPlan(schedule, travelled, snapshot.places) } });
    const [amsterdam] = exported.cities;
    expect(amsterdam.arrival).toMatchObject({ title: "Flight QR 273 lands at Amsterdam Schiphol", time: "13:20", detail: "45 min at the airport, 45 min to Motel One; at the hotel about 14:50" });
    expect(amsterdam.departure).toMatchObject({ label: "Day 2 · Fri 25 Dec", title: "Train leaves Amsterdam Centraal at 17:00", time: "16:20" });
    expect(amsterdam.days[0].visits.slice(0, 2)).toMatchObject([
      { name: "Albert Cuyp Market", alternativeTo: ["Roopram Roti"], note: "Albert Cuyp Market or Roopram Roti for lunch" },
      { name: "Roopram Roti", alternativeTo: ["Albert Cuyp Market"], note: "Same note as Albert Cuyp Market." },
    ]);
    const page = itineraryHtml(exported, false);
    expect(page).toContain("Arrive: Flight QR 273 lands at Amsterdam Schiphol");
    expect(page.indexOf("Arrive: Flight")).toBeLessThan(page.indexOf("Albert Cuyp Market"));
    expect(page.indexOf("Leave: Train")).toBeGreaterThan(page.indexOf("Light Festival Cruise"));
    expect(page).toContain("Alternative to Roopram Roti");
    const rows = itineraryRows(exported);
    expect(rows[1].slice(0, 6)).toEqual(["Amsterdam", "2026-12-24", "Day 1 · Thu 24 Dec", "13:20", "", "Arrive: Flight QR 273 lands at Amsterdam Schiphol"]);
    expect(rows.find((row) => row[5] === "Leave: Train leaves Amsterdam Centraal at 17:00")).toBeTruthy();
    const calendar = itineraryIcs(exported).replace(/\r\n /g, "");
    // 13:20 to 14:50 in Amsterdam in December is 12:20 to 13:50 UTC.
    expect(calendar).toContain("DTSTART:20261224T122000Z\r\nDTEND:20261224T135000Z\r\nSUMMARY:Flight QR 273 lands at Amsterdam Schiphol");
    expect(calendar).toContain("SUMMARY:Train leaves Amsterdam Centraal at 17:00");
  });
  it("says where a place left out could still fit", () => {
    const { journey: data, trip } = journey();
    const rum = { ...newStop("Rum Baba"), optional: true, duration: 45 };
    const withRum: Trip = { ...trip, stops: [...trip.stops, rum] };
    const snapshot = data.plans[trip.id]!.snapshot!;
    const [sango] = snapshot.schedule.days[0].visits;
    const schedule: Schedule = { ...snapshot.schedule, omitted: [rum.id], squeezeIns: [{ stopId: rum.id, day: 0, after: sango.stopId, start: minuteAt(trip, 0, "16:55"), end: minuteAt(trip, 0, "17:40"), extraMinutes: 12 }] };
    const exported = itineraryExport({ ...data, cities: [withRum, data.cities[1]], plans: { ...data.plans, [trip.id]: persistedPlan(schedule, withRum, snapshot.places) } });
    expect(exported.cities[0].notScheduled).toEqual([{ name: "Rum Baba", fits: "Day 1 (Thu 24 Dec) after Sango Coffee, about 16:55–17:40, adding about 12 min of travel" }]);
    expect(itineraryHtml(exported, false)).toContain("Rum Baba (could fit Day 1 (Thu 24 Dec) after Sango Coffee");
  });
  it("ends a direct departure day at the station in every format", () => {
    const { journey: data, trip } = journey();
    const direct: Trip = { ...trip, departure: { mode: "TRAIN", time: "21:30", place: "Amsterdam Centraal", placeId: "g-centraal", direct: true } };
    const snapshot = data.plans[trip.id]!.snapshot!;
    const places = { ...snapshot.places, departure: place("g-centraal", "Amsterdam Centraal", "Stationsplein, Amsterdam") };
    const days = snapshot.schedule.days.map((day, index) => index === 1 ? { ...day, visits: [] } : day);
    const oneDay = { ...direct, days: 1 };
    const exported = itineraryExport({ ...data, cities: [oneDay, data.cities[1]], plans: { ...data.plans, [trip.id]: persistedPlan({ ...snapshot.schedule, days: days.slice(0, 1) }, oneDay, places) } });
    const [amsterdam] = exported.cities;
    expect(amsterdam.days[0].back).toMatchObject({ time: "19:55", to: "Amsterdam Centraal", address: "Stationsplein, Amsterdam" });
    expect(amsterdam.days[0].back!.travel.directionsUrl).toContain("destination_place_id=g-centraal");
    expect(amsterdam.departure).toMatchObject({ time: "21:10", detail: "Checked out; at Amsterdam Centraal by 21:10, 20 min before departure" });
    expect(itineraryHtml(exported, false)).toContain("At Amsterdam Centraal around 19:55");
    expect(itineraryRows(exported).map((row) => row[5])).toContain("To Amsterdam Centraal");
  });
});
