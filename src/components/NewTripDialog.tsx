"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, CalendarDays, Plus, RotateCcw, Trash2 } from "lucide-react";
import { ZodError } from "zod";
import { Dialog } from "./Dialog";
import { cityPreset, createJourney, popularCities, stayDates, type CityStay, type Journey } from "@/lib/journey";

export function NewTripDialog({ startDate: initialDate, available = 10, adding = false, onCreate, onClose }: { startDate: string; available?: number; adding?: boolean; onCreate: (journey: Journey) => void; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [startDate, setStartDate] = useState(initialDate);
  const [stays, setStays] = useState<(CityStay & { key: string })[]>([]);
  const [error, setError] = useState("");
  let dates: ReturnType<typeof stayDates> = [];
  try { dates = stayDates(startDate, stays); } catch { dates = []; }

  function addCity(name = "") {
    if (stays.length >= available) return;
    const preset = cityPreset(name);
    setStays((current) => [...current, { key: crypto.randomUUID(), city: preset ? `${preset.name}, ${preset.country}` : name, days: preset?.days ?? 3, timeZone: preset?.timeZone ?? "UTC", startDate: null }]);
  }

  function update(index: number, patch: Partial<CityStay>) {
    setError("");
    setStays((current) => current.map((stay, stayIndex) => stayIndex === index ? { ...stay, ...patch } : stay));
  }

  return <Dialog title={adding ? "Add cities" : "New trip"} onClose={onClose}>
    <form onSubmit={(event) => {
      event.preventDefault(); setError("");
      try { onCreate(createJourney(title, startDate, stays.map(({ city, days, startDate, timeZone }) => ({ city, days, startDate, timeZone })))); }
      catch (cause) { setError(cause instanceof ZodError ? cause.issues[0].message : cause instanceof Error ? cause.message : "Check the city dates."); }
    }}>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="form-grid journey-basics">
        {!adding && <label className="field">Trip title<input value={title} maxLength={150} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Autumn in Europe" /></label>}
        <label className="field">Departure date<input type="date" required value={startDate} onChange={(event) => { if (event.target.value) setStartDate(event.target.value); }} /></label>
      </div>
      <div className="popular-cities" aria-label="Quick add cities">{popularCities.slice(0, 3).map((city) => <button type="button" className="button secondary small" key={city.name} disabled={stays.length >= available} onClick={() => addCity(city.name)}><Plus size={14} />{city.name}</button>)}</div>
      <datalist id="setup-city-presets">{popularCities.map((city) => <option key={city.name} value={`${city.name}, ${city.country}`} />)}</datalist>
      <div className="city-stays">{stays.map((stay, index) => <section className="city-stay" key={stay.key} aria-label={`City visit ${index + 1}`}>
        <div className="city-stay-heading"><strong>City {index + 1}</strong><span>{dates[index] ? `${dates[index].startDate} to ${dates[index].endDate}` : "Dates incomplete"}</span><div className="row">{[-1, 1].map((direction) => <button type="button" className="icon-button" key={direction} disabled={index + direction < 0 || index + direction >= stays.length} title={direction < 0 ? "Move city earlier" : "Move city later"} aria-label={`${direction < 0 ? "Move earlier" : "Move later"}: city ${index + 1}`} onClick={() => setStays((current) => {
          const next = [...current]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; return next;
        })}>{direction < 0 ? <ArrowUp size={14} /> : <ArrowDown size={14} />}</button>)}<button type="button" className="icon-button danger" title="Remove city" aria-label={`Remove city ${index + 1}`} onClick={() => setStays((current) => current.filter((_, stayIndex) => stayIndex !== index))}><Trash2 size={15} /></button></div></div>
        <label className="field">City<input aria-label={`City ${index + 1}`} list="setup-city-presets" required maxLength={150} value={stay.city} placeholder="City and country" onChange={(event) => {
          const preset = cityPreset(event.target.value);
          update(index, { city: event.target.value, ...(preset ? { timeZone: preset.timeZone } : {}) });
        }} /></label>
        <div className="form-grid"><label className="field">Days<input aria-label={`Days in city ${index + 1}`} type="number" min={1} max={7} required value={stay.days} onChange={(event) => update(index, { days: Number(event.target.value) })} /></label><label className="field">Arrival date<div className="date-with-reset"><input aria-label={`Arrival in city ${index + 1}`} type="date" required value={stay.startDate ?? dates[index]?.startDate ?? ""} onChange={(event) => update(index, { startDate: event.target.value || null })} /><button type="button" className="icon-button" disabled={!stay.startDate} title="Use consecutive dates" aria-label={`Reset arrival for city ${index + 1}`} onClick={() => update(index, { startDate: null })}><RotateCcw size={14} /></button></div></label></div>
        <label className="field">Timezone<input aria-label={`Timezone for city ${index + 1}`} required maxLength={100} value={stay.timeZone} onChange={(event) => update(index, { timeZone: event.target.value })} /></label>
      </section>)}</div>
      <button className="text-button" type="button" disabled={stays.length >= available} onClick={() => addCity()}><Plus size={16} />Add another city</button>
      <div className="dialog-actions"><span className="quiet">{stays.length} / {available} cities</span><button className="button primary" type="submit" disabled={!stays.length}><CalendarDays size={16} />{adding ? "Add cities" : "Create trip"}</button></div>
    </form>
  </Dialog>;
}