"use client";

import { useEffect, useState } from "react";
import { APIProvider, AdvancedMarker, Map as GoogleMap, useMap } from "@vis.gl/react-google-maps";
import { decode } from "@googlemaps/polyline-codec";
import { Hotel, LocateFixed, MapPinned } from "lucide-react";
import type { Place, Schedule, TravelEdge, Trip } from "@/lib/trip";

type Props = { trip: Trip; places: Record<string, Place>; schedule: Schedule | null; day: number; selected: string | null; onSelect: (id: string) => void; currentLocation?: { lat: number; lng: number }; selectedRoute?: TravelEdge };

function MapContents({ trip, places, schedule, day, selected, onSelect, currentLocation, selectedRoute }: Props) {
  const map = useMap();
  const visits = schedule?.days.find((entry) => entry.day === day);
  const stopIds = visits ? visits.visits.map((visit) => visit.stopId) : selectedRoute ? [selectedRoute.to].filter((id) => id !== "hotel") : trip.stops.map((stop) => stop.id);
  const visiblePlaces = Object.entries(places).filter(([id]) => id === "hotel" || stopIds.includes(id));
  const locationKey = visiblePlaces.map(([id, place]) => `${id}:${place.location.lat},${place.location.lng}`).join("|") + (currentLocation ? `|current:${currentLocation.lat},${currentLocation.lng}` : "");
  useEffect(() => {
    if (!map || !locationKey) return;
    const bounds = new google.maps.LatLngBounds();
    visiblePlaces.forEach(([, place]) => bounds.extend(place.location));
    if (currentLocation) bounds.extend(currentLocation);
    map.fitBounds(bounds, 70);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, locationKey]);
  useEffect(() => { if (map && selected && places[selected]) map.panTo(places[selected].location); }, [map, selected, places]);
  useEffect(() => {
    if (!map) return;
    const legs = selectedRoute ? [selectedRoute] : visits ? [...visits.visits.map((visit) => visit.leg), ...(visits.returnLeg ? [visits.returnLeg] : [])] : [];
    const lines = legs.filter((leg) => leg.polyline).map((leg) => new google.maps.Polyline({
      map, path: decode(leg.polyline!).map(([lat, lng]) => ({ lat, lng })), strokeColor: leg.mode === "WALK" ? "#137765" : "#426eab", strokeWeight: 4, strokeOpacity: 0.85,
    }));
    return () => lines.forEach((line) => line.setMap(null));
  }, [map, visits, selectedRoute]);
  return <>
    {places.hotel && <AdvancedMarker position={places.hotel.location} title={trip.hotel}><span className="hotel-marker"><Hotel size={19} /></span></AdvancedMarker>}
    {currentLocation && <AdvancedMarker position={currentLocation} title="Current location"><span className="current-marker"><LocateFixed size={21} /></span></AdvancedMarker>}
    {stopIds.map((id, index) => places[id] && <AdvancedMarker key={id} position={places[id].location} title={trip.stops.find((stop) => stop.id === id)?.name} onClick={() => onSelect(id)}><span className={`place-marker ${selected === id ? "selected" : ""}`}>{index + 1}</span></AdvancedMarker>)}
  </>;
}

export function TripMap(props: Props) {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const [failed, setFailed] = useState(false);
  if (!key || failed) return <div className="map-unavailable"><div className="map-grid" aria-hidden="true" /><div className="map-unavailable-content"><MapPinned size={38} strokeWidth={1.3} /><h2>{failed ? "Map could not load" : "Map not connected"}</h2><p>{failed ? "Try again or check your connections." : "Map display has not been set up."}</p><span className="status-label">{failed ? "Connection error" : "Not set up"}</span></div></div>;
  return <APIProvider apiKey={key} onError={() => setFailed(true)}><GoogleMap defaultCenter={{ lat: 30, lng: 10 }} defaultZoom={3} mapId={process.env.NEXT_PUBLIC_GOOGLE_MAP_ID || "DEMO_MAP_ID"} disableDefaultUI gestureHandling="greedy" zoomControl mapTypeControl={false} style={{ height: "100%", width: "100%" }}><MapContents {...props} /></GoogleMap></APIProvider>;
}