"use client";

import { useState } from "react";
import { ArrowUpRight, Check, Footprints, LoaderCircle, LockKeyhole, Plus, Route, Search, Settings2, TrainFront, Trash2 } from "lucide-react";
import { ZodError } from "zod";
import { Dialog } from "./Dialog";
import { ConflictResolution, ProvisionalOutline } from "./ConflictResolution";
import { VisitTimingFields } from "./VisitTiming";
import { applyPlanningFixes, applyScheduleDurations, bookingConflicts, bookingTimeSuggestion, formatMinute, planningPreferences, suggestDayTrips, tripSchema, type BookingTravelCheck, type DayGroup, type Place, type PlanningFix, type PlanningPreferences, type PlanningPreview, type PlanResult, type Stop, type Trip } from "@/lib/trip";
import { validateSchedule } from "@/lib/schedule-validation";
import { timingResultSchema, type TimingResult } from "@/lib/timing";
import { alternativeGroups } from "@/lib/visit-slots";
import { OmittedPlaces } from "./OmittedPlaces";

type Props = {
  trip: Trip; canPlan: boolean; canResearch: boolean;
  onClose: () => void;
  onPreview: (trip: Trip) => Promise<PlanningPreview>;
  onCheck: (trip: Trip) => Promise<BookingTravelCheck>;
  onApply: (trip: Trip, result?: PlanResult) => void;
  onResearch: (places: { id: string; name: string; source: string; sourceUrl?: string }[]) => Promise<TimingResult>;
  places?: Record<string, Place>;
};

