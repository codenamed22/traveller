"use client";

import { useEffect, useState } from "react";
import { APIProvider, AdvancedMarker, Map as GoogleMap, useMap } from "@vis.gl/react-google-maps";
import { decode } from "@googlemaps/polyline-codec";
import { Hotel, MapPinned } from "lucide-react";
import type { Place, Schedule, Trip } from "@/lib/trip";

type Props = { trip: Trip; places: Record<string, Place>; schedule: Schedule | null; day: number; selected: string | null; onSelect: (id: string) => void };

function MapContents({ trip, places, schedule, day, selected, onSelect }: Props) {
  const map = useMap();
  const visits = schedule?.days.find((entry) => entry.day === day);
  const stopIds = visits ? visits.visits.map((visit) => visit.stopId) : trip.stops.map((stop) => stop.id);
  useEffect(() => {
    if (!map || !Object.keys(places).length) return;
    const bounds = new google.maps.LatLngBounds();
    Object.values(places).forEach((place) => bounds.extend(place.location));
    map.fitBounds(bounds, 70);
  }, [map, places]);
  useEffect(() => { if (map && selected && places[selected]) map.panTo(places[selected].location); }, [map, selected, places]);
  useEffect(() => {
    if (!map || !visits) return;
    const legs = [...visits.visits.map((visit) => visit.leg), ...(visits.returnLeg ? [visits.returnLeg] : [])];
    const lines = legs.filter((leg) => leg.polyline).map((leg) => new google.maps.Polyline({
      map, path: decode(leg.polyline!).map(([lat, lng]) => ({ lat, lng })), strokeColor: leg.mode === "WALK" ? "#137765" : "#426eab", strokeWeight: 4, strokeOpacity: 0.85,
    }));
    return () => lines.forEach((line) => line.setMap(null));
  }, [map, visits]);
  return <>
    {places.hotel && <AdvancedMarker position={places.hotel.location} title={trip.hotel}><span className="hotel-marker"><Hotel size={19} /></span></AdvancedMarker>}
    {stopIds.map((id, index) => places[id] && <AdvancedMarker key={id} position={places[id].location} title={trip.stops.find((stop) => stop.id === id)?.name} onClick={() => onSelect(id)}><span className={`place-marker ${selected === id ? "selected" : ""}`}>{index + 1}</span></AdvancedMarker>)}
  </>;
}

export function TripMap(props: Props) {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const [failed, setFailed] = useState(false);
  if (!key || failed) return <div className="map-unavailable"><div className="map-grid" aria-hidden="true" /><div className="map-unavailable-content"><MapPinned size={38} strokeWidth={1.3} /><h2>{failed ? "Map could not load" : "Map not connected"}</h2><p>{failed ? "Check the Maps API key and browser restrictions." : "Google Maps requires a browser API key."}</p><span className="status-label">{failed ? "Connection error" : "Awaiting configuration"}</span></div></div>;
  return <APIProvider apiKey={key} onError={() => setFailed(true)}><GoogleMap defaultCenter={{ lat: 30, lng: 10 }} defaultZoom={3} mapId={process.env.NEXT_PUBLIC_GOOGLE_MAP_ID || "DEMO_MAP_ID"} disableDefaultUI gestureHandling="greedy" zoomControl mapTypeControl={false} style={{ height: "100%", width: "100%" }}><MapContents {...props} /></GoogleMap></APIProvider>;
}