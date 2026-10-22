"use client";

import { useState } from "react";
import { Coffee, LoaderCircle, Plus, Utensils } from "lucide-react";
import type { RoutineGap } from "@/lib/gaps";
import type { NearbyPlace } from "@/lib/nearby";

const titles: Record<RoutineGap["meal"], string> = { breakfast: "No breakfast planned", lunch: "No lunch planned", dinner: "No dinner planned" };

// A meal the day's plan leaves out, in the itinerary at about when it would be, with three places open nearby then
// to add for it. `start` and `end` are the meal's time on the city's clock.
export function MealGap({ gap, start, end, onAdd }: { gap: RoutineGap; start: string; end: string; onAdd: (place: NearbyPlace) => void }) {
  const [places, setPlaces] = useState<NearbyPlace[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function suggest() {
    if (!gap.location) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/places/nearby", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ meal: gap.meal, location: gap.location, date: gap.date, start, end }) });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error ?? "Suggestions are unavailable.");
      setPlaces(data.places);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Suggestions are unavailable.");
    } finally { setBusy(false); }
  }
  return <section className="meal-gap" aria-label={titles[gap.meal]}>
    <div className="meal-gap-head">
      {gap.meal === "breakfast" ? <Coffee size={15} /> : <Utensils size={15} />}
      <span><strong>{titles[gap.meal]}</strong><small>Near {gap.nearName}</small></span>
      {gap.location && !places && <button type="button" className="button secondary small" disabled={busy} onClick={() => void suggest()}>{busy && <LoaderCircle size={14} className="spin" />}Suggest</button>}
    </div>
    {error && <p className="notice error" role="alert">{error}</p>}
    {places && (places.length ? <>
      <ul className="meal-suggestions">{places.map((place) => <li key={place.id}>
        <span><strong>{place.name}</strong><small>{place.rating.toFixed(1)} ★ ({place.reviews.toLocaleString("en")}) · {place.walkMinutes} min walk{place.price ? ` · ${place.price}` : ""}</small></span>
        <button type="button" className="button secondary small" aria-label={`Add ${place.name}`} onClick={() => onAdd(place)}><Plus size={14} />Add</button>
      </li>)}</ul>
      <p className="provider-attribution">Google Maps</p>
    </> : <p className="quiet">Nothing open nearby.</p>)}
  </section>;
}
