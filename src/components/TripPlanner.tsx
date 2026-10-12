"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { signIn, signOut } from "next-auth/react";
import { ZodError } from "zod";
import { ArrowDown, ArrowUp, ArrowUpRight, CalendarDays, Check, ChevronDown, Compass, Download, FileInput, FolderOpen, Footprints, Hotel, List, LoaderCircle, LockKeyhole, Map, MapPin, Plus, Route, Save, Search, Settings2, ShieldCheck, TrainFront, Trash2, UserRound, X } from "lucide-react";
import { Dialog } from "./Dialog";
import { ImportReview } from "./ImportReview";
import { TripMap } from "./TripMap";
import { NewTripDialog } from "./NewTripDialog";
import { asJourney, cityPreset, journeySchema, popularCities, restoreJourney, type Journey, type StoredTrip } from "@/lib/journey";
import { changeStartDate, formatMinute, newStop, newTrip, persistedPlan, tripDate, tripSchema, type Place, type PlanResult, type SavedPlan, type Stop, type TravelEdge, type Trip } from "@/lib/trip";

export type AppConfig = { auth: boolean; database: boolean; maps: boolean; routes: boolean; ai: boolean; email: string | null };
type SavedTrip = { data: StoredTrip; revision: number; plan: SavedPlan | null; updatedAt: string };

async function requestJson(url: string, body?: unknown, method = "POST") {
  const response = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(data?.error ?? "The request failed.");
  return data;
}

