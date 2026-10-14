"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { signIn, signOut } from "next-auth/react";
import { ZodError } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import { ArrowDown, ArrowUp, ArrowUpRight, CalendarDays, Check, ChevronDown, Compass, Download, FileInput, FolderOpen, Footprints, Hotel, List, LoaderCircle, LockKeyhole, Map, MapPin, MapPinOff, Plus, Route, Save, Search, Settings2, ShieldCheck, TrainFront, Trash2, UserRound, X } from "lucide-react";
import { Dialog } from "./Dialog";
import { ImportReview } from "./ImportReview";
import { TripMap } from "./TripMap";
import { PlacePhotos } from "./PlacePhotos";
import { TransferFields, TransferLine } from "./TransferFields";
import { VisitTimingFields } from "./VisitTiming";
import { NewTripDialog } from "./NewTripDialog";
import { PlanningDialog } from "./PlanningDialog";
import { DayRecoveryDialog } from "./DayRecoveryDialog";
import { ExportMenu } from "./ExportMenu";
import { applyDayRecovery, newDayProgress, recoveryMinute, recoveryPlanKey, remainingIds, validateDayRecovery, type CheckedNextRoute, type DayProgress, type RecoveryRequest } from "@/lib/day-recovery";
import { duplicateStopPairs, mergeReviewedDuplicate } from "@/lib/duplicates";
import type { ExtractionServices } from "@/lib/import";
import { asJourney, cityPreset, journeySchema, popularCities, restoreJourney, type Journey, type StoredTrip } from "@/lib/journey";
import { validateSchedule } from "@/lib/schedule-validation";
import { placePhotoResponseSchema, type PlacePhoto } from "@/lib/place-photos";
import { alternativeGroups } from "@/lib/visit-slots";
import { changeStartDate, dayStart, endpointKey, formatMinute, hotelReturnAllowance, maxStopsPerCity, newStop, newTrip, persistedPlan, planningFixSchema, provisionalPlanSchema, tripDate, tripSchema, type DayPlan, type Place, type PlanningPreview, type PlanResult, type SavedPlan, type Stop, type TravelEdge, type Trip } from "@/lib/trip";
import { OmittedPlaces } from "./OmittedPlaces";

export type AppConfig = { auth: boolean; database: boolean; maps: boolean; routes: boolean; ai: boolean; extraction?: ExtractionServices; timing?: boolean; email: string | null };
type SavedTrip = { data: StoredTrip; revision: number; plan: SavedPlan | null; updatedAt: string };
type PhotoSession = { key: string; total?: number; frames: Partial<Record<number, PlacePhoto | null>>; loading: number[]; errors: number[] };

async function requestJson(url: string, body?: unknown, method = "POST", signal?: AbortSignal) {
  const response = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const fixes = planningFixSchema.array().safeParse(data?.fixes);
    throw Object.assign(new Error(data?.error ?? "The request failed."), fixes.success ? { fixes: fixes.data } : {});
  }
  return data;
}

