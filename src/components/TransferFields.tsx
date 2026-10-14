"use client";

import { Temporal } from "@js-temporal/polyfill";
import { Bus, Car, Check, MapPin, Plane, Search, TrainFront } from "lucide-react";
import { arrivalTimes, dayEnd, dayStart, departureTimes, directDeparture, formatMinute, minuteAt, transferDefaults, tripDate, type Transfer, type Trip } from "@/lib/trip";

type Kind = "arrival" | "departure";
const modes: { value: Transfer["mode"]; label: string }[] = [{ value: "FLIGHT", label: "Flight" }, { value: "TRAIN", label: "Train" }, { value: "BUS", label: "Bus or coach" }, { value: "CAR", label: "Car" }, { value: "OTHER", label: "Other" }];
const hub: Record<Transfer["mode"], string> = { FLIGHT: "airport", TRAIN: "station", BUS: "station", CAR: "parking", OTHER: "terminal" };
const bufferLabel = (kind: Kind, mode: Transfer["mode"]) => mode === "CAR" ? kind === "arrival" ? "Parking (min)" : "Loading (min)" : kind === "arrival" ? mode === "FLIGHT" ? "Immigration & bags (min)" : `Leaving the ${hub[mode]} (min)` : mode === "FLIGHT" ? "At the airport before (min)" : `At the ${hub[mode]} before (min)`;
const placeholder: Record<Transfer["mode"], string> = { FLIGHT: "e.g. Amsterdam Schiphol", TRAIN: "e.g. Amsterdam Centraal", BUS: "e.g. Sloterdijk bus station", CAR: "e.g. Parking garage", OTHER: "Where you arrive" };
const reference: Record<Transfer["mode"], string> = { FLIGHT: "e.g. QR 273", TRAIN: "e.g. Eurostar 9114", BUS: "e.g. FlixBus N800", CAR: "", OTHER: "Booking reference" };
const dateLabel = (date: string) => Temporal.PlainDate.from(date).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short" });

// How the arrival or departure shapes the day: the first visit can start once you are settled at the hotel, and the last
// day ends in time to collect bags and get to the airport or station.
export function transferSummary(trip: Trip, kind: Kind) {
  try {
    if (kind === "arrival") {
      const times = arrivalTimes(trip);
      if (!times) return "";
      const steps = `${trip.arrival!.mode === "CAR" ? "arrive" : trip.arrival!.mode === "FLIGHT" ? "lands" : "arrives"} ${trip.arrival!.time}, ${times.buffer} min ${trip.arrival!.mode === "CAR" ? "parking" : `at the ${hub[trip.arrival!.mode]}`}, ${times.transfer} min to the hotel, ${transferDefaults.hotelMinutes} min to drop bags`;
      const date = dateLabel(tripDate(trip, 0));
      if (dayEnd(trip, 0) <= dayStart(trip, 0)) return `No time for visits on ${date} (${steps}).`;
      return times.ready > minuteAt(trip, 0, trip.dailyStart) ? `Sightseeing starts about ${formatMinute(trip, 0, dayStart(trip, 0))} on ${date} (${steps}).` : `Arrives before your day starts on ${date} (${steps}).`;
    }
    const times = departureTimes(trip);
    if (!times) return "";
    const date = dateLabel(tripDate(trip, times.day));
    const where = trip.departure!.place || `the ${hub[trip.departure!.mode]}`;
    if (trip.departure!.direct && !trip.departure!.placeId) return `Confirm ${where} on the map to plan the last leg straight there.`;
    if (trip.departure!.direct && !trip.returnToHotel) return `Turn on "Return to hotel each day" to plan the last leg to ${where}.`;
    if (times.direct) return dayEnd(trip, times.day) <= dayStart(trip, times.day) ? `No time for visits on ${date}.` : `Check out in the morning; the last visit on ${date} is planned so you reach ${where} by ${formatMinute(trip, times.day, times.end)}, ${times.buffer} min before ${trip.departure!.time}.`;
    const steps = `back at the hotel for bags, leave ${formatMinute(trip, times.day, times.leaveHotel)}, ${times.transfer} min to the ${hub[trip.departure!.mode]}, ${times.buffer} min there before ${trip.departure!.time}`;
    if (dayEnd(trip, times.day) <= dayStart(trip, times.day)) return `No time for visits on ${date} (${steps}).`;
    return times.backAtHotel < minuteAt(trip, times.day, trip.dailyEnd) ? `Visits end about ${formatMinute(trip, times.day, dayEnd(trip, times.day))} on ${date} (${steps}).` : `Leaves after your day ends on ${date} (${steps}).`;
  } catch {
    return "";
  }
}