export function TripPlanner({ initialTrip, initialSaved, config }: { initialTrip: Trip; initialSaved: SavedTrip | null; config: AppConfig }) {
  const [restored] = useState(() => { const parsed = initialSaved ? journeySchema.safeParse(asJourney(initialSaved.data, initialSaved.plan)) : null; return parsed?.success ? parsed.data : null; });
  const [journey, setJourney] = useState(() => restored ?? asJourney(initialTrip));
  const [activeCity, setActiveCity] = useState(() => (restored ?? asJourney(initialTrip)).cities[0].id);
  const trip = journey.cities.find((city) => city.id === activeCity) ?? journey.cities[0];
  const [revision, setRevision] = useState(restored && initialSaved ? initialSaved.revision : 0);
  const [savedFor, setSavedFor] = useState(restored ? JSON.stringify(restored) : "");
  const [placeState, setPlaces] = useState<Record<string, Place>>({});
  const places = useMemo(() => {
    const stored: Record<string, Place> = {};
    if (trip.hotelPlaceId && trip.hotelLocation) stored.hotel = { id: trip.hotelPlaceId, name: trip.hotel, address: "", location: trip.hotelLocation };
    for (const stop of trip.stops) if (stop.placeId && stop.location) stored[stop.id] = { id: stop.placeId, name: stop.name, address: "", location: stop.location };
    return { ...stored, ...placeState };
  }, [trip, placeState]);
  const [result, setResult] = useState<PlanResult | null>(null);
  const [plannedFor, setPlannedFor] = useState("");
  const savedPlan = journey.plans[trip.id] ?? null;
  const [day, setDay] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "map">("list");
  const [tab, setTab] = useState<"places" | "itinerary">("places");
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [setup, setSetup] = useState<"new" | "add" | null>(null);
  const [savedTrips, setSavedTrips] = useState<SavedTrip[] | null>(null);
  const [search, setSearch] = useState<{ id: string; query: string } | null>(null);
  const [matches, setMatches] = useState<Place[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [adding, setAdding] = useState("");
  const backupInput = useRef<HTMLInputElement>(null);
  const editVersion = useRef(0);
  const cityViews = useRef<Record<string, { places: Record<string, Place>; result: PlanResult | null; plannedFor: string }>>({});
  const snapshot = JSON.stringify(journey);
  const stale = Boolean(result && plannedFor !== JSON.stringify(trip));
  const canUseServices = Boolean(config.email && config.database);
  const canPlan = canUseServices && config.routes;
  const saving = useRef(false);

  useEffect(() => {
    if (!canUseServices || snapshot === savedFor || busy) return;
    const parsed = journeySchema.safeParse(journey);
    if (!parsed.success) return;
    const timer = setTimeout(async () => {
      if (saving.current) return;
      saving.current = true;
      try {
        const response = await requestJson(`/api/trips/${journey.id}`, { journey: parsed.data, revision }, "PUT");
        setRevision(response.revision); setSavedFor(snapshot);
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Autosave failed."); }
      finally { saving.current = false; }
    }, 1500);
    return () => clearTimeout(timer);
  }, [snapshot, savedFor, busy, canUseServices, revision, journey]);
  const currentDay = result?.schedule.days.find((entry) => entry.day === day);
  const plannedCount = result?.schedule.days.reduce((sum, entry) => sum + entry.visits.length, 0) ?? 0;

  function setTrip(update: Trip | ((current: Trip) => Trip)) {
    setJourney((current) => {
      const plans = { ...current.plans }; delete plans[trip.id];
      return { ...current, plans, cities: current.cities.map((city) => city.id === trip.id ? typeof update === "function" ? update(city) : update : city) };
    });
  }

  function switchCity(cityId: string) {
    if (busy || cityId === trip.id) return;
    cityViews.current[trip.id] = { places, result, plannedFor };
    const cached = cityViews.current[cityId];
    editVersion.current += 1; setActiveCity(cityId); setPlaces(cached?.places ?? {}); setResult(cached?.result ?? null); setPlannedFor(cached?.plannedFor ?? "");
    setDay(0); setSelected(null); setTab("places"); setView("list"); setAdding(""); setError(""); setNotice(""); setSearch(null);
  }

  function openJourney(next: Journey, savedRevision = 0, saved = false) {
    editVersion.current += 1; cityViews.current = {};
    setJourney(next); setActiveCity(next.cities[0].id); setRevision(savedRevision); setSavedFor(saved ? JSON.stringify(next) : "");
    setResult(null); setPlaces({}); setPlannedFor(""); setSelected(null); setDay(0); setTab("places"); setView("list"); setAdding("");
    setSetup(null); setSettingsOpen(false); setSavedTrips(null); setSearch(null); setNotice(""); setError("");
  }

  function confirmDiscard() {
    return snapshot === savedFor || (journey.cities.length === 1 && !trip.city && !trip.hotel && !trip.stops.length && journey.title === "Untitled trip") || window.confirm("Replace this unsaved trip? Save or export all cities first.");
  }

  function edit(patch: Partial<Trip>) { editVersion.current += 1; setTrip((current) => ({ ...current, ...patch })); setNotice(""); }
  function editStop(id: string, patch: Partial<Stop>) { editVersion.current += 1; setTrip((current) => ({ ...current, stops: current.stops.map((stop) => stop.id === id ? { ...stop, ...patch } : stop) })); }

  async function perform(label: string, action: () => Promise<void>) {
    setBusy(label); setError(""); setNotice("");
    try { await action(); } catch (cause) { setError(cause instanceof ZodError ? cause.issues[0].message : cause instanceof Error ? cause.message : "Something went wrong."); }
    finally { setBusy(null); }
  }

  function addPlace() {
    if (!adding.trim()) return;
    if (trip.stops.length >= 25) { setError("A city can contain at most 25 stops."); return; }
    const stop = newStop(adding.trim());
    edit({ stops: [...trip.stops, stop] });
    setAdding(""); setSelected(stop.id);
  }

  async function findPlaces(query: string) {
    await perform("Finding places", async () => {
      if (!canUseServices || !config.routes) throw new Error("Hotel and place search requires Google sign-in, Neon, and the Google Places server key.");
      if (!query.trim()) throw new Error("Enter a hotel name or address.");
      setMatches((await requestJson("/api/places", { query })).places); setHasSearched(true);
    });
  }

  function openSearch(id: string, query: string) {
    const text = `${query} ${trip.city}`.trim().slice(0, 350);
    setMatches([]); setHasSearched(false); setError(""); setSearch({ id, query: text }); void findPlaces(text);
  }

  async function confirmPlace(place: Place) {
    if (!search) return;
    const id = search.id;
    const version = editVersion.current;
    await perform("Confirming place", async () => {
      const detailed: Place = id === "hotel" ? (await requestJson("/api/places", { placeId: place.id })).place : place;
      if (version !== editVersion.current) throw new Error("The trip changed while the place was loading. Confirm the location again.");
      setPlaces((current) => ({ ...current, [id]: detailed }));
      if (id === "hotel") edit({ hotelPlaceId: detailed.id, hotelLocation: detailed.location, ...(detailed.timeZone ? { timeZone: detailed.timeZone } : {}) });
      else editStop(id, { placeId: detailed.id, location: detailed.location });
      setSearch(null);
    });
  }

  async function save() {
    if (!config.email) { setSettingsOpen(true); return; }
    await perform("Saving", async () => {
      const validated = journeySchema.parse(journey);
      const response = await requestJson(`/api/trips/${journey.id}`, { journey: validated, revision }, "PUT");
      setRevision(response.revision); setSavedFor(JSON.stringify(validated)); setNotice("All cities saved to Neon.");
    });
  }

  async function generate() {
    if (!canPlan) { setSettingsOpen(true); return; }
    await perform("Planning your days", async () => {
      const version = editVersion.current;
      journeySchema.parse(journey);
      const validated = tripSchema.parse(trip);
      const response: PlanResult = await requestJson("/api/plan", { trip: validated, operationId: crypto.randomUUID() });
      if (version !== editVersion.current) throw new Error("The trip changed while planning. Your edits were kept; generate a new route.");
      setResult(response); setPlaces(response.places); setPlannedFor(JSON.stringify(validated)); setTab("itinerary"); setDay(0);
      setJourney((current) => ({ ...current, plans: { ...current.plans, [trip.id]: persistedPlan(response.schedule) } }));
      setNotice("Travel times checked. Review venue opening hours before departure.");
    });
  }

  function loadSaved(entry: SavedTrip) {
    if (!confirmDiscard()) return;
    openJourney(journeySchema.parse(asJourney(entry.data, entry.plan)), entry.revision, true);
    setNotice("Trip loaded. Refresh routes for current travel times.");
  }

  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ journey, ...(journey.cities.length === 1 ? { trip: { ...trip, title: journey.title }, plan: savedPlan } : {}) }, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "traveller-trip.json"; anchor.click(); URL.revokeObjectURL(url);
  }

  return <div className="app-shell">
    <header className="app-header">
      <Link className="brand" href="/" aria-label="Traveller home"><span className="brand-mark"><Compass size={23} /></span>traveller<span className="brand-dot">.</span></Link>
      <nav aria-label="Main navigation"><button className="nav-button active" aria-label="My trips" title="My trips" disabled={Boolean(busy)} onClick={() => void perform("Loading trips", async () => {
        if (!canUseServices) { setSettingsOpen(true); return; }
        setSavedTrips((await requestJson("/api/trips", undefined, "GET")).trips);
      })}><FolderOpen size={17} /><span>My trips</span></button><button className="nav-button new-trip-trigger" aria-label="New trip" title="New trip" disabled={Boolean(busy)} onClick={() => setSetup("new")}><Plus size={17} /><span>New trip</span></button></nav>
      <div className="header-actions"><button className="icon-button" title="Connections and settings" aria-label="Connections and settings" onClick={() => setSettingsOpen(true)}><Settings2 size={18} /></button><span className="header-divider" />{config.email ? <button className="account-button" title={config.email} onClick={() => void signOut()}><span className="avatar">{config.email[0].toUpperCase()}</span><span>Sign out</span></button> : <button className="button secondary small" onClick={() => config.auth ? void signIn("google") : setSettingsOpen(true)}><UserRound size={15} />Sign in</button>}</div>
    </header>

    <main className="planner-main">
      <section className="trip-heading">
        <div className="trip-identity"><span className="eyebrow">{journey.cities.length > 1 ? "MULTI-CITY TRIP" : "CITY ITINERARY"}</span><input className="trip-title" aria-label="Trip name" value={journey.title} maxLength={150} onChange={(event) => setJourney((current) => ({ ...current, title: event.target.value }))} /><div className="trip-meta"><span><MapPin size={13} />{journey.cities.length > 1 ? `${journey.cities.length} cities` : trip.city || "Choose a city"}</span><span><CalendarDays size={13} />{journey.cities.reduce((sum, city) => sum + city.days, 0)} city days</span><span className={`save-state ${snapshot === savedFor ? "saved" : ""}`}>{snapshot === savedFor ? "Saved" : "Unsaved draft"}</span></div></div>
        <div className="trip-actions"><button className="icon-button" title="Download trip backup" aria-label="Download trip backup" onClick={download}><Download size={18} /></button><button className="button secondary" disabled={Boolean(busy)} onClick={() => void save()}><Save size={16} /><span>Save trip</span></button><button className="button primary" disabled={Boolean(busy) || !trip.stops.length} onClick={() => void generate()}>{busy === "Planning your days" ? <LoaderCircle size={16} className="spin" /> : <Route size={16} />}<span>{busy === "Planning your days" ? "Planning..." : "Plan my days"}</span></button></div>
      </section>

      {(error || notice) && <div className={`banner ${error ? "error" : "success"}`} role={error ? "alert" : "status"}><span>{error || notice}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => { setError(""); setNotice(""); }}><X size={16} /></button></div>}

      <div className="journey-cities"><div className="city-tabs" aria-label="Trip cities">{journey.cities.map((city) => <button key={city.id} disabled={Boolean(busy)} aria-pressed={trip.id === city.id} onClick={() => switchCity(city.id)}><MapPin size={15} /><span><strong>{city.city || "First city"}</strong><small>{city.startDate} to {tripDate(city, city.days - 1)}</small></span></button>)}</div><div className="row"><button className="text-button" disabled={Boolean(busy) || journey.cities.length >= 10} onClick={() => setSetup(journey.cities.length === 1 && !trip.city.trim() ? "new" : "add")}><Plus size={15} />Add cities</button>{journey.cities.length > 1 && <button className="icon-button danger" title="Remove current city" aria-label="Remove current city" disabled={Boolean(busy)} onClick={() => {
        if (!window.confirm(`Remove ${trip.city} and its places from this trip?`)) return;
        const nextCity = journey.cities.find((city) => city.id !== trip.id)!; switchCity(nextCity.id);
        setJourney((current) => { const plans = { ...current.plans }; delete plans[trip.id]; return { ...current, cities: current.cities.filter((city) => city.id !== trip.id), plans }; });
        delete cityViews.current[trip.id];
      }}><Trash2 size={15} /></button>}</div></div>

      <div className="workspace-toolbar"><div className="day-tabs" aria-label="Sightseeing day">{Array.from({ length: trip.days }, (_, index) => <button key={index} aria-pressed={day === index} onClick={() => setDay(index)}><span>Day {index + 1}</span><small>{trip.startDate ? new Date(`${tripDate(trip, index)}T12:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" }) : ""}</small></button>)}</div><div className="toolbar-right"><span className="quiet desktop-only">{trip.stops.length} places · {trip.stops.filter((stop) => stop.fixedTime).length} bookings</span><div className="segmented mobile-tabs"><button aria-pressed={view === "list"} onClick={() => setView("list")}><List size={16} />List</button><button aria-pressed={view === "map"} onClick={() => setView("map")}><Map size={16} />Map</button></div></div></div>

      <div className={`workspace mobile-view-${view}`}>
        <section className="planning-panel" aria-label="Trip editor">
          <details className="trip-settings" open>
            <summary><span><Settings2 size={16} />City details</span><ChevronDown size={16} /></summary>
            <div className="settings-content">
              <datalist id="editor-city-presets">{popularCities.map((city) => <option key={city.name} value={`${city.name}, ${city.country}`} />)}</datalist>
              <label className="field">City<input value={trip.city} list="editor-city-presets" maxLength={150} placeholder="e.g. Paris, France" onChange={(event) => {
                const preset = cityPreset(event.target.value);
                edit({ city: event.target.value, hotelPlaceId: null, hotelLocation: undefined, stops: trip.stops.map((stop) => ({ ...stop, placeId: null, location: undefined })), ...(preset ? { timeZone: preset.timeZone } : {}) }); setPlaces({});
              }} /></label>
              <label className="field">Hotel or starting point<div className="input-with-action"><Hotel size={15} /><input value={trip.hotel} maxLength={200} placeholder="Hotel name or address" onChange={(event) => { edit({ hotel: event.target.value, hotelPlaceId: null, hotelLocation: undefined }); setPlaces((current) => { const next = { ...current }; delete next.hotel; return next; }); }} /><button title="Find hotel on map" aria-label="Find hotel on map" disabled={!trip.hotel.trim() || Boolean(busy)} onClick={() => openSearch("hotel", trip.hotel)}>{trip.hotelPlaceId ? <Check size={17} /> : <Search size={17} />}</button></div></label>
              {places.hotel && <div className="confirmed-hotel"><Check size={14} /><span><strong>{places.hotel.name}</strong><small>{places.hotel.address}</small></span></div>}
              <div className="form-grid"><label className="field">Start date<input type="date" value={trip.startDate} onChange={(event) => {
                if (!event.target.value) return;
                try { edit(changeStartDate(trip, event.target.value)); } catch (cause) { setError(cause instanceof Error ? cause.message : "Check booked dates."); }
              }} /></label><label className="field">Days<select value={trip.days} onChange={(event) => {
                const days = Number(event.target.value);
                if (trip.stops.some((stop) => stop.day !== null && stop.day >= days)) { setError("A place is assigned beyond these dates. Adjust its date explicitly first."); return; }
                edit({ days }); setDay(Math.min(day, days - 1));
              }}>{Array.from({ length: 7 }, (_, index) => <option key={index} value={index + 1}>{index + 1} {index === 0 ? "day" : "days"}</option>)}</select></label></div>
              <div className="form-grid"><label className="field">Day starts<input type="time" value={trip.dailyStart} onChange={(event) => edit({ dailyStart: event.target.value })} /></label><label className="field">Day ends<input type="time" value={trip.dailyEnd} onChange={(event) => edit({ dailyEnd: event.target.value })} /></label></div>
              <label className="field">City timezone<input value={trip.timeZone} maxLength={100} placeholder="Europe/Paris" onChange={(event) => edit({ timeZone: event.target.value })} /></label>
              <label className="checkbox"><input type="checkbox" checked={trip.returnToHotel} onChange={(event) => edit({ returnToHotel: event.target.checked })} />Return to hotel each day</label>
            </div>
          </details>

          <div className="section-tabs"><button className={tab === "places" ? "active" : ""} onClick={() => setTab("places")}>Places <span>{trip.stops.length}</span></button><button className={tab === "itinerary" ? "active" : ""} onClick={() => setTab("itinerary")}>Itinerary {result && <span>{plannedCount}</span>}</button><button className="text-button import-trigger" onClick={() => setImportOpen(true)}><FileInput size={15} />Import</button></div>

          {tab === "places" ? <div className="places-editor">
            <form className="add-place" onSubmit={(event) => { event.preventDefault(); addPlace(); }}><MapPin size={17} /><input aria-label="New place name" placeholder="Add a place to visit" value={adding} maxLength={200} onChange={(event) => setAdding(event.target.value)} /><button type="submit" className="icon-button" aria-label="Add place" title="Add place" disabled={!adding.trim() || trip.stops.length >= 25}><Plus size={20} /></button></form>
            {!trip.stops.length && <div className="empty-stops"><span className="empty-icon"><MapPin size={24} strokeWidth={1.4} /></span><h2>Your places, all together</h2><p>No places added yet.</p><button className="button secondary" onClick={() => setImportOpen(true)}><FileInput size={16} />Import itinerary</button></div>}
            <div className="stop-list">{trip.stops.map((stop, index) => <article key={stop.id} className={`stop-item ${selected === stop.id ? "selected" : ""}`}>
              <button className="stop-summary" aria-expanded={selected === stop.id} onClick={() => setSelected(selected === stop.id ? null : stop.id)}><span className={`stop-number ${stop.fixedTime ? "booked" : ""}`}>{index + 1}</span><span className="stop-heading"><strong>{stop.name}</strong><span>{stop.duration} min <span className="dot-separator">·</span> {stop.day === null ? "Flexible day" : `Day ${stop.day + 1}`}{stop.fixedTime && `, ${stop.fixedTime}`}</span></span>{stop.fixedTime ? <LockKeyhole size={15} className="booking-icon" /> : stop.placeId ? <Check size={15} className="confirmed-icon" /> : <span className="unconfirmed-dot" title="Place not yet confirmed" />}<ChevronDown size={14} /></button>
              {selected === stop.id && <div className="stop-details">
                <label className="field">Place name<input value={stop.name} maxLength={200} onChange={(event) => { editStop(stop.id, { name: event.target.value, placeId: null, location: undefined }); setPlaces((current) => { const next = { ...current }; delete next[stop.id]; return next; }); }} /></label>
                <button className="text-button" disabled={Boolean(busy)} onClick={() => openSearch(stop.id, stop.name)}>{stop.placeId ? <Check size={14} /> : <Search size={14} />}{stop.placeId ? "Place confirmed · change" : "Confirm place on map"}</button>
                <div className="form-grid"><label className="field">Visit minutes<input type="number" min={5} max={480} step={5} value={stop.duration} onChange={(event) => editStop(stop.id, { duration: Number(event.target.value) })} /></label><label className="field">Assigned day<select value={stop.day ?? ""} onChange={(event) => editStop(stop.id, { day: event.target.value === "" ? null : Number(event.target.value), ...(event.target.value === "" ? { fixedTime: null } : {}) })}><option value="">Flexible</option>{Array.from({ length: trip.days }, (_, dayIndex) => <option key={dayIndex} value={dayIndex}>Day {dayIndex + 1}</option>)}</select></label></div>
                <label className="checkbox"><input type="checkbox" checked={Boolean(stop.fixedTime)} onChange={(event) => editStop(stop.id, event.target.checked ? { fixedTime: "10:00", day: stop.day ?? day, optional: false } : { fixedTime: null })} /><LockKeyhole size={13} />Fixed booking</label>
                {stop.fixedTime && <div className="form-grid"><label className="field">Booked time<input type="time" value={stop.fixedTime} onChange={(event) => editStop(stop.id, { fixedTime: event.target.value || null })} /></label><label className="field">Arrival buffer (min)<input type="number" min={0} max={120} value={stop.buffer} onChange={(event) => editStop(stop.id, { buffer: Number(event.target.value) })} /></label></div>}
                <label className="field">Transport<select value={stop.mode} onChange={(event) => editStop(stop.id, { mode: event.target.value as Stop["mode"] })}><option value="AUTO">Walking or public transit</option><option value="WALK">Walking only</option><option value="TRANSIT">Public transit</option></select></label>
                <label className="checkbox"><input type="checkbox" checked={stop.optional} disabled={Boolean(stop.fixedTime)} onChange={(event) => editStop(stop.id, { optional: event.target.checked })} />Optional if the day is full</label>
                {stop.source && <blockquote>{stop.source}</blockquote>}
                {stop.sourceUrl && <a className="source-link" href={stop.sourceUrl} target="_blank" rel="noopener noreferrer"><ArrowUpRight size={14} />Source link</a>}
                <div className="stop-detail-actions"><div className="row">{[-1, 1].map((direction) => <button key={direction} className="icon-button" aria-label={direction < 0 ? "Move place up" : "Move place down"} title={direction < 0 ? "Move up" : "Move down"} disabled={index + direction < 0 || index + direction >= trip.stops.length} onClick={() => { const next = [...trip.stops]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; edit({ stops: next }); }}>{direction < 0 ? <ArrowUp size={15} /> : <ArrowDown size={15} />}</button>)}</div><button className="text-button danger" onClick={() => { edit({ stops: trip.stops.filter((entry) => entry.id !== stop.id) }); setPlaces((current) => { const next = { ...current }; delete next[stop.id]; return next; }); }}><Trash2 size={14} />Remove</button></div>
              </div>}
            </article>)}</div>
            {!!trip.stops.length && <p className="list-footnote"><LockKeyhole size={12} />{trip.stops.filter((stop) => stop.fixedTime).length} fixed bookings <span>·</span> {trip.stops.filter((stop) => !stop.placeId).length} places to confirm</p>}
          </div> : <div className="itinerary-content">
            {stale && <p className="notice warning">This itinerary is out of date. Plan again after your changes.</p>}
            {!result || stale ? <div className="empty-stops"><span className="empty-icon"><Route size={25} /></span><h2>{stale ? "Schedule needs refresh" : savedPlan ? "Saved itinerary" : "A day worth taking"}</h2>{savedPlan ? <ol className="saved-order">{savedPlan.days.find((entry) => entry.day === day)?.stopIds.map((id) => <li key={id}>{trip.stops.find((stop) => stop.id === id)?.name ?? "Removed stop"}</li>)}</ol> : <p>{stale ? "Your previous plan is retained until a new one succeeds." : "No schedule generated yet."}</p>}<button className="button primary" disabled={!trip.stops.length || Boolean(busy)} onClick={() => void generate()}><Route size={16} />{savedPlan ? "Refresh travel times" : "Plan my days"}</button></div> : <>
              <div className="itinerary-start"><span className="hotel-marker small"><Hotel size={15} /></span><div><strong>{trip.hotel}</strong><span>Depart {trip.dailyStart}</span></div></div>
              {currentDay?.visits.map((visit, index) => {
                const stop = trip.stops.find((entry) => entry.id === visit.stopId);
                if (!stop) return null;
                return <div key={visit.stopId}><LegDetails edge={visit.leg} places={places} onMode={(mode) => editStop(stop.id, { mode })} /><button className={`itinerary-stop ${selected === stop.id ? "selected" : ""}`} onClick={() => setSelected(stop.id)}><span className="stop-number">{index + 1}</span><span className="stop-heading"><strong>{stop.name}</strong><span>{formatMinute(trip, day, visit.start)} - {formatMinute(trip, day, visit.end)} · {stop.duration} min</span></span>{stop.fixedTime && <LockKeyhole size={15} />}</button></div>;
              })}
              {currentDay?.returnLeg && <><LegDetails edge={currentDay.returnLeg} places={places} /><div className="itinerary-start"><span className="hotel-marker small"><Hotel size={15} /></span><div><strong>Back to {trip.hotel}</strong><span>{formatMinute(trip, day, (currentDay.visits.at(-1)?.end ?? 0) + currentDay.returnLeg.minutes)}</span></div></div></>}
              {!currentDay?.visits.length && <p className="notice">No sights assigned to this day.</p>}
              {!!result.schedule.omitted.length && <div className="notice warning"><strong>Optional places not scheduled</strong><ul>{result.schedule.omitted.map((id) => <li key={id}>{trip.stops.find((stop) => stop.id === id)?.name}</li>)}</ul></div>}
              <div className="route-notices">{result.schedule.warnings.map((warning) => <p key={warning}>{warning}</p>)}<p>Walking routes may lack clear sidewalks or pedestrian paths. Use caution.</p><span>Route information: Google Maps</span></div>
            </>}
          </div>}
        </section>

        <section className="map-panel" aria-label="City map"><TripMap trip={trip} places={places} schedule={tab === "places" || stale ? null : result?.schedule ?? null} day={day} selected={selected} onSelect={setSelected} /><div className="map-heading"><span className="map-heading-dot" /><span>{trip.city || "Your city"}</span><span className="map-heading-divider" />{tab === "places" ? "All places" : `Day ${day + 1}`}</div>{tab === "itinerary" && result && !stale && <div className="map-legend"><span><i className="walking-line" />Walking</span><span><i className="transit-line" />Public transit</span></div>}</section>
      </div>
    </main>

    {importOpen && <ImportReview trip={trip} canExtract={Boolean(canUseServices && config.ai)} onClose={() => setImportOpen(false)} onImport={(stops) => { edit({ stops: [...trip.stops, ...stops] }); setTab("places"); setNotice(`${stops.length} places added. Confirm each place on the map before planning.`); }} />}
    {search && <Dialog title={search.id === "hotel" ? "Find your hotel" : "Confirm location"} onClose={() => setSearch(null)}><form className="search-form" onSubmit={(event) => { event.preventDefault(); void findPlaces(search.query); }}><label className="field grow">Place or address<input autoFocus disabled={Boolean(busy)} maxLength={350} value={search.query} onChange={(event) => { setSearch({ ...search, query: event.target.value }); setMatches([]); setHasSearched(false); }} /></label><button type="submit" className="button primary" disabled={Boolean(busy)}>{busy ? <LoaderCircle size={17} className="spin" /> : <Search size={17} />}Search</button></form>{error && <p className="notice error" role="alert">{error}</p>}{hasSearched && !matches.length && !error && <p className="notice">No matching places found. Try the hotel address or a more specific name.</p>}<div className="place-matches">{matches.map((place) => <button key={place.id} disabled={Boolean(busy)} onClick={() => void confirmPlace(place)}><MapPin size={19} /><span><strong>{place.name}</strong><small>{place.address}</small></span><ArrowUpRight size={17} /></button>)}</div><p className="provider-attribution">Google Maps</p></Dialog>}
    {settingsOpen && <Dialog title="Connections" onClose={() => setSettingsOpen(false)}><div className="connection-list">{[{ label: "Google sign-in", ready: config.auth }, { label: "Neon database", ready: config.database }, { label: "Google Maps display", ready: config.maps }, { label: "Places and routes", ready: config.routes }, { label: "Gemini extraction", ready: config.ai }].map((service) => <div key={service.label}><span>{service.label}</span><span className={`service-state ${service.ready ? "ready" : ""}`}>{service.ready ? "Configured" : "Not configured"}</span></div>)}</div><p className="notice">Server credentials belong in environment variables. Never include them in a trip or uploaded document.</p><div className="connection-limits"><ShieldCheck size={17} /><span>Personal account allowlist · capped API usage</span></div><div className="dialog-actions"><button className="button secondary" disabled={Boolean(busy)} onClick={() => backupInput.current?.click()}><FileInput size={16} />Open backup</button><button className="button secondary" disabled={Boolean(busy)} onClick={() => { setSettingsOpen(false); setSetup("new"); }}><Plus size={16} />New trip</button>{!config.email && <button className="button primary" disabled={!config.auth} onClick={() => void signIn("google")}><UserRound size={16} />Sign in</button>}</div></Dialog>}
    {savedTrips && <Dialog title="My trips" onClose={() => setSavedTrips(null)}><div className="saved-trips">{savedTrips.length ? savedTrips.map((entry) => <div key={entry.data.id}><button className="saved-trip" disabled={Boolean(busy)} onClick={() => loadSaved(entry)}><span className="saved-trip-icon"><MapPin size={22} /></span><span><strong>{entry.data.title}</strong><small>{asJourney(entry.data).cities.map((city) => city.city).join(" / ")} · {asJourney(entry.data).cities[0].startDate}</small></span><ArrowUpRight size={17} /></button><button className="icon-button danger" title={`Delete ${entry.data.title}`} aria-label={`Delete ${entry.data.title}`} disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Delete ${entry.data.title}?`)) void perform("Deleting trip", async () => { await requestJson(`/api/trips/${entry.data.id}`, undefined, "DELETE"); setSavedTrips((current) => current!.filter((item) => item.data.id !== entry.data.id)); if (journey.id === entry.data.id) { setRevision(0); setSavedFor(""); } }); }}><Trash2 size={17} /></button></div>) : <p className="notice">No saved trips yet.</p>}</div></Dialog>}
    {setup && <NewTripDialog adding={setup === "add"} available={setup === "add" ? 10 - journey.cities.length : 10} startDate={setup === "add" ? tripDate(journey.cities.at(-1)!, journey.cities.at(-1)!.days) : newTrip().startDate} onClose={() => setSetup(null)} onCreate={(next) => {
      if (setup === "new") { if (confirmDiscard()) openJourney(next); }
      else {
        const combined = journeySchema.parse({ ...journey, cities: [...journey.cities, ...next.cities] });
        setJourney(combined); switchCity(next.cities[0].id); setSetup(null);
      }
    }} />}
    <input ref={backupInput} hidden type="file" accept="application/json" aria-label="Open trip backup" onChange={(event) => {
      const file = event.target.files?.[0]; if (!file) return;
      void perform("Opening backup", async () => { if (file.size > 10_000_000) throw new Error("The backup is too large."); const restored = restoreJourney(JSON.parse(await file.text())); if (confirmDiscard()) openJourney(restored); });
    }} />
  </div>;
}

