"use client";

import { useEffect, useRef, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import { Check, Clock3, Footprints, LocateFixed, PencilLine, RefreshCw, Route, SkipForward, TrainFront, Undo2, X } from "lucide-react";
import { Dialog } from "./Dialog";
import { dayProgressSchema, liveCheckIsFresh, liveRouteKey, recoveryContext, recoveryInputErrors, recoveryMinute, recoveryPlanKey, remainingIds, validateDayRecovery, type CheckedNextRoute, type DayProgress, type RecoveryOption, type RecoveryRequest, type RecoveryResult } from "@/lib/day-recovery";
import { formatMinute, instantForMinute, minuteAt, type DayPlan, type Trip } from "@/lib/trip";

type Props = { trip: Trip; day: number; stopIds: string[]; progress: DayProgress; plannedDay?: DayPlan; selectedRoute?: CheckedNextRoute; onClearRoute: () => void; onProgress: (progress: DayProgress) => void; onApply: (request: RecoveryRequest, option: RecoveryOption, checkedAt: string) => void; onRoute: (route: CheckedNextRoute) => void; onClose: () => void };

export function DayRecoveryDialog({ trip, day, stopIds, progress, plannedDay, selectedRoute, onClearRoute, onProgress, onApply, onRoute, onClose }: Props) {
  const nowMinute = () => Math.ceil(recoveryMinute(trip, day, Temporal.Now.instant().toString()));
  const [ready, setReady] = useState(() => formatMinute(trip, day, Math.max(nowMinute(), progress.readyAt ?? 0)));
  const [origin, setOrigin] = useState(selectedRoute?.origin.id ?? progress.originId);
  const [location, setLocation] = useState<{ lat: number; lng: number } | undefined>(selectedRoute?.origin.location);
  const [locationNote, setLocationNote] = useState("");
  const [minimums, setMinimums] = useState<Record<string, number>>({});
  const [skipIds, setSkipIds] = useState<string[]>([]);
  const [target, setTarget] = useState(() => selectedRoute?.edge.to ?? remainingIds(stopIds, progress)[0] ?? "hotel");
  const [completion, setCompletion] = useState<{ id: string; start: string; end: string }>();
  const [preview, setPreview] = useState<RecoveryResult>();
  const [issued, setIssued] = useState<RecoveryRequest>();
  const [routeChoice, setRouteChoice] = useState(selectedRoute?.edge);
  const [routeCheckedAt, setRouteCheckedAt] = useState(selectedRoute?.checkedAt);
  const [routeDeparture, setRouteDeparture] = useState(selectedRoute?.departureAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const version = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const pending = remainingIds(stopIds, progress);
  const name = (id: string) => id === "hotel" ? trip.hotel : trip.stops.find((stop) => stop.id === id)?.name ?? "Removed visit";
  const mismatch = progress.planKey !== recoveryPlanKey(trip, day, stopIds);
  const nextBooking = trip.stops.filter((stop) => pending.includes(stop.id) && stop.fixedTime).sort((left, right) => minuteAt(trip, day, left.fixedTime!) - minuteAt(trip, day, right.fixedTime!))[0];
  useEffect(() => () => { version.current++; abort.current?.abort(); }, []);

  function invalidate(clearRoute = false) {
    version.current++; abort.current?.abort(); setBusy(false); setPreview(undefined); setIssued(undefined); setError("");
    if (clearRoute) { setRouteChoice(undefined); setRouteCheckedAt(undefined); setRouteDeparture(undefined); onClearRoute(); }
  }
  function record(patch: Partial<DayProgress>) {
    invalidate(true);
    const next = dayProgressSchema.parse({ ...progress, ...patch, version: progress.version + 1 });
    onProgress(next);
  }
  function extraTime(minutes: number) {
    const minute = Math.max(nowMinute(), minuteAt(trip, day, ready), progress.readyAt ?? 0) + minutes;
    setReady(formatMinute(trip, day, minute)); record({ readyAt: minute });
  }
  function completeVisit() {
    if (!completion) return;
    try {
      const start = minuteAt(trip, day, completion.start); const end = minuteAt(trip, day, completion.end);
      if (end < start || end > nowMinute() || progress.completed.some((visit) => visit.stopId !== completion.id && start < visit.end && end > visit.start)) throw new Error("Actual visit times overlap or are in the future.");
      const correction = progress.completed.some((visit) => visit.stopId === completion.id);
      record({ completed: [...progress.completed.filter((visit) => visit.stopId !== completion.id), { stopId: completion.id, start, end }].sort((left, right) => left.start - right.start), ...(!correction ? { originId: completion.id } : {}), readyAt: Math.max(end, progress.readyAt ?? 0) });
      if (!correction) { setOrigin(completion.id); setLocation(undefined); }
      setReady(formatMinute(trip, day, Math.max(nowMinute(), end, progress.readyAt ?? 0))); setCompletion(undefined);
      if (target === completion.id) setTarget(pending.find((id) => id !== completion.id) ?? "hotel");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Check actual visit times."); }
  }
  async function submit(mode: "route" | "replan") {
    invalidate();
    const currentVersion = version.current;
    const controller = new AbortController(); abort.current = controller;
    try {
      if (mode === "replan" && routeChoice && (!routeCheckedAt || !routeDeparture || !liveCheckIsFresh(routeCheckedAt, routeDeparture))) throw new Error("The selected next route is stale. Refresh it or clear its preference.");
      const departure = Math.max(nowMinute(), minuteAt(trip, day, ready), progress.readyAt ?? 0);
      const request: RecoveryRequest = { trip, day, stopIds, progress, origin: { id: origin, ...(location ? { location } : {}) }, departureAt: instantForMinute(trip, day, departure).toString(), operationId: crypto.randomUUID(), mode, targetId: target === "hotel" || pending.includes(target) ? target : pending[0] ?? "hotel", permissions: mode === "route" ? { skipIds: [], minimumDurations: {} } : { skipIds: skipIds.filter((id) => pending.includes(id)), minimumDurations: Object.fromEntries(Object.entries(minimums).filter(([id]) => pending.includes(id))) }, ...(mode === "replan" && routeChoice ? { preferredRoute: { to: routeChoice.to, key: liveRouteKey(routeChoice) } } : {}) };
      const errors = recoveryInputErrors(request);
      if (errors.length) throw new Error(errors.join(" "));
      setBusy(true); setReady(formatMinute(trip, day, departure));
      const response = await fetch("/api/day-recovery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Live recovery failed.");
      if (currentVersion !== version.current || result.context !== recoveryContext(request)) return;
      setPreview(result); setIssued(request);
    } catch (cause) { if (currentVersion === version.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Live recovery failed."); }
    finally { if (currentVersion === version.current) setBusy(false); }
  }
  function apply(option: RecoveryOption) {
    if (!issued || !preview) return;
    const errors = validateDayRecovery(issued, option);
    if (preview.status !== "recovery-checked" || progress.version !== issued.progress.version || !liveCheckIsFresh(preview.checkedAt, issued.departureAt)) errors.push("This preview is stale. Replan from the current time.");
    if (errors.length) { setError(errors.join(" ")); return; }
    try { onApply(issued, option, preview.checkedAt); invalidate(true); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The day changed. Refresh the preview."); }
  }

  return <Dialog title="Today" onClose={onClose} className="planning-dialog recovery-dialog">
    <p className="planning-context">{progress.date} · {progress.completed.length} completed · {pending.length} remaining</p>
    {error && <p className="notice error" role="alert">{error}</p>}
    {mismatch && <div className="notice warning"><p>The trip changed. Your completed and skipped visits are kept.</p><button className="button secondary" onClick={() => {
      if (progress.timeZone && progress.timeZone !== trip.timeZone && (progress.completed.length || progress.readyAt !== null)) { setError(`Actual progress uses ${progress.timeZone}. Restore that city timezone before reconciling.`); return; }
      if (progress.completed.some((visit) => !stopIds.includes(visit.stopId))) { setError("A completed visit is missing from the approved day. Restore that visit before reconciling."); return; }
      if (window.confirm("Update today with the new trip settings? Completed and skipped visits are kept. Changes to remaining visits will be cleared.")) record({ planKey: recoveryPlanKey(trip, day, stopIds), baselineStopIds: stopIds, timeZone: trip.timeZone, remaining: undefined, previousRemaining: undefined, undoAvailable: false });
    }}><RefreshCw size={15} />Update today</button></div>}
    <fieldset className="planning-inputs" disabled={mismatch}>
      <div className="form-grid"><label className="field">Current location<select value={origin} onChange={(event) => { setOrigin(event.target.value); setLocation(undefined); setLocationNote(""); record({ originId: event.target.value }); }}><option value="hotel">{trip.hotel}</option>{trip.stops.map((stop) => <option key={stop.id} value={stop.id}>{stop.name}</option>)}</select></label><label className="field">Ready to leave<input type="time" value={ready} onChange={(event) => { setReady(event.target.value); if (event.target.value) record({ readyAt: minuteAt(trip, day, event.target.value) }); else invalidate(true); }} /></label></div>
      <div className="recovery-toolbar"><button className="button secondary small" onClick={() => extraTime(10)}><Clock3 size={15} />+10 min</button><button className="button secondary small" onClick={() => extraTime(20)}><Clock3 size={15} />+20 min</button><button className="button secondary small" onClick={() => {
        invalidate(true);
        if (!navigator.geolocation) { setError("Device location is unavailable. Select a place instead."); return; }
        const currentVersion = version.current;
        navigator.geolocation.getCurrentPosition((position) => { if (version.current !== currentVersion) return; if (position.coords.accuracy > 200) { setError("Device location is too imprecise. Select a place instead."); return; } setLocation({ lat: position.coords.latitude, lng: position.coords.longitude }); setLocationNote(`Device location, accuracy ${Math.round(position.coords.accuracy)} m`); }, () => { if (version.current === currentVersion) setError("Device location was denied or unavailable. Select a place instead."); }, { timeout: 10_000, maximumAge: 0, enableHighAccuracy: true });
      }}><LocateFixed size={15} />Use device location</button></div>
      {locationNote && <p className="notice" role="status">{locationNote}</p>}
      <div className="planning-section"><h3>Visits</h3>
        {progress.completed.map((visit) => <div key={visit.stopId} className="recovery-fact"><Check size={14} /><span>{name(visit.stopId)} · {formatMinute(trip, day, visit.start)} - {formatMinute(trip, day, visit.end)}</span><button className="icon-button" title={`Edit actual times for ${name(visit.stopId)}`} aria-label={`Edit actual times for ${name(visit.stopId)}`} onClick={() => { invalidate(); setCompletion({ id: visit.stopId, start: formatMinute(trip, day, visit.start), end: formatMinute(trip, day, visit.end) }); }}><PencilLine size={15} /></button></div>)}
        {[...progress.skipped, ...(progress.remaining?.skipped ?? [])].map((id) => <p key={id} className="recovery-fact"><SkipForward size={14} />{name(id)} · {progress.missedBookings.includes(id) ? "Missed booking" : "Skipped"}</p>)}
        {pending.map((id) => { const stop = trip.stops.find((stop) => stop.id === id); if (!stop) return <p className="notice warning" key={id}>A saved visit was removed. Restore it before replanning.</p>; const duration = progress.remaining?.durations[id] ?? stop.duration;
          return <div key={id} className="planning-visit"><div className="planning-visit-heading"><strong>{stop.name}</strong><span className="quiet">{duration} min{stop.fixedTime ? ` · Booked ${stop.fixedTime}` : ""}</span></div>
            <div className="recovery-toolbar"><button className="button secondary small" onClick={() => { invalidate(); setCompletion({ id, start: formatMinute(trip, day, Math.min(nowMinute(), plannedDay?.visits.find((visit) => visit.stopId === id)?.start ?? Math.max(0, nowMinute() - duration))), end: formatMinute(trip, day, nowMinute()) }); }}><Check size={15} />Done</button><button className="button secondary small" onClick={() => { if (!window.confirm(stop.fixedTime ? `Record ${stop.name} as a missed booking? This does not cancel its ticket.` : `Record ${stop.name} as skipped today?`)) return; record({ skipped: [...progress.skipped, id], ...(stop.fixedTime ? { missedBookings: [...progress.missedBookings, id] } : {}) }); if (target === id) setTarget(pending.find((entry) => entry !== id) ?? "hotel"); }}><SkipForward size={15} />{stop.fixedTime ? "Record missed booking" : "Skip visit"}</button></div>
            {!stop.fixedTime && <div className="recovery-permissions"><label className="checkbox"><input type="checkbox" checked={skipIds.includes(id)} onChange={(event) => { invalidate(); setSkipIds(event.target.checked ? [...skipIds, id] : skipIds.filter((entry) => entry !== id)); }} />Allow skipping {stop.name}</label><label className="field">Minimum minutes for {stop.name}<input type="number" min={5} max={duration} step={1} value={minimums[id] ?? duration} onChange={(event) => { invalidate(); setMinimums({ ...minimums, [id]: Number(event.target.value) }); }} /></label><div className="recovery-toolbar">{[10, 20].map((percent) => <button key={percent} className="button secondary small" title={`${percent}% shorter for ${stop.name}`} onClick={() => { invalidate(); setMinimums({ ...minimums, [id]: Math.max(5, Math.ceil(duration * (100 - percent) / 100)) }); }}>{percent}% shorter</button>)}{duration === 15 && <button className="button secondary small" onClick={() => { invalidate(); setMinimums({ ...minimums, [id]: 10 }); }}>10 min</button>}</div></div>}
          </div>;
        })}
        {completion && <div className="planning-visit"><strong>Actual times: {name(completion.id)}</strong><div className="form-grid"><label className="field">Actual start<input type="time" value={completion.start} onChange={(event) => setCompletion({ ...completion, start: event.target.value })} /></label><label className="field">Actual finish<input type="time" value={completion.end} onChange={(event) => setCompletion({ ...completion, end: event.target.value })} /></label></div><div className="recovery-toolbar"><button className="button primary small" onClick={completeVisit}><Check size={15} />Confirm completed visit</button><button className="button secondary small" onClick={() => setCompletion(undefined)}>Cancel</button></div></div>}
      </div>
      {nextBooking && <p className="notice">Next booking: {nextBooking.name} at {nextBooking.fixedTime}. Arrival deadline {formatMinute(trip, day, minuteAt(trip, day, nextBooking.fixedTime!) - nextBooking.buffer)}; travel still needs checking.</p>}
      {routeChoice && <div className="notice"><p>Selected next route: {name(routeChoice.to)} · {routeChoice.mode === "WALK" ? "Walk" : "Transit"} · {routeChoice.minutes} min</p><button className="button secondary small" onClick={() => invalidate(true)}><X size={14} />Clear route preference</button></div>}
      <label className="field">Next destination<select value={target === "hotel" || pending.includes(target) ? target : pending[0] ?? "hotel"} onChange={(event) => { invalidate(true); setTarget(event.target.value); }}>{pending.map((id) => <option key={id} value={id}>{name(id)}</option>)}<option value="hotel">Return to {trip.hotel}</option></select></label>
      <div className="recovery-toolbar"><button className="button secondary" disabled={busy} onClick={() => void submit("route")}><RefreshCw size={16} />Leave now / Refresh route</button><button className="button primary" disabled={busy} onClick={() => void submit("replan")}><Route size={16} />{busy ? "Checking..." : "Replan today"}</button></div>
    </fieldset>
    <p className="provider-attribution">Google Maps · Route refresh: 3 service units · Replan: 30</p>
    {preview?.message && <p className="notice warning" role="status">{preview.message}</p>}
    {preview && <p className="quiet">Checked with Google at {new Date(preview.checkedAt).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", timeZone: trip.timeZone })}. Transit times remain estimates.</p>}
    {preview?.routes?.map((edge, index) => <div className="planning-visit" key={index}><label className="checkbox"><input type="radio" name="live-route" checked={routeChoice === edge} onChange={() => { setRouteChoice(edge); setRouteCheckedAt(preview.checkedAt); setRouteDeparture(issued!.departureAt); }} />{edge.mode === "WALK" ? <Footprints size={16} /> : <TrainFront size={16} />}{edge.mode === "WALK" ? "Walk" : "Transit"} · {edge.minutes} min · {(edge.meters / 1000).toFixed(1)} km</label>{edge.steps?.map((step, stepIndex) => <p className="quiet" key={stepIndex}>{step.line ? `${step.line}: ${step.from ?? ""} to ${step.to ?? ""}` : step.instruction}</p>)}{edge.fare && <p className="quiet">Estimated fare: {edge.fare}</p>}<button className="button secondary small" disabled={routeChoice !== edge} onClick={() => { if (!liveCheckIsFresh(preview.checkedAt, issued!.departureAt)) { setError("The route is stale. Refresh it first."); return; } onRoute({ edge, origin: issued!.origin, checkedAt: preview.checkedAt, departureAt: issued!.departureAt }); }}><Check size={15} />Use this route</button></div>)}
    {preview?.options?.map((option, index) => <section className="planning-section recovery-option" key={index}><h3>{option.label}</h3><ol>{option.day.visits.map((visit) => { const stop = trip.stops.find((stop) => stop.id === visit.stopId)!; const old = progress.remaining?.durations[stop.id] ?? stop.duration; return <li key={visit.stopId}>{name(visit.stopId)} · {formatMinute(trip, day, visit.start)} - {formatMinute(trip, day, visit.end)}{option.durations[stop.id] < old ? ` · Shortened from ${old} to ${option.durations[stop.id]} min` : ""}{stop.fixedTime ? ` · Booking buffer ${stop.buffer} min` : ""}</li>; })}</ol>{option.skipped.length > 0 && <p className="notice warning">Skip: {option.skipped.map(name).join(", ")}</p>}{option.day.returnLeg && <p>Hotel return {formatMinute(trip, day, (option.day.visits.at(-1)?.end ?? recoveryMinute(trip, day, issued!.departureAt)) + option.day.returnLeg.minutes)}</p>}<button className="button primary" onClick={() => apply(option)}><Check size={16} />Use this plan</button></section>)}
    <div className="dialog-actions">{progress.undoAvailable && <button className="button secondary" onClick={() => record({ remaining: progress.previousRemaining, previousRemaining: undefined, undoAvailable: false })}><Undo2 size={16} />Undo last change</button>}<button className="button secondary" onClick={() => { abort.current?.abort(); onClose(); }}>Keep current plan</button></div>
  </Dialog>;
}