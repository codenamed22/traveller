"use client";

import { useState } from "react";
import { ArrowUpRight, Check, Footprints, LoaderCircle, LockKeyhole, Route, Search, Settings2, TrainFront } from "lucide-react";
import { ZodError } from "zod";
import { Dialog } from "./Dialog";
import { formatMinute, planningPreferences, tripSchema, type PlanningPreferences, type PlanResult, type Stop, type Trip } from "@/lib/trip";
import { timingResultSchema, type TimingResult } from "@/lib/timing";

type Props = {
  trip: Trip; canPlan: boolean; canResearch: boolean;
  onClose: () => void;
  onPreview: (trip: Trip) => Promise<PlanResult>;
  onApply: (trip: Trip, result?: PlanResult) => void;
  onResearch: (places: { id: string; name: string }[]) => Promise<TimingResult>;
};

export function PlanningDialog({ trip, canPlan, canResearch, onClose, onPreview, onApply, onResearch }: Props) {
  const [draft, setDraft] = useState<Trip>(() => ({ ...trip, planning: { ...planningPreferences(trip) } }));
  const [preview, setPreview] = useState<PlanResult | null>(null);
  const [stage, setStage] = useState<"preferences" | "preview">("preferences");
  const [busy, setBusy] = useState<"planning" | "research" | null>(null);
  const [error, setError] = useState("");
  const [consent, setConsent] = useState(false);
  const [researchIds, setResearchIds] = useState<string[]>([]);
  const [timing, setTiming] = useState<TimingResult | null>(null);
  const preferences = planningPreferences(draft);
  const unconfirmed = draft.stops.filter((stop) => !stop.placeId).map((stop) => stop.name);
  const confirmed = Boolean(draft.hotelPlaceId && draft.stops.length && !unconfirmed.length);

  function report(cause: unknown) { setError(cause instanceof ZodError ? cause.issues[0].message : cause instanceof Error ? cause.message : "Unable to complete this request."); }
  function edit(patch: Partial<Trip>) { setDraft((current) => ({ ...current, ...patch })); setPreview(null); setError(""); }
  function editPreferences(patch: Partial<PlanningPreferences>) { edit({ planning: { ...preferences, ...patch } }); }
  function editStop(id: string, patch: Partial<Stop>) { edit({ stops: draft.stops.map((stop) => stop.id === id ? { ...stop, ...patch } : stop) }); }

  async function optimize() {
    setBusy("planning"); setError("");
    try {
      const result = await onPreview(tripSchema.parse(draft));
      if (!result.verified) throw new Error("This route has not passed travel-time checks. Adjust preferences and try again.");
      setPreview(result); setStage("preview");
    } catch (cause) { report(cause); }
    finally { setBusy(null); }
  }

  async function research() {
    if (!consent || !researchIds.length || researchIds.length > 5) return;
    setBusy("research"); setError("");
    try { setTiming(timingResultSchema.parse(await onResearch(draft.stops.filter((stop) => researchIds.includes(stop.id)).map(({ id, name }) => ({ id, name }))))); }
    catch (cause) { report(cause); }
    finally { setBusy(null); }
  }

  function apply(result?: PlanResult) {
    try { onApply(draft, result); } catch (cause) { report(cause); }
  }

  return <Dialog title="Plan my days" className="planning-dialog" busy={Boolean(busy)} onClose={onClose}>
    <div className="planning-context"><span>{draft.city}</span><span>{draft.days} days</span><span>{draft.stops.length} places</span><span><LockKeyhole size={13} />{draft.stops.filter((stop) => stop.fixedTime).length} fixed bookings</span></div>
    <div className="segmented planning-stages"><button disabled={Boolean(busy)} aria-pressed={stage === "preferences"} onClick={() => setStage("preferences")}><Settings2 size={15} />Preferences</button><button disabled={!preview || Boolean(busy)} aria-pressed={stage === "preview"} onClick={() => setStage("preview")}><Route size={15} />Suggested plan</button></div>
    {error && <p className="notice error" role="alert">{error}</p>}
    {busy && <p className="planning-progress" role="status"><LoaderCircle size={16} className="spin" />{busy === "planning" ? "Checking Google routes and optimizing days..." : "Researching visit durations with Google Search..."}</p>}
    {stage === "preferences" ? <>
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
          <h3>Visits</h3>
          {draft.stops.map((stop) => {
            const recommendation = timing?.recommendations.find((item) => item.stopId === stop.id);
            return <div className="planning-visit" key={stop.id}>
              <div className="planning-visit-heading"><strong>{stop.name}</strong>{stop.fixedTime && <span className="booking-time"><LockKeyhole size={13} />Day {stop.day! + 1}, {stop.fixedTime}</span>}</div>
              <div className="form-grid three">
                <label className="field">Visit minutes<input aria-label={`Visit minutes for ${stop.name}`} type="number" min={5} max={480} value={stop.duration} onChange={(event) => editStop(stop.id, { duration: Number(event.target.value) })} /></label>
                <label className="field">Day<select aria-label={`Day for ${stop.name}`} disabled={Boolean(stop.fixedTime)} value={stop.day ?? ""} onChange={(event) => editStop(stop.id, { day: event.target.value === "" ? null : Number(event.target.value) })}><option value="">Optimize</option>{Array.from({ length: draft.days }, (_, index) => <option key={index} value={index}>Day {index + 1}</option>)}</select></label>
                <label className="field">Transport<select aria-label={`Transport for ${stop.name}`} value={stop.mode} onChange={(event) => editStop(stop.id, { mode: event.target.value as Stop["mode"] })}><option value="AUTO">Trip default</option><option value="WALK">Walking only</option><option value="TRANSIT">Public transit</option></select></label>
              </div>
              <div className="planning-visit-options"><label className="checkbox"><input type="checkbox" aria-label={`Optional ${stop.name}`} disabled={Boolean(stop.fixedTime)} checked={stop.optional} onChange={(event) => editStop(stop.id, { optional: event.target.checked })} />Optional</label>
                {!stop.fixedTime && <label className="checkbox"><input type="checkbox" aria-label={`Research timing for ${stop.name}`} checked={researchIds.includes(stop.id)} disabled={!researchIds.includes(stop.id) && researchIds.length >= 5} onChange={(event) => { setResearchIds((current) => event.target.checked ? [...current, stop.id] : current.filter((id) => id !== stop.id)); setConsent(false); setTiming(null); }} />Research timing</label>}
              </div>
              {recommendation && timing && <div className="timing-suggestion"><strong>Suggested: {recommendation.duration} min</strong><p>{recommendation.reason}</p>{recommendation.bestTime && <p>Time-of-day advice (not scheduled): {recommendation.bestTime}</p>}<div className="timing-links">{recommendation.sourceIndexes.map((index) => timing.sources[index] && <a key={index} href={timing.sources[index].url} target="_blank" rel="noopener noreferrer">{timing.sources[index].title}<ArrowUpRight size={12} /></a>)}</div><button className="text-button" onClick={() => editStop(stop.id, { duration: recommendation.duration })}><Check size={14} />Use {recommendation.duration} min for {stop.name}</button></div>}
            </div>;
          })}
        </div>
        <div className="planning-section timing-research">
          <h3>Optional timing research <span>{researchIds.length}/5 selected</span></h3>
          {!canResearch && <p className="notice">Timing research requires sign-in, Neon quota tracking, and a Gemini key.</p>}
          <label className="checkbox consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />Send selected place names and city to Gemini and Google Search. Paid usage and provider retention policies apply.</label>
          <button className="button secondary" disabled={!consent || !researchIds.length} onClick={() => void research()}><Search size={15} />Research selected timings</button>
          {timing && <><p className="quiet">{timing.recommendations.length} timing suggestions. Opening hours and ticket conditions still need checking.</p><details className="research-evidence"><summary>Google Search evidence</summary><p>{timing.research}</p><ul>{timing.sources.map((source, index) => <li key={index}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a></li>)}</ul></details>{timing.searchEntryPoint && <iframe title="Google Search suggestions" className="search-attribution" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={timing.searchEntryPoint} />}</>}
        </div>
      </fieldset>
      {!confirmed && <p className="notice warning">Confirm the hotel and every place on the map before optimizing.{unconfirmed.length > 0 && ` Not confirmed yet: ${unconfirmed.join(", ")}.`}</p>}
      {!canPlan && <p className="notice">Google route planning requires sign-in, Neon quota tracking, and the Maps server key.</p>}
      <div className="dialog-actions planning-actions"><button className="button secondary" disabled={Boolean(busy)} onClick={() => apply()}><Check size={15} />Apply preferences</button><button className="button primary" disabled={Boolean(busy) || !confirmed} onClick={() => void optimize()}><Route size={16} />Optimize preview</button></div>
    </> : preview && <>
      <div className="plan-preview" aria-label="Suggested itinerary">
        {preview.schedule.days.map((day) => {
          const travel = day.visits.reduce((total, visit) => total + visit.leg.minutes, day.returnLeg?.minutes ?? 0);
          const visitMinutes = day.visits.reduce((total, visit) => total + visit.end - visit.start, 0);
          return <section className="plan-preview-day" key={day.day}><h3>Day {day.day + 1} <span>{day.date}</span></h3><p className="quiet">{day.visits.length} places / {Math.round(visitMinutes)} min visiting / {travel} min travel</p><ol>{day.visits.map((visit) => <li key={visit.stopId}><span className="preview-time">{formatMinute(draft, day.day, visit.start)} - {formatMinute(draft, day.day, visit.end)}</span><div><strong>{draft.stops.find((stop) => stop.id === visit.stopId)?.name}</strong><small>{visit.leg.mode === "WALK" ? <Footprints size={13} /> : <TrainFront size={13} />}{visit.leg.mode === "WALK" ? "Walk" : "Public transit"} {visit.leg.minutes} min{draft.stops.find((stop) => stop.id === visit.stopId)?.fixedTime && <LockKeyhole size={12} />}</small></div></li>)}</ol>{day.returnLeg && <p className="quiet">Return to {draft.hotel}: {day.returnLeg.mode === "WALK" ? "walk" : "public transit"}, {day.returnLeg.minutes} min</p>}{!day.visits.length && <p className="quiet">No places assigned.</p>}</section>;
        })}
      </div>
      {!!preview.schedule.omitted.length && <div className="notice warning"><strong>Optional places not scheduled</strong><ul>{preview.schedule.omitted.map((id) => <li key={id}>{draft.stops.find((stop) => stop.id === id)?.name}</li>)}</ul></div>}
      <div className="route-notices">{preview.schedule.warnings.map((warning) => <p key={warning}>{warning}</p>)}<p>Walking routes may lack pedestrian paths. Transit can include walking to stations.</p><span>Route information: Google Maps</span></div>
      <div className="dialog-actions planning-actions"><button className="button secondary" disabled={Boolean(busy)} onClick={() => setStage("preferences")}><Settings2 size={15} />Adjust preferences</button><button className="button primary" disabled={Boolean(busy)} onClick={() => apply(preview)}><Check size={15} />Use this plan</button></div>
    </>}
  </Dialog>;
}