export function TripPlanner({ initialTrip, initialSaved, initialList, config }: { initialTrip: Trip; initialSaved: SavedTrip | null; initialList: SavedTrip[] | null; config: AppConfig }) {
  const [restored] = useState(() => { const parsed = initialSaved ? journeySchema.safeParse(asJourney(initialSaved.data, initialSaved.plan)) : null; return parsed?.success ? parsed.data : null; });
  const [journey, setJourney] = useState(() => restored ?? asJourney(initialTrip));
  const [activeCity, setActiveCity] = useState(() => (restored ?? asJourney(initialTrip)).cities[0].id);
  const trip = journey.cities.find((city) => city.id === activeCity) ?? journey.cities[0];
  const savedPlan = journey.plans[trip.id] ?? null;
  const [revision, setRevision] = useState(restored && initialSaved ? initialSaved.revision : 0);
  const [savedFor, setSavedFor] = useState(restored ? JSON.stringify(restored) : "");
  const [placeState, setPlaces] = useState<Record<string, Place>>({});
  const places = useMemo(() => {
    const stored: Record<string, Place> = {};
    if (trip.hotelPlaceId && trip.hotelLocation) stored.hotel = { id: trip.hotelPlaceId, name: trip.hotel, address: "", location: trip.hotelLocation };
    for (const stop of trip.stops) if (stop.placeId && stop.location) stored[stop.id] = { id: stop.placeId, name: stop.name, address: "", location: stop.location };
    const confirmed = Object.fromEntries(Object.entries(savedPlan?.snapshot?.places ?? {}).filter(([id, place]) => id === "hotel"
      ? trip.hotelPlaceId === place.id : trip.stops.some((stop) => stop.id === id && stop.placeId === place.id)));
    return { ...confirmed, ...stored, ...placeState };
  }, [trip, placeState, savedPlan]);
  const [resultState, setResult] = useState<PlanResult | null>(null);
  const result: PlanResult | null = resultState ?? (savedPlan?.snapshot ? { schedule: savedPlan.snapshot.schedule, places: savedPlan.snapshot.places, verified: false } : null);
  const [plannedFor, setPlannedFor] = useState("");
  const [day, setDay] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [photoSession, setPhotoSession] = useState<PhotoSession | null>(null);
  const photoSessionRef = useRef<PhotoSession | null>(null);
  const activePhotoKeyRef = useRef<string | null>(null);
  const photoRequests = useRef(new globalThis.Map<string, AbortController>());
  const [view, setView] = useState<"list" | "map">("list");
  const [tab, setTab] = useState<"places" | "itinerary">("places");
  const [importOpen, setImportOpen] = useState(false);
  const [duplicateReview, setDuplicateReview] = useState<{ ignored: string[]; keepId: string | null; error: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [planningOpen, setPlanningOpen] = useState(false);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [refreshPreview, setRefreshPreview] = useState<{ result: PlanResult; trip: Trip; tripKey: string; planKey: string } | null>(null);
  const refreshAbort = useRef<AbortController | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [now, setNow] = useState(() => Temporal.Now.instant());
  const [liveDay, setLiveDay] = useState<{ cityId: string; version: number; planKey: string; day: DayPlan; checkedAt: string; departureAt: string; origin: RecoveryRequest["origin"] }>();
  const [liveRoute, setLiveRoute] = useState<CheckedNextRoute & { cityId: string; day: number; version: number; planKey: string }>();
  const [setup, setSetup] = useState<"new" | "add" | null>(null);
  const [savedTrips, setSavedTrips] = useState<SavedTrip[] | null>(initialList);
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
  const canUseServices = Boolean(config.email && config.database);
  const canPlan = canUseServices && config.routes;
  const saving = useRef(false);
  useEffect(() => { const timer = setInterval(() => setNow(Temporal.Now.instant()), 60_000); return () => clearInterval(timer); }, []);

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
  const baselineDay = result?.schedule.days.find((entry) => entry.day === day);
  const date = tripDate(trip, day);
  const execution = journey.execution?.[trip.id]?.[date];
  const savedRecovery = execution?.remaining?.snapshot;
  const stale = savedRecovery ? JSON.stringify(savedRecovery.trip) !== JSON.stringify(trip) : Boolean(result && (plannedFor || JSON.stringify(savedPlan?.snapshot?.trip)) !== JSON.stringify(trip));
  const dayStopIds = savedPlan?.days.find((entry) => entry.day === day)?.stopIds ?? baselineDay?.visits.map((visit) => visit.stopId) ?? execution?.baselineStopIds;
  const progress = execution ?? newDayProgress(trip, day, dayStopIds ?? []);
  function formatActual(minute: number) {
    try { return formatMinute({ ...trip, timeZone: progress.timeZone ?? trip.timeZone }, day, minute); }
    catch { return `${Math.round(minute)} elapsed min`; }
  }
  const checkedDay = liveDay?.cityId === trip.id && liveDay.day.day === day && liveDay.version === progress.version && liveDay.planKey === recoveryPlanKey(trip, day, dayStopIds ?? []) ? liveDay : undefined;
  const checkedRoute = liveRoute?.cityId === trip.id && liveRoute.day === day && liveRoute.version === progress.version && liveRoute.planKey === recoveryPlanKey(trip, day, dayStopIds ?? []) ? liveRoute : undefined;
  const currentDay = checkedDay?.day ?? savedRecovery?.day ?? (execution ? undefined : baselineDay);
  const itineraryTrip = checkedDay ? trip : savedRecovery?.trip ?? savedPlan?.snapshot?.trip ?? trip;
  let isToday = false;
  try { isToday = date === now.toZonedDateTimeISO(trip.timeZone).toPlainDate().toString(); } catch { isToday = false; }
  function recordProgress(next: DayProgress) {
    editVersion.current++; setLiveDay(undefined); setLiveRoute(undefined);
    setJourney((current) => ({ ...current, execution: { ...current.execution, [trip.id]: { ...current.execution?.[trip.id], [date]: next } } }));
  }
  const mapSchedule = tab === "places" ? null : checkedDay ? { generatedAt: checkedDay.checkedAt, warnings: [], omitted: [], days: [checkedDay.day] } : savedRecovery ? { generatedAt: savedRecovery.checkedAt, warnings: [], omitted: [], days: [savedRecovery.day] } : execution ? null : result?.schedule ?? null;
  const markerOrder = tab === "places"
    ? savedPlan?.days.slice().sort((left, right) => left.day - right.day).flatMap((entry) => entry.stopIds)
    : currentDay?.visits.map((visit) => visit.stopId);
  const mapOrigin = checkedRoute?.origin ?? checkedDay?.origin ?? savedRecovery?.origin;
  const mapLocation = mapOrigin?.location ?? (mapOrigin ? places[mapOrigin.id]?.location : undefined);
  const itineraryPlaces = savedRecovery?.places ?? savedPlan?.snapshot?.places ?? places;
  const recoveryOrigin = checkedDay?.origin ?? savedRecovery?.origin;
  const recoveryPlaces = recoveryOrigin ? { ...(checkedDay ? places : itineraryPlaces), current: { id: recoveryOrigin.location ? "" : itineraryPlaces[recoveryOrigin.id]?.id ?? "", name: recoveryOrigin.location ? "Current device location" : recoveryOrigin.id === "hotel" ? itineraryTrip.hotel : itineraryTrip.stops.find((stop) => stop.id === recoveryOrigin.id)?.name ?? "Current location", address: "", location: recoveryOrigin.location ?? itineraryPlaces[recoveryOrigin.id]?.location ?? { lat: 0, lng: 0 } } } : itineraryPlaces;
  const photoPlaces = tab === "itinerary" ? recoveryPlaces : places;
  const photoTrip = tab === "itinerary" ? itineraryTrip : trip;
  const photoStop = selected ? photoTrip.stops.find((stop) => stop.id === selected) : undefined;
  const photoPlaceId = selected === "hotel" ? photoPlaces.hotel?.id ?? photoTrip.hotelPlaceId : selected ? photoPlaces[selected]?.id ?? photoStop?.placeId : undefined;
  const photoKey = photoPlaceId ? `${trip.id}:${photoPlaceId}` : null;
  const canLoadPhotos = canUseServices && config.routes;
  const activePhotoSession = photoSession?.key === photoKey ? photoSession : null;
  const photoFrames = activePhotoSession?.frames ?? {};
  const photoLoading = Object.fromEntries(activePhotoSession?.loading.map((index) => [index, true]) ?? []);
  const photoErrors = Object.fromEntries(activePhotoSession?.errors.map((index) => [index, true]) ?? []);
  const photoDisabledMessage = !photoPlaceId ? "Confirm this place to view photos" : !canLoadPhotos ? "Photos are unavailable" : undefined;
  const plannedCount = result?.schedule.days.reduce((sum, entry) => sum + entry.visits.length, 0) ?? 0;

  function cancelPhotoRequests(keepKey?: string) {
    for (const [requestKey, controller] of photoRequests.current) {
      if (keepKey && requestKey.startsWith(`${keepKey}:`)) continue;
      controller.abort(); photoRequests.current.delete(requestKey);
    }
  }

  function setPhotoSessionValue(next: PhotoSession | null) {
    photoSessionRef.current = next;
    setPhotoSession(next);
  }

  async function requestPhoto(key: string, placeId: string, index: number, retry = false) {
    if (!canLoadPhotos || activePhotoKeyRef.current !== key) return;
    let session = photoSessionRef.current;
    if (session?.key !== key) {
      session = { key, frames: {}, loading: [], errors: [] };
      setPhotoSessionValue(session);
    }
    if (session.total !== undefined && index >= session.total) return;
    if (retry && Object.hasOwn(session.frames, index)) {
      const frames = { ...session.frames };
      delete frames[index];
      session = { ...session, frames };
      setPhotoSessionValue(session);
    }
    if (!retry && session.frames[index] !== undefined) return;
    if (session.errors.includes(index) && !retry) return;
    const requestKey = `${key}:${index}`;
    if (photoRequests.current.has(requestKey)) return;

    const controller = new AbortController();
    photoRequests.current.set(requestKey, controller);
    session = { ...session, loading: [...new Set([...session.loading, index])], errors: session.errors.filter((entry) => entry !== index) };
    setPhotoSessionValue(session);
    try {
      const response = placePhotoResponseSchema.parse(await requestJson("/api/place-photos", { placeId, index, operationId: crypto.randomUUID() }, "POST", controller.signal));
      if (response.placeId !== placeId || response.index !== index) throw new Error("The photo response did not match this place.");
      if (activePhotoKeyRef.current !== key || controller.signal.aborted) return;
      const current = photoSessionRef.current;
      if (current?.key !== key) return;
      setPhotoSessionValue({ ...current, total: response.total, frames: { ...current.frames, [index]: response.photo }, loading: current.loading.filter((entry) => entry !== index) });
    } catch {
      if (activePhotoKeyRef.current !== key || controller.signal.aborted) return;
      const current = photoSessionRef.current;
      if (current?.key === key) setPhotoSessionValue({ ...current, loading: current.loading.filter((entry) => entry !== index), errors: [...new Set([...current.errors, index])] });
    } finally {
      if (photoRequests.current.get(requestKey) === controller) photoRequests.current.delete(requestKey);
    }
  }

  function selectLocation(id: string | null) {
    if (!id) {
      activePhotoKeyRef.current = null; cancelPhotoRequests(); setPhotoSessionValue(null); setSelected(null); return;
    }
    const sourcePlaces = tab === "itinerary" ? recoveryPlaces : places;
    const sourceTrip = tab === "itinerary" ? itineraryTrip : trip;
    const place = sourcePlaces[id];
    const placeId = id === "hotel" ? place?.id ?? sourceTrip.hotelPlaceId : place?.id ?? sourceTrip.stops.find((stop) => stop.id === id)?.placeId;
    const key = placeId ? `${trip.id}:${placeId}` : null;
    if (activePhotoKeyRef.current !== key) {
      activePhotoKeyRef.current = key;
      cancelPhotoRequests(key ?? undefined);
      const current = photoSessionRef.current;
      if (current?.key !== key) setPhotoSessionValue(key ? { key, frames: {}, loading: [], errors: [] } : null);
    }
    setSelected(id);
    if (placeId && key && canLoadPhotos) void requestPhoto(key, placeId, 0);
  }

  useEffect(() => {
    activePhotoKeyRef.current = photoKey;
    cancelPhotoRequests(photoKey ?? undefined);
    if (photoSessionRef.current?.key !== photoKey) setPhotoSessionValue(null);
  }, [photoKey]);
  const duplicatePairs = duplicateStopPairs(trip.stops);
  const stopAlternatives = alternativeGroups(trip);
  const duplicatePair = duplicatePairs.find(({ first, second }) => !duplicateReview?.ignored.includes(`${first.id}:${second.id}`));
  function mergeDuplicates() {
    if (!duplicatePair || ![duplicatePair.first.id, duplicatePair.second.id].includes(duplicateReview?.keepId ?? "")) return;
    const kept = duplicatePair.first.id === duplicateReview!.keepId ? duplicatePair.first : duplicatePair.second;
    const removed = kept === duplicatePair.first ? duplicatePair.second : duplicatePair.first;
    try {
      const stops = mergeReviewedDuplicate(trip.stops, kept.id, removed.id);
      edit({ stops });
      setPlaces((current) => { const next = { ...current }; if (!next[kept.id] && next[removed.id]) next[kept.id] = next[removed.id]; delete next[removed.id]; return next; });
      if (selected === removed.id) setSelected(kept.id);
      setDuplicateReview((current) => ({ ignored: current?.ignored ?? [], keepId: null, error: "" }));
      setNotice(`Merged duplicate visits. Kept ${kept.name} and its selected booking details.`);
    } catch (cause) { setDuplicateReview((current) => ({ ignored: current?.ignored ?? [], keepId: null, error: cause instanceof Error ? cause.message : "Could not merge these visits." })); }
  }

  function setTrip(update: Trip | ((current: Trip) => Trip)) {
    setJourney((current) => ({ ...current, cities: current.cities.map((city) => city.id === trip.id ? typeof update === "function" ? update(city) : update : city) }));
  }

  function switchCity(cityId: string) {
    if (busy || cityId === trip.id) return;
    activePhotoKeyRef.current = null; cancelPhotoRequests(); setPhotoSessionValue(null);
    cityViews.current[trip.id] = { places, result, plannedFor };
    const cached = cityViews.current[cityId];
    editVersion.current += 1; setActiveCity(cityId); setPlaces(cached?.places ?? {}); setResult(cached?.result ?? null); setPlannedFor(cached?.plannedFor ?? "");
    setDay(0); setSelected(null); setTab("places"); setView("list"); setAdding(""); setError(""); setNotice(""); setSearch(null); setLiveDay(undefined); setLiveRoute(undefined); setRecoveryOpen(false);
  }

  function openJourney(next: Journey, savedRevision = 0, saved = false) {
    activePhotoKeyRef.current = null; cancelPhotoRequests(); setPhotoSessionValue(null);
    editVersion.current += 1; cityViews.current = {};
    setJourney(next); setActiveCity(next.cities[0].id); setRevision(savedRevision); setSavedFor(saved ? JSON.stringify(next) : "");
    setResult(null); setPlaces({}); setPlannedFor(""); setSelected(null); setDay(0); setTab("places"); setView("list"); setAdding(""); setLiveDay(undefined); setLiveRoute(undefined); setRecoveryOpen(false);
    setSetup(null); setSettingsOpen(false); setSavedTrips(null); setSearch(null); setNotice(""); setError("");
  }

  function confirmDiscard() {
    return snapshot === savedFor || (journey.cities.length === 1 && !trip.city && !trip.hotel && !trip.stops.length && journey.title === "Untitled trip") || window.confirm("Replace this unsaved trip? Save or export all cities first.");
  }

  function edit(patch: Partial<Trip>) {
    editVersion.current += 1;
    setLiveDay(undefined); setLiveRoute(undefined);
    setTrip((current) => {
      const next = { ...current, ...patch };
      if (patch.stops && current.dayGroups && !("dayGroups" in patch)) {
        const retained = new Set(patch.stops.map((stop) => stop.id));
        const groups = current.dayGroups.map((group) => ({ ...group, stopIds: group.stopIds.filter((id) => retained.has(id)) })).filter((group) => group.stopIds.length);
        next.dayGroups = groups.length ? groups : undefined;
      }
      return next;
    });
    setNotice("");
  }
  function editStop(id: string, patch: Partial<Stop>) { editVersion.current += 1; setLiveDay(undefined); setLiveRoute(undefined); setTrip((current) => ({ ...current, stops: current.stops.map((stop) => stop.id === id ? { ...stop, ...patch } : stop) })); }

  async function perform(label: string, action: () => Promise<void>) {
    setBusy(label); setError(""); setNotice("");
    try { await action(); } catch (cause) { setError(cause instanceof ZodError ? cause.issues[0].message : cause instanceof Error ? cause.message : "Something went wrong."); }
    finally { setBusy(null); }
  }

  function addPlace() {
    if (!adding.trim()) return;
    if (trip.stops.length >= maxStopsPerCity) { setError(`A city can contain at most ${maxStopsPerCity} stops.`); return; }
    const stop = newStop(adding.trim());
    edit({ stops: [...trip.stops, stop] });
    setAdding(""); setSelected(stop.id);
  }

  async function findPlaces(query: string) {
    await perform("Finding places", async () => {
      if (!canUseServices || !config.routes) throw new Error("Place search is unavailable. Check your sign-in and connections.");
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
      // A confirmed airport or station takes Google's name, so what you see is what was matched.
      else if (id === "arrival" || id === "departure") { const transfer = trip[id]; if (transfer) edit({ [id]: { ...transfer, placeId: detailed.id, place: detailed.name } }); }
      else editStop(id, { placeId: detailed.id, location: detailed.location });
      setSearch(null);
    });
  }

  async function save() {
    if (!config.email) { setSettingsOpen(true); return; }
    await perform("Saving", async () => {
      const validated = journeySchema.parse(journey);
      const response = await requestJson(`/api/trips/${journey.id}`, { journey: validated, revision }, "PUT");
      setRevision(response.revision); setSavedFor(JSON.stringify(validated)); setNotice("Saved");
    });
  }

  async function generate(candidate: Trip): Promise<PlanningPreview> {
    setBusy("Planning your days");
    try {
      const version = editVersion.current;
      journeySchema.parse({ ...journey, cities: journey.cities.map((city) => city.id === trip.id ? candidate : city) });
      const validated = tripSchema.parse(candidate);
      const response: PlanningPreview = await requestJson("/api/plan", { trip: validated, operationId: crypto.randomUUID() });
      if (version !== editVersion.current) throw new Error("The trip changed while planning. Your edits were kept; generate a new route.");
      return response.status === "provisional" ? provisionalPlanSchema.parse(response) : response;
    } finally { setBusy(null); }
  }

  async function refreshTimes() {
    if (!savedPlan || busy) return;
    const controller = new AbortController();
    refreshAbort.current = controller;
    setRefreshOpen(true); setRefreshPreview(null); setBusy("Refreshing travel times"); setError(""); setNotice("");
    const version = editVersion.current;
    try {
      const validated = tripSchema.parse(trip);
      const response: PlanResult = await requestJson("/api/plan", { trip: validated, plan: savedPlan, mode: "refresh", operationId: crypto.randomUUID() }, "POST", controller.signal);
      if (controller.signal.aborted) return;
      if (version !== editVersion.current) throw new Error("The trip changed during refresh. Your saved itinerary was kept.");
      if (!response.verified || validateSchedule(validated, response.schedule).length) throw new Error("Refreshed routes did not pass itinerary validation. Your saved plan was kept.");
      const order = response.schedule.days.map(({ day, visits }) => ({ day, stopIds: visits.map((visit) => visit.stopId) })).sort((left, right) => left.day - right.day);
      if (JSON.stringify(order) !== JSON.stringify([...savedPlan.days].sort((left, right) => left.day - right.day)) || JSON.stringify(response.schedule.omitted) !== JSON.stringify(savedPlan.omitted)) throw new Error("Refresh changed saved days, order or omissions. Your saved plan was kept.");
      persistedPlan(response.schedule, validated, response.places);
      setRefreshPreview({ result: response, trip: validated, tripKey: JSON.stringify(trip), planKey: JSON.stringify(savedPlan) });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Travel-time refresh failed. Your saved plan was kept.");
    } finally {
      if (refreshAbort.current === controller) { refreshAbort.current = null; setBusy(null); }
    }
  }

  function loadSaved(entry: SavedTrip) {
    if (!confirmDiscard()) return;
    openJourney(journeySchema.parse(asJourney(entry.data, entry.plan)), entry.revision, true);
    setNotice("Trip loaded. Saved routes are not a live travel check.");
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
        <div className="trip-actions"><button className="icon-button" title="Download trip backup" aria-label="Download trip backup" onClick={download}><Download size={18} /></button><ExportMenu journey={journey} /><button className="button secondary" disabled={Boolean(busy)} onClick={() => void save()}><Save size={16} /><span>Save trip</span></button><button className="button primary" disabled={Boolean(busy) || !trip.stops.length} onClick={() => setPlanningOpen(true)}>{busy === "Planning your days" ? <LoaderCircle size={16} className="spin" /> : <Route size={16} />}<span>{busy === "Planning your days" ? "Planning..." : "Plan my days"}</span></button></div>
      </section>

      {(error || notice) && <div className={`banner ${error ? "error" : "success"}`} role={error ? "alert" : "status"}><span>{error || notice}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => { setError(""); setNotice(""); }}><X size={16} /></button></div>}

      <div className="journey-cities"><div className="city-tabs" aria-label="Trip cities">{journey.cities.map((city) => <button key={city.id} disabled={Boolean(busy)} aria-pressed={trip.id === city.id} onClick={() => switchCity(city.id)}><MapPin size={15} /><span><strong>{city.city || "First city"}</strong><small>{city.startDate} to {tripDate(city, city.days - 1)}</small></span></button>)}</div><div className="row"><button className="text-button" disabled={Boolean(busy) || journey.cities.length >= 10} onClick={() => setSetup(journey.cities.length === 1 && !trip.city.trim() ? "new" : "add")}><Plus size={15} />Add cities</button>{journey.cities.length > 1 && <button className="icon-button danger" title="Remove current city" aria-label="Remove current city" disabled={Boolean(busy)} onClick={() => {
        if (!window.confirm(`Remove ${trip.city} and its places from this trip?`)) return;
        const nextCity = journey.cities.find((city) => city.id !== trip.id)!; switchCity(nextCity.id);
        setJourney((current) => { const plans = { ...current.plans }; const execution = { ...current.execution }; delete plans[trip.id]; delete execution[trip.id]; return { ...current, cities: current.cities.filter((city) => city.id !== trip.id), plans, execution }; });
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
                if (trip.dayGroups?.some((group) => group.allowedDays.some((allowed) => allowed >= days))) { setError("A day-trip group includes later days. Adjust its eligible days explicitly first."); return; }
                edit({ days }); setDay(Math.min(day, days - 1));
              }}>{Array.from({ length: 7 }, (_, index) => <option key={index} value={index + 1}>{index + 1} {index === 0 ? "day" : "days"}</option>)}</select></label></div>
              <div className="form-grid"><label className="field">Day starts<input type="time" value={trip.dailyStart} onChange={(event) => edit({ dailyStart: event.target.value })} /></label><label className="field">Sightseeing ends<input type="time" value={trip.dailyEnd} onChange={(event) => edit({ dailyEnd: event.target.value })} /></label></div>
              <p className="quiet">The last visit ends by this time; getting back to the hotel may take up to {hotelReturnAllowance / 60} hours longer.</p>
              <label className="field">City timezone<input value={trip.timeZone} maxLength={100} placeholder="Europe/Paris" onChange={(event) => edit({ timeZone: event.target.value })} /></label>
              <label className="checkbox"><input type="checkbox" checked={trip.returnToHotel} onChange={(event) => edit({ returnToHotel: event.target.checked })} />Return to hotel each day</label>
              <TransferFields trip={trip} kind="arrival" onChange={(arrival) => edit({ arrival })} onFind={busy ? undefined : () => openSearch("arrival", trip.arrival?.place ?? "")} />
              <TransferFields trip={trip} kind="departure" onChange={(departure) => edit({ departure })} onFind={busy ? undefined : () => openSearch("departure", trip.departure?.place ?? "")} />
            </div>
          </details>

          <div className="section-tabs"><button className={tab === "places" ? "active" : ""} onClick={() => setTab("places")}>Places <span>{trip.stops.length}</span></button><button className={tab === "itinerary" ? "active" : ""} onClick={() => setTab("itinerary")}>Itinerary {result && <span>{plannedCount}</span>}</button><button className="text-button import-trigger" onClick={() => setImportOpen(true)}><FileInput size={15} />Import</button></div>

          {tab === "places" ? <div className="places-editor">
            {duplicateReview && <Dialog title="Review duplicate places" onClose={() => setDuplicateReview(null)}>
              {duplicateReview.error && <p className="notice error" role="alert">{duplicateReview.error}</p>}
              {duplicatePair ? <>
                <p className="notice">{duplicatePair.match}</p>
                <fieldset className="duplicate-options"><legend>Visit details to keep</legend>{[duplicatePair.first, duplicatePair.second].map((stop) => <div className="duplicate-option" key={stop.id}>
                  <label className="checkbox"><input type="radio" name="keep-duplicate" aria-label={`Keep ${stop.name}, visit ${trip.stops.findIndex((entry) => entry.id === stop.id) + 1}`} checked={duplicateReview.keepId === stop.id} onChange={() => setDuplicateReview((current) => ({ ignored: current?.ignored ?? [], keepId: stop.id, error: "" }))} /><strong>{stop.name}</strong></label>
                  <dl><dt>Date</dt><dd>{stop.day === null ? "Flexible" : tripDate(trip, stop.day)}</dd><dt>Booked time</dt><dd>{stop.fixedTime ?? "None"}</dd><dt>Duration</dt><dd>{stop.duration} min</dd><dt>Arrival buffer</dt><dd>{stop.buffer} min</dd><dt>Visit</dt><dd>{stop.optional ? "Optional" : "Required"}, priority {stop.priority}</dd><dt>Transport</dt><dd>{stop.mode === "AUTO" ? "City default" : stop.mode === "WALK" ? "Walking" : "Public transit"}</dd><dt>Location</dt><dd>{stop.placeId ? "Confirmed" : "Not confirmed"}</dd></dl>
                  {stop.source && <blockquote>{stop.source}</blockquote>}
                  {stop.sourceUrl && <a className="source-link" href={stop.sourceUrl} target="_blank" rel="noopener noreferrer"><ArrowUpRight size={14} />Source link</a>}
                </div>)}</fieldset>
                <p className="notice warning">After merging: one visit with the selected date, time, duration and settings. Both source notes retained. The other visit is removed.</p>
                <div className="dialog-actions"><button className="button secondary" onClick={() => setDuplicateReview((current) => ({ ignored: [...current!.ignored, `${duplicatePair.first.id}:${duplicatePair.second.id}`], keepId: null, error: "" }))}>Keep both visits</button><button className="button primary" disabled={![duplicatePair.first.id, duplicatePair.second.id].includes(duplicateReview.keepId ?? "")} onClick={mergeDuplicates}><Check size={16} />Merge visits</button></div>
              </> : <><p className="notice" role="status">No more duplicate pairs to review.</p><div className="dialog-actions"><button className="button primary" onClick={() => setDuplicateReview(null)}>Done</button></div></>}
            </Dialog>}
            <form className="add-place" onSubmit={(event) => { event.preventDefault(); addPlace(); }}><MapPin size={17} /><input aria-label="New place name" placeholder="Add a place to visit" value={adding} maxLength={200} onChange={(event) => setAdding(event.target.value)} /><button type="submit" className="icon-button" aria-label="Add place" title="Add place" disabled={!adding.trim() || trip.stops.length >= maxStopsPerCity}><Plus size={20} /></button></form>
            {duplicatePairs.length > 0 && <button className="button secondary small" onClick={() => setDuplicateReview({ ignored: [], keepId: null, error: "" })}><Search size={15} />Review duplicates ({duplicatePairs.length})</button>}
            {!trip.stops.length && <div className="empty-stops"><span className="empty-icon"><MapPin size={24} strokeWidth={1.4} /></span><h2>No places yet</h2><button className="button secondary" onClick={() => setImportOpen(true)}><FileInput size={16} />Import itinerary</button></div>}
            <div className="stop-list">{trip.stops.map((stop, index) => <article key={stop.id} className={`stop-item ${selected === stop.id ? "selected" : ""}`}>
              <button className="stop-summary" aria-expanded={selected === stop.id} onClick={() => selectLocation(selected === stop.id ? null : stop.id)}><span className={`stop-number ${stop.fixedTime ? "booked" : ""}`}>{index + 1}</span><span className="stop-heading"><strong>{stop.name}</strong><span>{stop.duration} min <span className="dot-separator">·</span> {stop.day === null ? "Flexible day" : `Day ${stop.day + 1}`}{stop.fixedTime && `, ${stop.fixedTime}`}</span></span><span className="stop-statuses">{stop.fixedTime && <span className="booking-status" role="img" aria-label="Booked appointment" title="Fixed booking date and time"><LockKeyhole size={16} className="booking-icon" /></span>}<span className="location-status" role="img" aria-label={stop.placeId ? "Location confirmed on map" : "Location not confirmed on map"} title={stop.placeId ? "Location confirmed on map" : "Location not confirmed on map"}>{stop.placeId ? <Check size={16} className="confirmed-icon" /> : <MapPinOff size={16} className="unconfirmed-icon" />}</span></span><ChevronDown size={14} /></button>
              {selected === stop.id && <div className="stop-details">
                <PlacePhotos key={photoKey ?? stop.id} placeName={stop.name} variant="carousel" total={activePhotoSession?.total} frames={photoFrames} loading={photoLoading} errors={photoErrors} disabledMessage={photoDisabledMessage} onRequest={(index) => { if (photoKey && photoPlaceId) void requestPhoto(photoKey, photoPlaceId, index); }} onRetry={(index) => { if (photoKey && photoPlaceId) void requestPhoto(photoKey, photoPlaceId, index, true); }} />
                <label className="field">Place name<input value={stop.name} maxLength={200} onChange={(event) => { editStop(stop.id, { name: event.target.value, placeId: null, location: undefined }); setPlaces((current) => { const next = { ...current }; delete next[stop.id]; return next; }); }} /></label>
                <button className="text-button" disabled={Boolean(busy)} onClick={() => openSearch(stop.id, stop.name)}>{stop.placeId ? <Check size={14} /> : <Search size={14} />}{stop.placeId ? "Place confirmed · change" : "Confirm place on map"}</button>
                <div className="form-grid"><label className="field">Visit minutes<input type="number" min={5} max={480} step={5} value={stop.duration} onChange={(event) => editStop(stop.id, { duration: Number(event.target.value) })} /></label><label className="field">Assigned day<select value={stop.day ?? ""} onChange={(event) => editStop(stop.id, { day: event.target.value === "" ? null : Number(event.target.value), ...(event.target.value === "" ? { fixedTime: null } : {}) })}><option value="">Flexible</option>{Array.from({ length: trip.days }, (_, dayIndex) => <option key={dayIndex} value={dayIndex}>Day {dayIndex + 1}</option>)}</select></label></div>
                <VisitTimingFields trip={trip} stop={stop} place={places[stop.id]} groups={stopAlternatives} onChange={(patch) => editStop(stop.id, patch)} />
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
            {(isToday || execution) && <section className="today-summary"><div className="recovery-toolbar"><strong>{isToday ? "Today" : "Day progress"} · {execution?.completed.length ?? 0} completed</strong>{isToday && dayStopIds && <button className="button secondary small" disabled={Boolean(busy)} onClick={() => setRecoveryOpen(true)}><Route size={15} />Today</button>}</div>{execution?.completed.map((visit) => <p className="recovery-fact" key={visit.stopId}><Check size={14} />{trip.stops.find((stop) => stop.id === visit.stopId)?.name ?? "Removed visit"} · Actual {formatActual(visit.start)} - {formatActual(visit.end)}</p>)}{[...progress.skipped, ...(progress.remaining?.skipped ?? [])].map((id) => <p className="recovery-fact" key={id}>{trip.stops.find((stop) => stop.id === id)?.name ?? "Removed visit"} · {progress.missedBookings.includes(id) ? "Missed booking" : "Skipped today"}</p>)}{checkedDay && <p className="quiet">Checked with Google at {new Date(checkedDay.checkedAt).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", timeZone: trip.timeZone })}</p>}</section>}
            {checkedRoute && <div className="notice"><strong>Selected next route</strong><p>{checkedRoute.edge.mode === "WALK" ? "Walk" : "Transit"} · {checkedRoute.edge.minutes} min · {trip.stops.find((stop) => stop.id === checkedRoute.edge.to)?.name ?? trip.hotel}</p><span className="quiet">Checked with Google at {new Date(checkedRoute.checkedAt).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", timeZone: trip.timeZone })}; remaining travel is not refreshed.</span></div>}
            {stale && <p className="notice warning">This itinerary is out of date. Plan again after your changes.</p>}
            {!currentDay ? <div className="empty-stops"><span className="empty-icon"><Route size={25} /></span><h2>{execution ? "Remaining today" : stale ? "Schedule needs refresh" : savedPlan ? "Saved itinerary" : "No itinerary yet"}</h2>{dayStopIds ? <ol className="saved-order">{remainingIds(dayStopIds, progress).map((id) => <li key={id}>{trip.stops.find((stop) => stop.id === id)?.name ?? "Removed stop"}{progress.remaining?.durations[id] ? ` · ${progress.remaining.durations[id]} min` : ""}</li>)}</ol> : stale && <p>Your saved itinerary is unchanged.</p>}{execution ? <p className="quiet">Travel times need refreshing.</p> : <button className="button primary" disabled={!trip.stops.length || Boolean(busy)} onClick={() => savedPlan ? void refreshTimes() : setPlanningOpen(true)}><Route size={16} />{savedPlan ? "Refresh travel times" : "Plan my days"}</button>}</div> : <>
              {!checkedDay && (savedRecovery || savedPlan?.snapshot) && <div className="notice"><strong>Saved {savedRecovery ? "day plan" : "itinerary"} · {currentDay.date} · {itineraryTrip.timeZone}</strong><p>Routes generated {savedRecovery?.checkedAt ?? savedPlan?.snapshot?.schedule.generatedAt}. Not a live travel check.</p>{!execution && <button className="button secondary small" disabled={Boolean(busy)} onClick={() => void refreshTimes()}><Route size={15} />Refresh travel times</button>}</div>}
              {day === 0 && itineraryTrip.arrival && !recoveryOrigin && <TransferLine trip={itineraryTrip} kind="arrival" />}
              <div className="itinerary-start"><span className="hotel-marker small"><Hotel size={15} /></span><div><strong>{recoveryOrigin ? recoveryOrigin.location ? "Current device location" : recoveryOrigin.id === "hotel" ? itineraryTrip.hotel : itineraryTrip.stops.find((stop) => stop.id === recoveryOrigin.id)?.name : itineraryTrip.hotel}</strong><span>Depart {checkedDay || savedRecovery ? new Date(checkedDay?.departureAt ?? savedRecovery!.departureAt).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", timeZone: itineraryTrip.timeZone }) : formatMinute(itineraryTrip, day, dayStart(itineraryTrip, day))}</span></div></div>
              {currentDay?.visits.map((visit, index) => {
                const stop = itineraryTrip.stops.find((entry) => entry.id === visit.stopId);
                if (!stop) return null;
                const alternatives = stop.alternativeGroup ? currentDay.visits.filter((other) => other.stopId !== stop.id && itineraryTrip.stops.find((entry) => entry.id === other.stopId)?.alternativeGroup === stop.alternativeGroup).map((other) => itineraryTrip.stops.find((entry) => entry.id === other.stopId)!.name) : [];
                return <div key={visit.stopId}><LegDetails edge={visit.leg} places={recoveryPlaces} onMode={checkedDay || stale ? undefined : (mode) => editStop(stop.id, { mode })} /><button className={`itinerary-stop ${selected === stop.id ? "selected" : ""}`} onClick={() => selectLocation(stop.id)}><span className="stop-number">{index + 1}</span><span className="stop-heading"><strong>{stop.name}</strong><span>{formatMinute(itineraryTrip, day, visit.start)} - {formatMinute(itineraryTrip, day, visit.end)} · {visit.end - visit.start} min</span>{alternatives.length > 0 && <span className="alternative-note">Alternative to {alternatives.join(", ")}; both fit</span>}</span>{stop.fixedTime && <LockKeyhole size={15} />}</button>{selected === stop.id && <PlacePhotos key={photoKey ?? stop.id} placeName={stop.name} variant="carousel" total={activePhotoSession?.total} frames={photoFrames} loading={photoLoading} errors={photoErrors} disabledMessage={photoDisabledMessage} onRequest={(photoIndex) => { if (photoKey && photoPlaceId) void requestPhoto(photoKey, photoPlaceId, photoIndex); }} onRetry={(photoIndex) => { if (photoKey && photoPlaceId) void requestPhoto(photoKey, photoPlaceId, photoIndex, true); }} />}</div>;
              })}
              {currentDay?.returnLeg && <><LegDetails edge={currentDay.returnLeg} places={recoveryPlaces} endpointToDeparture={endpointKey(itineraryTrip, day, "hotel", "to") === "departure"} /><div className="itinerary-start"><span className="hotel-marker small"><Hotel size={15} /></span><div><strong>{endpointKey(itineraryTrip, day, "hotel", "to") === "departure" ? `At ${itineraryTrip.departure!.place || "the station"}` : `Back to ${itineraryTrip.hotel}`}</strong><span>{formatMinute(itineraryTrip, day, (currentDay.visits.at(-1)?.end ?? (checkedDay || savedRecovery ? recoveryMinute(itineraryTrip, day, checkedDay?.departureAt ?? savedRecovery!.departureAt) : dayStart(itineraryTrip, day))) + currentDay.returnLeg.minutes)}</span></div></div></>}
              {day === itineraryTrip.days - 1 && itineraryTrip.departure && <TransferLine trip={itineraryTrip} kind="departure" />}
              {!currentDay?.visits.length && <p className="notice">No sights assigned to this day.</p>}
              {!checkedDay && result && <OmittedPlaces trip={trip} schedule={result.schedule} />}
              <div className="route-notices">{!checkedDay && result?.schedule.warnings.map((warning) => <p key={warning}>{warning}</p>)}<p>Walking routes may lack clear sidewalks or pedestrian paths. Use caution.</p><span>Route information: Google Maps</span></div>
            </>}
          </div>}
        </section>

        <section className="map-panel" aria-label="City map"><TripMap trip={tab === "itinerary" ? itineraryTrip : trip} places={photoPlaces} schedule={mapSchedule} markerOrder={markerOrder} currentLocation={tab === "itinerary" ? mapLocation : undefined} selectedRoute={tab === "itinerary" ? checkedRoute?.edge : undefined} day={day} selected={selected} onSelect={selectLocation} photoTotal={activePhotoSession?.total} photoFrames={photoFrames} photoLoading={photoLoading} photoErrors={photoErrors} photoDisabledMessage={photoDisabledMessage} onPhotoRequest={(placeId, index) => { if (photoKey) void requestPhoto(photoKey, placeId, index); }} onPhotoRetry={(placeId, index) => { if (photoKey) void requestPhoto(photoKey, placeId, index, true); }} /><div className="map-heading"><span className="map-heading-dot" /><span>{trip.city || "Your city"}</span><span className="map-heading-divider" />{tab === "places" ? "All places" : `Day ${day + 1}`}</div>{tab === "itinerary" && (checkedRoute || mapSchedule) && <div className="map-legend"><span><i className="walking-line" />Walking</span><span><i className="transit-line" />Public transit</span></div>}</section>
      </div>
    </main>

    {refreshOpen && <Dialog title="Refresh travel times" onClose={() => { refreshAbort.current?.abort(); setRefreshOpen(false); setRefreshPreview(null); }}>
      {busy === "Refreshing travel times" && <p className="notice" role="status"><LoaderCircle size={16} className="spin" />Checking the saved itinerary</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      {refreshPreview && <div aria-label="Refreshed itinerary preview">
        {refreshPreview.result.schedule.days.map((entry) => <section key={entry.day}><h3>Day {entry.day + 1} · {entry.date}</h3>
          {entry.visits.map((visit) => <div key={visit.stopId}><LegDetails edge={visit.leg} places={refreshPreview.result.places} /><p><strong>{refreshPreview.trip.stops.find((stop) => stop.id === visit.stopId)?.name}</strong> · {formatMinute(refreshPreview.trip, entry.day, visit.start)} - {formatMinute(refreshPreview.trip, entry.day, visit.end)}</p></div>)}
          {entry.returnLeg && <><LegDetails edge={entry.returnLeg} places={refreshPreview.result.places} endpointToDeparture={endpointKey(refreshPreview.trip, entry.day, "hotel", "to") === "departure"} /><p>{endpointKey(refreshPreview.trip, entry.day, "hotel", "to") === "departure" ? `At ${refreshPreview.trip.departure!.place || "the station"}` : `Back to ${refreshPreview.trip.hotel}`} · {formatMinute(refreshPreview.trip, entry.day, (entry.visits.at(-1)?.end ?? dayStart(refreshPreview.trip, entry.day)) + entry.returnLeg.minutes)}</p></>}
        </section>)}
        <div className="route-notices">{refreshPreview.result.schedule.warnings.map((warning) => <p key={warning}>{warning}</p>)}<span>Route information: Google Maps</span></div>
      </div>}
      <div className="dialog-actions"><button className="button secondary" onClick={() => { refreshAbort.current?.abort(); setRefreshOpen(false); setRefreshPreview(null); }}>Keep saved itinerary</button>
        {refreshPreview && <button className="button primary" disabled={Boolean(busy) || refreshPreview.tripKey !== JSON.stringify(trip) || refreshPreview.planKey !== JSON.stringify(savedPlan)} onClick={() => {
          if (refreshPreview.tripKey !== JSON.stringify(trip) || refreshPreview.planKey !== JSON.stringify(savedPlan) || validateSchedule(trip, refreshPreview.result.schedule).length) { setError("The trip changed. Refresh again before accepting new timings."); return; }
          const accepted = persistedPlan(refreshPreview.result.schedule, trip, refreshPreview.result.places);
          setJourney((current) => ({ ...current, plans: { ...current.plans, [trip.id]: accepted } }));
          setResult(refreshPreview.result); setPlaces(refreshPreview.result.places); setPlannedFor(JSON.stringify(trip));
          setRefreshOpen(false); setRefreshPreview(null); setError(""); setNotice("Travel times updated.");
        }}><Check size={16} />Use refreshed times</button>}
        {!busy && !refreshPreview && <button className="button secondary" onClick={() => { setRefreshOpen(false); setPlanningOpen(true); }}><Route size={16} />Replan itinerary</button>}
      </div>
    </Dialog>}
    {planningOpen && <PlanningDialog trip={trip} places={places} canPlan={canPlan} canResearch={Boolean(canUseServices && config.timing)} onClose={() => setPlanningOpen(false)} onPreview={generate} onCheck={(candidate) => requestJson("/api/plan", { trip: { ...candidate, dayGroups: undefined }, mode: "check", operationId: crypto.randomUUID() })} onResearch={(places) => requestJson("/api/timing", { city: trip.city, places, consent: true, operationId: crypto.randomUUID() })} onApply={(candidate, response) => {
      journeySchema.parse({ ...journey, cities: journey.cities.map((city) => city.id === trip.id ? candidate : city) });
      if (response && (!response.verified || validateSchedule(candidate, response.schedule).length)) throw new Error("Only a verified itinerary that respects the current preferences can be accepted.");
      const acceptedPlan = response ? persistedPlan(response.schedule, candidate, response.places) : undefined;
      editVersion.current += 1; setTrip(candidate);
      if (response) {
        setResult(response); setPlaces(response.places); setPlannedFor(JSON.stringify(candidate)); setTab("itinerary"); setDay(0);
        setJourney((current) => ({ ...current, plans: { ...current.plans, [trip.id]: acceptedPlan! } }));
      }
      setPlanningOpen(false); setError(""); setNotice(response ? "Itinerary updated. Check venue hours and ticket conditions before departure." : "Planning preferences updated.");
    }} />}
    {importOpen && <ImportReview trip={trip} extraction={config.extraction} canExtract={Boolean(canUseServices && config.ai)} onClose={() => setImportOpen(false)} onImport={(stops, existing) => { const combined = tripSchema.shape.stops.parse([...existing, ...stops]); if (combined.some((stop) => stop.day !== null && stop.day >= trip.days)) throw new Error("A visit is assigned outside this trip."); edit({ stops: combined }); setTab("places"); setNotice(stops.length ? `${stops.length} places added. Confirm each place on the map before planning.` : "Approved duplicate updates applied."); }} />}
    {search && <Dialog title={search.id === "hotel" ? "Find your hotel" : search.id === "departure" || search.id === "arrival" ? "Find your airport or station" : "Confirm location"} onClose={() => setSearch(null)}><form className="search-form" onSubmit={(event) => { event.preventDefault(); void findPlaces(search.query); }}><label className="field grow">Place or address<input autoFocus disabled={Boolean(busy)} maxLength={350} value={search.query} onChange={(event) => { setSearch({ ...search, query: event.target.value }); setMatches([]); setHasSearched(false); }} /></label><button type="submit" className="button primary" disabled={Boolean(busy)}>{busy ? <LoaderCircle size={17} className="spin" /> : <Search size={17} />}Search</button></form>{error && <p className="notice error" role="alert">{error}</p>}{hasSearched && !matches.length && !error && <p className="notice">No matching places found. Try the hotel address or a more specific name.</p>}<div className="place-matches">{matches.map((place) => <button key={place.id} disabled={Boolean(busy)} onClick={() => void confirmPlace(place)}><MapPin size={19} /><span><strong>{place.name}</strong><small>{place.address}</small></span><ArrowUpRight size={17} /></button>)}</div><p className="provider-attribution">Google Maps</p></Dialog>}
    {settingsOpen && <Dialog title="Connections" onClose={() => setSettingsOpen(false)}><div className="connection-list">{[{ label: "Google sign-in", ready: config.auth }, { label: "Trip storage", ready: config.database }, { label: "Google Maps", ready: config.maps }, { label: "Place search and routes", ready: config.routes }, { label: "AI import", ready: config.ai }].map((service) => <div key={service.label}><span>{service.label}</span><span className={`service-state ${service.ready ? "ready" : ""}`}>{service.ready ? "Enabled" : "Not set up"}</span></div>)}</div><p className="notice">Do not include passwords or API keys in trips or uploaded documents.</p><div className="connection-limits"><ShieldCheck size={17} /><span>Restricted access · Usage limits apply</span></div><div className="dialog-actions"><button className="button secondary" disabled={Boolean(busy)} onClick={() => backupInput.current?.click()}><FileInput size={16} />Open backup</button><button className="button secondary" disabled={Boolean(busy)} onClick={() => { setSettingsOpen(false); setSetup("new"); }}><Plus size={16} />New trip</button>{!config.email && <button className="button primary" disabled={!config.auth} onClick={() => void signIn("google")}><UserRound size={16} />Sign in</button>}</div></Dialog>}
    {savedTrips && <Dialog title="My trips" onClose={() => setSavedTrips(null)}><div className="saved-trips">{savedTrips.length ? savedTrips.map((entry) => <div key={entry.data.id}><button className="saved-trip" disabled={Boolean(busy)} onClick={() => loadSaved(entry)}><span className="saved-trip-icon"><MapPin size={22} /></span><span><strong>{entry.data.title}</strong><small>{asJourney(entry.data).cities.map((city) => city.city).join(" / ")} · {asJourney(entry.data).cities[0].startDate}</small></span><ArrowUpRight size={17} /></button><button className="icon-button danger" title={`Delete ${entry.data.title}`} aria-label={`Delete ${entry.data.title}`} disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Delete ${entry.data.title}?`)) void perform("Deleting trip", async () => { await requestJson(`/api/trips/${entry.data.id}`, undefined, "DELETE"); setSavedTrips((current) => current!.filter((item) => item.data.id !== entry.data.id)); if (journey.id === entry.data.id) { setRevision(0); setSavedFor(""); } }); }}><Trash2 size={17} /></button></div>) : <p className="notice">No saved trips yet.</p>}</div><div className="dialog-actions"><button className="button primary" disabled={Boolean(busy)} onClick={() => { setSavedTrips(null); setSetup("new"); }}><Plus size={16} />New trip</button></div></Dialog>}
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
    {recoveryOpen && dayStopIds && <DayRecoveryDialog key={`${trip.id}:${date}`} trip={trip} day={day} stopIds={dayStopIds} progress={progress} plannedDay={currentDay} selectedRoute={checkedRoute} onClearRoute={() => setLiveRoute(undefined)} onProgress={recordProgress} onClose={() => setRecoveryOpen(false)} onRoute={(route) => { setLiveRoute({ ...route, cityId: trip.id, day, version: progress.version, planKey: recoveryPlanKey(trip, day, dayStopIds) }); }} onApply={(request, option, checkedAt) => {
      if (progress.version !== request.progress.version || request.progress.planKey !== recoveryPlanKey(trip, day, dayStopIds) || validateDayRecovery(request, option).length) throw new Error("The day changed. Refresh the recovery preview.");
      const next = applyDayRecovery(progress, option, { trip, day: option.day, checkedAt, departureAt: request.departureAt, origin: request.origin, places }); recordProgress(next);
      setLiveDay({ cityId: trip.id, version: next.version, planKey: next.planKey, day: option.day, checkedAt, departureAt: request.departureAt, origin: request.origin });
      setNotice("Today's plan updated. Other days are unchanged.");
    }} />}
  </div>;
}

function LegDetails({ edge, places, onMode, endpointToDeparture = false }: { edge: TravelEdge; places: Record<string, Place>; onMode?: (mode: "WALK" | "TRANSIT") => void; endpointToDeparture?: boolean }) {
  const origin = places[edge.from];
  // Last leg of a direct departure day: "hotel" stands for the airport or station.
  const destination = endpointToDeparture && edge.to === "hotel" && places.departure ? places.departure : places[edge.to];
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1"); url.searchParams.set("origin", origin?.name ?? edge.from); url.searchParams.set("destination", destination?.name ?? edge.to);
  if (origin?.id) url.searchParams.set("origin_place_id", origin.id);
  if (destination) url.searchParams.set("destination_place_id", destination.id);
  url.searchParams.set("travelmode", edge.mode === "WALK" ? "walking" : "transit");
  return <details className="travel-leg"><summary>{edge.mode === "WALK" ? <Footprints size={15} /> : <TrainFront size={15} />}<span>{edge.mode === "WALK" ? "Walk" : "Public transit"} · {edge.minutes} min{edge.assumed ? " (assumed, not checked with Google)" : ""}{edge.timetableDate ? ` (timetable of ${edge.timetableDate})` : ""} {edge.mode === "WALK" && `· ${(edge.meters / 1000).toFixed(1)} km`}</span><ChevronDown size={13} /></summary><div className="leg-details"><div className="transport-options">{[edge, ...(edge.alternatives ?? [])].map((option) => <button key={option.mode} disabled={!onMode || option.mode === edge.mode} aria-pressed={option.mode === edge.mode} title={`Prefer ${option.mode === "WALK" ? "walking" : "public transit"} and replan`} onClick={() => onMode?.(option.mode)}>{option.mode === "WALK" ? <Footprints size={14} /> : <TrainFront size={14} />}<span>{option.mode === "WALK" ? "Walk" : "Transit"}<strong>{option.minutes} min</strong></span></button>)}</div>{edge.steps?.map((step, index) => <p key={index}>{step.line && <strong>{step.line} </strong>}{step.from && step.to ? `${step.from} to ${step.to}` : step.instruction}</p>)}{edge.fare && <p>Estimated fare: {edge.fare}</p>}<a href={url.toString()} target="_blank" rel="noreferrer">Open in Google Maps <ArrowUpRight size={13} /></a></div></details>;
}