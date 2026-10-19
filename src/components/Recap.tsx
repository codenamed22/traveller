"use client";

import { useMemo } from "react";
import type { Temporal } from "@js-temporal/polyfill";
import { Heart, Images, Star } from "lucide-react";
import type { JournalAction } from "@/lib/journal";
import type { Journey } from "@/lib/journey";
import { appHandles, postToApp } from "@/lib/native-bridge";
import { tripRecap, type RecapTravel, type RecapVisit } from "@/lib/recap";
import { durationLabel } from "@/lib/trip-mode";
import { Dialog } from "./Dialog";
import { DayNote, FavouriteButton } from "./Journal";

const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

function travelText(travel: RecapTravel) {
  return [travel.walkKm ? `${travel.walkKm} km on foot` : "", travel.transitMinutes ? `${durationLabel(travel.transitMinutes)} by transit` : ""].filter(Boolean).join(" · ");
}

function statusText(visit: RecapVisit) {
  if (visit.status === "done") return visit.actual ? `Done ${visit.actual}` : "Done";
  return visit.status === "skipped" ? "Skipped" : visit.status === "missed" ? "Not visited" : "Later today";
}

// How the trip went: each day's visits, planned against done, with the day's note and favourites to keep or change.
export function RecapDialog({ journey, now, onJournal, onClose }: { journey: Journey; now: Temporal.Instant; onJournal?: (action: JournalAction) => void; onClose: () => void }) {
  const recap = useMemo(() => tripRecap(journey, now), [journey, now]);
  const { totals } = recap;
  const summary = [plural(totals.days, "day"), plural(totals.done, "visit"), totals.skipped ? `${totals.skipped} skipped` : "", totals.missed ? `${totals.missed} not visited` : "", travelText(totals), totals.favourites ? plural(totals.favourites, "favourite") : ""].filter(Boolean).join(" · ");
  return <Dialog title="Recap" className="recap-dialog" onClose={onClose}>
    <p className="recap-summary">{summary}</p>
    {appHandles("travellerMemories") && <button type="button" className="button secondary small recap-photos" onClick={() => postToApp("travellerMemories", { journeyId: journey.id })}><Images size={15} />Photos</button>}
    {recap.days.map((day) => <section key={day.key} className="recap-day" aria-label={`${day.label}, ${day.city}`}>
      <h3>{day.label}<small>{day.city}</small></h3>
      {travelText(day.travel) && <p className="recap-travel">{travelText(day.travel)}</p>}
      <ul className="recap-visits">{day.visits.map((visit) => <li key={visit.stopId} className={`recap-visit ${visit.status}`}>
        {onJournal ? <FavouriteButton className="icon-button" on={visit.favourite} name={visit.name} onChange={(on) => onJournal({ kind: "favourite", cityId: day.cityId, day: day.day, stopId: visit.stopId, on })} />
          : visit.favourite ? <Heart size={15} className="favourite-icon" role="img" aria-label="Favourite" /> : <span className="recap-spacer" />}
        <span><strong>{visit.name}{visit.mustSee && <Star size={12} className="must-see-icon" role="img" aria-label="Must-see" />}</strong>
          <small>{visit.planned ? `Planned ${visit.planned} · ` : ""}<em>{statusText(visit)}</em></small></span>
      </li>)}</ul>
      <DayNote note={day.note} onSave={onJournal ? (text) => onJournal({ kind: "note", cityId: day.cityId, day: day.day, text }) : undefined} />
    </section>)}
  </Dialog>;
}
