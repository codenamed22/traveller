"use client";

import { useState } from "react";
import { Heart } from "lucide-react";

// The day's note: saved when the field loses focus; read-only without `onSave`.
export function DayNote({ note = "", onSave }: { note?: string; onSave?: (text: string) => void }) {
  // What's being typed; while not editing the field shows the saved note, so a note saved elsewhere shows too.
  const [draft, setDraft] = useState<string | null>(null);
  if (!onSave) return note ? <p className="day-note-text">{note}</p> : null;
  return <label className="field day-note">Day note<textarea rows={2} maxLength={2000} value={draft ?? note} placeholder="How was the day?"
    onFocus={() => setDraft(note)} onChange={(event) => setDraft(event.target.value)}
    onBlur={() => { if (draft !== null && draft !== note) onSave(draft); setDraft(null); }} /></label>;
}

export function FavouriteButton({ on, name, onChange, className = "button secondary small" }: { on: boolean; name: string; onChange: (on: boolean) => void; className?: string }) {
  return <button type="button" className={`${className} favourite`} aria-pressed={on} aria-label={`Favourite ${name}`} title="Favourite" onClick={() => onChange(!on)}>
    <Heart size={15} fill={on ? "currentColor" : "none"} />
  </button>;
}
