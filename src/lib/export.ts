import { Temporal } from "@js-temporal/polyfill";
import type { Journey } from "./journey";
import { arrivalTimes, departureTimes, endpointKey, formatMinute, instantForMinute, squeezeInNote, tripDate, type Place, type Transfer, type TravelEdge, type Trip } from "./trip";

// Shareable exports of the accepted itinerary: a printable page (save as PDF), an Excel workbook and a calendar file.
// Everything is built from the saved plan snapshots, so an export never calls Google or changes the trip.

export type ExportTravel = { mode: "Walk" | "Transit"; minutes: number; km: number; lines: string[]; fare?: string; directionsUrl: string; estimated: boolean };
export type ExportVisit = { stopId: string; start: string; end: string; startInstant: string; endInstant: string; minutes: number; name: string; address: string; booked: boolean; optional: boolean; travel: ExportTravel; mapsUrl: string; note: string; sourceUrl?: string; alternativeTo?: string[] };
export type ExportDay = { day: number; date: string; label: string; leave: string; visits: ExportVisit[]; back?: { time: string; travel: ExportTravel; to?: string; address?: string } };
// Getting into or out of the city: the arrival runs until you are at the hotel, the departure from leaving the hotel.
export type ExportTransfer = { kind: "arrival" | "departure"; date: string; label: string; title: string; time: string; detail: string; place: string; startInstant: string; endInstant: string };
export type ExportCity = { arrival?: ExportTransfer; departure?: ExportTransfer; id: string; city: string; hotel: string; hotelAddress: string; startDate: string; endDate: string; planned: boolean; outOfDate: boolean; generatedAt?: string; days: ExportDay[]; notScheduled: { name: string; fits?: string }[] };
export type ItineraryExport = { title: string; cities: ExportCity[]; exportedAt: string };

const dateLabel = (date: string) => Temporal.PlainDate.from(date).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short" });

function mapsUrl(place: Place | undefined, fallback: string) {
  const url = new URL("https://www.google.com/maps/search/");
  url.searchParams.set("api", "1"); url.searchParams.set("query", place?.name ?? fallback);
  if (place?.id) url.searchParams.set("query_place_id", place.id);
  return url.toString();
}

function travel(edge: TravelEdge, places: Record<string, Place>): ExportTravel {
  const url = new URL("https://www.google.com/maps/dir/");
  const [origin, destination] = [places[edge.from], places[edge.to]];
  url.searchParams.set("api", "1"); url.searchParams.set("origin", origin?.name ?? edge.from); url.searchParams.set("destination", destination?.name ?? edge.to);
  if (origin?.id) url.searchParams.set("origin_place_id", origin.id);
  if (destination?.id) url.searchParams.set("destination_place_id", destination.id);
  url.searchParams.set("travelmode", edge.mode === "WALK" ? "walking" : "transit");
  const lines = (edge.steps ?? []).filter((step) => step.line).map((step) => `${step.line}${step.from && step.to ? ` ${step.from} → ${step.to}` : ""}${step.departure ? ` (${step.departure})` : ""}`);
  return { mode: edge.mode === "WALK" ? "Walk" : "Transit", minutes: Math.round(edge.minutes), km: Math.round(edge.meters / 100) / 10, lines, ...(edge.fare ? { fare: edge.fare } : {}), directionsUrl: url.toString(), estimated: Boolean(edge.assumed || edge.timetableDate) };
}

// Original itinerary notes keep their own clock times ("17:50 – 18:35 | Toki"); those lines would contradict the plan.
const transferName: Record<Transfer["mode"], string> = { FLIGHT: "Flight", TRAIN: "Train", BUS: "Bus", CAR: "Drive", OTHER: "Transfer" };
const transferHub: Record<Transfer["mode"], string> = { FLIGHT: "the airport", TRAIN: "the station", BUS: "the station", CAR: "parking", OTHER: "the terminal" };

