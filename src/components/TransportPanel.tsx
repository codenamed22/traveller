"use client";

import { useRef, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import { ArrowUpRight, Check, Circle, CreditCard, Minus, Pencil, Plane, Plus, Ticket, Trash2, X } from "lucide-react";
import { dayPassUntil, formatAmount, topUpPrice, type PricedRide, type TransportStatus } from "@/lib/transport-status";
import { entryLabel, suggestedCard, type TransitApp, type TransportAction, type TransportCard, type TransportEntry } from "@/lib/transport";

const kinds: { value: TransportCard["kind"]; label: string }[] = [
  { value: "tickets", label: "Tickets on a card" },
  { value: "balance", label: "Money on a card" },
  { value: "tap", label: "Tap a bank card" },
];

function Amount({ label, value, onChange, step = 0.01, min = 0, max = 10_000 }: { label: string; value: number | undefined; onChange: (value: number | undefined) => void; step?: number; min?: number; max?: number }) {
  return <label className="field">{label}<input type="number" inputMode="decimal" min={min} max={max} step={step} value={value ?? ""} onChange={(event) => {
    const number = event.target.value === "" ? undefined : Number(event.target.value);
    onChange(number !== undefined && Number.isFinite(number) ? number : undefined);
  }} /></label>;
}

// The city's card in the planner: started from how the city charges, then any of it changed.
export function TransportCardFields({ city, card, entries, onChange }: { city: string; card?: TransportCard; entries: number; onChange: (card: TransportCard | undefined) => void }) {
  if (!card) return <div><button type="button" className="button secondary small" onClick={() => onChange(suggestedCard(city))}><CreditCard size={15} />Add a transport card</button></div>;
  const change = (patch: Partial<TransportCard>) => {
    const next: TransportCard = { ...card, ...patch };
    for (const key of Object.keys(patch) as (keyof TransportCard)[]) if (next[key] === undefined) delete next[key];
    onChange(next);
  };
  return <div className="transport-card-fields">
    <div className="form-grid"><label className="field">Pay with<select value={card.kind} onChange={(event) => change({ kind: event.target.value as TransportCard["kind"] })}>{kinds.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}</select></label><label className="field">Card name<input value={card.name} maxLength={60} placeholder="Navigo Easy" onChange={(event) => change({ name: event.target.value })} /></label></div>
    <div className="form-grid three">
      <Amount label="Travellers" step={1} min={1} max={9} value={card.travellers} onChange={(value) => change({ travellers: Math.min(9, Math.max(1, Math.round(value ?? 1))) })} />
      <label className="field">Currency<input value={card.currency} maxLength={3} onChange={(event) => change({ currency: event.target.value.toUpperCase() })} /></label>
      <Amount label={card.kind === "tickets" ? "Ticket price" : "Fare per ride"} value={card.ridePrice} onChange={(value) => change({ ridePrice: value ?? 0 })} />
    </div>
    <div className="form-grid three">
      {card.kind !== "tickets" && <Amount label="Per km" step={0.001} value={card.perKm} onChange={(value) => change({ perKm: value })} />}
      {card.kind === "tap" ? <Amount label="Daily cap" value={card.dailyCap} onChange={(value) => change({ dailyCap: value })} /> : <Amount label="Day pass" value={card.dayPass} onChange={(value) => change({ dayPass: value })} />}
      <Amount label="Airport ride" value={card.airportPrice} onChange={(value) => change({ airportPrice: value })} />
    </div>
    <div><button type="button" className="text-button danger" onClick={() => { if (!entries || window.confirm("Remove the card and what was recorded on it?")) onChange(undefined); }}><Trash2 size={14} />Remove card</button></div>
  </div>;
}

export type Corner = "top-left" | "top-right" | "bottom-left";
const cornerKey = "traveller.transportCorner";
function savedCorner(): Corner {
  if (typeof window === "undefined") return "top-left";
  try { const value = window.localStorage.getItem(cornerKey); return value === "top-right" || value === "bottom-left" ? value : "top-left"; } catch { return "top-left"; }
}

const time = (at: number, timeZone: string) => {
  try { return Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(timeZone).toPlainTime().toString({ smallestUnit: "minute" }); } catch { return ""; }
};
const localDay = (at: number, timeZone: string) => {
  try { return Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(timeZone).toPlainDate().toString(); } catch { return ""; }
};

// The card's chip in trip mode, kept in a corner and dragged to another, and what it opens: the balance, today's rides
// and what to add, with buttons to record what the plan can't know, and each of today's rides with its fare to correct.
export function TransportChip({ cityId, timeZone, status, app, bottom, hidden, onAction }: {
  cityId: string; timeZone: string; status: TransportStatus; app: TransitApp | null; bottom: number; hidden: boolean; onAction: (action: TransportAction) => void;
}) {
  // Trip mode only opens in the browser, so local storage is there to read.
  const [corner, setCorner] = useState<Corner>(savedCorner);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<"topup" | "set" | "fare" | null>(null);
  const [fareFor, setFareFor] = useState<PricedRide | null>(null);
  const [amount, setAmount] = useState<number | undefined>();
  const [paid, setPaid] = useState<number | undefined>();
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  // A drag ends with a click on the chip, which mustn't open it.
  const dragged = useRef(false);
  const { card } = status;
  const money = (value: number) => formatAmount(card, value, "money");
  const tap = card.kind === "tap";
  const today = status.today;
  const label = tap ? `${money(today?.spent ?? 0)} today` : formatAmount(card, status.balance ?? 0);
  const entries = status.entries.filter(({ entry }) => !entry.voided).sort((left, right) => right.entry.at - left.entry.at);
  const add = (entry: Omit<TransportEntry, "id" | "at">) => onAction({ kind: "transport-entry", cityId, entry: { id: crypto.randomUUID(), at: Date.now(), ...entry } });
  const remove = (entry: TransportEntry) => onAction({ kind: "transport-void", cityId, entryId: entry.id });
  // Fewer rides: the last one added by hand today goes, or else one the plan counted wasn't taken.
  const lastRide = today ? entries.find(({ entry }) => entry.kind === "ride" && entry.paid === undefined && (entry.amount ?? 1) > 0 && localDay(entry.at, timeZone) === today.date) : undefined;
  function openForm(kind: "topup" | "set") {
    setForm(kind);
    const start = kind === "set" ? status.balance ?? 0 : card.kind === "tickets" ? 10 : 20;
    setAmount(start); setPaid(kind === "topup" ? topUpPrice(card, start) : undefined);
  }
  function openFare(ride: PricedRide) {
    setForm("fare"); setFareFor(ride);
    setAmount(Math.round(ride.price / card.travellers * 100) / 100); setPaid(undefined);
  }
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (amount === undefined) return;
    if (form === "set") add({ kind: "set", amount });
    else if (form === "fare" && fareFor) add({ kind: "fare", ride: fareFor.key, amount });
    else add({ kind: "topup", amount, paid: paid ?? topUpPrice(card, amount) });
    setForm(null);
  }
  const each = card.travellers > 1 ? " each" : "";
  const formLabel = form === "set" ? "The card shows" : form === "fare" ? `${card.kind === "tickets" ? "Tickets" : "Fare"}${each}` : card.kind === "tickets" ? "Tickets" : "Amount";
  const rides = [...today?.rides ?? []].sort((left, right) => left.at - right.at);
  const rideNames = new globalThis.Map(status.days.flatMap((day) => day.rides).map((ride) => [ride.key, ride.name]));
  const describe = (entry: TransportEntry) => {
    if (entry.kind === "fare") return `${entryLabel(entry)}${rideNames.has(entry.ride ?? "") ? ` for ${rideNames.get(entry.ride!)}` : ""} · ${formatAmount(card, entry.amount ?? 0)}`;
    return `${entryLabel(entry)}${entry.kind === "topup" || entry.kind === "set" ? ` · ${formatAmount(card, entry.amount ?? 0)}` : entry.paid !== undefined ? ` · ${money(entry.paid)}` : ""}`;
  };
  function down(event: React.PointerEvent) {
    drag.current = { x: event.clientX, y: event.clientY, moved: false };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }
  function move(event: React.PointerEvent) {
    const start = drag.current;
    if (!start) return;
    const x = event.clientX - start.x, y = event.clientY - start.y;
    if (!start.moved && Math.hypot(x, y) < 6) return;
    start.moved = true;
    setOffset({ x, y });
  }
  function up(event: React.PointerEvent) {
    const start = drag.current;
    drag.current = null;
    setOffset(null);
    dragged.current = Boolean(start?.moved);
    if (!start?.moved) return;
    const left = event.clientX < window.innerWidth / 2, top = event.clientY < window.innerHeight / 2;
    const next: Corner = top ? left ? "top-left" : "top-right" : "bottom-left";
    setCorner(next);
    try { window.localStorage.setItem(cornerKey, next); } catch { /* Kept for this visit only. */ }
  }
  if (hidden) return null;
  return <div className={`transport-chip-wrap ${corner}`} style={corner === "bottom-left" ? { bottom } : undefined}>
    <button type="button" className={`transport-chip ${status.toAdd ? "short" : ""}`} aria-expanded={open} aria-label={`Transport card, ${label}`}
      style={offset ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : undefined}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { drag.current = null; setOffset(null); }}
      onClick={() => { if (!dragged.current) setOpen((value) => !value); dragged.current = false; }}><CreditCard size={15} /><span>{label}</span></button>
    {open && <section className="transport-panel" aria-label="Transport card">
      <header><strong>{card.name || "Transport card"}</strong>{card.travellers > 1 && <span>for {card.travellers}</span>}<button type="button" className="icon-button" aria-label="Close transport card" onClick={() => setOpen(false)}><X size={16} /></button></header>
      <dl>
        {status.balance !== undefined && <div><dt>On the card</dt><dd>{formatAmount(card, status.balance)}</dd></div>}
        {today && <div><dt>Today</dt><dd>{today.count} {today.count === 1 ? "ride" : "rides"} · {today.planned} to go{tap ? ` · ${money(today.spent)}${card.dailyCap !== undefined ? ` of ${money(card.dailyCap * card.travellers)}` : ""}` : ""}</dd></div>}
        {status.toAdd !== undefined && <div className="transport-add"><dt>To add</dt><dd>{formatAmount(card, status.toAdd)}</dd></div>}
        <div><dt>Spent</dt><dd>{money(status.spent)}</dd></div>
      </dl>
      <div className="transport-actions">
        <button type="button" className="button secondary small" onClick={() => add({ kind: "ride" })}><Plus size={14} />Ride</button>
        <button type="button" className="button secondary small" disabled={!today || today.count <= 0} onClick={() => lastRide ? remove(lastRide.entry) : add({ kind: "ride", amount: -1 })}><Minus size={14} />Ride</button>
        {card.airportPrice !== undefined && <button type="button" className="button secondary small" onClick={() => add({ kind: "ride", paid: Math.round(card.airportPrice! * card.travellers * 100) / 100 })}><Plane size={14} />Airport ride</button>}
        {!tap && <button type="button" className="button secondary small" onClick={() => openForm("topup")}>Top up</button>}
        {card.dayPass !== undefined && <button type="button" className="button secondary small" onClick={() => add({ kind: "pass", paid: Math.round(card.dayPass! * card.travellers * 100) / 100, validUntil: dayPassUntil(timeZone, Temporal.Now.instant()) })}><Ticket size={14} />Day pass</button>}
        {!tap && <button type="button" className="button secondary small" onClick={() => openForm("set")}>Card shows…</button>}
        {app && <a className="button secondary small" href={app.url} target="_blank" rel="noreferrer"><ArrowUpRight size={14} />Open {app.name}</a>}
      </div>
      {form && <form className="transport-form" onSubmit={submit}>
        {form === "fare" && fareFor && <strong className="transport-form-title">{fareFor.name}</strong>}
        <Amount label={formLabel} step={card.kind === "tickets" ? 1 : 0.01} max={form === "fare" && card.kind === "tickets" ? 20 : 10_000} value={amount} onChange={(value) => { setAmount(value); if (form === "topup" && value !== undefined) setPaid(topUpPrice(card, value)); }} />
        {form === "topup" && card.kind === "tickets" && <Amount label="Paid" value={paid} onChange={setPaid} />}
        <div className="transport-form-actions"><button type="submit" className="button primary small" disabled={amount === undefined}>{form === "topup" ? "Add" : "Save"}</button><button type="button" className="button secondary small" onClick={() => setForm(null)}>Cancel</button></div>
      </form>}
      {rides.length > 0 && <ul className="transport-rides" aria-label="Today's rides">{rides.map((ride) => <li key={ride.key} className={ride.counted ? "counted" : undefined}>
        {ride.counted ? <Check size={13} aria-label="Taken" /> : <Circle size={13} aria-label="To go" />}
        <span>{ride.name}</span>
        <small>{formatAmount(card, ride.price)}</small>
        <button type="button" className="icon-button" aria-label={`Change the fare to ${ride.name}`} onClick={() => openFare(ride)}><Pencil size={13} /></button>
      </li>)}</ul>}
      {entries.length > 0 && <ul className="transport-entries">{entries.slice(0, 4).map(({ entry }) => <li key={entry.id}>
        <span>{describe(entry)}</span>
        <small>{time(entry.at, timeZone)}</small>
        <button type="button" className="icon-button" aria-label={`Remove ${entryLabel(entry).toLowerCase()}`} onClick={() => remove(entry)}><X size={14} /></button>
      </li>)}</ul>}
    </section>}
  </div>;
}
