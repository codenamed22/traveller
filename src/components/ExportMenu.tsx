"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarPlus, FileSpreadsheet, FileText, Share2 } from "lucide-react";
import type { Journey } from "@/lib/journey";
import { exportFilename, itineraryExport, itineraryHtml, itineraryIcs, itineraryXlsx } from "@/lib/export";
import { saveFile } from "@/lib/save-file";

// Exports accepted itineraries only; an unaccepted preview is never shared by accident.
export function ExportMenu({ journey }: { journey: Journey }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const planned = journey.cities.some((city) => journey.plans[city.id]?.snapshot);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => { if (event instanceof KeyboardEvent ? event.key === "Escape" : !menu.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); };
  }, [open]);

  function run(format: "pdf" | "xlsx" | "ics") {
    setOpen(false);
    const data = itineraryExport(journey);
    if (format === "xlsx") return void saveFile(itineraryXlsx(data) as BlobPart, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", exportFilename(data, "xlsx"));
    if (format === "ics") return void saveFile(itineraryIcs(data), "text/calendar", exportFilename(data, "ics"));
    // The printable page opens in a new tab and offers the browser's Save as PDF; if pop-ups are blocked, download it.
    const url = URL.createObjectURL(new Blob([itineraryHtml(data)], { type: "text/html" }));
    if (!window.open(url, "_blank")) void saveFile(itineraryHtml(data, false), "text/html", exportFilename(data, "html"));
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return <div className="export-menu" ref={menu}>
    <button className="icon-button" title={planned ? "Export itinerary" : "Accept a plan to export the itinerary"} aria-label="Export itinerary" aria-haspopup="menu" aria-expanded={open} disabled={!planned} onClick={() => setOpen((value) => !value)}><Share2 size={18} /></button>
    {open && <div className="export-options" role="menu" aria-label="Export itinerary">
      <button role="menuitem" onClick={() => run("pdf")}><FileText size={16} /><span><strong>PDF</strong>Printable itinerary; choose Save as PDF</span></button>
      <button role="menuitem" onClick={() => run("xlsx")}><FileSpreadsheet size={16} /><span><strong>Excel</strong>Spreadsheet of every visit (.xlsx)</span></button>
      <button role="menuitem" onClick={() => run("ics")}><CalendarPlus size={16} /><span><strong>Calendar</strong>Add visits to Google, Apple or Outlook (.ics)</span></button>
      <p>Uses each city&apos;s accepted itinerary.</p>
    </div>}
  </div>;
}
