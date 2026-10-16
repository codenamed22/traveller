"use client";

import type { Place, Stop, Trip, VisitKind, VisitSlot } from "@/lib/trip";
import { describeTiming, kindLabels, slotLabels, timingSourceLabels, visitTiming, type AlternativeGroup } from "@/lib/visit-slots";

type Props = { trip: Trip; stop: Stop; place?: Place; groups: AlternativeGroup[]; onChange: (patch: Partial<Stop>) => void };

export function VisitTimingFields({ trip, stop, place, groups, onChange }: Props) {
  // What kind of place it is sets its usual hours and the daily meal and coffee limits, so bookings have it too.
  const guessed = visitTiming(trip, { ...stop, kind: undefined }, place).kind;
  const type = <label className="field">Place type<select aria-label={`Place type for ${stop.name}`} value={stop.kind ?? ""} onChange={(event) => onChange({ kind: (event.target.value || undefined) as VisitKind | undefined })}>
    <option value="">Automatic{guessed ? ` (${kindLabels[guessed]})` : ""}</option>
    {(Object.keys(kindLabels) as VisitKind[]).map((kind) => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}
  </select></label>;
  if (stop.fixedTime) return <div className="visit-timing">{type}</div>;
  const automatic = describeTiming(trip, { ...stop, slot: undefined }, place);
  const current = describeTiming(trip, stop, place);
  const group = groups.find((candidate) => candidate.stopIds.includes(stop.id));
  const others = group?.stopIds.filter((id) => id !== stop.id).map((id) => trip.stops.find((candidate) => candidate.id === id)?.name).filter(Boolean) ?? [];
  // "Plan separately" only takes this place out; the itinerary's other choice keeps the group, so it can come back.
  const rejoin = stop.alternativeGroup === null && stop.source.trim() ? trip.stops.find((other) => other.id !== stop.id && other.alternativeGroup && other.source.trim() === stop.source.trim()) : undefined;
  return <div className="visit-timing">
    {type}
    <label className="field">Time of day<select aria-label={`Time of day for ${stop.name}`} value={stop.slot ?? ""} onChange={(event) => onChange({ slot: (event.target.value || undefined) as VisitSlot | undefined })}>
      <option value="">Automatic{automatic ? ` (${automatic.label})` : " (no preference)"}</option>
      {(Object.keys(slotLabels) as VisitSlot[]).map((slot) => <option key={slot} value={slot}>{slotLabels[slot]}</option>)}
    </select></label>
    {current && <span className="quiet">{current.label} · {timingSourceLabels[current.source]}. A soft preference; opening hours and bookings come first.</span>}
    {!group && rejoin && <span className="visit-alternative">Listed with {rejoin.name} as alternatives in the itinerary, now planned separately.<button type="button" className="text-button" onClick={() => onChange({ alternativeGroup: rejoin.alternativeGroup })}>Plan as alternatives</button></span>}
    {group && <span className="visit-alternative">Alternative to {others.join(", ")}. Both are planned when they fit; otherwise one is kept.<button type="button" className="text-button" onClick={() => onChange({ alternativeGroup: null })}>Plan separately</button></span>}
  </div>;
}
