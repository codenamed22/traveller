"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, LockKeyhole, LockKeyholeOpen, Route, Search, Settings2 } from "lucide-react";
import { ZodError } from "zod";
import { applyScheduleDurations, bookingConflictDetails, formatMinute, resolvePlanningConstraints, suggestDayTrips, tripDate, type BookingTravelCheck, type DayGroup, type DurationRule, type Place, type PlanningPreview, type PlanningResolution, type PlanResult, type ProvisionalPlan, type Trip } from "@/lib/trip";
import { validateSchedule } from "@/lib/schedule-validation";

type Props = {
  trip: Trip;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onCheck: (trip: Trip) => Promise<BookingTravelCheck>;
  onPreview: (trip: Trip) => Promise<PlanningPreview>;
  onApply: (trip: Trip, result: PlanResult) => void;
  onCancel: () => void;
  places?: Record<string, Place>;
};

export function ConflictResolution({ trip, busy, onBusy, onCheck, onPreview, onApply, onCancel, places = {} }: Props) {
  const [check, setCheck] = useState<BookingTravelCheck | null>(null);
  const [choices, setChoices] = useState<PlanningResolution>(() => ({ keepTimeIds: trip.stops.filter((stop) => stop.fixedTime).map((stop) => stop.id), movableDayIds: [], optionalIds: [], durationRules: {} }));
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState("");
  const [proposal, setProposal] = useState<{ trip: Trip; result: PlanResult } | null>(null);
  const [provisional, setProvisional] = useState<{ trip: Trip; result: ProvisionalPlan } | null>(null);
  const [dayTrip, setDayTrip] = useState<DayGroup | null>(null);
  const dayTripSuggestion = suggestDayTrips(trip, places)[0];
  const dayTripNames = (dayTrip?.stopIds ?? dayTripSuggestion?.stopIds ?? []).map((id) => trip.stops.find((stop) => stop.id === id)?.name).join(", ");
  const booked = trip.stops.filter((stop) => stop.fixedTime);
  const flexible = trip.stops.filter((stop) => !choices.keepTimeIds.includes(stop.id));
  const movable = flexible.filter((stop) => stop.day !== null);
  const confirmed = Boolean(trip.hotelPlaceId && trip.stops.length && trip.stops.every((stop) => stop.placeId));
  const placeName = (id: string) => id === "hotel" ? "Hotel" : trip.stops.find((stop) => stop.id === id)?.name ?? id;
  const originalTime = (stop: Trip["stops"][number]) => `${stop.day === null ? "Any day" : tripDate(trip, stop.day)}, ${stop.fixedTime ?? "any time"}`;
  const report = (cause: unknown) => setError(cause instanceof Error ? cause.message : "Unable to complete this request.");
  function candidateTrip() {
    if (!dayTrip) return resolvePlanningConstraints(trip, choices);
    const memberDays = new Set(trip.stops.filter((stop) => dayTrip.stopIds.includes(stop.id)).map((stop) => stop.day));
    const released = trip.stops.filter((stop) => stop.day !== null && !choices.keepTimeIds.includes(stop.id) && (dayTrip.stopIds.includes(stop.id) || memberDays.has(stop.day))).map((stop) => stop.id);
    return resolvePlanningConstraints({ ...trip, dayGroups: [...trip.dayGroups ?? [], dayTrip] }, { ...choices, movableDayIds: [...new Set([...choices.movableDayIds, ...released])] });
  }
  let conflicts: ReturnType<typeof bookingConflictDetails> = [];
  let constraintError = "";
  try { conflicts = bookingConflictDetails(candidateTrip()); }
  catch (cause) { constraintError = cause instanceof ZodError ? cause.issues[0].message : cause instanceof Error ? cause.message : "Review the trip details before planning."; }

  function choose(field: "keepTimeIds" | "movableDayIds" | "optionalIds", id: string, selected: boolean) {
    setChoices((current) => ({ ...current, [field]: selected ? [...new Set([...current[field], id])] : current[field].filter((value) => value !== id),
      ...(field === "keepTimeIds" && selected ? { movableDayIds: current.movableDayIds.filter((value) => value !== id), optionalIds: current.optionalIds.filter((value) => value !== id), durationRules: Object.fromEntries(Object.entries(current.durationRules ?? {}).filter(([stopId]) => stopId !== id)) } : {}),
    }));
    setProposal(null); setProvisional(null); setError("");
  }

  async function checkTravel() {
    onBusy(true); setError("");
    try { setCheck(await onCheck(trip)); }
    catch (cause) { report(cause); }
    finally { onBusy(false); }
  }

  async function preview() {
    onBusy(true); setError(""); setProposal(null); setProvisional(null);
    try {
      const candidate = candidateTrip();
      if (bookingConflictDetails(candidate).length) { document.getElementById("resolution-conflicts")?.focus(); return; }
      const result = await onPreview(candidate);
      if (result.status === "provisional") { setProvisional({ trip: candidate, result }); setAttempted(true); return; }
      if (!result.verified) throw new Error("This proposal has not passed route verification.");
      const issues = validateSchedule(candidate, result.schedule, undefined, result.places);
      if (issues.length) throw new Error(`The proposed route does not respect your choices. ${issues.join(" ")}`);
      setProposal({ trip: applyScheduleDurations(candidate, result.schedule), result });
    } catch (cause) { setAttempted(true); report(cause); }
    finally { onBusy(false); }
  }

  const visits = new Map(proposal?.result.schedule.days.flatMap((day) => day.visits.map((visit) => [visit.stopId, { day: day.day, visit }] as const)) ?? []);
  return <div aria-label="Conflict resolution">
    {error && (!check || !conflicts.length || proposal) && <p className="notice error" role="alert">{error}</p>}
    {error && dayTripSuggestion && !dayTrip && <p className="notice warning">Consider a day trip for {dayTripNames}.</p>}
    {!check ? <>
      <section className="planning-section"><h3>Travel between bookings</h3><p className="quiet">{booked.length} fixed bookings, including travel from and back to the hotel when needed.</p><p className="notice">Travel check: {booked.length ? 3 : 0} service units · Plan preview: 30</p></section>
      <div className="dialog-actions planning-actions"><button className="button secondary" disabled={busy} onClick={onCancel}>Cancel</button>{error && <button className="button secondary" disabled={busy} onClick={() => { setCheck({ connections: [], warnings: ["Travel estimates are unavailable. Full route verification is still required."] }); setError(""); }}>Review without estimates</button>}<button className="button primary" disabled={busy} onClick={() => void checkTravel()}><Search size={15} />Check travel gaps</button></div>
    </> : provisional ? <>
      <ProvisionalOutline trip={provisional.trip} result={provisional.result} />
      <div className="dialog-actions planning-actions"><button className="button secondary" disabled={busy} onClick={onCancel}>Cancel</button><button className="button secondary" disabled={busy} onClick={() => { setProvisional(null); setError(""); }}><Settings2 size={15} />Change choices</button></div>
    </> : proposal ? <>
      <section className="planning-section" aria-label="Proposed changes"><h3>Proposed changes</h3><p className="quiet">{choices.keepTimeIds.length} {choices.keepTimeIds.length === 1 ? "reservation" : "reservations"} kept fixed. Travel and arrival constraints verified.</p>
        {trip.stops.map((stop) => {
          const scheduled = visits.get(stop.id);
          const kept = choices.keepTimeIds.includes(stop.id);
          return <div className="planning-visit" key={stop.id}>
            <div className="planning-visit-heading"><strong>{stop.name}</strong>{kept && <span className="booking-time"><LockKeyhole size={13} />Reservation unchanged</span>}</div>
            <div className="resolution-comparison"><span><small>Original</small>{originalTime(stop)}<small>{stop.duration} min</small></span><ArrowRight size={16} aria-hidden="true" /><span><small>Proposed</small>{scheduled ? `${tripDate(trip, scheduled.day)}, ${formatMinute(trip, scheduled.day, scheduled.visit.start)}` : "Not scheduled (optional)"}{scheduled && <small>{proposal.trip.stops.find((candidate) => candidate.id === stop.id)!.duration} min</small>}</span></div>
            <p className="quiet">{!scheduled ? "Not scheduled; you allowed this visit to be optional." : `${scheduled.visit.leg.minutes} min ${scheduled.visit.leg.mode === "WALK" ? "walking" : "transit"}${scheduled.visit.leg.assumed ? " (assumed)" : ""}${scheduled.visit.leg.timetableDate ? ` (timetable of ${scheduled.visit.leg.timetableDate})` : ""} from the previous stop.`}</p>
          </div>;
        })}
      </section>
      <div className="route-notices">{proposal.result.schedule.warnings.map((warning) => <p key={warning}>{warning}</p>)}<p>Route information: Google Maps. Venue hours and ticket conditions still need checking.</p></div>
      <div className="dialog-actions planning-actions"><button className="button secondary" disabled={busy} onClick={onCancel}>Cancel</button><button className="button secondary" disabled={busy} onClick={() => { setProposal(null); setError(""); }}><Settings2 size={15} />Change choices</button><button className="button primary" disabled={busy} onClick={() => { try { onApply(proposal.trip, proposal.result); } catch (cause) { report(cause); } }}><Check size={15} />Approve changes</button></div>
    </> : <>
      <section className="planning-section" aria-label="Timing permissions">
        {(dayTrip || dayTripSuggestion) && <label className="checkbox notice"><input type="checkbox" aria-label="Plan these as one day trip" checked={Boolean(dayTrip)} onChange={(event) => { setDayTrip(event.target.checked && dayTripSuggestion ? { id: crypto.randomUUID(), name: dayTripSuggestion.name.slice(0, 100), stopIds: dayTripSuggestion.stopIds, allowedDays: Array.from({ length: trip.days }, (_, day) => day), exclusive: true } : null); setProposal(null); setProvisional(null); setError(""); }} /><span><strong>Plan these as one day trip</strong>: {dayTripNames}{dayTripSuggestion ? `, about ${dayTripSuggestion.distanceKm} km away` : ""}. Keep these visits together. Their day and other unlocked visits on that day may change.</span></label>}
        {dayTrip && <label className="field">Assumed travel each way (min), used only where Google has no route for these dates<input type="number" min={5} max={240} placeholder="Not set" aria-label="Assumed day-trip travel minutes" value={dayTrip.assumedTravelMinutes ?? ""} onChange={(event) => { setDayTrip({ ...dayTrip, assumedTravelMinutes: event.target.value === "" ? undefined : Number(event.target.value) }); setProposal(null); setProvisional(null); setError(""); }} /></label>}
        <h3>Which visit times may move?</h3>
        <p className="quiet" role="status">{choices.keepTimeIds.length} booking times locked / {booked.length - choices.keepTimeIds.length} released. Keep confirmed reservations locked.</p>
        {!!choices.keepTimeIds.length && <button className="button secondary" disabled={busy} onClick={() => { setChoices((current) => ({ ...current, keepTimeIds: [] })); setProposal(null); setError(""); }}><LockKeyholeOpen size={15} />Allow all visit times to move</button>}
        <fieldset className="planning-inputs" disabled={busy || !flexible.length}>
          {trip.days > 1 && !!movable.length && <label className="checkbox"><input type="checkbox" checked={movable.every((stop) => choices.movableDayIds.includes(stop.id))} onChange={(event) => { const selected = event.target.checked; setChoices((current) => ({ ...current, movableDayIds: selected ? [...new Set([...current.movableDayIds, ...movable.map((stop) => stop.id)])] : current.movableDayIds.filter((id) => !movable.some((stop) => stop.id === id)) })); setProposal(null); setError(""); }} />Allow all flexible visits to change days</label>}
          <h3>Duration permissions</h3>
          {flexible.map((stop) => <div className="planning-visit" key={stop.id}><label className="field">{stop.name}<select aria-label={`Duration flexibility for ${stop.name}`} value={choices.durationRules?.[stop.id] ?? "original"} onChange={(event) => { const rule = event.target.value as DurationRule; setChoices((current) => ({ ...current, durationRules: { ...current.durationRules, [stop.id]: rule } })); setProposal(null); setError(""); }}><option value="original">Keep {stop.duration} min</option><option value="eatery10">Eatery: up to 10% shorter</option><option value="eatery20">Eatery: up to 20% shorter</option>{stop.duration === 15 && <option value="short">Short visit: 15 or 10 min</option>}</select></label></div>)}
          <p className="quiet">Only selected durations may change. Arrival buffers stay the same.</p>
        </fieldset>
      </section>
      {constraintError && <p className="notice error" role="alert">{constraintError}</p>}
      {!!conflicts.length && <section className="planning-section" aria-label="Reservations needing a decision" role="alert">
        <h3 id="resolution-conflicts" tabIndex={-1}>Selected fixed reservations still overlap</h3>
        <p className="quiet" id="resolution-conflict-status">{conflicts.length} fixed booking {conflicts.length === 1 ? "conflict requires" : "conflicts require"} a choice. At least one time in each conflict must be allowed to move.</p>
        <ul className="resolution-connections">{conflicts.map((conflict) => <li className="notice warning" key={`${conflict.day}:${conflict.stopIds.join(":")}:${conflict.message}`}><span>{conflict.message}</span><div className="planning-visit-options">{conflict.stopIds.map((id) => <button className="text-button resolution-release" key={id} disabled={busy} onClick={() => choose("keepTimeIds", id, false)}><LockKeyholeOpen size={14} /><span>Make {placeName(id)} flexible</span></button>)}</div></li>)}</ul>
      </section>}
      <section className="planning-section" aria-label="Google travel estimates"><h3>Original booking travel estimates</h3>
        {check.connections.length ? <ul className="resolution-connections">{check.connections.map((leg) => <li className={leg.minutes === null || leg.minutes > leg.availableMinutes ? "notice warning" : "quiet"} key={`${leg.day}:${leg.from}:${leg.to}`}><strong>Day {leg.day + 1}: {placeName(leg.from)} to {placeName(leg.to)}</strong><span>{leg.availableMinutes} min available / {leg.minutes === null ? "no route estimate within current preferences" : `${leg.minutes} min estimated ${leg.mode === "WALK" ? "walking" : "transit"}`}</span></li>)}</ul> : <p className="quiet">{booked.length ? "No travel estimates available." : "No fixed bookings to check."}</p>}
        {check.warnings.map((warning) => <p className="quiet" key={warning}>{warning}</p>)}
      </section>
      <fieldset className="planning-inputs" disabled={busy}>
        <section className="planning-section"><h3>Which reservations must stay fixed?</h3>
          {booked.length ? booked.map((stop) => <div className="planning-visit" key={stop.id}><label className="checkbox"><input type="checkbox" aria-label={`Keep ${stop.name} fixed`} checked={choices.keepTimeIds.includes(stop.id)} onChange={(event) => choose("keepTimeIds", stop.id, event.target.checked)} />Keep {stop.name} fixed</label><span className="quiet">{originalTime(stop)} / {stop.duration} min</span>{stop.source && <details className="research-evidence"><summary>Original source</summary><p>{stop.source}</p></details>}</div>) : <p className="quiet">All visit times are flexible.</p>}
        </section>
        {attempted && <section className="planning-section" aria-label="Additional flexibility"><h3>Can any flexible visits move days or become optional?</h3>
          {!flexible.length && <p className="notice">All reservations are still fixed. Review their times before changing other constraints.</p>}
          {flexible.map((stop) => <div className="planning-visit" key={stop.id}><div className="planning-visit-heading"><strong>{stop.name}</strong></div><div className="planning-visit-options"><label className="checkbox"><input type="checkbox" aria-label={`Allow another day for ${stop.name}`} disabled={stop.day === null || trip.days < 2} checked={stop.day === null || choices.movableDayIds.includes(stop.id)} onChange={(event) => choose("movableDayIds", stop.id, event.target.checked)} />Allow another day</label><label className="checkbox"><input type="checkbox" aria-label={`Allow omission of ${stop.name}`} disabled={stop.optional} checked={stop.optional || choices.optionalIds.includes(stop.id)} onChange={(event) => choose("optionalIds", stop.id, event.target.checked)} />Optional if it cannot fit</label></div></div>)}
        </section>}
      </fieldset>
      {!confirmed && <p className="notice warning">Confirm the hotel and every place on the map before previewing an adjusted plan.</p>}
      <div className="dialog-actions planning-actions"><button className="button secondary" disabled={busy} onClick={onCancel}>Cancel</button><button className="button primary" aria-describedby={conflicts.length ? "resolution-conflict-status" : undefined} disabled={busy || !confirmed} onClick={() => void preview()}><Route size={15} />Preview adjusted plan</button></div>
    </>}
  </div>;
}