function transferExport(trip: Trip, kind: "arrival" | "departure"): ExportTransfer | undefined {
  const transfer = trip[kind];
  if (!transfer) return undefined;
  try {
    const name = [transferName[transfer.mode], transfer.reference].filter(Boolean).join(" ");
    const place = transfer.place || transferHub[transfer.mode];
    const hotel = trip.hotel || "the hotel";
    if (kind === "arrival") {
      const times = arrivalTimes(trip)!;
      const date = tripDate(trip, 0);
      return { kind, date, label: `Day 1 · ${dateLabel(date)}`, title: `${name} ${transfer.mode === "FLIGHT" ? "lands at" : "arrives at"} ${place}`, time: transfer.time, place: transfer.place, detail: `${times.buffer} min at ${transferHub[transfer.mode]}, ${times.transfer} min to ${hotel}; at the hotel about ${formatMinute(trip, 0, times.atHotel)}`, startInstant: instantForMinute(trip, 0, times.arrive).toString(), endInstant: instantForMinute(trip, 0, times.atHotel).toString() };
    }
    const times = departureTimes(trip)!;
    const date = tripDate(trip, times.day);
    return { kind, date, label: `Day ${times.day + 1} · ${dateLabel(date)}`, title: `${name} ${transfer.mode === "FLIGHT" ? "takes off from" : "leaves"} ${place} at ${transfer.time}`, time: formatMinute(trip, times.day, times.direct ? times.end : times.leaveHotel), place: transfer.place, detail: times.direct ? `Checked out; at ${place} by ${formatMinute(trip, times.day, times.end)}, ${times.buffer} min before departure` : `Leave ${hotel} ${formatMinute(trip, times.day, times.leaveHotel)}: ${times.transfer} min to ${place}, ${times.buffer} min there before departure`, startInstant: instantForMinute(trip, times.day, times.direct ? times.end : times.leaveHotel).toString(), endInstant: instantForMinute(trip, times.day, times.depart).toString() };
  } catch {
    return undefined;
  }
}

export function exportNote(source: string) {
  return source.split(/\r?\n/).filter((line) => !/^\s*\d{1,2}[:.]\d{2}\s*[–—-]\s*\d{1,2}[:.]\d{2}\s*\|/.test(line)).join("\n").trim();
}

export function travelLabel(leg: ExportTravel) {
  return `${leg.mode} ${leg.minutes} min${leg.mode === "Walk" ? ` · ${leg.km} km` : ""}${leg.lines.length ? ` · ${leg.lines.join("; ")}` : ""}${leg.fare ? ` · ${leg.fare}` : ""}`;
}

