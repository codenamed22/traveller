"use client";

import { useEffect, useRef, useState } from "react";
import { APIProvider, AdvancedMarker, InfoWindow, Map as GoogleMap, useMap } from "@vis.gl/react-google-maps";
import { decode } from "@googlemaps/polyline-codec";
import { Hotel, LocateFixed, MapPinned, Plus } from "lucide-react";
import type { Place, Schedule, StopAbout, TravelEdge, Trip } from "@/lib/trip";
import type { PlacePhoto } from "@/lib/place-photos";
import { placeMarkerLabel } from "@/lib/map-markers";
import { PlaceAbout } from "./PlaceAbout";
import { PlacePhotos } from "./PlacePhotos";
import { transferIcons } from "./TransferFields";

type Props = { trip: Trip; places: Record<string, Place>; schedule: Schedule | null; day: number; selected: string | null; onSelect: (id: string | null) => void; currentLocation?: { lat: number; lng: number }; selectedRoute?: TravelEdge; markerOrder?: string[]; photoTotal?: number; photoFrames: Partial<Record<number, PlacePhoto | null>>; photoLoading: Partial<Record<number, boolean>>; photoErrors: Partial<Record<number, boolean>>; photoDisabledMessage?: string; onPhotoRequest: (placeId: string, index: number) => void; onPhotoRetry: (placeId: string, index: number) => void;
  // Trip mode: room for the floating bar and sheet, a refit on demand, no photo popup, a closer look at the selected stop,
  // a location dot that never moves the camera, progress on markers, and centring on the phone's location.
  padding?: google.maps.Padding; fitToken?: number; popup?: boolean; zoomOnSelect?: boolean; fitCurrentLocation?: boolean;
  markerStatus?: Record<string, "done" | "skipped" | "next">; centerOn?: { lat: number; lng: number; token: number };
  // A click on the map itself, not on a marker.
  onMapClick?: () => void;
  // What a guide says about the selected place, shown in its popup.
  about?: StopAbout;
  // Trip mode: places for spare time, as grey squares left out of the fit.
  extras?: { id: string; name: string; location: { lat: number; lng: number } }[] };

// Room for the city and day chip and the route legend along the top (stacked on narrow screens) and the assistant tab on
// the right, so no marker is fitted underneath them.
const overlayPadding: google.maps.Padding = { top: 130, right: 70, bottom: 60, left: 60 };

