"use client";

import { useEffect, useState } from "react";
import { APIProvider, AdvancedMarker, InfoWindow, Map as GoogleMap, useMap } from "@vis.gl/react-google-maps";
import { decode } from "@googlemaps/polyline-codec";
import { Hotel, LocateFixed, MapPinned } from "lucide-react";
import type { Place, Schedule, TravelEdge, Trip } from "@/lib/trip";
import type { PlacePhoto } from "@/lib/place-photos";
import { placeMarkerLabel } from "@/lib/map-markers";
import { PlacePhotos } from "./PlacePhotos";

type Props = { trip: Trip; places: Record<string, Place>; schedule: Schedule | null; day: number; selected: string | null; onSelect: (id: string | null) => void; currentLocation?: { lat: number; lng: number }; selectedRoute?: TravelEdge; markerOrder?: string[]; photoTotal?: number; photoFrames: Partial<Record<number, PlacePhoto | null>>; photoLoading: Partial<Record<number, boolean>>; photoErrors: Partial<Record<number, boolean>>; photoDisabledMessage?: string; onPhotoRequest: (placeId: string, index: number) => void; onPhotoRetry: (placeId: string, index: number) => void;
  // Trip mode: room for the floating bar and sheet, a refit on demand, no photo popup, a closer look at the selected stop,
  // a location dot that never moves the camera, progress on markers, and centring on the phone's location.
  padding?: google.maps.Padding; fitToken?: number; popup?: boolean; zoomOnSelect?: boolean; fitCurrentLocation?: boolean;
  markerStatus?: Record<string, "done" | "skipped" | "next">; centerOn?: { lat: number; lng: number; token: number } };

function MapContents({ trip, places, schedule, day, selected, onSelect, currentLocation, selectedRoute, markerOrder, photoTotal, photoFrames, photoLoading, photoErrors, photoDisabledMessage, onPhotoRequest, onPhotoRetry, padding, fitToken, popup = true, zoomOnSelect = false, fitCurrentLocation = true, markerStatus, centerOn }: Props) {
  const map = useMap();
  const visits = schedule?.days.find((entry) => entry.day === day);
  const stopIds = visits ? visits.visits.map((visit) => visit.stopId) : selectedRoute ? [selectedRoute.to].filter((id) => id !== "hotel") : trip.stops.map((stop) => stop.id);
  const visiblePlaces = Object.entries(places).filter(([id]) => id === "hotel" || stopIds.includes(id));
  const selectedPlace = visiblePlaces.find(([id]) => id === selected)?.[1];
  const selectedName = selected === "hotel" ? places.hotel?.name : trip.stops.find((stop) => stop.id === selected)?.name ?? selectedPlace?.name;
  const fitLocation = fitCurrentLocation ? currentLocation : undefined;
  const locationKey = visiblePlaces.map(([id, place]) => `${id}:${place.location.lat},${place.location.lng}`).join("|") + (fitLocation ? `|current:${fitLocation.lat},${fitLocation.lng}` : "");
  const paddingKey = JSON.stringify(padding ?? 70);
  useEffect(() => {
    if (!map || !locationKey) return;
    const bounds = new google.maps.LatLngBounds();
    visiblePlaces.forEach(([, place]) => bounds.extend(place.location));
    if (fitLocation) bounds.extend(fitLocation);
    map.fitBounds(bounds, padding ?? 70);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, locationKey, paddingKey, fitToken]);
  useEffect(() => {
    if (!map || !selected || !places[selected]) return;
    map.panTo(places[selected].location);
    if (zoomOnSelect && (map.getZoom() ?? 0) < 16) map.setZoom(16);
  }, [map, selected, places, zoomOnSelect]);
  useEffect(() => {
    if (!map || !centerOn) return;
    map.panTo(centerOn);
    if ((map.getZoom() ?? 0) < 15) map.setZoom(15);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, centerOn?.token]);
  useEffect(() => {
    if (!map) return;
    const legs = selectedRoute ? [selectedRoute] : visits ? [...visits.visits.map((visit) => visit.leg), ...(visits.returnLeg ? [visits.returnLeg] : [])] : [];
    const lines = legs.filter((leg) => leg.polyline).map((leg) => new google.maps.Polyline({
      map, path: decode(leg.polyline!).map(([lat, lng]) => ({ lat, lng })), strokeColor: leg.mode === "WALK" ? "#137765" : "#426eab", strokeWeight: 4, strokeOpacity: 0.85,
    }));
    return () => lines.forEach((line) => line.setMap(null));
  }, [map, visits, selectedRoute]);
  return <>
    {places.hotel && <AdvancedMarker position={places.hotel.location} title={places.hotel.name || trip.hotel} onClick={() => onSelect("hotel")}><span className="hotel-marker"><Hotel size={19} /></span></AdvancedMarker>}
    {currentLocation && <AdvancedMarker position={currentLocation} title="Current location"><span className="current-marker"><LocateFixed size={21} /></span></AdvancedMarker>}
    {stopIds.map((id, index) => {
      const visitIndex = markerOrder?.indexOf(id) ?? -1;
      return places[id] && <AdvancedMarker key={id} position={places[id].location} title={trip.stops.find((stop) => stop.id === id)?.name ?? places[id].name} onClick={() => onSelect(id)}><span className={`place-marker ${selected === id ? "selected" : ""} ${markerOrder && visitIndex < 0 ? "unscheduled" : ""} ${markerStatus?.[id] ?? ""}`}>{placeMarkerLabel(id, index, markerOrder)}</span></AdvancedMarker>;
    })}
    {popup && selected && selectedPlace && selectedName && <InfoWindow position={selectedPlace.location} onCloseClick={() => onSelect(null)} shouldFocus={false}>
      <div className="map-photo-popup"><h2>{selectedName}</h2><PlacePhotos key={selectedPlace.id} placeName={selectedName} variant="popup" total={photoTotal} frames={photoFrames} loading={photoLoading} errors={photoErrors} disabledMessage={photoDisabledMessage} onRequest={(index) => onPhotoRequest(selectedPlace.id, index)} onRetry={(index) => onPhotoRetry(selectedPlace.id, index)} /></div>
    </InfoWindow>}
  </>;
}

export function TripMap(props: Props) {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const [failed, setFailed] = useState(false);
  if (!key || failed) return <div className="map-unavailable"><div className="map-grid" aria-hidden="true" /><div className="map-unavailable-content"><MapPinned size={38} strokeWidth={1.3} /><h2>{failed ? "Map could not load" : "Map not connected"}</h2><p>{failed ? "Try again or check your connections." : "Map display has not been set up."}</p><span className="status-label">{failed ? "Connection error" : "Not set up"}</span></div></div>;
  return <APIProvider apiKey={key} onError={() => setFailed(true)}><GoogleMap defaultCenter={{ lat: 30, lng: 10 }} defaultZoom={3} mapId={process.env.NEXT_PUBLIC_GOOGLE_MAP_ID || "DEMO_MAP_ID"} disableDefaultUI gestureHandling="greedy" zoomControl mapTypeControl={false} style={{ height: "100%", width: "100%" }}><MapContents {...props} /></GoogleMap></APIProvider>;
}