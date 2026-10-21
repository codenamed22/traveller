"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import { ArrowUpRight, Check, ChevronLeft, ChevronRight, Footprints, Heart, Hotel, LocateFixed, LockKeyhole, LogOut, Maximize2, Menu, Navigation, SkipForward, Star, Ticket as TicketIcon, TrainFront, Undo2, X } from "lucide-react";
import type { DayProgress } from "@/lib/day-recovery";
import { exportNote } from "@/lib/export";
import { ticketsFor, type Ticket, type TicketPlace } from "@/lib/tickets";
import type { Journey } from "@/lib/journey";
import { journalEntry, type JournalAction } from "@/lib/journal";
import { endpointKey, formatMinute, instantForMinute, isMustSee, tripDate, type SavedPlan, type Trip, type Visit } from "@/lib/trip";
import { dayLabel, daySummary, directionsUrl, durationLabel, leaveBy, markDone, markPending, markSkipped, minuteNow, nextVisit, startingDay, tripModeDays, visitStatus, type TripModeDay } from "@/lib/trip-mode";
import { BottomSheet, type Snap } from "./BottomSheet";
import { LegDetails } from "./LegDetails";
import { OmittedPlaces } from "./OmittedPlaces";
import { PlacePhotos } from "./PlacePhotos";
import { TransferLine } from "./TransferFields";
import { TripMap } from "./TripMap";
import { usePlacePhotos } from "./usePlacePhotos";
import { RainWarning, WeatherBadge, WeatherCredit } from "./Weather";
import { DayNote, FavouriteButton } from "./Journal";
import { rainWarningFor, type Forecast } from "@/lib/weather";

type Props = {
  title: string; cities: Trip[]; plans: Record<string, SavedPlan>; execution?: Journey["execution"]; start?: { cityId: string; day: number };
  // Owners can record Done and Skip on today's visits; viewers of a shared trip cannot.
  canTrack: boolean; onProgress?: (cityId: string, date: string, progress: DayProgress | undefined) => void;
  onAdjustToday?: (cityId: string, day: number) => void; onClose: () => void;
  // Changing this asks trip mode to close, as its own close button does.
  exitSignal?: number;
  // Owners can load Google photos of a tapped place; shared viewers cannot.
  photos?: boolean;
  // The owner's tickets, opened from the visit or the arrival or departure they're for.
  tickets?: Ticket[];
  // Each city's forecast, by city id; `onSwap` asks the agent to swap a visit rain threatens.
  forecasts?: Record<string, Forecast>; onSwap?: (cityId: string, day: number, stopId: string) => void;
  // The owner's notes and favourites; `onJournal` keeps them, from the first day of the trip on.
  journal?: Journey["journal"]; onJournal?: (action: JournalAction) => void;
};
type Undo = { cityId: string; date: string; previous?: DayProgress; message: string };

const noPhotos = {};
const noTickets: Ticket[] = [];
const noForecasts: Record<string, Forecast> = {};
const modeLabel = (visit: Visit) => `${durationLabel(visit.leg.minutes)} ${visit.leg.mode === "WALK" ? "walk" : "by transit"}`;

