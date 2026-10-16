import { arrivalTimes, departureTimes, formatMinute, instantForMinute, type Transfer, type Trip } from "./trip";

type Kind = "arrival" | "departure";
export const transferModes: { value: Transfer["mode"]; label: string }[] = [{ value: "FLIGHT", label: "Flight" }, { value: "TRAIN", label: "Train" }, { value: "BUS", label: "Bus or coach" }, { value: "CAR", label: "Car" }, { value: "OTHER", label: "Other" }];
export const transferHub: Record<Transfer["mode"], string> = { FLIGHT: "airport", TRAIN: "station", BUS: "station", CAR: "parking", OTHER: "terminal" };

// The arrival or departure as one line of the day: when it lands or leaves, and when that puts you at or away from the hotel.
export function transferLineText(trip: Trip, kind: Kind) {
  const transfer = trip[kind];
  if (!transfer) return null;
  const where = transfer.place || `the ${transferHub[transfer.mode]}`;
  const label = [transfer.reference, transferModes.find((mode) => mode.value === transfer.mode)?.label].filter(Boolean)[0];
  let detail = "";
  try {
    if (kind === "arrival") { const times = arrivalTimes(trip)!; detail = `At ${trip.hotel || "the hotel"} about ${formatMinute(trip, 0, times.atHotel)}`; }
    else { const times = departureTimes(trip)!; detail = times.direct ? `Checked out; at ${where} by ${formatMinute(trip, times.day, times.end)}` : `Leave ${trip.hotel || "the hotel"} ${formatMinute(trip, times.day, times.leaveHotel)} · ${times.transfer} min to ${where}`; }
  } catch { /* An ambiguous local time is reported by the planner. */ }
  const title = kind === "arrival" ? `${transfer.mode === "FLIGHT" ? "Land" : "Arrive"} at ${where} ${transfer.time}${transfer.reference ? ` · ${transfer.reference}` : ""}` : `${label} ${transfer.mode === "FLIGHT" ? "takes off" : "leaves"} ${where} ${transfer.time}`;
  return { mode: transfer.mode, title, detail };
}

// When the flight or train lands or leaves, in epoch milliseconds.
export function transferAt(trip: Trip, kind: Kind) {
  try {
    const times = kind === "arrival" ? arrivalTimes(trip) : departureTimes(trip);
    if (!times) return undefined;
    return instantForMinute(trip, kind === "arrival" ? 0 : trip.days - 1, "arrive" in times ? times.arrive : times.depart).epochMilliseconds;
  } catch { return undefined; }
}
