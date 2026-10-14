"use client";

import type { Place, Stop, Trip, VisitSlot } from "@/lib/trip";
import { describeTiming, slotLabels, timingSourceLabels, type AlternativeGroup } from "@/lib/visit-slots";

type Props = { trip: Trip; stop: Stop; place?: Place; groups: AlternativeGroup[]; onChange: (patch: Partial<Stop>) => void };

export function VisitTimingFields({ trip, stop, place, groups, onChange }: Props) {
  if (stop.fixedTime) return null;
  const automatic = describeTiming(trip, { ...stop, slot: undefined }, place);
  const current = describeTiming(trip, stop, place);
  const group = groups.find((candidate) => candidate.stopIds.includes(stop.id));
  const others = group?.stopIds.filter((id) => id !== stop.id).map((id) => trip.stops.find((candidate) => candidate.id === id)?.name).filter(Boolean) ?? [];
  return <div className="visit-timing">
    <label className="field">Time of day<select aria-label={`Time of day for ${stop.name}`} value={stop.slot ?? ""} onChange={(event) => onChange({ slot: (event.target.value || undefined) as VisitSlot | undefined })}>
      <option value="">Automatic{automatic ? ` (${automatic.label})` : " (no preference)"}</option>
      {(Object.keys(slotLabels) as VisitSlot[]).map((slot) => <option key={slot} value={slot}>{slotLabels[slot]}</option>)}
    </select></label>
    {current && <span className="quiet">{current.label} · {timingSourceLabels[current.source]}. A soft preference; opening hours and bookings come first.</span>}
    {group && <span className="visit-alternative">Alternative to {others.join(", ")}. Both are planned when they fit; otherwise one is kept.<button type="button" className="text-button" onClick={() => onChange({ alternativeGroup: null })}>Plan separately</button></span>}
  </div>;
}
