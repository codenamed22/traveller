import { squeezeInNote, type Schedule, type Trip } from "@/lib/trip";

// Places left out of a plan, each with the gap where it could still be squeezed in, if one fits.
export function OmittedPlaces({ trip, schedule }: { trip: Trip; schedule: Schedule }) {
  if (!schedule.omitted.length) return null;
  return <div className="notice warning omitted-places"><strong>Optional places not scheduled</strong><ul>{schedule.omitted.map((id) => {
    const fit = schedule.squeezeIns?.find((squeeze) => squeeze.stopId === id);
    return <li key={id}>{trip.stops.find((stop) => stop.id === id)?.name}{fit && <span> · could fit {squeezeInNote(trip, fit)}</span>}</li>;
  })}</ul>{schedule.squeezeIns?.length ? <p>Times are estimates if you want to add a place on the day; the plan does not include them.</p> : null}</div>;
}
