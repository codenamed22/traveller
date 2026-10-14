import { ArrowUpRight, ChevronDown, Footprints, TrainFront } from "lucide-react";
import type { Place, TravelEdge } from "@/lib/trip";

// One travel leg with its Google Maps directions link. Without onMode the walk/transit choice is shown but cannot be changed.
export function LegDetails({ edge, places, onMode, endpointToDeparture = false }: { edge: TravelEdge; places: Record<string, Place>; onMode?: (mode: "WALK" | "TRANSIT") => void; endpointToDeparture?: boolean }) {
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