function LegDetails({ edge, places, onMode }: { edge: TravelEdge; places: Record<string, Place>; onMode?: (mode: "WALK" | "TRANSIT") => void }) {
  const origin = places[edge.from];
  const destination = places[edge.to];
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1"); url.searchParams.set("origin", origin?.name ?? edge.from); url.searchParams.set("destination", destination?.name ?? edge.to);
  if (origin) url.searchParams.set("origin_place_id", origin.id);
  if (destination) url.searchParams.set("destination_place_id", destination.id);
  url.searchParams.set("travelmode", edge.mode === "WALK" ? "walking" : "transit");
  return <details className="travel-leg"><summary>{edge.mode === "WALK" ? <Footprints size={15} /> : <TrainFront size={15} />}<span>{edge.mode === "WALK" ? "Walk" : "Public transit"} · {edge.minutes} min {edge.mode === "WALK" && `· ${(edge.meters / 1000).toFixed(1)} km`}</span><ChevronDown size={13} /></summary><div className="leg-details"><div className="transport-options">{[edge, ...(edge.alternatives ?? [])].map((option) => <button key={option.mode} disabled={!onMode || option.mode === edge.mode} aria-pressed={option.mode === edge.mode} title={`Prefer ${option.mode === "WALK" ? "walking" : "public transit"} and replan`} onClick={() => onMode?.(option.mode)}>{option.mode === "WALK" ? <Footprints size={14} /> : <TrainFront size={14} />}<span>{option.mode === "WALK" ? "Walk" : "Transit"}<strong>{option.minutes} min</strong></span></button>)}</div>{edge.steps?.map((step, index) => <p key={index}>{step.line && <strong>{step.line} </strong>}{step.from && step.to ? `${step.from} to ${step.to}` : step.instruction}</p>)}{edge.fare && <p>Estimated fare: {edge.fare}</p>}<a href={url.toString()} target="_blank" rel="noreferrer">Open in Google Maps <ArrowUpRight size={13} /></a></div></details>;
}