// Uses each city's accepted plan; a plan made before the city's latest edits is flagged as out of date.
export function itineraryExport(journey: Journey, now = Temporal.Now.instant()): ItineraryExport {
  return {
    title: journey.title, exportedAt: now.toString(),
    cities: journey.cities.map((current): ExportCity => {
      const snapshot = journey.plans[current.id]?.snapshot;
      const trip: Trip = snapshot?.trip ?? current;
      const places = snapshot?.places ?? {};
      const name = (id: string) => trip.stops.find((stop) => stop.id === id)?.name ?? "Removed place";
      const base = { ...(transferExport(trip, "arrival") ? { arrival: transferExport(trip, "arrival") } : {}), ...(transferExport(trip, "departure") ? { departure: transferExport(trip, "departure") } : {}), id: current.id, city: current.city || current.title, hotel: trip.hotel, hotelAddress: places.hotel?.address ?? "", startDate: current.startDate, endDate: tripDate(current, current.days - 1) };
      if (!snapshot) return { ...base, planned: false, outOfDate: false, days: [], notScheduled: current.stops.map((stop) => ({ name: stop.name })) };
      // Alternatives imported from one itinerary line share its note; name the pairing instead of repeating the note.
      const scheduled = snapshot.schedule.days.flatMap((day) => day.visits.map((visit) => visit.stopId));
      const alternatives = (id: string) => { const group = trip.stops.find((stop) => stop.id === id)?.alternativeGroup; return group ? trip.stops.filter((stop) => stop.id !== id && stop.alternativeGroup === group && scheduled.includes(stop.id)).map((stop) => stop.name) : []; };
      const notes = new Map<string, string>();
      const days = snapshot.schedule.days.filter((day) => day.visits.length).sort((left, right) => left.day - right.day).map((day): ExportDay => {
        const visits = day.visits.map((visit): ExportVisit => {
          const stop = trip.stops.find((candidate) => candidate.id === visit.stopId);
          return {
            stopId: visit.stopId, start: formatMinute(trip, day.day, visit.start), end: formatMinute(trip, day.day, visit.end),
            startInstant: instantForMinute(trip, day.day, visit.start).toString(), endInstant: instantForMinute(trip, day.day, visit.end).toString(),
            minutes: Math.round(visit.end - visit.start), name: name(visit.stopId), address: places[visit.stopId]?.address ?? "",
            booked: Boolean(stop?.fixedTime), optional: Boolean(stop?.optional), travel: travel(visit.leg, places), mapsUrl: mapsUrl(places[visit.stopId], name(visit.stopId)),
            note: exportNote(stop?.source ?? ""), ...(stop?.sourceUrl ? { sourceUrl: stop.sourceUrl } : {}),
            ...(alternatives(visit.stopId).length ? { alternativeTo: alternatives(visit.stopId) } : {}),
          };
        });
        for (const visit of visits) {
          const earlier = visit.note && notes.get(visit.note);
          if (earlier) visit.note = `Same note as ${earlier}.`; else if (visit.note) notes.set(visit.note, visit.name);
        }
        const [first, last] = [day.visits[0], day.visits.at(-1)!];
        const firstStop = trip.stops.find((stop) => stop.id === first.stopId);
        return {
          day: day.day, date: day.date, label: `Day ${day.day + 1} · ${dateLabel(day.date)}`, visits,
          // Departure for the first visit: its start, less travel and any booking's arrival buffer.
          leave: formatMinute(trip, day.day, first.start - first.leg.minutes - (firstStop?.fixedTime ? firstStop.buffer : 0)),
          // A direct departure day ends at the airport or station rather than the hotel.
          ...(day.returnLeg ? endpointKey(trip, day.day, "hotel", "to") === "departure"
            ? { back: { time: formatMinute(trip, day.day, last.end + day.returnLeg.minutes), travel: travel(day.returnLeg, { ...places, hotel: places.departure ?? places.hotel }), to: trip.departure!.place || places.departure?.name || "the station", address: places.departure?.address ?? "" } }
            : { back: { time: formatMinute(trip, day.day, last.end + day.returnLeg.minutes), travel: travel(day.returnLeg, places) } } : {}),
        };
      });
      const planned = new Set(snapshot.schedule.days.flatMap((day) => day.visits.map((visit) => visit.stopId)));
      return { ...base, planned: true, outOfDate: JSON.stringify(snapshot.trip) !== JSON.stringify(current), generatedAt: snapshot.schedule.generatedAt, days, notScheduled: [...snapshot.schedule.omitted.map((id) => { const fit = snapshot.schedule.squeezeIns?.find((squeeze) => squeeze.stopId === id); return { name: name(id), ...(fit ? { fits: squeezeInNote(snapshot.trip, fit) } : {}) }; }), ...current.stops.filter((stop) => !planned.has(stop.id) && !snapshot.schedule.omitted.includes(stop.id)).map((stop) => ({ name: stop.name }))] };
    }),
  };
}

export function exportFilename(data: ItineraryExport, extension: string) {
  const slug = data.title.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").toLowerCase().slice(0, 60) || "itinerary";
  return `${slug}.${extension}`;
}

// ---------- Printable page (the browser saves it as PDF) ----------

const html = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

