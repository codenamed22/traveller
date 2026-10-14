"use client";

import { useState } from "react";
import { Copy, Eye } from "lucide-react";
import { Dialog } from "./Dialog";

// The owner's control for sharing a saved trip read-only with anyone who signs in.
export function ShareTrip({ tripId, shared, disabled, onChange }: { tripId: string; shared: boolean; disabled: boolean; onChange: (shared: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const link = typeof window === "undefined" ? `/shared/${tripId}` : `${window.location.origin}/shared/${tripId}`;

  async function toggle(next: boolean) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/trips/${tripId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shared: next }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? "Sharing could not be changed.");
      onChange(data.shared);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Sharing could not be changed."); }
    finally { setBusy(false); }
  }

  return <>
    <button className={`icon-button ${shared ? "active" : ""}`} title={disabled ? "Save the trip to share it" : shared ? "Shared for viewing" : "Share for viewing"} aria-label="Share for viewing" disabled={disabled} onClick={() => { setMessage(""); setOpen(true); }}><Eye size={18} /></button>
    {open && <Dialog title="Share for viewing" busy={busy} onClose={() => setOpen(false)}>
      <label className="checkbox"><input type="checkbox" checked={shared} disabled={busy} onChange={(event) => void toggle(event.target.checked)} />Anyone who signs in with Google can view this trip</label>
      <p className="quiet">Viewers see each city&apos;s last saved, accepted itinerary. They can&apos;t edit, plan or load photos.</p>
      {shared && <div className="share-link"><input readOnly aria-label="Share link" value={link} onFocus={(event) => event.target.select()} /><button className="button secondary small" onClick={() => void navigator.clipboard.writeText(link).then(() => setMessage("Link copied."), () => setMessage("Copy the link above."))}><Copy size={15} />Copy</button></div>}
      {message && <p className="notice" role="status">{message}</p>}
    </Dialog>}
  </>;
}
