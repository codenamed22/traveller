"use client";

import { FileText, Image as ImageIcon, LoaderCircle, Paperclip, X } from "lucide-react";
import { useRef, useState } from "react";
import { maxTicketBytes, ticketTypes, type Ticket, type TicketPlace } from "@/lib/tickets";

// Large photos of a ticket are made smaller in the browser, keeping enough detail for a barcode.
async function smaller(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.size <= 1_500_000 || typeof createImageBitmap !== "function") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
  } catch { return file; }
}

export function Tickets({ tripId, place, tickets, onAdd, onRemove }: { tripId: string; place: TicketPlace; tickets: Ticket[]; onAdd: (ticket: Ticket) => void; onRemove: (id: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const url = (id: string) => `/api/trips/${tripId}/tickets/${id}`;

  async function add(chosen: File) {
    setBusy(true); setError("");
    try {
      const file = await smaller(chosen);
      if (file.size > maxTicketBytes) throw new Error("Tickets can be up to 4 MB.");
      const form = new FormData();
      form.set("file", file); form.set("cityId", place.cityId); form.set("target", place.target);
      if (place.stopId) form.set("stopId", place.stopId);
      const response = await fetch(`/api/trips/${tripId}/tickets`, { method: "POST", body: form });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error ?? "Couldn't add the ticket.");
      onAdd(data.ticket);
    } catch (reason) {
      setError(reason instanceof TypeError ? "Couldn't add the ticket: no connection." : reason instanceof Error ? reason.message : "Couldn't add the ticket.");
    } finally { setBusy(false); }
  }

  async function remove(ticket: Ticket) {
    if (!window.confirm(`Delete ${ticket.name}?`)) return;
    setError("");
    try {
      const response = await fetch(url(ticket.id), { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new Error((await response.json().catch(() => null))?.error ?? "Couldn't delete the ticket.");
      onRemove(ticket.id);
    } catch (reason) { setError(reason instanceof TypeError ? "Couldn't delete the ticket: no connection." : reason instanceof Error ? reason.message : "Couldn't delete the ticket."); }
  }

  return <div className="tickets">
    {tickets.map((ticket) => <span key={ticket.id} className="ticket">
      <a href={url(ticket.id)} target="_blank" rel="noopener">{ticket.mime === "application/pdf" ? <FileText size={14} /> : <ImageIcon size={14} />}<span>{ticket.name}</span></a>
      <button type="button" className="icon-button" aria-label={`Delete ${ticket.name}`} title="Delete" onClick={() => void remove(ticket)}><X size={13} /></button>
    </span>)}
    <button type="button" className="text-button" disabled={busy} onClick={() => input.current?.click()}>{busy ? <LoaderCircle size={14} className="spin" /> : <Paperclip size={14} />}Add ticket</button>
    <input ref={input} type="file" hidden accept={ticketTypes.join(",")} aria-label="Ticket file" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void add(file); }} />
    {error && <p className="notice error" role="alert">{error}</p>}
  </div>;
}