export function itineraryHtml(data: ItineraryExport, autoPrint = true) {
  const range = (city: ExportCity) => city.startDate === city.endDate ? dateLabel(city.startDate) : `${dateLabel(city.startDate)} – ${dateLabel(city.endDate)}`;
  const leg = (travel: ExportTravel) => `<div class="leg"><span>${html(travelLabel(travel))}${travel.estimated ? " · estimated" : ""}</span> <a href="${html(travel.directionsUrl)}">Directions</a></div>`;
  const transfer = (entry: ExportTransfer) => `<p class="transfer"><span class="time">${html(entry.label.replace(/^Day \d+ · /, ""))} ${html(entry.time)}</span><span><strong>${html(entry.kind === "arrival" ? "Arrive" : "Leave")}: ${html(entry.title)}</strong><span class="muted">${html(entry.detail)}</span></span></p>`;
  const cities = data.cities.map((city) => `
    <section class="city">
      <h2>${html(city.city)} <small>${html(range(city))}</small></h2>
      <p class="meta">${city.hotel ? `Stay: <strong>${html(city.hotel)}</strong>${city.hotelAddress ? ` · ${html(city.hotelAddress)}` : ""}` : "No hotel set"}</p>
      ${city.outOfDate ? `<p class="flag">This itinerary was planned before the latest edits to ${html(city.city)}. Replan to update it.</p>` : ""}
      ${city.planned ? "" : `<p class="flag">Not planned yet.</p>`}
      ${city.arrival ? transfer(city.arrival) : ""}
      ${city.days.map((day) => `
        <article class="day">
          <h3>${html(day.label)} <small>Leave ${html(city.hotel || "the hotel")} ${html(day.leave)}</small></h3>
          <ol>${day.visits.map((visit) => `
            <li>
              ${leg(visit.travel)}
              <div class="visit">
                <span class="time">${html(visit.start)}–${html(visit.end)}</span>
                <div>
                  <strong><a href="${html(visit.mapsUrl)}">${html(visit.name)}</a></strong>${visit.booked ? ' <span class="tag">Booked</span>' : ""}${visit.optional ? ' <span class="tag light">Optional</span>' : ""}${visit.alternativeTo ? ` <span class="tag light">Alternative to ${html(visit.alternativeTo.join(", "))}</span>` : ""}
                  <span class="muted">${visit.minutes} min${visit.address ? ` · ${html(visit.address)}` : ""}</span>
                  ${visit.note ? `<p class="note">${html(visit.note)}</p>` : ""}
                </div>
              </div>
            </li>`).join("")}
          </ol>
          ${day.back ? `${leg(day.back.travel)}<p class="back">${day.back.to ? `At ${html(day.back.to)}` : `Back at ${html(city.hotel || "the hotel")}`} around ${html(day.back.time)}</p>` : ""}
        </article>`).join("")}
      ${city.departure ? transfer(city.departure) : ""}
      ${city.notScheduled.length ? `<p class="meta">${city.planned ? "Not in this plan" : "Places"}: ${city.notScheduled.map((place) => html(place.fits ? `${place.name} (could fit ${place.fits})` : place.name)).join(", ")}</p>` : ""}
    </section>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(data.title)} – itinerary</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font: 10.5pt/1.45 "IBM Plex Sans", -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1d2621; margin: 0; padding: 24px; max-width: 820px; margin-inline: auto; }
  a { color: #1f5c43; }
  h1 { font-size: 22pt; margin: 0 0 2px; }
  h2 { font-size: 15pt; margin: 22px 0 2px; padding-bottom: 4px; border-bottom: 2px solid #2d6a4f; }
  h2 small, h3 small { font-weight: 400; color: #5c6b63; font-size: 10pt; margin-left: 6px; }
  h3 { font-size: 11.5pt; margin: 16px 0 6px; }
  .meta, .muted { color: #5c6b63; }
  .muted { display: block; font-size: 9.5pt; }
  .flag { background: #fff4d6; border-left: 3px solid #c99a1f; padding: 6px 10px; }
  ol { list-style: none; margin: 0; padding: 0; }
  li, .day h3 { break-inside: avoid; page-break-inside: avoid; }
  .day h3 { break-after: avoid; page-break-after: avoid; }
  .leg { font-size: 9pt; color: #5c6b63; margin: 4px 0 4px 92px; padding-left: 10px; border-left: 2px dotted #b9c7bf; }
  .leg a { margin-left: 4px; }
  .visit { display: flex; gap: 12px; }
  .time { width: 92px; flex-shrink: 0; white-space: nowrap; font-weight: 600; font-variant-numeric: tabular-nums; }
  .visit strong a { color: inherit; text-decoration: none; }
  .tag { font-size: 8pt; background: #2d6a4f; color: #fff; border-radius: 3px; padding: 1px 5px; vertical-align: 1px; }
  .tag.light { background: #e3ece6; color: #2d6a4f; }
  .note { margin: 2px 0 0; font-size: 9pt; color: #3f4b45; white-space: pre-line; }
  .transfer { display: flex; gap: 12px; background: #eef4f0; border-radius: 5px; padding: 7px 10px; margin: 10px 0; break-inside: avoid; }
  .transfer .time { width: 120px; }
  .back { margin: 2px 0 0 104px; font-weight: 600; }
  .toolbar { position: sticky; top: 0; display: flex; gap: 10px; align-items: center; justify-content: space-between; background: #eef4f0; border-radius: 6px; padding: 10px 14px; margin-bottom: 18px; }
  .toolbar button { font: inherit; font-weight: 600; background: #2d6a4f; color: #fff; border: 0; border-radius: 5px; padding: 8px 14px; cursor: pointer; }
  footer { margin-top: 24px; font-size: 8.5pt; color: #5c6b63; }
  @media print { body { padding: 0; } .toolbar { display: none; } a { text-decoration: none; } }
</style></head><body>
<div class="toolbar"><span>Choose <strong>Save as PDF</strong> as the destination to keep a copy you can share.</span><button type="button" onclick="window.print()">Save as PDF / Print</button></div>
<h1>${html(data.title)}</h1>
<p class="meta">${data.cities.map((city) => html(city.city)).join(" · ")} · ${html(range({ ...data.cities[0], endDate: data.cities.at(-1)!.endDate }))}</p>
${cities}
<footer>Exported from Traveller on ${html(dateLabel(data.exportedAt.slice(0, 10)))}. Travel times are Google estimates at planning time; check venue hours, bookings and transit before you go.</footer>
${autoPrint ? "<script>addEventListener('load', () => setTimeout(() => window.print(), 300));</script>" : ""}
</body></html>`;
}

// ---------- Excel workbook (.xlsx written directly; no spreadsheet library needed) ----------

type Cell = string | number | { link: string; text: string } | null;

const xml = (value: string) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!);
const column = (index: number) => { let name = ""; for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + ((value - 1) % 26)) + name; return name; };

