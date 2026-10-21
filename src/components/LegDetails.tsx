import { ArrowUpRight, CarTaxiFront, ChevronDown, Footprints, TrainFront } from "lucide-react";
import type { Place, RouteLeg } from "@/lib/trip";
import { directionsUrl } from "@/lib/trip-mode";

// One travel leg with its Google Maps directions link. Without onMode the walk/transit choice is shown but cannot be changed.
const modeName = { WALK: "Walk", TRANSIT: "Public transit", DRIVE: "Car or taxi" };

export function LegDetails({ edge, places, onMode, endpointToDeparture = false }: { edge: RouteLeg; places: Record<string, Place>; onMode?: (mode: "WALK" | "TRANSIT") => void; endpointToDeparture?: boolean }) {
  const url = directionsUrl(edge, places, { toDeparture: endpointToDeparture });
  // A car or taxi has no walk or transit choice to switch to.
  const options = edge.mode === "DRIVE" ? [] : [{ ...edge, mode: edge.mode }, ...(edge.alternatives ?? [])];
  return <details className="travel-leg"><summary>{edge.mode === "WALK" ? <Footprints size={15} /> : edge.mode === "DRIVE" ? <CarTaxiFront size={15} /> : <TrainFront size={15} />}<span>{modeName[edge.mode]} · {edge.minutes} min{edge.assumed ? " (assumed, not checked with Google)" : ""}{edge.timetableDate ? ` (timetable of ${edge.timetableDate})` : ""} {edge.mode !== "TRANSIT" && `· ${(edge.meters / 1000).toFixed(1)} km`}</span><ChevronDown size={13} /></summary><div className="leg-details">{options.length > 0 && <div className="transport-options">{options.map((option) => <button key={option.mode} disabled={!onMode || option.mode === edge.mode} aria-pressed={option.mode === edge.mode} title={`Prefer ${option.mode === "WALK" ? "walking" : "public transit"} and replan`} onClick={() => onMode?.(option.mode)}>{option.mode === "WALK" ? <Footprints size={14} /> : <TrainFront size={14} />}<span>{option.mode === "WALK" ? "Walk" : "Transit"}<strong>{option.minutes} min</strong></span></button>)}</div>}{edge.steps?.map((step, index) => <p key={index}>{step.line && <strong>{step.line} </strong>}{step.from && step.to ? `${step.from} to ${step.to}` : step.instruction}</p>)}{edge.fare && <p>Estimated fare: {edge.fare}</p>}<a href={url} target="_blank" rel="noreferrer">Open in Google Maps <ArrowUpRight size={13} /></a></div></details>;
}
