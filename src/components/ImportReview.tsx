"use client";

import { useState } from "react";
import Image from "next/image";
import { ArrowUpRight, FileText, ImagePlus, Link, LoaderCircle, Sparkles, Trash2, Upload, Video } from "lucide-react";
import { Dialog } from "./Dialog";
import { candidatesToStops, duplicateCandidateIndexes, importResultSchema, manualCandidates, mergeDuplicateDetails, youtubeUrl, type ImportCandidate } from "@/lib/import";
import { readDocument, type ImportImage } from "@/lib/documents";
import { maxStopsPerCity, type Stop, type Trip } from "@/lib/trip";

export function ImportReview({ trip, canExtract, onImport, onClose }: { trip: Trip; canExtract: boolean; onImport: (stops: Stop[], existing: Stop[]) => void; onClose: () => void }) {
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
  const remoteSource = tab === "link" || tab === "youtube";
  const selectedPlaces = candidates?.filter((candidate) => candidate.included).map((candidate) => candidate.place) ?? [];
  const duplicates = duplicateCandidateIndexes(candidates?.map((candidate) => candidate.place) ?? [], trip.stops);
  const selectedDuplicates = candidates?.filter((candidate, index) => candidate.included && duplicates.has(index)).length ?? 0;
  const remaining = maxStopsPerCity - trip.stops.length;
  const merged = candidates ? mergeDuplicateDetails(candidates, trip.stops, trip).merged : 0;

  function beginReview(places: ImportCandidate[]) {
    const duplicates = duplicateCandidateIndexes(places, trip.stops);
    setError("");
    setDuplicatesAccepted(false);
    setCandidates(places.map((place, index) => ({ place, included: !duplicates.has(index) })));
  }

  async function extract() {
    setBusy(true); setError("");
    try {
      const video = remoteSource ? youtubeUrl(url.trim()) : null;
      if (tab === "youtube" && !video) throw new Error("Enter a single YouTube video URL.");
      const activeImages = tab === "file" ? images : [];
      const activeText = remoteSource ? "" : text;
      const batches = Math.max(1, Math.ceil(activeImages.length / 3));
      const extracted: ImportCandidate[] = [];
      for (let batch = 0; batch < batches; batch++) {
        const body = JSON.stringify({ text: batch === 0 ? activeText : "", ...(remoteSource ? { url: video ?? url.trim() } : {}), images: activeImages.slice(batch * 3, batch * 3 + 3).map(({ data, mediaType }) => ({ data, mediaType })), consent, city: trip.city, startDate: trip.startDate, timeZone: trip.timeZone, operationId: crypto.randomUUID() });
        if (new TextEncoder().encode(body).byteLength > 3_500_000) throw new Error("The selected images are too large. Remove some pages or use a smaller screenshot.");
        const response = await fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        extracted.push(...importResultSchema.parse(result).places);
      }
      setIdeas(Boolean(video));
      beginReview(extracted);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Import failed."); }
    finally { setBusy(false); }
  }

  async function loadFile(file?: File) {
    if (!file) return;
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
      const { entries, stops: existing } = mergeDuplicateDetails(candidates ?? [], trip.stops, trip);
      const parsed = importResultSchema.parse({ places: entries.filter((entry) => entry.included).map((entry) => entry.place) });
      if (parsed.places.length + trip.stops.length > maxStopsPerCity) throw new Error(`A city can contain at most ${maxStopsPerCity} places.`);
      onImport(candidatesToStops(parsed.places, trip, { ideas }), existing);
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
      {remoteSource ? <label className="field">{tab === "youtube" ? "YouTube video URL" : "Itinerary URL"}<input type="url" value={url} maxLength={3000} onChange={(event) => { setUrl(event.target.value); setConsent(false); }} placeholder={tab === "youtube" ? "https://www.youtube.com/watch?v=..." : "https://..."} /></label> : <label className="field">{tab === "file" ? "Extracted text" : "Places or itinerary"}<textarea rows={7} value={text} maxLength={30_000} onChange={(event) => setText(event.target.value)} placeholder={"Louvre Museum\nTuesday 10:00 - booked museum visit\nLuxembourg Gardens"} /></label>}
      {tab === "youtube" && <p className="source-availability">Public videos only. Gemini model availability and video processing limits apply.</p>}
      {tab === "file" && !!images.length && <div className="image-previews">{images.map((image, index) => <figure key={`${index}-${image.label}`}><Image src={`data:${image.mediaType};base64,${image.data}`} alt={image.label} width={112} height={140} unoptimized /><figcaption>{image.label}<button className="icon-button" title={`Remove ${image.label}`} onClick={() => setImages((current) => current.filter((_, imageIndex) => imageIndex !== index))}><Trash2 size={14} /></button></figcaption></figure>)}</div>}
      <label className="checkbox consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />{remoteSource ? "Send this link and its content to Gemini for extraction. Video processing may incur additional costs. Provider retention policies apply." : "Send the selected text and images to Gemini for extraction. Provider retention policies apply."}</label>
      </fieldset>
      {!canExtract && <p className="notice">AI extraction requires configured services and sign-in. Manual entry is available.</p>}
      <div className="dialog-actions">
        {!remoteSource && <button className="button secondary" disabled={busy || !text.trim()} onClick={() => {
          const lines = text.split(/\r?\n/).filter((line) => line.trim());
          if (lines.length > 25) setError("Choose at most 25 place names per import, one per line.");
          else { setIdeas(false); beginReview(manualCandidates(text)); }
        }}><FileText size={16} />Review place list</button>}
        <button className="button primary" disabled={busy || !consent || !canExtract || !(remoteSource ? url.trim() : text.trim() || (tab === "file" && images.length))} onClick={() => void extract()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{tab === "youtube" ? "Find place ideas" : "Extract itinerary"}</button>
      </div>
    </> : <>
      <div className="review-summary"><span>{selectedPlaces.length} selected · {remaining} slots available</span><label className="checkbox"><input type="checkbox" checked={candidates.length > 0 && selectedPlaces.length === candidates.length} onChange={(event) => { setDuplicatesAccepted(false); setCandidates((current) => current!.map((entry) => ({ ...entry, included: event.target.checked }))); }} />Select all places</label><label className="checkbox"><input type="checkbox" checked={ideas} onChange={(event) => setIdeas(event.target.checked)} />Add as optional ideas</label></div>
      {!!duplicates.size && <div className="notice warning">
        <p role="status">{duplicates.size} possible {duplicates.size === 1 ? "duplicate" : "duplicates"} found in this city or import. {selectedDuplicates ? `${selectedDuplicates} selected for another visit.` : "All excluded from this import."}</p>
        {!!selectedDuplicates && <><button className="button secondary" onClick={() => { setDuplicatesAccepted(false); setCandidates((current) => current!.map((entry, index) => duplicates.has(index) ? { ...entry, included: false } : entry)); }}>Skip duplicates</button><label className="checkbox consent"><input type="checkbox" checked={duplicatesAccepted} onChange={(event) => setDuplicatesAccepted(event.target.checked)} />Include selected duplicates as separate visits</label></>}
      </div>}
      {selectedPlaces.length > remaining && <p className="notice warning">Select at most {remaining} places to stay within the {maxStopsPerCity}-place city limit.</p>}
      {merged > 0 && <p className="notice" role="status">Times and durations from {merged} skipped {merged === 1 ? "duplicate" : "duplicates"} will update the existing places.</p>}
      <div className="review-list">{candidates.map(({ place: candidate, included }, index) => <section className="review-item" key={index}>
        <label className="checkbox"><input type="checkbox" aria-label={`Include ${candidate.name}`} checked={included} onChange={(event) => { setDuplicatesAccepted(false); setCandidates((current) => current!.map((entry, candidateIndex) => candidateIndex === index ? { ...entry, included: event.target.checked } : entry)); }} />Include place{duplicates.has(index) && <span className="warning-text">Possible duplicate</span>}</label>
        <div className="row"><label className="field grow">Place<input value={candidate.name} onChange={(event) => update(index, { name: event.target.value })} /></label><button className="icon-button" aria-label={`Remove ${candidate.name}`} onClick={() => { setDuplicatesAccepted(false); setCandidates((current) => current!.filter((_, candidateIndex) => candidateIndex !== index)); }}><Trash2 size={17} /></button></div>
        <div className="form-grid three"><label className="field">Date<input type="date" value={candidate.date ?? ""} onChange={(event) => update(index, { date: event.target.value || null })} /></label><label className="field">Booked time<input type="time" value={candidate.time ?? ""} onChange={(event) => update(index, { time: event.target.value || null })} /></label><label className="field">Visit minutes<input type="number" min={5} max={480} value={candidate.duration ?? 45} onChange={(event) => update(index, { duration: Number(event.target.value) })} /></label></div>
        {candidate.source && <blockquote>{candidate.source}</blockquote>}{candidate.warning && <p className="warning-text">{candidate.warning}</p>}
        {candidate.sourceUrl && <a className="source-link" href={candidate.sourceUrl} target="_blank" rel="noopener noreferrer"><ArrowUpRight size={14} />Source link</a>}
      </section>)}</div>
      {!candidates.length && <p className="notice">No places found in this selection.</p>}
      <div className="dialog-actions"><button className="button secondary" onClick={() => { setCandidates(null); setError(""); }}>Back</button><button className="button primary" disabled={(!selectedPlaces.length && !merged) || selectedPlaces.length > remaining || (selectedDuplicates > 0 && !duplicatesAccepted)} onClick={accept}>{selectedPlaces.length || !merged ? `Confirm ${selectedPlaces.length} ${selectedPlaces.length === 1 ? "place" : "places"}` : `Update ${merged} existing ${merged === 1 ? "place" : "places"}`}</button></div>
    </>}
  </Dialog>;
}