// Links are real worksheet hyperlinks (relationships), which unlike HYPERLINK() have no 255-character limit.
function sheetXml(rows: Cell[][], widths: number[]) {
  const links: { ref: string; url: string }[] = [];
  const body = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((cell, columnIndex) => {
    const ref = `${column(columnIndex)}${rowIndex + 1}`;
    if (cell === null || cell === "") return "";
    if (typeof cell === "number") return `<c r="${ref}"${rowIndex === 0 ? ' s="1"' : ""}><v>${cell}</v></c>`;
    if (typeof cell === "object") { links.push({ ref, url: cell.link }); return `<c r="${ref}" t="inlineStr" s="3"><is><t>${xml(cell.text)}</t></is></c>`; }
    return `<c r="${ref}" t="inlineStr" s="${rowIndex === 0 ? 1 : 2}"><is><t xml:space="preserve">${xml(cell)}</t></is></c>`;
  }).join("")}</row>`).join("");
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("")}</cols><sheetData>${body}</sheetData>${links.length ? `<hyperlinks>${links.map((link, index) => `<hyperlink ref="${link.ref}" r:id="rId${index + 1}"/>`).join("")}</hyperlinks>` : ""}</worksheet>`;
  const rels = links.length ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${links.map((link, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(link.url)}" TargetMode="External"/>`).join("")}</Relationships>` : null;
  return { sheet, rels };
}

export function itineraryRows(data: ItineraryExport): Cell[][] {
  const rows: Cell[][] = [["City", "Date", "Day", "Start", "End", "Place", "Booked", "Minutes", "Getting there", "Travel min", "Address", "Notes", "Map", "Directions"]];
  const transfer = (city: ExportCity, entry: ExportTransfer): Cell[] => [city.city, entry.date, entry.label, entry.time, "", `${entry.kind === "arrival" ? "Arrive" : "Leave"}: ${entry.title}`, "", null, entry.detail, null, entry.place, "", null, null];
  for (const city of data.cities) {
    if (city.arrival) rows.push(transfer(city, city.arrival));
    for (const day of city.days) {
      for (const visit of day.visits) rows.push([city.city, day.date, day.label, visit.start, visit.end, visit.name, visit.booked ? "Booked" : visit.optional ? "Optional" : "", visit.minutes, travelLabel(visit.travel), visit.travel.minutes, visit.address, [visit.alternativeTo ? `Alternative to ${visit.alternativeTo.join(", ")}.` : "", visit.note].filter(Boolean).join(" "), { link: visit.mapsUrl, text: "Map" }, { link: visit.travel.directionsUrl, text: "Directions" }]);
      if (day.back) rows.push([city.city, day.date, day.label, day.back.time, "", day.back.to ? `To ${day.back.to}` : `Back to ${city.hotel || "hotel"}`, "", null, travelLabel(day.back.travel), day.back.travel.minutes, day.back.to ? day.back.address ?? "" : city.hotelAddress, "", null, { link: day.back.travel.directionsUrl, text: "Directions" }]);
    }
    if (city.departure) rows.push(transfer(city, city.departure));
  }
  return rows;
}

export function itineraryXlsx(data: ItineraryExport): Uint8Array {
  const sheets = [
    { name: "Itinerary", rows: itineraryRows(data), widths: [14, 11, 18, 7, 7, 30, 9, 8, 40, 9, 36, 50, 8, 11] },
    { name: "Not scheduled", rows: [["City", "Place", "Reason"], ...data.cities.flatMap((city) => city.notScheduled.map((place): Cell[] => [city.city, place.name, place.fits ? `Left out of the plan; could fit ${place.fits}` : city.planned ? "Left out of the plan" : "City not planned yet"]))], widths: [16, 40, 60] },
    { name: "Stays", rows: [["City", "From", "To", "Hotel", "Address", "Plan status"], ...data.cities.map((city): Cell[] => [city.city, city.startDate, city.endDate, city.hotel, city.hotelAddress, !city.planned ? "Not planned" : city.outOfDate ? "Out of date: replan" : "Planned"])], widths: [16, 11, 11, 30, 40, 18] },
  ];
  const files: [string, string][] = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><u/><sz val="11"/><color rgb="FF1F5C43"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2D6A4F"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ...sheets.flatMap((sheet, index): [string, string][] => {
      const { sheet: content, rels } = sheetXml(sheet.rows, sheet.widths);
      return [[`xl/worksheets/sheet${index + 1}.xml`, content], ...(rels ? [[`xl/worksheets/_rels/sheet${index + 1}.xml.rels`, rels] as [string, string]] : [])];
    }),
  ];
  return zip(files.map(([name, content]) => ({ name, data: new TextEncoder().encode(content) })));
}