export function PlanningDialog({ trip, canPlan, canResearch, onClose, onPreview, onCheck, onApply, onResearch, places = {} }: Props) {
  const [resolving, setResolving] = useState(false);
  const [draft, setDraft] = useState<Trip>(() => ({ ...trip, planning: { ...planningPreferences(trip) } }));
  const [bookedTimes, setBookedTimes] = useState<Record<string, string>>(() => Object.fromEntries(trip.stops.filter((stop) => stop.fixedTime).map((stop) => [stop.id, stop.fixedTime!])));
  const [preview, setPreview] = useState<PlanningPreview | null>(null);
  const [stage, setStage] = useState<"preferences" | "preview">("preferences");
  const [busy, setBusy] = useState<"planning" | "research" | null>(null);
  const [error, setError] = useState("");
  const [fixes, setFixes] = useState<PlanningFix[]>([]);
  const [consent, setConsent] = useState(false);
  const [researchIds, setResearchIds] = useState<string[]>([]);
  const [timing, setTiming] = useState<TimingResult | null>(null);
  const preferences = planningPreferences(draft);
  const unconfirmed = draft.stops.filter((stop) => !stop.placeId).map((stop) => stop.name);
  const confirmed = Boolean(draft.hotelPlaceId && draft.stops.length && !unconfirmed.length);
  let conflicts: string[] = [];
  const suggestions = new Map<string, string>();
  const dayTripSuggestions = suggestDayTrips(draft, places);
  const validated = tripSchema.safeParse(draft);
  const draftAlternatives = alternativeGroups(draft);
  const invalidGroups = !validated.success && validated.error.issues.some((issue) => issue.path[0] === "dayGroups");
  if (validated.success) {
    try {
      conflicts = bookingConflicts(validated.data);
      if (conflicts.length) for (const stop of validated.data.stops) {
        const suggestion = bookingTimeSuggestion(validated.data, stop.id);
        if (suggestion) suggestions.set(stop.id, suggestion);
      }
    } catch { conflicts = ["A booked or daily time does not exist or is ambiguous on this date in the selected timezone."]; }
  }

  function report(cause: unknown) {
    setError(cause instanceof ZodError ? cause.issues[0].message : cause instanceof Error ? cause.message : "Unable to complete this request.");
    setFixes(cause instanceof Error && "fixes" in cause && Array.isArray(cause.fixes) ? cause.fixes as PlanningFix[] : []);
  }
  function edit(patch: Partial<Trip>) { setDraft((current) => ({ ...current, ...patch })); setPreview(null); setError(""); setFixes([]); }
  function editPreferences(patch: Partial<PlanningPreferences>) { edit({ planning: { ...preferences, ...patch } }); }
  function editGroup(id: string, patch: Partial<DayGroup>) { edit({ dayGroups: draft.dayGroups?.map((group) => group.id === id ? { ...group, ...patch } : group) }); }
  function editStop(id: string, patch: Partial<Stop>) {
    edit({ stops: draft.stops.map((stop) => stop.id === id ? { ...stop, ...patch, ...(patch.duration !== undefined || patch.fixedTime ? { durationOptions: undefined } : {}) } : stop) });
    if (patch.fixedTime) {
      setBookedTimes((current) => ({ ...current, [id]: patch.fixedTime! }));
      setResearchIds((current) => current.filter((stopId) => stopId !== id)); setConsent(false); setTiming(null);
    }
  }

  async function optimize(candidate = draft) {
    if (conflicts.length) return;
    setBusy("planning"); setError(""); setFixes([]);
    try {
      const result = await onPreview(tripSchema.parse(candidate));
      if (result.status === "provisional") { setPreview(result); setStage("preview"); return; }
      if (!result.verified) throw new Error("This route has not passed travel-time checks. Adjust preferences and try again.");
      const issues = validateSchedule(candidate, result.schedule);
      if (issues.length) throw new Error(issues.join(" "));
      setPreview(result); setStage("preview");
    } catch (cause) { report(cause); }
    finally { setBusy(null); }
  }

  async function research() {
    if (!consent || !researchIds.length || researchIds.length > 5) return;
    setBusy("research"); setError("");
    const places = draft.stops.filter((stop) => researchIds.includes(stop.id)).map(({ id, name, source, sourceUrl }) => ({ id, name, source, ...(sourceUrl ? { sourceUrl } : {}) }));
    try { setTiming(timingResultSchema.parse(await onResearch(places))); }
    catch (cause) { report(cause); }
    finally { setBusy(null); }
  }

  function apply(result?: PlanResult) {
    try { onApply(result ? applyScheduleDurations(draft, result.schedule) : draft, result); } catch (cause) { report(cause); }
  }

  function applyFixes() {
    const next = applyPlanningFixes(draft, fixes);
    setDraft(next); setPreview(null);
    void optimize(next);
  }

  function reviewVisitTimes() { document.getElementById("planning-visits")?.focus(); }

  if (resolving) return <Dialog title="Resolve conflicts" className="planning-dialog" busy={Boolean(busy)} onClose={() => setResolving(false)}>
    {busy && <p className="planning-progress" role="status"><LoaderCircle size={16} className="spin" />Checking routes...</p>}
    <ConflictResolution trip={draft} busy={Boolean(busy)} onBusy={(value) => setBusy(value ? "planning" : null)} onCheck={onCheck} onPreview={onPreview} onApply={onApply} onCancel={() => setResolving(false)} places={places} />
  </Dialog>;

  return <Dialog title="Plan my days" className="planning-dialog" busy={Boolean(busy)} onClose={onClose}>
    <div className="planning-context"><span>{draft.city}</span><span>{draft.days} days</span><span>{draft.stops.length} places</span><span><LockKeyhole size={13} />{draft.stops.filter((stop) => stop.fixedTime).length} fixed bookings</span></div>
    <div className="segmented planning-stages"><button disabled={Boolean(busy)} aria-pressed={stage === "preferences"} onClick={() => setStage("preferences")}><Settings2 size={15} />Preferences</button><button disabled={!preview || Boolean(busy)} aria-pressed={stage === "preview"} onClick={() => setStage("preview")}><Route size={15} />Suggested plan</button></div>
    {error && (fixes.length ? <div className="notice error planning-fixes" role="alert">
      <strong>{fixes.length === 1 ? "One visit can't be scheduled as set" : `${fixes.length} visits can't be scheduled as set`}</strong>
      <ul>{fixes.map((fix) => <li key={fix.stopId}><strong>{fix.stopName}</strong>: {fix.issue} <span className="planning-fix-action">Suggested: {fix.action === "optimize-day" ? "set Day to Optimize" : fix.action === "flexible-optional" ? "set Day to Optimize and mark Optional" : "mark Optional"}</span></li>)}</ul>
      <button className="button primary" disabled={Boolean(busy) || !confirmed || !!conflicts.length || !validated.success} onClick={applyFixes}><Check size={15} />Apply all suggestions and plan again</button>
      <details><summary>Details</summary><p>{error}</p></details>
    </div> : <p className="notice error" role="alert">{error}</p>)}
    {error && !!dayTripSuggestions.length && <p className="notice warning">Consider grouping distant visits as a day trip.</p>}
    {busy && <p className="planning-progress" role="status"><LoaderCircle size={16} className="spin" />{busy === "planning" ? "Planning your days..." : "Checking visit durations..."}</p>}
    {stage === "preferences" ? <>
      <button className="button secondary" disabled={Boolean(busy)} onClick={() => setResolving(true)}><Settings2 size={15} />Resolve conflicts</button>
      {!!conflicts.length && <details className="notice warning" open role="alert"><summary>Fixed booking conflicts ({conflicts.length})</summary><p>Times must accommodate each visit and arrival buffer. Travel time is additional.</p><ul>{conflicts.map((conflict, index) => <li key={index}>{conflict}</li>)}</ul><button className="text-button" disabled={Boolean(busy)} onClick={reviewVisitTimes}><Settings2 size={14} />Review visit times</button></details>}
      <fieldset className="planning-inputs" disabled={Boolean(busy)}>
        <div className="planning-section">
          <h3>Day and travel preferences</h3>
          <div className="form-grid">
            <label className="field">Sightseeing starts<input type="time" value={draft.dailyStart} onChange={(event) => edit({ dailyStart: event.target.value })} /></label>
            <label className="field">Sightseeing ends<input type="time" value={draft.dailyEnd} onChange={(event) => edit({ dailyEnd: event.target.value })} /></label>
            <label className="field">Day grouping<select value={preferences.goal} onChange={(event) => editPreferences({ goal: event.target.value as PlanningPreferences["goal"] })}><option value="TRAVEL">Minimize total travel</option><option value="BALANCED">Balance daily activity</option></select></label>
            <label className="field">Maximum places per day<input type="number" min={1} max={25} value={preferences.maxStopsPerDay} onChange={(event) => editPreferences({ maxStopsPerDay: Number(event.target.value) })} /></label>
            <label className="field">Default transport<select value={preferences.mode} onChange={(event) => editPreferences({ mode: event.target.value as Stop["mode"] })}><option value="AUTO">Walking and public transit</option><option value="WALK">Walking only</option><option value="TRANSIT">Public transit</option></select></label>
            <label className="field">Transit preference<select value={preferences.transitPreference} onChange={(event) => editPreferences({ transitPreference: event.target.value as PlanningPreferences["transitPreference"] })}><option value="DEFAULT">Google recommended</option><option value="LESS_WALKING">Less walking</option><option value="FEWER_TRANSFERS">Fewer transfers</option></select></label>
            <label className="field">Standalone walking leg limit (min, always max 1.5 km)<input type="number" min={5} max={180} placeholder="No limit" value={preferences.maxWalkMinutes ?? ""} onChange={(event) => editPreferences({ maxWalkMinutes: event.target.value === "" ? null : Number(event.target.value) })} /></label>
            <label className="checkbox"><input type="checkbox" checked={draft.returnToHotel} onChange={(event) => edit({ returnToHotel: event.target.checked })} />Return to hotel each day</label>
          </div>
        </div>
        <div className="planning-section">
          <h3>Day trips</h3>
          {dayTripSuggestions.map((suggestion) => <div className="notice" role="status" key={suggestion.stopIds.join(":")}><p><strong>Suggested day trip{suggestion.name === "Day trip" ? "" : `: ${suggestion.name}`}</strong> · {suggestion.stopIds.length} nearby visits, at least {suggestion.distanceKm} km from {suggestion.from === "hotel" ? "the hotel" : "your other places"}: {suggestion.stopIds.map((id) => draft.stops.find((stop) => stop.id === id)?.name).join(", ")}. Keep them together on one day.</p><button className="text-button" type="button" onClick={() => edit({ dayGroups: [...draft.dayGroups ?? [], { id: crypto.randomUUID(), name: suggestion.name.slice(0, 100), stopIds: suggestion.stopIds, allowedDays: Array.from({ length: draft.days }, (_, day) => day), exclusive: true }] })}><Plus size={14} />{suggestion.name === "Day trip" ? "Group these as a day trip" : `Add ${suggestion.name} as a day trip`}</button></div>)}
          {(draft.dayGroups ?? []).map((group, index) => <div className="planning-visit" key={group.id} role="group" aria-label={`${group.name || "Day trip"} group`}>
            <div className="planning-visit-heading"><label className="field grow">Group name<input aria-label={`Day-trip name ${index + 1}`} maxLength={100} value={group.name} onChange={(event) => editGroup(group.id, { name: event.target.value })} /></label><button className="icon-button danger" type="button" aria-label={`Remove ${group.name} group`} title={`Remove ${group.name} group`} onClick={() => edit({ dayGroups: draft.dayGroups!.length === 1 ? undefined : draft.dayGroups!.filter((candidate) => candidate.id !== group.id) })}><Trash2 size={16} /></button></div>
            <div className="planning-visit-options"><label className="checkbox"><input type="checkbox" aria-label={`Exclusive day for ${group.name}`} checked={group.exclusive} onChange={(event) => editGroup(group.id, { exclusive: event.target.checked })} />Exclusive day</label></div>
            <label className="field">Assumed travel each way (min), only if Google has no route<input type="number" min={5} max={240} placeholder="Not set" aria-label={`Assumed travel minutes for ${group.name}`} value={group.assumedTravelMinutes ?? ""} onChange={(event) => editGroup(group.id, { assumedTravelMinutes: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
            <fieldset className="planning-inputs"><legend>Eligible days</legend><div className="planning-visit-options">{Array.from({ length: draft.days }, (_, day) => <label className="checkbox" key={day}><input type="checkbox" aria-label={`Day ${day + 1} allowed for ${group.name}`} checked={group.allowedDays.includes(day)} onChange={(event) => editGroup(group.id, { allowedDays: event.target.checked ? [...group.allowedDays, day].sort((left, right) => left - right) : group.allowedDays.filter((allowed) => allowed !== day) })} />Day {day + 1}</label>)}</div></fieldset>
            <details className="research-evidence" open><summary>Visits ({group.stopIds.length})</summary><div className="form-grid">{draft.stops.map((stop) => <label className="checkbox" key={stop.id}><input type="checkbox" aria-label={`Include ${stop.name} in ${group.name}`} checked={group.stopIds.includes(stop.id)} disabled={draft.dayGroups!.some((other) => other.id !== group.id && other.stopIds.includes(stop.id))} onChange={(event) => editGroup(group.id, { stopIds: event.target.checked ? [...group.stopIds, stop.id] : group.stopIds.filter((id) => id !== stop.id) })} /><span>{stop.name}{stop.day !== null && <small className="quiet"> / Day {stop.day + 1}{stop.fixedTime ? `, ${stop.fixedTime}` : ""}</small>}</span></label>)}</div></details>
          </div>)}
          <button className="button secondary" type="button" disabled={!draft.stops.some((stop) => !draft.dayGroups?.some((group) => group.stopIds.includes(stop.id)))} onClick={() => edit({ dayGroups: [...draft.dayGroups ?? [], { id: crypto.randomUUID(), name: "Day trip", stopIds: [], allowedDays: Array.from({ length: draft.days }, (_, day) => day), exclusive: true }] })}><Plus size={15} />Add day trip</button>
          {!validated.success && !!draft.dayGroups?.length && <p className="notice warning" role="alert">{validated.error.issues[0].message}</p>}
        </div>
        <div className="planning-section">
          <h3 id="planning-visits" tabIndex={-1}>Visits</h3>
          {draft.stops.map((stop) => {
            const recommendation = timing?.recommendations.find((item) => item.stopId === stop.id);
            const suggestedTime = suggestions.get(stop.id);
            return <div className="planning-visit" key={stop.id}>
              <div className="planning-visit-heading"><strong>{stop.name}</strong>{stop.fixedTime && <span className="booking-time"><LockKeyhole size={13} />Day {stop.day! + 1}, {stop.fixedTime}</span>}</div>
              <div className="form-grid three">
                <label className="field">Visit minutes<input aria-label={`Visit minutes for ${stop.name}`} type="number" min={5} max={480} value={stop.duration} onChange={(event) => editStop(stop.id, { duration: Number(event.target.value) })} /></label>
                <label className="field">Day<select aria-label={`Day for ${stop.name}`} disabled={Boolean(stop.fixedTime)} value={stop.day ?? ""} onChange={(event) => editStop(stop.id, { day: event.target.value === "" ? null : Number(event.target.value) })}><option value="">Optimize</option>{Array.from({ length: draft.days }, (_, index) => <option key={index} value={index}>Day {index + 1}</option>)}</select></label>
                <label className="field">Transport<select aria-label={`Transport for ${stop.name}`} value={stop.mode} onChange={(event) => editStop(stop.id, { mode: event.target.value as Stop["mode"] })}><option value="AUTO">Trip default</option><option value="WALK">Walking only</option><option value="TRANSIT">Public transit</option></select></label>
                <label className="field">Booked time<input aria-label={`Booked time for ${stop.name}`} type="time" disabled={!stop.fixedTime} value={stop.fixedTime ?? ""} onChange={(event) => editStop(stop.id, { fixedTime: event.target.value || null })} /></label>
                <label className="field">Arrival buffer (min)<input aria-label={`Arrival buffer for ${stop.name}`} type="number" min={0} max={120} value={stop.buffer} onChange={(event) => editStop(stop.id, { buffer: Number(event.target.value) })} /></label>
              </div>
              <VisitTimingFields trip={draft} stop={stop} place={places?.[stop.id]} groups={draftAlternatives} onChange={(patch) => editStop(stop.id, patch)} />
              <div className="planning-visit-options"><label className="checkbox"><input type="checkbox" aria-label={`Any time slot for ${stop.name}`} checked={!stop.fixedTime} onChange={(event) => editStop(stop.id, event.target.checked ? { fixedTime: null } : { fixedTime: bookedTimes[stop.id] ?? draft.dailyStart, day: stop.day ?? 0, optional: false })} />Any time slot</label><label className="checkbox"><input type="checkbox" aria-label={`Optional ${stop.name}`} disabled={Boolean(stop.fixedTime)} checked={stop.optional} onChange={(event) => editStop(stop.id, { optional: event.target.checked })} />Optional</label>
                {!stop.fixedTime && <label className="checkbox"><input type="checkbox" aria-label={`Research timing for ${stop.name}`} checked={researchIds.includes(stop.id)} disabled={!researchIds.includes(stop.id) && researchIds.length >= 5} onChange={(event) => { setResearchIds((current) => event.target.checked ? [...current, stop.id] : current.filter((id) => id !== stop.id)); setConsent(false); setTiming(null); }} />Research timing</label>}
              </div>
              {suggestedTime && <div className="planning-visit-options"><span className="quiet">Suggested time: {suggestedTime} (before travel)</span><button className="text-button" aria-label={`Use suggested time ${suggestedTime} for ${stop.name}`} onClick={() => editStop(stop.id, { fixedTime: suggestedTime })}><Check size={14} />Use {suggestedTime}</button></div>}
              {stop.source && <details className="research-evidence"><summary>Original source</summary><p>{stop.source}</p>{stop.sourceUrl && <a href={stop.sourceUrl} target="_blank" rel="noopener noreferrer">Source link<ArrowUpRight size={12} /></a>}</details>}
              {stop.preferredTimeWindow && <div className="preferred-time-window"><strong>Preferred start time</strong><span>{stop.fixedTime ? "Booked time takes precedence." : "The visit should start in this range. A strongly weighted soft preference; opening hours come first."}</span><div className="form-grid"><label className="field">From<input aria-label={`Preferred start time for ${stop.name}`} type="time" max={stop.preferredTimeWindow.end} value={stop.preferredTimeWindow.start} onChange={(event) => { if (event.target.value && event.target.value < stop.preferredTimeWindow!.end) editStop(stop.id, { preferredTimeWindow: { ...stop.preferredTimeWindow!, start: event.target.value } }); }} /></label><label className="field">Until<input aria-label={`Preferred end time for ${stop.name}`} type="time" min={stop.preferredTimeWindow.start} value={stop.preferredTimeWindow.end} onChange={(event) => { if (event.target.value && event.target.value > stop.preferredTimeWindow!.start) editStop(stop.id, { preferredTimeWindow: { ...stop.preferredTimeWindow!, end: event.target.value } }); }} /></label></div><div className="timing-links">{[...new Set(stop.preferredTimeWindow.sources)].map((url) => <a key={url} href={url} target="_blank" rel="noopener noreferrer">Timing source<ArrowUpRight size={12} /></a>)}</div><button className="text-button" onClick={() => editStop(stop.id, { preferredTimeWindow: undefined })}>Clear time preference</button></div>}
              {recommendation && timing && <div className="timing-suggestion"><strong>Suggested: {recommendation.duration} min</strong><p>{recommendation.reason}</p>{recommendation.bestTime && <p>Time-of-day guidance: {recommendation.bestTime}</p>}{recommendation.preferredTimeWindow && <p>Flexible range: {recommendation.preferredTimeWindow.start}–{recommendation.preferredTimeWindow.end}</p>}<div className="timing-links">{recommendation.sourceIndexes.map((index) => timing.sources[index] && <a key={index} href={timing.sources[index].url} target="_blank" rel="noopener noreferrer">{timing.sources[index].title}<ArrowUpRight size={12} /></a>)}</div>{recommendation.preferredTimeWindow && <button className="text-button" onClick={() => editStop(stop.id, { preferredTimeWindow: { ...recommendation.preferredTimeWindow!, sources: [...new Set(recommendation.sourceIndexes.map((index) => timing.sources[index].url))] } })}><Check size={14} />Use this time window</button>}<button className="text-button" onClick={() => editStop(stop.id, { duration: recommendation.duration })}><Check size={14} />Use {recommendation.duration} min for {stop.name}</button></div>}
            </div>;
          })}
        </div>
        <div className="planning-section timing-research">
          <h3>Timing guidance <span>{researchIds.length}/5 selected</span></h3>
          {!canResearch && <p className="notice">Visit research is unavailable. Check your sign-in and connections.</p>}
          <label className="checkbox consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />Send selected place names, original notes and links to the agent to look up. Charges and retention policies apply.</label>
          <button className="button secondary" disabled={!consent || !researchIds.length} onClick={() => void research()}><Search size={15} />Research timing windows</button>
          {timing && <><p className="quiet">{timing.recommendations.length} grounded suggestions. Apply a flexible range before route planning; bookings always take precedence.</p><details className="research-evidence"><summary>Google Search evidence</summary><p>{timing.research}</p><ul>{timing.sources.map((source, index) => <li key={index}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a></li>)}</ul></details>{timing.searchEntryPoint && <iframe title="Google Search suggestions" className="search-attribution" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={timing.searchEntryPoint} />}</>}
        </div>
      </fieldset>
      {!confirmed && <p className="notice warning">Confirm the hotel and all places on the map before planning.{unconfirmed.length > 0 && ` Unconfirmed: ${unconfirmed.join(", ")}.`}</p>}
      {!canPlan && <p className="notice">Route planning is unavailable. Check your sign-in and connections.</p>}
      {!!conflicts.length && <div className="notice warning" id="planning-blocker" role="status"><p>{conflicts.length} fixed booking {conflicts.length === 1 ? "conflict remains" : "conflicts remain"}. Preview is blocked until these times no longer overlap.</p><button className="text-button" disabled={Boolean(busy)} onClick={reviewVisitTimes}><Settings2 size={14} />Review visit times</button></div>}
      <div className="dialog-actions planning-actions"><button className="button secondary" disabled={Boolean(busy) || invalidGroups} onClick={() => apply()}><Check size={15} />Apply preferences</button><button className="button primary" aria-describedby={conflicts.length ? "planning-blocker" : undefined} disabled={Boolean(busy) || !confirmed || !!conflicts.length || !validated.success} onClick={() => void optimize()}><Route size={16} />Optimize preview</button></div>
    </> : preview?.status === "provisional" ? <>
      <ProvisionalOutline trip={draft} result={preview} />
      <div className="dialog-actions planning-actions"><button className="button secondary" disabled={Boolean(busy)} onClick={() => setStage("preferences")}><Settings2 size={15} />Adjust preferences</button></div>
    </> : preview && <>
      <div className="plan-preview" aria-label="Suggested itinerary">
        {preview.schedule.days.map((day) => {
          const travel = day.visits.reduce((total, visit) => total + visit.leg.minutes, day.returnLeg?.minutes ?? 0);
          const visitMinutes = day.visits.reduce((total, visit) => total + visit.end - visit.start, 0);
          return <section className="plan-preview-day" key={day.day}><h3>Day {day.day + 1} <span>{day.date}</span></h3><p className="quiet">{day.visits.length} places / {Math.round(visitMinutes)} min visiting / {travel} min travel</p><ol>{day.visits.map((visit) => <li key={visit.stopId}><span className="preview-time">{formatMinute(draft, day.day, visit.start)} - {formatMinute(draft, day.day, visit.end)}</span><div><strong>{draft.stops.find((stop) => stop.id === visit.stopId)?.name}</strong><small>{visit.leg.mode === "WALK" ? <Footprints size={13} /> : <TrainFront size={13} />}{visit.leg.mode === "WALK" ? "Walk" : "Public transit"} {visit.leg.minutes} min{visit.leg.assumed ? " (assumed)" : ""}{visit.leg.timetableDate ? ` (timetable of ${visit.leg.timetableDate})` : ""}{draft.stops.find((stop) => stop.id === visit.stopId)?.fixedTime && <LockKeyhole size={12} />}</small></div></li>)}</ol>{day.returnLeg && <p className="quiet">Return to {draft.hotel}: {day.returnLeg.mode === "WALK" ? "walk" : "public transit"}, {day.returnLeg.minutes} min{day.returnLeg.assumed ? " (assumed)" : ""}{day.returnLeg.timetableDate ? ` (timetable of ${day.returnLeg.timetableDate})` : ""}</p>}{!day.visits.length && <p className="quiet">No places assigned.</p>}</section>;
        })}
      </div>
      <OmittedPlaces trip={draft} schedule={preview.schedule} />
      <div className="route-notices">{preview.schedule.warnings.map((warning) => <p key={warning}>{warning}</p>)}<p>Walking routes may lack pedestrian paths. Transit can include walking to stations.</p><span>Route information: Google Maps</span></div>
      <div className="dialog-actions planning-actions"><button className="button secondary" disabled={Boolean(busy)} onClick={() => setStage("preferences")}><Settings2 size={15} />Adjust preferences</button><button className="button primary" disabled={Boolean(busy)} onClick={() => apply(preview)}><Check size={15} />Use this plan</button></div>
    </>}
  </Dialog>;
}