function MapContents({ trip, places, schedule, day, selected, onSelect, currentLocation, selectedRoute, markerOrder, photoTotal, photoFrames, photoLoading, photoErrors, photoDisabledMessage, onPhotoRequest, onPhotoRetry, padding, fitToken, popup = true, zoomOnSelect = false, fitCurrentLocation = true, markerStatus, centerOn, about, extras }: Props) {
  const map = useMap();
  const visits = schedule?.days.find((entry) => entry.day === day);
  const stopIds = visits ? visits.visits.map((visit) => visit.stopId) : selectedRoute ? [selectedRoute.to].filter((id) => id !== "hotel") : trip.stops.map((stop) => stop.id);
  // The airport or station you arrive at or leave from, on the day its route to or from the hotel is planned.
  const hubs = selectedRoute ? [] : (["arrival", "departure"] as const).filter((kind) => places[kind] && trip[kind] && visits?.[kind === "arrival" ? "arrivalLeg" : "departureLeg"]);
  const visiblePlaces = Object.entries(places).filter(([id]) => id === "hotel" || stopIds.includes(id) || hubs.some((kind) => kind === id));
  const selectedPlace = visiblePlaces.find(([id]) => id === selected)?.[1];
  const selectedName = selected === "hotel" ? places.hotel?.name : trip.stops.find((stop) => stop.id === selected)?.name ?? selectedPlace?.name;
  const fitLocation = fitCurrentLocation ? currentLocation : undefined;
  const locationKey = visiblePlaces.map(([id, place]) => `${id}:${place.location.lat},${place.location.lng}`).join("|") + (fitLocation ? `|current:${fitLocation.lat},${fitLocation.lng}` : "");
  const paddingKey = JSON.stringify(padding ?? overlayPadding);
  // The place last brought into view (a selected stop, or a point to centre on such as the phone's location). While there
  // is one, a change of room around the map (trip mode's sheet growing for photos, or shrinking) keeps it centred rather
  // than zooming out to the whole day; a new day or a fit request clears it.
  const focus = useRef<{ lat: number; lng: number } | null>(null);
  const fitted = useRef<{ locationKey: string; fitToken?: number } | null>(null);
  // Centres a point in the part of the map the padding leaves visible.
  function centre(location: { lat: number; lng: number }) {
    if (!map) return;
    const room = padding ?? overlayPadding;
    map.panTo(location);
    map.panBy(((room.right ?? 0) - (room.left ?? 0)) / 2, ((room.bottom ?? 0) - (room.top ?? 0)) / 2);
  }
  useEffect(() => {
    if (!map || !locationKey) return;
    if (fitted.current?.locationKey !== locationKey || fitted.current.fitToken !== fitToken) focus.current = null;
    fitted.current = { locationKey, fitToken };
    if (focus.current) { centre(focus.current); return; }
    const bounds = new google.maps.LatLngBounds();
    visiblePlaces.forEach(([, place]) => bounds.extend(place.location));
    if (fitLocation) bounds.extend(fitLocation);
    map.fitBounds(bounds, padding ?? overlayPadding);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, locationKey, paddingKey, fitToken]);
  const selectedExtra = extras?.find((extra) => extra.id === selected)?.location;
  useEffect(() => {
    const location = selected ? places[selected]?.location ?? selectedExtra : undefined;
    if (!map || !location) return;
    focus.current = location;
    if (zoomOnSelect && (map.getZoom() ?? 0) < 16) map.setZoom(16);
    centre(focus.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, selected, places, zoomOnSelect, selectedExtra?.lat, selectedExtra?.lng]);
  useEffect(() => {
    if (!map || !centerOn) return;
    focus.current = { lat: centerOn.lat, lng: centerOn.lng };
    if ((map.getZoom() ?? 0) < 15) map.setZoom(15);
    centre(focus.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, centerOn?.token]);
  useEffect(() => {
    if (!map) return;
    const legs = selectedRoute ? [selectedRoute] : visits ? [...(visits.arrivalLeg ? [visits.arrivalLeg] : []), ...visits.visits.map((visit) => visit.leg), ...(visits.returnLeg ? [visits.returnLeg] : []), ...(visits.departureLeg ? [visits.departureLeg] : [])] : [];
    const lines = legs.filter((leg) => leg.polyline).map((leg) => new google.maps.Polyline({
      map, path: decode(leg.polyline!).map(([lat, lng]) => ({ lat, lng })), strokeColor: leg.mode === "WALK" ? "#137765" : leg.mode === "DRIVE" ? "#6b5b8e" : "#426eab", strokeWeight: 4, strokeOpacity: 0.85,
    }));
    return () => lines.forEach((line) => line.setMap(null));
  }, [map, visits, selectedRoute]);
  return <>
    {places.hotel && <AdvancedMarker position={places.hotel.location} title={places.hotel.name || trip.hotel} onClick={() => onSelect("hotel")}><span className="hotel-marker"><Hotel size={19} /></span></AdvancedMarker>}
    {hubs.map((kind) => { const Icon = transferIcons[trip[kind]!.mode]; return <AdvancedMarker key={kind} position={places[kind].location} title={trip[kind]!.place || places[kind].name}><span className="hotel-marker"><Icon size={19} /></span></AdvancedMarker>; })}
    {currentLocation && <AdvancedMarker position={currentLocation} title="Current location"><span className="current-marker"><LocateFixed size={21} /></span></AdvancedMarker>}
    {stopIds.map((id, index) => {
      const visitIndex = markerOrder?.indexOf(id) ?? -1;
      return places[id] && <AdvancedMarker key={id} position={places[id].location} title={trip.stops.find((stop) => stop.id === id)?.name ?? places[id].name} onClick={() => onSelect(id)}><span className={`place-marker ${selected === id ? "selected" : ""} ${markerOrder && visitIndex < 0 ? "unscheduled" : ""} ${markerStatus?.[id] ?? ""}`}>{placeMarkerLabel(id, index, markerOrder)}</span></AdvancedMarker>;
    })}
    {extras?.map((extra) => <AdvancedMarker key={extra.id} position={extra.location} title={extra.name} onClick={() => onSelect(extra.id)}><span className={`extra-marker ${selected === extra.id ? "selected" : ""}`}><Plus size={15} strokeWidth={2.6} /></span></AdvancedMarker>)}
    {popup && selected && selectedPlace && selectedName && <InfoWindow position={selectedPlace.location} onCloseClick={() => onSelect(null)} shouldFocus={false}>
      <div className="map-photo-popup"><h2>{selectedName}</h2><PlacePhotos key={selectedPlace.id} placeName={selectedName} variant="popup" total={photoTotal} frames={photoFrames} loading={photoLoading} errors={photoErrors} disabledMessage={photoDisabledMessage} onRequest={(index) => onPhotoRequest(selectedPlace.id, index)} onRetry={(index) => onPhotoRetry(selectedPlace.id, index)} />{selected !== "hotel" && <PlaceAbout about={about} />}</div>
    </InfoWindow>}
  </>;
}

export function TripMap(props: Props) {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const [failed, setFailed] = useState(false);
  if (!key || failed) return <div className="map-unavailable"><div className="map-grid" aria-hidden="true" /><div className="map-unavailable-content"><MapPinned size={38} strokeWidth={1.3} /><h2>{failed ? "Map could not load" : "Map not connected"}</h2><p>{failed ? "Try again or check your connections." : "Map display has not been set up."}</p><span className="status-label">{failed ? "Connection error" : "Not set up"}</span></div></div>;
  return <APIProvider apiKey={key} onError={() => setFailed(true)}><GoogleMap defaultCenter={{ lat: 30, lng: 10 }} defaultZoom={3} mapId={process.env.NEXT_PUBLIC_GOOGLE_MAP_ID || "DEMO_MAP_ID"} disableDefaultUI gestureHandling="greedy" zoomControl mapTypeControl={false} style={{ height: "100%", width: "100%" }} onClick={props.onMapClick && (() => props.onMapClick!())}><MapContents {...props} /></GoogleMap></APIProvider>;
}