// Full-screen, map-first view of one day at a time, for using the itinerary while travelling.
export function TripMode({ title, cities, plans, execution, start, canTrack, onProgress, onAdjustToday, onClose, exitSignal, photos = false, tickets = noTickets, forecasts = noForecasts, onSwap, journal, onJournal }: Props) {
  const ticketLinks = (place: TicketPlace) => ticketsFor(tickets, place).map((ticket, _index, all) => <a key={ticket.id} className="button secondary small" href={`/api/trips/${ticket.tripId}/tickets/${ticket.id}`} target="_blank" rel="noopener"><TicketIcon size={15} />{all.length === 1 ? "Ticket" : ticket.name}</a>);
  const [now, setNow] = useState(() => Temporal.Now.instant());
  const days = useMemo(() => tripModeDays(cities, plans, execution, now), [cities, plans, execution, now]);
  const [key, setKey] = useState(() => startingDay(days, start)?.key);
  const entry = days.find((candidate) => candidate.key === key) ?? days[0];
  const [selected, setSelected] = useState<string | null>(null);
  const [snap, setSnap] = useState<Snap>("peek");
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheetHeight, setSheetHeight] = useState(200);
  const [viewport, setViewport] = useState({ width: 390, height: 800 });
  const [location, setLocation] = useState<{ lat: number; lng: number }>();
  const [centerOn, setCenterOn] = useState<{ lat: number; lng: number; token: number }>();
  const [fitToken, setFitToken] = useState(0);
  const [locationNote, setLocationNote] = useState("");
  const [undo, setUndo] = useState<Undo>();
  const watch = useRef<number | null>(null);
  const pushed = useRef(0);
  const centreOnFix = useRef(false);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });

  // Back closes the menu first, then trip mode. Opening pushes #trip (and #trip-menu for the menu); reopening after a
  // reload on #trip pushes nothing, so leaving replaces the hash instead of going back.
  useEffect(() => {
    if (window.location.hash === "#trip-menu") window.history.replaceState(null, "", "#trip");
    else if (window.location.hash !== "#trip") { window.history.pushState(null, "", "#trip"); pushed.current = 1; }
    const pop = () => {
      if (window.location.hash === "#trip-menu") setMenuOpen(true);
      else if (window.location.hash === "#trip") setMenuOpen(false);
      // The assistant can open over trip mode with its own entry.
      else if (window.location.hash !== "#assistant") close.current();
    };
    window.addEventListener("popstate", pop);
    document.body.classList.add("trip-mode-open");
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    resize(); window.addEventListener("resize", resize);
    const timer = setInterval(() => setNow(Temporal.Now.instant()), 30_000);
    return () => {
      window.removeEventListener("popstate", pop); window.removeEventListener("resize", resize); clearInterval(timer);
      document.body.classList.remove("trip-mode-open");
      if (watch.current !== null) navigator.geolocation?.clearWatch(watch.current);
    };
  }, []);
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(undefined), 6000);
    return () => clearTimeout(timer);
  }, [undo]);
  useEffect(() => {
    // Resume the location dot without asking again if this site already has permission.
    navigator.permissions?.query({ name: "geolocation" as PermissionName }).then((status) => { if (status.state === "granted") locate(false); }, () => {});
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && window.location.hash !== "#assistant") { if (window.location.hash === "#trip-menu") window.history.back(); else exit(); } };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (exitSignal) exit(); }, [exitSignal]);

  function exit() {
    if (pushed.current) { window.history.go(-pushed.current); pushed.current = 0; return; }
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    close.current();
  }
  function openMenu() { window.history.pushState(null, "", "#trip-menu"); pushed.current += 1; setMenuOpen(true); }
  function closeMenu() { if (window.location.hash === "#trip-menu") { pushed.current = Math.max(0, pushed.current - 1); window.history.back(); } setMenuOpen(false); }
  function choose(next: TripModeDay) { setKey(next.key); setSelected(null); setSnap("peek"); closeMenu(); }
  function step(direction: 1 | -1) {
    const index = days.findIndex((candidate) => candidate.key === entry?.key);
    const next = days[index + direction];
    if (next) { setKey(next.key); setSelected(null); }
  }
  function locate(centre = true) {
    if (!navigator.geolocation) { setLocationNote("Location isn't available on this device."); return; }
    if (location && centre) { setCenterOn({ ...location, token: Date.now() }); return; }
    if (watch.current !== null) return;
    centreOnFix.current = centre;
    setLocationNote(centre ? "Finding you…" : "");
    watch.current = navigator.geolocation.watchPosition((position) => {
      const fix = { lat: position.coords.latitude, lng: position.coords.longitude };
      setLocation(fix); setLocationNote("");
      if (centreOnFix.current) { centreOnFix.current = false; setCenterOn({ ...fix, token: Date.now() }); }
    }, () => {
      if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
      watch.current = null; setLocationNote("Location is off. Allow it for this site to see where you are.");
    }, { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 });
  }

  // Photos load for a place you tap, as in the planner.
  const photoPlaceId = selected ? entry?.places[selected]?.id || entry?.trip.stops.find((stop) => stop.id === selected)?.placeId || undefined : undefined;
  const photoKey = photoPlaceId ? `${entry?.cityId}:${photoPlaceId}` : null;
  const photo = usePlacePhotos(photoKey, photoPlaceId, photos);
  if (!entry) return null;
  const stopName = (id: string) => entry.trip.stops.find((stop) => stop.id === id)?.name ?? entry.places[id]?.name ?? "Removed place";
  const tracking = canTrack && entry.isToday && Boolean(onProgress);
  const next = entry.isToday ? nextVisit(entry) : undefined;
  const focus = entry.plan.visits.find((visit) => visit.stopId === selected) ?? next;
  const forecast = forecasts[entry.cityId];
  const weather = forecast?.days[entry.date];
  const rainAt = (visit: Visit) => {
    try { return rainWarningFor(forecast, entry.trip, entry.trip.stops.find((stop) => stop.id === visit.stopId), entry.places[visit.stopId], instantForMinute(entry.trip, entry.day, visit.start).epochMilliseconds, instantForMinute(entry.trip, entry.day, visit.end).epochMilliseconds); } catch { return undefined; }
  };
  const toDeparture = endpointKey(entry.trip, entry.day, "hotel", "to") === "departure";
  const nowMinute = minuteNow(entry, now);
  const position = days.indexOf(entry);
  const markerStatus = Object.fromEntries(entry.plan.visits.map((visit) => [visit.stopId, visitStatus(entry.progress, visit.stopId)]).filter(([, status]) => status !== "pending"));
  if (next) markerStatus[next.stopId] = "next";
  const done = entry.isToday && entry.plan.visits.length > 0 && !next;
  const summary = daySummary(entry.plan);
  const dayJournal = journalEntry({ journal }, entry.cityId, entry.date);
  const favourite = (stopId: string) => Boolean(dayJournal.favourites?.includes(stopId));
  const journaling = Boolean(onJournal) && entry.started;

  function record(kind: "done" | "skip", visit: Visit) {
    const stop = entry.trip.stops.find((candidate) => candidate.id === visit.stopId);
    if (!onProgress || !stop) return;
    const updated = kind === "done" ? markDone(entry, visit.stopId, nowMinute) : markSkipped(entry, stop);
    onProgress(entry.cityId, entry.date, updated);
    setUndo({ cityId: entry.cityId, date: entry.date, previous: entry.progress, message: kind === "done" ? `${stop.name} marked done` : `${stop.name} skipped` });
    setSelected(null);
  }

  // Undo on the visit itself, for any time after the quick Undo has gone.
  function reset(visit: Visit) {
    const stop = entry.trip.stops.find((candidate) => candidate.id === visit.stopId);
    if (!onProgress || !stop) return;
    const wasDone = visitStatus(entry.progress, visit.stopId) === "done";
    onProgress(entry.cityId, entry.date, markPending(entry, visit.stopId));
    setUndo({ cityId: entry.cityId, date: entry.date, previous: entry.progress, message: wasDone ? `${stop.name} no longer marked done` : `${stop.name} no longer skipped` });
  }

  function card() {
    if (focus) {
      const index = entry.plan.visits.indexOf(focus);
      const status = visitStatus(entry.progress, focus.stopId);
      const stop = entry.trip.stops.find((candidate) => candidate.id === focus.stopId);
      const completed = entry.progress?.completed.find((visit) => visit.stopId === focus.stopId);
      const leave = leaveBy(focus);
      const isNext = focus === next;
      const note = stop?.source ? exportNote(stop.source) : "";
      // From the city as it is now, so a note written after planning shows.
      const current = entry.cityTrip.stops.find((candidate) => candidate.id === focus.stopId);
      const yourNote = current?.note;
      return <div className="trip-card">
        <div className="trip-card-label">{isNext ? "Next" : "Stop"} · {index + 1} of {entry.plan.visits.length}{selected && next && focus !== next && <button type="button" className="chip" onClick={() => setSelected(null)}>Back to next</button>}</div>
        <div className="trip-card-title"><h2>{stopName(focus.stopId)}</h2>{journaling && <FavouriteButton className="icon-button" on={favourite(focus.stopId)} name={stopName(focus.stopId)} onChange={(on) => onJournal!({ kind: "favourite", cityId: entry.cityId, day: entry.day, stopId: focus.stopId, on })} />}</div>
        <p className="trip-card-time">{formatMinute(entry.trip, entry.day, focus.start)}–{formatMinute(entry.trip, entry.day, focus.end)}{stop?.fixedTime && <span className="booked"><LockKeyhole size={12} />Booked</span>}{current && isMustSee(current) && <span className="booked"><Star size={12} />Must-see</span>}</p>
        {status === "done" ? <p className="trip-card-status done"><Check size={14} />Done{completed ? ` ${formatMinute(entry.cityTrip, entry.day, completed.start)}–${formatMinute(entry.cityTrip, entry.day, completed.end)}` : ""}</p>
          : status === "skipped" ? <p className="trip-card-status skipped"><SkipForward size={14} />Skipped</p>
          : <p className="trip-card-leave">{focus.leg.mode === "WALK" ? <Footprints size={14} /> : <TrainFront size={14} />}Leave by {formatMinute(entry.trip, entry.day, leave)} · {modeLabel(focus)}{entry.isToday && isNext ? leave > nowMinute ? ` · in ${durationLabel(leave - nowMinute)}` : " · now" : ""}</p>}
        {status === "pending" && rainAt(focus) !== undefined && <RainWarning chance={rainAt(focus)!} onSwap={onSwap ? () => { const target = entry; exit(); onSwap(target.cityId, target.day, focus.stopId); } : undefined} />}
        {selected && <PlacePhotos key={photoKey ?? focus.stopId} placeName={stopName(focus.stopId)} variant="carousel" total={photo.total} frames={photo.frames} loading={photo.loading} errors={photo.errors} disabledMessage={photo.disabledMessage} onRequest={photo.request} onRetry={photo.retry} />}
        {yourNote && <p className="stop-note">{yourNote}</p>}
        {selected && note && <p className="trip-card-note">{note}</p>}
        <div className="trip-card-actions">
          <a className="button primary small" href={directionsUrl(focus.leg, entry.places, { fromHere: entry.isToday && status === "pending" })} target="_blank" rel="noreferrer"><Navigation size={15} />Directions</a>
          {tracking && status === "pending" && <><button type="button" className="button secondary small" onClick={() => record("done", focus)}><Check size={15} />Done</button><button type="button" className="button secondary small" onClick={() => record("skip", focus)}><SkipForward size={15} />Skip</button></>}
          {tracking && status !== "pending" && <button type="button" className="button secondary small" onClick={() => reset(focus)}><Undo2 size={15} />Undo</button>}
          {ticketLinks({ cityId: entry.cityId, target: "stop", stopId: focus.stopId })}
        </div>
      </div>;
    }
    if (done) return <div className="trip-card">
      <div className="trip-card-label">Today</div>
      <h2>All done for today</h2>
      {entry.plan.returnLeg && <><p className="trip-card-leave">{toDeparture ? `On to ${entry.trip.departure?.place || "the station"}` : `Back to ${entry.trip.hotel}`} · {durationLabel(entry.plan.returnLeg.minutes)} {entry.plan.returnLeg.mode === "WALK" ? "walk" : "by transit"}</p>
        <div className="trip-card-actions"><a className="button primary small" href={directionsUrl(entry.plan.returnLeg, entry.places, { fromHere: true, toDeparture })} target="_blank" rel="noreferrer"><Navigation size={15} />Directions</a></div></>}
    </div>;
    return <div className="trip-card">
      <div className="trip-card-label">{entry.isToday ? "Today" : entry.label}</div>
      <h2>{summary.stops ? `${summary.stops} ${summary.stops === 1 ? "stop" : "stops"}` : "Nothing planned"}{summary.leave !== undefined && summary.back !== undefined ? ` · ${formatMinute(entry.trip, entry.day, summary.leave)}–${formatMinute(entry.trip, entry.day, summary.back)}` : ""}</h2>
      {summary.stops > 0 && <p className="trip-card-leave">{durationLabel(summary.travel)} travelling · first {stopName(entry.plan.visits[0].stopId)} at {formatMinute(entry.trip, entry.day, entry.plan.visits[0].start)}</p>}
      {summary.stops > 0 && <div className="trip-card-actions"><button type="button" className="button secondary small" onClick={() => setSnap("half")}>See the day</button></div>}
    </div>;
  }

  const firstLeave = entry.plan.visits[0] ? leaveBy(entry.plan.visits[0]) : undefined;
  // Tapping the map closes an open place and brings the map to it, or lowers the day plan so the map shows.
  function backToMap() {
    const place = selected ? entry.places[selected] : undefined;
    setSelected(null); setSnap("peek");
    if (place) setCenterOn({ ...place.location, token: Date.now() });
  }
  const sheetSizes = { half: Math.round(viewport.height * 0.52), full: viewport.height - 84 };
  const padding = { top: 92, bottom: Math.min(sheetHeight, sheetSizes.half) + 24, left: 36, right: 64 };

  return <div className="trip-mode" role="dialog" aria-modal="true" aria-label={`Trip mode, ${entry.label}`}>
    <div className="trip-mode-map">
      <TripMap trip={entry.trip} places={entry.places} schedule={{ generatedAt: "", warnings: [], omitted: [], days: [entry.plan] }} day={entry.plan.day} markerOrder={entry.plan.visits.map((visit) => visit.stopId)} selected={selected} onSelect={(id) => { setSelected(id === "hotel" ? null : id); if (id) setSnap("peek"); }} currentLocation={location} fitCurrentLocation={false} padding={padding} fitToken={fitToken} popup={false} zoomOnSelect markerStatus={markerStatus} centerOn={centerOn} onMapClick={backToMap} photoFrames={noPhotos} photoLoading={noPhotos} photoErrors={noPhotos} onPhotoRequest={() => {}} onPhotoRetry={() => {}} />
    </div>

    <header className="trip-mode-bar">
      <button type="button" className="round-button" aria-label="Trip menu" aria-expanded={menuOpen} onClick={openMenu}><Menu size={20} /></button>
      <div className="trip-mode-day">
        <button type="button" aria-label="Previous day" disabled={position <= 0} onClick={() => step(-1)}><ChevronLeft size={18} /></button>
        <div><strong>{entry.label}</strong><span>{entry.city}{entry.isToday ? " · Today" : ""}{weather && <WeatherBadge weather={weather} range />}</span></div>
        <button type="button" aria-label="Next day" disabled={position >= days.length - 1} onClick={() => step(1)}><ChevronRight size={18} /></button>
      </div>
      <button type="button" className="round-button" aria-label="Exit trip mode" onClick={exit}><X size={20} /></button>
    </header>

    <div className="trip-mode-tools" style={{ bottom: Math.min(sheetHeight, sheetSizes.half) + 14 }}>
      <button type="button" className="round-button" aria-label="Show my location" aria-pressed={Boolean(location)} onClick={() => locate(true)}><LocateFixed size={19} /></button>
      <button type="button" className="round-button" aria-label="Fit the day on the map" onClick={() => { setSelected(null); setFitToken((value) => value + 1); }}><Maximize2 size={18} /></button>
    </div>
    {locationNote && <p className="trip-mode-toast" role="status">{locationNote}</p>}
    {undo && <div className="trip-mode-toast" role="status"><span>{undo.message}</span><button type="button" onClick={() => { onProgress?.(undo.cityId, undo.date, undo.previous); setUndo(undefined); }}>Undo</button></div>}

    <BottomSheet label="Day plan" snap={snap} sizes={sheetSizes} onSnap={setSnap} onSwipe={step} onHeight={setSheetHeight} header={<>
      {entry.stale && <p className="trip-mode-note">Plan is out of date. Replan in the planner.</p>}
      {card()}
    </>}>
      <div className="trip-timeline">
        {entry.replanned && <p className="trip-mode-note">Today was replanned; showing the updated day.</p>}
        {entry.day === 0 && entry.trip.arrival && <TransferLine trip={entry.trip} kind="arrival">{ticketLinks({ cityId: entry.cityId, target: "arrival", stopId: null })}</TransferLine>}
        {entry.day === 0 && entry.plan.arrivalLeg && <LegDetails edge={entry.plan.arrivalLeg} places={entry.places} />}
        {entry.progress?.completed.filter((visit) => !entry.plan.visits.some((planned) => planned.stopId === visit.stopId)).map((visit) => <p className="trip-timeline-done" key={visit.stopId}><Check size={14} />{stopName(visit.stopId)} · {formatMinute(entry.cityTrip, entry.day, visit.start)}–{formatMinute(entry.cityTrip, entry.day, visit.end)}</p>)}
        {entry.plan.visits.length > 0 && <div className="itinerary-start"><span className="hotel-marker small"><Hotel size={15} /></span><div><strong>{entry.trip.hotel}</strong><span>Leave {firstLeave !== undefined ? formatMinute(entry.trip, entry.day, firstLeave) : ""}</span></div></div>}
        {entry.plan.visits.map((visit, index) => {
          const stop = entry.trip.stops.find((candidate) => candidate.id === visit.stopId);
          const status = visitStatus(entry.progress, visit.stopId);
          const alternatives = stop?.alternativeGroup ? entry.plan.visits.filter((other) => other.stopId !== visit.stopId && entry.trip.stops.find((candidate) => candidate.id === other.stopId)?.alternativeGroup === stop.alternativeGroup).map((other) => stopName(other.stopId)) : [];
          return <div key={visit.stopId} className={`trip-timeline-stop ${status}`}>
            <LegDetails edge={visit.leg} places={entry.places} />
            <button type="button" className={`itinerary-stop ${selected === visit.stopId ? "selected" : ""} ${visit === next ? "next" : ""}`} onClick={() => { setSelected(visit.stopId); setSnap("peek"); }}>
              <span className="stop-number">{status === "done" ? <Check size={13} /> : index + 1}</span>
              <span className="stop-heading"><strong>{stopName(visit.stopId)}{isMustSee(entry.cityTrip.stops.find((candidate) => candidate.id === visit.stopId) ?? { priority: 1 }) && <Star size={12} className="must-see-icon" role="img" aria-label="Must-see" />}{favourite(visit.stopId) && <Heart size={12} className="favourite-icon" role="img" aria-label="Favourite" />}</strong><span>{formatMinute(entry.trip, entry.day, visit.start)} - {formatMinute(entry.trip, entry.day, visit.end)} · {visit.end - visit.start} min{status === "skipped" ? " · skipped" : ""}</span>{status === "pending" && rainAt(visit) !== undefined && <RainWarning chance={rainAt(visit)!} />}{alternatives.length > 0 && <span className="alternative-note">Alternative to {alternatives.join(", ")}; both fit</span>}</span>
              {stop?.fixedTime && <LockKeyhole size={15} />}
            </button>
          </div>;
        })}
        {entry.plan.returnLeg && <><LegDetails edge={entry.plan.returnLeg} places={entry.places} endpointToDeparture={toDeparture} /><div className="itinerary-start"><span className="hotel-marker small"><Hotel size={15} /></span><div><strong>{toDeparture ? `At ${entry.trip.departure?.place || "the station"}` : `Back to ${entry.trip.hotel}`}</strong><span>{summary.back !== undefined ? formatMinute(entry.trip, entry.day, summary.back) : ""}</span></div></div></>}
        {entry.day === entry.trip.days - 1 && entry.plan.departureLeg && <LegDetails edge={entry.plan.departureLeg} places={entry.places} />}
        {entry.day === entry.trip.days - 1 && entry.trip.departure && <TransferLine trip={entry.trip} kind="departure">{ticketLinks({ cityId: entry.cityId, target: "departure", stopId: null })}</TransferLine>}
        {plans[entry.cityId]?.snapshot && <OmittedPlaces trip={entry.trip} schedule={plans[entry.cityId].snapshot!.schedule} />}
        {(journaling || dayJournal.note) && <DayNote key={entry.key} note={dayJournal.note} onSave={journaling ? (text) => onJournal!({ kind: "note", cityId: entry.cityId, day: entry.day, text }) : undefined} />}
        {forecast && <p className="trip-mode-credit"><WeatherCredit /></p>}
      </div>
    </BottomSheet>

    {menuOpen && <div className="trip-menu-scrim" onClick={closeMenu}>
      <nav className="trip-menu" aria-label="Trip days" onClick={(event) => event.stopPropagation()}>
        <div className="trip-menu-heading"><strong>{title}</strong><button type="button" className="icon-button" aria-label="Close menu" onClick={closeMenu}><X size={18} /></button></div>
        <div className="trip-menu-days">{cities.map((city) => {
          const cityDays = days.filter((candidate) => candidate.cityId === city.id);
          return <section key={city.id}>
            <h3>{city.city}<small>{city.startDate ? city.days > 1 ? `${dayLabel(city.startDate)} – ${dayLabel(tripDate(city, city.days - 1))}` : dayLabel(city.startDate) : ""}</small></h3>
            {!cityDays.length ? <p className="quiet">Not planned yet</p> : cityDays.map((candidate) => {
              const finished = candidate.plan.visits.filter((visit) => visitStatus(candidate.progress, visit.stopId) !== "pending").length;
              return <button type="button" key={candidate.key} aria-current={candidate.key === entry.key ? "true" : undefined} onClick={() => choose(candidate)}>
                <span>{candidate.label}</span>
                <small>{candidate.plan.visits.length} {candidate.plan.visits.length === 1 ? "stop" : "stops"}{finished ? ` · ${finished}/${candidate.plan.visits.length} done` : ""}</small>
                {candidate.isToday && <em>Today</em>}
              </button>;
            })}
          </section>;
        })}</div>
        <div className="trip-menu-footer">
          {onAdjustToday && entry.isToday && <button type="button" className="button secondary" onClick={() => { const target = entry; exit(); onAdjustToday(target.cityId, target.day); }}><ArrowUpRight size={16} />Running late? Adjust today</button>}
          <button type="button" className="button secondary" onClick={exit}><LogOut size={16} />Exit trip mode</button>
        </div>
      </nav>
    </div>}
  </div>;
}
