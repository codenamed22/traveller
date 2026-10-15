"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { ArrowUpRight, CalendarDays, Compass, Eye, FolderOpen, Hotel, List, LockKeyhole, Map, MapPin, Navigation, Route } from "lucide-react";
import type { SharedView } from "@/lib/shared-trips";
import { dayStart, endpointKey, formatMinute, planningKey, tripDate } from "@/lib/trip";
import { ExportMenu } from "./ExportMenu";
import { LegDetails } from "./LegDetails";
import { OmittedPlaces } from "./OmittedPlaces";
import { TransferLine } from "./TransferFields";
import { TripMap } from "./TripMap";
import { TripMode } from "./TripMode";

const noPhotos = {};

// A trip shared for viewing: the accepted itinerary of each city, with the map, directions and exports. Nothing here edits,
// saves, plans or calls a paid service.
export function TripViewer({ view, email }: { view: SharedView; email: string }) {
  const [cityId, setCityId] = useState(view.cities[0].id);
  const [day, setDay] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "map">("list");
  const [tripMode, setTripMode] = useState(false);
  const planned = view.cities.some((entry) => view.plans[entry.id]?.snapshot);
  // /shared/<id>#trip opens straight into trip mode. The hash is only known in the browser, after hydration.
  useEffect(() => { if (window.location.hash.startsWith("#trip") && planned) setTripMode(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  const city = view.cities.find((entry) => entry.id === cityId) ?? view.cities[0];
  const snapshot = view.plans[city.id]?.snapshot;
  const trip = snapshot?.trip ?? city;
  const currentDay = snapshot?.schedule.days.find((entry) => entry.day === day);
  const changed = Boolean(snapshot && planningKey(snapshot.trip) !== planningKey(city));
  const journey = { ...view, execution: undefined };
  // Notes come from the city as it is now: writing one doesn't replan.
  const note = (stopId: string) => city.stops.find((entry) => entry.id === stopId)?.note;
  const toDeparture = endpointKey(trip, day, "hotel", "to") === "departure";

  return <div className="app-shell trip-viewer">
    <header className="app-header">
      <Link className="brand" href="/shared" aria-label="Shared trips"><span className="brand-mark"><Compass size={23} /></span>traveller<span className="brand-dot">.</span></Link>
      <nav aria-label="Main navigation"><Link className="nav-button active" href="/shared"><FolderOpen size={17} /><span>Shared trips</span></Link>{view.isOwner && <Link className="nav-button" href="/"><ArrowUpRight size={17} /><span>Open planner</span></Link>}</nav>
      <div className="header-actions"><button className="account-button" title={email} onClick={() => void signOut({ redirectTo: "/shared" })}><span className="avatar">{email[0].toUpperCase()}</span><span>Sign out</span></button></div>
    </header>

    <main className="planner-main">
      <section className="trip-heading">
        <div className="trip-identity"><span className="eyebrow">{view.cities.length > 1 ? "MULTI-CITY TRIP" : "CITY ITINERARY"}</span><h1 className="trip-title">{view.title}</h1><div className="trip-meta"><span className="view-only"><Eye size={13} />View only</span><span><MapPin size={13} />{view.cities.length > 1 ? `${view.cities.length} cities` : city.city}</span><span><CalendarDays size={13} />{view.cities.reduce((sum, entry) => sum + entry.days, 0)} city days</span><span>Updated {new Date(view.updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span></div></div>
        <div className="trip-actions"><ExportMenu journey={journey} /></div>
      </section>

      {view.cities.length > 1 && <div className="journey-cities"><div className="city-tabs" aria-label="Trip cities">{view.cities.map((entry) => <button key={entry.id} aria-pressed={entry.id === city.id} onClick={() => { setCityId(entry.id); setDay(0); setSelected(null); }}><MapPin size={15} /><span><strong>{entry.city}</strong><small>{entry.startDate} to {tripDate(entry, entry.days - 1)}</small></span></button>)}</div></div>}

      <div className="workspace-toolbar"><div className="day-tabs" aria-label="Sightseeing day">{Array.from({ length: trip.days }, (_, index) => <button key={index} aria-pressed={day === index} onClick={() => { setDay(index); setSelected(null); }}><span>Day {index + 1}</span><small>{trip.startDate ? new Date(`${tripDate(trip, index)}T12:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" }) : ""}</small></button>)}</div><div className="toolbar-right">{planned && <button className="button secondary small trip-mode-button" onClick={() => setTripMode(true)}><Navigation size={15} />Trip mode</button>}<div className="segmented mobile-tabs"><button aria-pressed={mobileView === "list"} onClick={() => setMobileView("list")}><List size={16} />List</button><button aria-pressed={mobileView === "map"} onClick={() => setMobileView("map")}><Map size={16} />Map</button></div></div></div>

      <div className={`workspace mobile-view-${mobileView}`}>
        <section className="planning-panel" aria-label="Itinerary"><div className="itinerary-content">
          {changed && <p className="notice">The organiser has changed this city since this itinerary was made.</p>}
          {!snapshot ? <div className="empty-stops"><span className="empty-icon"><Route size={25} /></span><h2>Not planned yet</h2>{city.stops.length > 0 && <ol className="saved-order">{city.stops.map((stop) => <li key={stop.id}>{stop.name}</li>)}</ol>}</div>
            : !currentDay ? <div className="empty-stops"><span className="empty-icon"><Route size={25} /></span><h2>Nothing planned on this day</h2></div> : <>
              {day === 0 && trip.arrival && <TransferLine trip={trip} kind="arrival" />}
              <div className="itinerary-start"><span className="hotel-marker small"><Hotel size={15} /></span><div><strong>{trip.hotel}</strong><span>Depart {formatMinute(trip, day, currentDay.visits[0] ? currentDay.visits[0].start - currentDay.visits[0].leg.minutes : dayStart(trip, day))}</span></div></div>
              {currentDay.visits.map((visit, index) => {
                const stop = trip.stops.find((entry) => entry.id === visit.stopId);
                if (!stop) return null;
                const alternatives = stop.alternativeGroup ? currentDay.visits.filter((other) => other.stopId !== stop.id && trip.stops.find((entry) => entry.id === other.stopId)?.alternativeGroup === stop.alternativeGroup).map((other) => trip.stops.find((entry) => entry.id === other.stopId)!.name) : [];
                return <div key={visit.stopId}><LegDetails edge={visit.leg} places={snapshot.places} /><button className={`itinerary-stop ${selected === stop.id ? "selected" : ""}`} aria-expanded={selected === stop.id} onClick={() => setSelected(selected === stop.id ? null : stop.id)}><span className="stop-number">{index + 1}</span><span className="stop-heading"><strong>{stop.name}</strong><span>{formatMinute(trip, day, visit.start)} - {formatMinute(trip, day, visit.end)} · {visit.end - visit.start} min</span>{alternatives.length > 0 && <span className="alternative-note">Alternative to {alternatives.join(", ")}; both fit</span>}</span>{stop.fixedTime && <LockKeyhole size={15} />}</button>
                  {selected === stop.id && (note(stop.id) || stop.source || stop.sourceUrl) && <div className="stop-details">{note(stop.id) && <p className="stop-note">{note(stop.id)}</p>}{stop.source && <blockquote>{stop.source}</blockquote>}{stop.sourceUrl && <a className="source-link" href={stop.sourceUrl} target="_blank" rel="noopener noreferrer"><ArrowUpRight size={14} />Source link</a>}</div>}</div>;
              })}
              {currentDay.returnLeg && <><LegDetails edge={currentDay.returnLeg} places={snapshot.places} endpointToDeparture={toDeparture} /><div className="itinerary-start"><span className="hotel-marker small"><Hotel size={15} /></span><div><strong>{toDeparture ? `At ${trip.departure!.place || "the station"}` : `Back to ${trip.hotel}`}</strong><span>{formatMinute(trip, day, (currentDay.visits.at(-1)?.end ?? dayStart(trip, day)) + currentDay.returnLeg.minutes)}</span></div></div></>}
              {day === trip.days - 1 && trip.departure && <TransferLine trip={trip} kind="departure" />}
              <OmittedPlaces trip={trip} schedule={snapshot.schedule} />
            </>}
        </div></section>
        <section className="map-panel" aria-label="City map"><TripMap trip={trip} places={snapshot?.places ?? {}} schedule={snapshot?.schedule ?? null} day={day} selected={selected} onSelect={setSelected} photoFrames={noPhotos} photoLoading={noPhotos} photoErrors={noPhotos} photoDisabledMessage="Photos aren't shown on shared trips." onPhotoRequest={() => {}} onPhotoRetry={() => {}} /><div className="map-heading"><span className="map-heading-dot" /><span>{city.city}</span><span className="map-heading-divider" />Day {day + 1}</div>{snapshot && <div className="map-legend"><span><i className="walking-line" />Walking</span><span><i className="transit-line" />Public transit</span></div>}</section>
      </div>
    </main>
    {planned && !tripMode && <button className="trip-mode-pill" onClick={() => setTripMode(true)}><Navigation size={17} />Start trip</button>}
    {tripMode && <TripMode title={view.title} cities={view.cities} plans={view.plans} start={{ cityId: city.id, day }} canTrack={false} onClose={() => setTripMode(false)} />}
  </div>;
}
