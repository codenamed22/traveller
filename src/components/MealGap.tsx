"use client";

import { useState, type ReactNode } from "react";
import { Coffee, LoaderCircle, Utensils } from "lucide-react";
import { mealTitles, type RoutineGap } from "@/lib/gaps";
import type { NearbyPlace } from "@/lib/nearby";

// A meal the day's plan leaves out, with three places open nearby then: in the itinerary at about when it would be, to add
// one, and in trip mode as it comes up, for directions to one. `start` and `end` are when to eat on the city's clock, and
// `location` where to look, the plan's spot unless trip mode knows where you are (`here`).
export function MealGap({ gap, start, end, location = gap.location, here = false, action }: { gap: RoutineGap; start: string; end: string; location?: { lat: number; lng: number }; here?: boolean; action: (place: NearbyPlace) => ReactNode }) {
  const [places, setPlaces] = useState<NearbyPlace[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function suggest() {
    if (!location) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/places/nearby", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ meal: gap.meal, location, date: gap.date, start, end }) });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error ?? "Suggestions are unavailable.");
      setPlaces(data.places);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Suggestions are unavailable.");
    } finally { setBusy(false); }
  }
  return <section className="meal-gap" aria-label={mealTitles[gap.meal]}>
    <div className="meal-gap-head">
      {gap.meal === "breakfast" ? <Coffee size={15} /> : <Utensils size={15} />}
      <span><strong>{mealTitles[gap.meal]}</strong><small>Near {here ? "you" : gap.nearName}</small></span>
      {location && !places && <button type="button" className="button secondary small" disabled={busy} onClick={() => void suggest()}>{busy && <LoaderCircle size={14} className="spin" />}Suggest</button>}
    </div>
    {error && <p className="notice error" role="alert">{error}</p>}
    {places && (places.length ? <>
      <ul className="meal-suggestions">{places.map((place) => <li key={place.id}>
        <span><strong>{place.name}</strong><small>{place.rating.toFixed(1)} ★ ({place.reviews.toLocaleString("en")}) · {place.walkMinutes} min walk{place.price ? ` · ${place.price}` : ""}</small></span>
        {action(place)}
      </li>)}</ul>
      <p className="provider-attribution">Google Maps</p>
    </> : <p className="quiet">Nothing open nearby.</p>)}
  </section>;
}