export function ProvisionalOutline({ trip, result }: { trip: Trip; result: ProvisionalPlan }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.closest("dialog")?.scrollTo({ top: 0 });
    heading.current?.focus({ preventScroll: true });
  }, []);
  const outcomes = { unqueried: "Not checked yet", noRoute: "No route found at the checked departure times", providerError: "Route service unavailable", excluded: "Outside your transport or day limits", outsideHorizon: "Timetable not available for these dates", unverified: "Not verified" };
  const directions = { outbound: "Outbound travel", return: "Return travel", internal: "Local routes and days", verification: "Travel at departure time" };
  const otherVisits = result.outline.filter((item) => !item.groupId).flatMap((item) => item.stopIds);
  const stops = (ids: string[]) => <ul className="provisional-stop-list">{ids.map((id) => { const stop = trip.stops.find((stop) => stop.id === id); return stop ? <li key={id}><span>{stop.name}</span><small className="quiet">{stop.duration} min{stop.optional ? " / optional" : ""}</small></li> : null; })}</ul>;
  return <section className="planning-section" aria-label="Provisional itinerary outline">
    <h3 ref={heading} tabIndex={-1}>Provisional outline</h3>
    <p className="notice warning" role="status">{result.message}</p>
    {result.outline.filter((item) => item.groupId).map((item) => <section className="plan-preview-day" key={item.groupId}><h3>{trip.dayGroups?.find((group) => group.id === item.groupId)?.name ?? "Day trip"}</h3><p className="quiet">Eligible days: {item.allowedDays.map((day) => day + 1).join(", ")}</p>{stops(item.stopIds)}</section>)}
    {!!otherVisits.length && <section className="plan-preview-day"><h3>Other visits</h3>{stops(otherVisits)}</section>}
    <h3>Unresolved travel</h3>
    <ul className="resolution-connections">{result.unresolved.map((item, index) => <li className="notice warning" key={index}><strong>{item.groupId ? trip.dayGroups?.find((group) => group.id === item.groupId)?.name : trip.city}{item.day !== undefined ? ` / Day ${item.day + 1}` : ""}</strong><span>{directions[item.direction]}: {outcomes[item.outcome]}</span></li>)}</ul>
    <div className="route-notices">{result.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>
  </section>;
}