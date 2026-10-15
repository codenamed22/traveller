"use client";

import { useState } from "react";
import Image from "next/image";
import { ArrowUpRight, Clock, FileText, ImagePlus, Link, LoaderCircle, Map as MapIcon, Plane, Sparkles, Trash2, Upload, Video } from "lucide-react";
import { Dialog } from "./Dialog";
import { candidatesToStops, dayTripGroup, duplicateCandidateIndexes, importDayTrips, importResultSchema, itineraryHours, manualCandidates, maxImportPlaces, mergeDuplicateDetails, transferProposal, youtubeUrl, type ExtractionServices, type ImportCandidate, type TransferCandidate } from "@/lib/import";
import { readDocument, type ImportImage } from "@/lib/documents";
import { maxStopsPerCity, stopSchema, tripDate, type DayGroup, type Stop, type Transfer, type Trip } from "@/lib/trip";

type Kind = "arrival" | "departure";
// What an itinerary sets on the city besides its places, each approved in the review.
export type ImportedChanges = Partial<Record<Kind, Transfer>> & { dayGroups?: DayGroup[]; dailyStart?: string; dailyEnd?: string };

export function ImportReview({ trip, canExtract, extraction, onImport, onClose }: { trip: Trip; canExtract: boolean; extraction?: ExtractionServices; onImport: (stops: Stop[], existing: Stop[], changes: ImportedChanges) => void; onClose: () => void }) {
  const [tab, setTab] = useState<"text" | "file" | "link" | "youtube">("text");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [images, setImages] = useState<ImportImage[]>([]);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [candidates, setCandidates] = useState<{ place: ImportCandidate; included: boolean }[] | null>(null);
  const [ideas, setIdeas] = useState(false);
  const [duplicatesAccepted, setDuplicatesAccepted] = useState(false);
  const [approvedMerge, setApprovedMerge] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Partial<Record<Kind, TransferCandidate>>>({});
  const [leftOut, setLeftOut] = useState(0);
  const [skippedTrips, setSkippedTrips] = useState<string[]>([]);
  const [useHours, setUseHours] = useState(true);
  const [useTransfer, setUseTransfer] = useState<Record<Kind, boolean>>({ arrival: false, departure: false });
  const remoteSource = tab === "link" || tab === "youtube";
  let videoSource = tab === "youtube";
  if (tab === "link") { try { videoSource = Boolean(youtubeUrl(url.trim())); } catch { videoSource = false; } }
  const provider = (videoSource ? extraction?.youtube : extraction?.standard) ?? null;
  const extractionEnabled = canExtract && Boolean(provider);
  const selectedPlaces = candidates?.filter((candidate) => candidate.included).map((candidate) => candidate.place) ?? [];
  const duplicates = duplicateCandidateIndexes(candidates?.map((candidate) => candidate.place) ?? [], trip.stops);
  const selectedDuplicates = candidates?.filter((candidate, index) => candidate.included && duplicates.has(index)).length ?? 0;
  const remaining = maxStopsPerCity - trip.stops.length;
  const proposal = candidates ? mergeDuplicateDetails(candidates, trip.stops, trip) : null;
  const mergeKey = JSON.stringify([candidates, trip.stops, trip.startDate, trip.days]);
  const mergeApproved = approvedMerge === mergeKey;
  const merged = mergeApproved ? proposal?.merged ?? 0 : 0;
  const transferRows = (["arrival", "departure"] as const).flatMap((kind) => {
    const candidate = transfers[kind];
    if (!candidate) return [];
    try { return [{ kind, candidate, ...transferProposal(trip, kind, candidate) }]; } catch { return []; }
  });
  const chosenTransfers: ImportedChanges = Object.fromEntries(transferRows.filter((row) => useTransfer[row.kind] && !row.blocked && !row.same).map((row) => [row.kind, row.transfer]));
  const transferCount = Object.keys(chosenTransfers).length;
  const dayTrips = importDayTrips(selectedPlaces, trip);
  const hours = itineraryHours(selectedPlaces, trip);
  const dayLabel = (day: number) => `Day ${day + 1} (${new Date(`${tripDate(trip, day)}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })})`;

  function beginReview(places: ImportCandidate[], found: Partial<Record<Kind, TransferCandidate>> = {}, more = 0) {
    const duplicates = duplicateCandidateIndexes(places, trip.stops);
    setError("");
    setLeftOut(more); setSkippedTrips([]); setUseHours(true);
    setTransfers(found);
    // Filled in when the city has none yet; replacing what you entered is your choice.
    setUseTransfer({ arrival: !trip.arrival, departure: !trip.departure });
    setDuplicatesAccepted(false);
    setCandidates(places.map((place, index) => ({ place, included: !duplicates.has(index) })));
  }

  async function extract() {
    setBusy(true); setError("");
    try {
      if (!provider || !consent) throw new Error("Review provider consent before extraction.");
      const video = remoteSource ? youtubeUrl(url.trim()) : null;
      if (tab === "youtube" && !video) throw new Error("Enter a single YouTube video URL.");
      const activeImages = tab === "file" ? images : [];
      const activeText = remoteSource ? "" : text;
      const batches = Math.max(1, Math.ceil(activeImages.length / 3));
      const extracted: ImportCandidate[] = [];
      const found: Partial<Record<Kind, TransferCandidate>> = {};
      let more = 0;
      for (let batch = 0; batch < batches; batch++) {
        const body = JSON.stringify({ text: batch === 0 ? activeText : "", ...(remoteSource ? { url: video ?? url.trim() } : {}), images: activeImages.slice(batch * 3, batch * 3 + 3).map(({ data, mediaType }) => ({ data, mediaType })), consent, provider, city: trip.city, startDate: trip.startDate, timeZone: trip.timeZone, operationId: crypto.randomUUID() });
        if (new TextEncoder().encode(body).byteLength > 3_500_000) throw new Error("The selected images are too large. Remove some pages or use a smaller screenshot.");
        const response = await fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        const parsed = importResultSchema.parse(result);
        extracted.push(...parsed.places);
        found.arrival ??= parsed.arrival ?? undefined; found.departure ??= parsed.departure ?? undefined;
        more += parsed.leftOut ?? 0;
      }
      setIdeas(Boolean(video));
      beginReview(extracted, found, more);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Import failed."); }
    finally { setBusy(false); }
  }

  async function loadFile(file?: File) {
    if (!file) return;
    setConsent(false);
    setBusy(true); setError("");
    try { const result = await readDocument(file); setText(result.text); setImages(result.images); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not read this file."); }
    finally { setBusy(false); }
  }

  function update(index: number, patch: Partial<ImportCandidate>) {
    setDuplicatesAccepted(false);
    setCandidates((current) => current!.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, place: { ...candidate.place, ...patch } } : candidate));
  }

  function accept() {
    try {
      if (selectedDuplicates && !duplicatesAccepted) throw new Error("Confirm the selected duplicates or skip them before importing.");
      const { entries, stops: existing } = mergeApproved ? mergeDuplicateDetails(candidates ?? [], trip.stops, trip) : { entries: candidates ?? [], stops: trip.stops };
      const parsed = importResultSchema.parse({ places: entries.filter((entry) => entry.included).map((entry) => entry.place) });
      if (parsed.places.length + trip.stops.length > maxStopsPerCity) throw new Error(`A city can contain at most ${maxStopsPerCity} places.`);
      const added = candidatesToStops(parsed.places, trip, { ideas });
      [...existing, ...added].forEach((stop) => stopSchema.parse(stop));
      const dayGroups = importDayTrips(parsed.places, trip).filter((entry) => !entry.blocked && !skippedTrips.includes(entry.name.toLowerCase()))
        .map((entry) => dayTripGroup(entry, entry.indexes.map((index) => added[index].id), trip));
      const chosenHours = useHours ? itineraryHours(parsed.places, trip) : null;
      onImport(added, existing, { ...chosenTransfers, ...(dayGroups.length ? { dayGroups } : {}), ...chosenHours });
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Check the imported dates and times."); }
  }

  return <Dialog title={candidates ? "Review imported places" : "Import places"} onClose={onClose}>
    {error && <p className="notice error" role="alert">{error}</p>}
    {!candidates ? <>
      <fieldset className="import-inputs" disabled={busy}>
      <div className="segmented import-formats" aria-label="Import format">
        {([{ id: "text", icon: FileText, label: "Text" }, { id: "file", icon: ImagePlus, label: "Document" }, { id: "link", icon: Link, label: "Link" }, { id: "youtube", icon: Video, label: "YouTube" }] as const).map(({ id, icon: Icon, label }) => <button key={id} aria-pressed={tab === id} onClick={() => { setTab(id); setConsent(false); setError(""); }}><Icon size={16} />{label}</button>)}
      </div>
      {tab === "file" && <label className="upload-area"><Upload size={24} /><strong>Choose a document</strong><span>PDF, JPEG, PNG, WebP · 10 MB maximum</span><input aria-label="Itinerary document" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" disabled={busy} onChange={(event) => void loadFile(event.target.files?.[0])} /></label>}
      {remoteSource ? <label className="field">{tab === "youtube" ? "YouTube video URL" : "Itinerary URL"}<input type="url" value={url} maxLength={3000} onChange={(event) => { setUrl(event.target.value); setConsent(false); }} placeholder={tab === "youtube" ? "https://www.youtube.com/watch?v=..." : "https://..."} /></label> : <label className="field">{tab === "file" ? "Extracted text" : "Places or itinerary"}<textarea rows={7} value={text} maxLength={30_000} onChange={(event) => { setText(event.target.value); setConsent(false); }} placeholder={"Louvre Museum\nTuesday 10:00 - booked museum visit\nLuxembourg Gardens"} /></label>}
      {tab === "youtube" && <p className="source-availability">Public videos only. Some videos may not be supported.</p>}
      {tab === "file" && !!images.length && <div className="image-previews">{images.map((image, index) => <figure key={`${index}-${image.label}`}><Image src={`data:${image.mediaType};base64,${image.data}`} alt={image.label} width={112} height={140} unoptimized /><figcaption>{image.label}<button className="icon-button" title={`Remove ${image.label}`} onClick={() => setImages((current) => current.filter((_, imageIndex) => imageIndex !== index))}><Trash2 size={14} /></button></figcaption></figure>)}</div>}
      <label className="checkbox consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />{remoteSource ? `Send this link and its content to the agent for extraction.${videoSource ? " Video processing may incur additional costs." : ""} Retention policies apply.` : `Send the selected text${tab === "file" && images.length ? " and images" : ""} to the agent for extraction. Retention policies apply.`}</label>
      </fieldset>
      {!extractionEnabled && <p className="notice">{videoSource && !provider ? "Video import is unavailable. Paste a transcript in Text instead." : "AI import is unavailable. Check your sign-in and connections, or enter places manually."}</p>}
      <div className="dialog-actions">
        {!remoteSource && <button className="button secondary" disabled={busy || !text.trim()} onClick={() => {
          const lines = text.split(/\r?\n/).filter((line) => line.trim());
          if (lines.length > maxImportPlaces) setError(`Choose at most ${maxImportPlaces} place names per import, one per line.`);
          else { setIdeas(false); beginReview(manualCandidates(text)); }
        }}><FileText size={16} />Review place list</button>}
        <button className="button primary" disabled={busy || !consent || !extractionEnabled || !(remoteSource ? url.trim() : text.trim() || (tab === "file" && images.length))} onClick={() => void extract()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{tab === "youtube" ? "Find place ideas" : "Extract itinerary"}</button>
      </div>
    </> : <>
      <div className="review-summary"><span>{selectedPlaces.length} selected · {remaining} slots available</span><label className="checkbox"><input type="checkbox" checked={candidates.length > 0 && selectedPlaces.length === candidates.length} onChange={(event) => { setDuplicatesAccepted(false); setCandidates((current) => current!.map((entry) => ({ ...entry, included: event.target.checked }))); }} />Select all places</label><label className="checkbox"><input type="checkbox" checked={ideas} onChange={(event) => setIdeas(event.target.checked)} />Add as optional ideas</label></div>
      {!!duplicates.size && <div className="notice warning">
        <p role="status">{duplicates.size} possible {duplicates.size === 1 ? "duplicate" : "duplicates"} found in this city or import. {selectedDuplicates ? `${selectedDuplicates} selected for another visit.` : "All excluded from this import."}</p>
        {!!selectedDuplicates && <><button className="button secondary" onClick={() => { setDuplicatesAccepted(false); setCandidates((current) => current!.map((entry, index) => duplicates.has(index) ? { ...entry, included: false } : entry)); }}>Skip duplicates</button><label className="checkbox consent"><input type="checkbox" checked={duplicatesAccepted} onChange={(event) => setDuplicatesAccepted(event.target.checked)} />Include selected duplicates as separate visits</label></>}
      </div>}
      {selectedPlaces.length > remaining && <p className="notice warning">Select at most {remaining} places to stay within the {maxStopsPerCity}-place city limit.</p>}
      {!!proposal?.changes.length && <div className="notice"><strong>Proposed duplicate updates</strong><ul>{proposal.changes.map((change, index) => <li key={index}>{change}</li>)}</ul><label className="checkbox"><input type="checkbox" checked={mergeApproved} onChange={(event) => setApprovedMerge(event.target.checked ? mergeKey : null)} />Apply these duplicate updates</label></div>}
      {!!transferRows.length && <div className="review-transfers">
        <strong>Getting there and away</strong>
        {transferRows.map((row) => <div key={row.kind} className="review-transfer">
          <label className="checkbox"><input type="checkbox" aria-label={`Use this ${row.kind}`} checked={!row.blocked && !row.same && useTransfer[row.kind]} disabled={Boolean(row.blocked || row.same)} onChange={(event) => setUseTransfer((current) => ({ ...current, [row.kind]: event.target.checked }))} />
            <Plane size={14} /><span><b>{row.kind === "arrival" ? "Arrival" : "Departure"}</b> {row.label}</span></label>
          {row.same && <p className="quiet">Already set for {trip.city || "this city"}.</p>}
          {row.replaces && <p className="quiet">Replaces {row.replaces}.</p>}
          {row.blocked && <p className="warning-text">{row.blocked}</p>}
          {row.candidate.source && <blockquote>{row.candidate.source}</blockquote>}
        </div>)}
      </div>}
      {!!dayTrips.length && <div className="review-transfers">
        <strong>Day trips</strong>
        <p className="quiet">Each is planned as one outing, its places back to back; other visits can fill the rest of the day.</p>
        {dayTrips.map((entry) => <div key={entry.name} className="review-transfer">
          <label className="checkbox"><input type="checkbox" aria-label={`Plan ${entry.name} as a day trip`} checked={!entry.blocked && !skippedTrips.includes(entry.name.toLowerCase())} disabled={Boolean(entry.blocked)} onChange={(event) => setSkippedTrips((current) => event.target.checked ? current.filter((name) => name !== entry.name.toLowerCase()) : [...current, entry.name.toLowerCase()])} />
            <MapIcon size={14} /><span><b>{entry.name}</b> {entry.indexes.length} {entry.indexes.length === 1 ? "place" : "places"}{entry.day !== null ? ` · ${dayLabel(entry.day)}` : ""}</span></label>
          {entry.blocked && <p className="warning-text">{entry.blocked}</p>}
        </div>)}
      </div>}
      {hours && <div className="review-transfers">
        <strong>Day hours</strong>
        <div className="review-transfer"><label className="checkbox"><input type="checkbox" aria-label="Use the itinerary's hours" checked={useHours} onChange={(event) => setUseHours(event.target.checked)} />
          <Clock size={14} /><span>Use the itinerary&apos;s hours, <b>{hours.dailyStart}–{hours.dailyEnd}</b></span></label>
          <p className="quiet">{trip.city || "This city"} is set to {trip.dailyStart}–{trip.dailyEnd}, so visits outside it would not fit.</p></div>
      </div>}
      {!!proposal?.issues.length && <div className="notice warning"><ul>{proposal.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></div>}
      <div className="review-list">{candidates.map(({ place: candidate, included }, index) => <section className="review-item" key={index}>
        <label className="checkbox"><input type="checkbox" aria-label={`Include ${candidate.name}`} checked={included} onChange={(event) => { setDuplicatesAccepted(false); setCandidates((current) => current!.map((entry, candidateIndex) => candidateIndex === index ? { ...entry, included: event.target.checked } : entry)); }} />Include place{duplicates.has(index) && <span className="warning-text">Possible duplicate</span>}</label>
        <div className="row"><label className="field grow">Place<input value={candidate.name} onChange={(event) => update(index, { name: event.target.value })} /></label><button className="icon-button" aria-label={`Remove ${candidate.name}`} onClick={() => { setDuplicatesAccepted(false); setCandidates((current) => current!.filter((_, candidateIndex) => candidateIndex !== index)); }}><Trash2 size={17} /></button></div>
        <div className="form-grid three"><label className="field">Date<input type="date" value={candidate.date ?? ""} onChange={(event) => update(index, { date: event.target.value || null })} /></label><label className="field">Booked time<input type="time" value={candidate.time ?? ""} onChange={(event) => update(index, { time: event.target.value || null })} /></label><label className="field">Visit minutes<input type="number" min={5} max={480} value={candidate.duration ?? 45} onChange={(event) => update(index, { duration: Number(event.target.value) })} /></label></div>
        {!candidate.time && (candidate.plannedTime || candidate.dayTrip) && <p className="quiet">{[candidate.plannedTime && `Around ${candidate.plannedTime} in the itinerary, not a booking`, candidate.dayTrip && `${candidate.dayTrip} day trip`].filter(Boolean).join(" · ")}</p>}
        {candidate.source && <blockquote>{candidate.source}</blockquote>}{candidate.warning && <p className="warning-text">{candidate.warning}</p>}
        {candidate.sourceUrl && <a className="source-link" href={candidate.sourceUrl} target="_blank" rel="noopener noreferrer"><ArrowUpRight size={14} />Source link</a>}
      </section>)}</div>
      {!candidates.length && <p className="notice">No places found in this selection.</p>}
      {leftOut > 0 && <p className="notice">This itinerary has {leftOut} more {leftOut === 1 ? "place" : "places"} than one import takes. Import the rest separately, for example by pasting the later days.</p>}
      <div className="dialog-actions"><button className="button secondary" onClick={() => { setCandidates(null); setError(""); }}>Back</button><button className="button primary" disabled={(!selectedPlaces.length && !merged && !transferCount) || selectedPlaces.length > remaining || (selectedDuplicates > 0 && !duplicatesAccepted)} onClick={accept}>{selectedPlaces.length ? `Confirm ${selectedPlaces.length} ${selectedPlaces.length === 1 ? "place" : "places"}` : merged ? `Update ${merged} existing ${merged === 1 ? "place" : "places"}` : transferCount ? `Use ${transferCount === 2 ? "arrival and departure" : chosenTransfers.arrival ? "arrival" : "departure"}` : "Confirm 0 places"}</button></div>
    </>}
  </Dialog>;
}