// Minimal ZIP writer (stored entries, no compression): enough for an Office Open XML package.
const crcTable = Array.from({ length: 256 }, (_, index) => { let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function zip(entries: { name: string; data: Uint8Array }[], modified = new Date()) {
  const time = (modified.getHours() << 11) | (modified.getMinutes() << 5) | Math.floor(modified.getSeconds() / 2);
  const date = ((modified.getFullYear() - 1980) << 9) | ((modified.getMonth() + 1) << 5) | modified.getDate();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    const local = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, time, 2], [12, date, 2], [14, crc, 4], [18, entry.data.length, 4], [22, entry.data.length, 4], [26, name.length, 2], [28, 0, 2]].forEach(([at, value, size]) => size === 4 ? local.setUint32(at, value, true) : local.setUint16(at, value, true));
    const header = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, time, 2], [14, date, 2], [16, crc, 4], [20, entry.data.length, 4], [24, entry.data.length, 4], [28, name.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, offset, 4]].forEach(([at, value, size]) => size === 4 ? header.setUint32(at, value, true) : header.setUint16(at, value, true));
    chunks.push(new Uint8Array(local.buffer), name, entry.data);
    central.push(new Uint8Array(header.buffer), name);
    offset += 30 + name.length + entry.data.length;
  }
  const size = central.reduce((total, chunk) => total + chunk.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, entries.length, 2], [10, entries.length, 2], [12, size, 4], [16, offset, 4], [20, 0, 2]].forEach(([at, value, sizeBytes]) => sizeBytes === 4 ? end.setUint32(at, value, true) : end.setUint16(at, value, true));
  const parts = [...chunks, ...central, new Uint8Array(end.buffer)];
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let position = 0;
  for (const part of parts) { output.set(part, position); position += part.length; }
  return output;
}