export function TransferFields({ trip, kind, onChange, onFind }: { trip: Trip; kind: Kind; onChange: (transfer: Transfer | undefined) => void; onFind?: () => void }) {
  const transfer = trip[kind];
  const defaults = transferDefaults[kind];
  const patch = (next: Partial<Transfer>) => transfer && onChange({ ...transfer, ...next });
  const minutes = (value: string) => value === "" ? undefined : Math.min(360, Math.max(0, Math.round(Number(value))));
  const title = kind === "arrival" ? "Arriving" : "Leaving";
  return <fieldset className="transfer-fields">
    <legend>{title}{kind === "departure" && trip.days > 1 ? ` on day ${trip.days}` : ""}</legend>
    <label className="field">{kind === "arrival" ? "How you arrive" : "How you leave"}<select aria-label={`${title} by`} value={transfer?.mode ?? ""} onChange={(event) => {
      const mode = event.target.value as Transfer["mode"] | "";
      if (!mode) return onChange(undefined);
      onChange(transfer ? { ...transfer, mode } : { mode, time: kind === "arrival" ? "12:00" : "18:00", place: "" });
    }}><option value="">{kind === "arrival" ? "Already here, use the day start" : "Leaving after the day ends"}</option>{modes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}</select></label>
    {transfer && <>
      <div className="form-grid">
        <label className="field">{kind === "arrival" ? transfer.mode === "FLIGHT" ? "Lands" : "Arrives" : transfer.mode === "FLIGHT" ? "Takes off" : "Departs"}<input type="time" value={transfer.time} onChange={(event) => { if (event.target.value) patch({ time: event.target.value }); }} /></label>
        {transfer.mode !== "CAR" && <label className="field">{transfer.mode === "FLIGHT" ? "Flight" : "Reference"}<input value={transfer.reference ?? ""} maxLength={100} placeholder={reference[transfer.mode]} onChange={(event) => patch({ reference: event.target.value || undefined })} /></label>}
      </div>
      <label className="field">{transfer.mode === "FLIGHT" ? "Airport" : transfer.mode === "CAR" ? "From" : "Station or stop"}<div className="input-with-action"><MapPin size={15} /><input value={transfer.place} maxLength={200} placeholder={placeholder[transfer.mode]} onChange={(event) => patch({ place: event.target.value, placeId: undefined })} /><button type="button" title={transfer.placeId ? "Confirmed on the map; search again" : "Find on map"} aria-label={`Find ${transfer.mode === "FLIGHT" ? "airport" : "station"} on map`} disabled={!onFind} onClick={onFind}>{transfer.placeId ? <Check size={17} /> : <Search size={17} />}</button></div></label>
      {kind === "departure" && transfer.mode !== "CAR" && <label className="checkbox"><input type="checkbox" checked={Boolean(transfer.direct)} onChange={(event) => patch({ direct: event.target.checked || undefined })} />Check out in the morning and go straight there from the last visit</label>}
      <div className={directDeparture(trip) && kind === "departure" ? "" : "form-grid"}>
        <label className="field">{bufferLabel(kind, transfer.mode)}<input type="number" min={0} max={360} step={5} value={transfer.bufferMinutes ?? ""} placeholder={String(defaults.buffer[transfer.mode])} onChange={(event) => patch({ bufferMinutes: minutes(event.target.value) })} /></label>
        {!(directDeparture(trip) && kind === "departure") && <label className="field">{kind === "arrival" ? "To the hotel (min)" : `Hotel to ${hub[transfer.mode]} (min)`}<input type="number" min={0} max={360} step={5} value={transfer.transferMinutes ?? ""} placeholder={String(defaults.transfer[transfer.mode])} onChange={(event) => patch({ transferMinutes: minutes(event.target.value) })} /></label>}
      </div>
      <p className="quiet" role="status">{transferSummary(trip, kind)}</p>
    </>}
  </fieldset>;
}

const icons = { FLIGHT: Plane, TRAIN: TrainFront, BUS: Bus, CAR: Car, OTHER: MapPin };

// The itinerary's arrival row on day 1 and departure row on the last day.
export function TransferLine({ trip, kind }: { trip: Trip; kind: Kind }) {
  const transfer = trip[kind];
  if (!transfer) return null;
  const Icon = icons[transfer.mode];
  const where = transfer.place || `the ${hub[transfer.mode]}`;
  const label = [transfer.reference, modes.find((mode) => mode.value === transfer.mode)?.label].filter(Boolean)[0];
  let detail = "";
  try {
    if (kind === "arrival") { const times = arrivalTimes(trip)!; detail = `At ${trip.hotel || "the hotel"} about ${formatMinute(trip, 0, times.atHotel)}`; }
    else { const times = departureTimes(trip)!; detail = times.direct ? `Checked out; at ${where} by ${formatMinute(trip, times.day, times.end)}` : `Leave ${trip.hotel || "the hotel"} ${formatMinute(trip, times.day, times.leaveHotel)} · ${times.transfer} min to ${where}`; }
  } catch { /* An ambiguous local time is reported by the planner. */ }
  return <div className={`itinerary-start transfer-line ${kind}`} aria-label={kind === "arrival" ? "Arrival" : "Departure"}>
    <span className="hotel-marker small"><Icon size={15} /></span>
    <div><strong>{kind === "arrival" ? `${transfer.mode === "FLIGHT" ? "Land" : "Arrive"} at ${where} ${transfer.time}` : `${label} ${transfer.mode === "FLIGHT" ? "takes off" : "leaves"} ${where} ${transfer.time}`}{kind === "arrival" && transfer.reference ? ` · ${transfer.reference}` : ""}</strong><span>{detail}</span></div>
  </div>;
}
