import { squeezeInNote, type Schedule, type Trip } from "@/lib/trip";

// Places left out of a plan, each with the gap where it could still be squeezed in, if one fits, and the places kept for
// spare time, which trip mode offers when there's time.
export function OmittedPlaces({ trip, schedule }: { trip: Trip; schedule: Schedule }) {
  const spare = trip.stops.filter((stop) => stop.spare);
  return <>
    {schedule.omitted.length > 0 && <div className="notice warning omitted-places"><strong>Optional places not scheduled</strong><ul>{schedule.omitted.map((id) => {
      const fit = schedule.squeezeIns?.find((squeeze) => squeeze.stopId === id);
      return <li key={id}>{trip.stops.find((stop) => stop.id === id)?.name}{fit && <span> · could fit {squeezeInNote(trip, fit)}</span>}</li>;
    })}</ul>{schedule.squeezeIns?.length ? <p>Times are estimates if you want to add a place on the day; the plan does not include them.</p> : null}</div>}
    {spare.length > 0 && <div className="notice omitted-places"><strong>Spare time</strong><ul>{spare.map((stop) => <li key={stop.id}>{stop.name}{stop.day !== null ? <span> · Day {stop.day + 1}</span> : null}</li>)}</ul></div>}
  </>;
}