// ---------- Calendar (.ics) ----------

const icsText = (value: string) => value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsTime = (instant: string) => Temporal.Instant.from(instant).toString({ smallestUnit: "second" }).replace(/[-:]/g, "");
// Lines longer than 75 octets continue on the next line after a space (RFC 5545), without splitting a character.
function fold(line: string) {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = "";
  for (const character of line) {
    if (encoder.encode(current + character).length > (parts.length ? 74 : 75)) { parts.push(current); current = ""; }
    current += character;
  }
  return [...parts, current].join("\r\n ");
}

export function itineraryIcs(data: ItineraryExport) {
  const stamp = icsTime(data.exportedAt);
  const events = data.cities.flatMap((city) => city.days.flatMap((day) => day.visits.map((visit) => [
    "BEGIN:VEVENT",
    `UID:${visit.stopId}-${day.date}@traveller`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${icsTime(visit.startInstant)}`,
    `DTEND:${icsTime(visit.endInstant)}`,
    `SUMMARY:${icsText(`${visit.name}${visit.booked ? " (booked)" : ""}`)}`,
    ...(visit.address ? [`LOCATION:${icsText(visit.address)}`] : []),
    `DESCRIPTION:${icsText([`${city.city} · ${day.label}`, `Getting there: ${travelLabel(visit.travel)}`, visit.note, `Map: ${visit.mapsUrl}`, `Directions: ${visit.travel.directionsUrl}`].filter(Boolean).join("\n"))}`,
    `URL:${visit.mapsUrl}`,
    "END:VEVENT",
  ])).concat([city.arrival, city.departure].filter((entry) => entry !== undefined).map((entry) => [
    "BEGIN:VEVENT",
    `UID:${city.id}-${entry.kind}@traveller`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${icsTime(entry.startInstant)}`,
    `DTEND:${icsTime(entry.endInstant)}`,
    `SUMMARY:${icsText(entry.title)}`,
    ...(entry.place ? [`LOCATION:${icsText(entry.place)}`] : []),
    `DESCRIPTION:${icsText(`${city.city} · ${entry.label}\n${entry.detail}`)}`,
    "END:VEVENT",
  ])));
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Traveller//Itinerary export//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${icsText(data.title)}`,
    ...events.flat(), "END:VCALENDAR",
  ].map(fold).join("\r\n") + "\r\n";
}
