import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { newStop, sourceUrlSchema, stopSchema, timeSchema, tripDate, visitKindSchema, visitSlotSchema, type Stop, type Trip } from "./trip";
import { duplicateNames } from "./duplicates";

export const extractionProviderSchema = z.object({ provider: z.enum(["gemini", "openrouter"]), model: z.string().min(1).max(200) }).strict();
export type ExtractionProvider = z.infer<typeof extractionProviderSchema>;
export type ExtractionServices = { standard: ExtractionProvider | null; youtube: ExtractionProvider | null };

export const candidateSchema = z.object({
  name: z.string().min(1).max(200),
  date: z.iso.date().nullable(),
  time: timeSchema.nullable(),
  duration: z.number().int().min(5).max(480).nullable(),
  source: z.string().max(1000),
  warning: z.string().max(500),
  kind: visitKindSchema.nullish(),
  slot: visitSlotSchema.nullish(),
  plannedTime: timeSchema.nullish(),
  alternativeGroup: z.string().trim().min(1).max(40).nullish(),
}).strict();
export const extractionSchema = z.object({ places: z.array(candidateSchema).max(25) }).strict();
export const importResultSchema = z.object({ places: z.array(candidateSchema.extend({ sourceUrl: sourceUrlSchema.optional() })).max(25) }).strict();
export type ImportCandidate = z.infer<typeof importResultSchema>["places"][number];

export function youtubeUrl(value: string): string | null {
  const url = new URL(value);
  if (!["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(url.hostname)) return null;
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Use an HTTPS YouTube video link without credentials or custom ports.");
  const parts = url.pathname.split("/").filter(Boolean);
  const videoId = url.hostname === "youtu.be" && parts.length === 1 ? parts[0]
    : url.pathname === "/watch" ? url.searchParams.get("v")
    : parts.length === 2 && ["shorts", "embed", "live"].includes(parts[0]) ? parts[1] : null;
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error("Use a single YouTube video link, not a channel or playlist.");
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function duplicateCandidateIndexes(candidates: ImportCandidate[], stops: Stop[]): Set<number> {
  const seen = stops.map((stop) => stop.name);
  const duplicates = new Set<number>();
  candidates.forEach((candidate, index) => {
    if (seen.some((name) => duplicateNames(name, candidate.name))) duplicates.add(index);
    seen.push(candidate.name);
  });
  return duplicates;
}

function normalizeName(name: string) {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function mergeDuplicateDetails(entries: { place: ImportCandidate; included: boolean }[], stops: Stop[], trip: Trip) {
  let merged = 0;
  const nextStops = stops.map((stop) => ({ ...stop }));
  const nextEntries = entries.map((entry) => ({ ...entry, place: { ...entry.place } }));
  const changes: string[] = [];
  const issues: string[] = [];
  nextEntries.forEach((entry, index) => {
    if (entry.included) return;
    const name = normalizeName(entry.place.name);
    const matches = nextStops.filter((candidate) => normalizeName(candidate.name) === name);
    const candidates = nextEntries.filter((other, otherIndex) => otherIndex < index && other.included && normalizeName(other.place.name) === name);
    const target = candidates[0]?.place;
    if (!matches.length && !target) return;
    const parsed = importResultSchema.shape.places.element.safeParse(entry.place);
    if (!parsed.success) { issues.push(`${entry.place.name}: invalid duplicate details; no updates proposed.`); return; }
    const source = parsed.data;
    if (matches.length + candidates.length > 1) { issues.push(`${source.name}: multiple existing visits match; edit the intended visit directly.`); return; }
    let day: number | null = null;
    try { day = source.date ? Temporal.PlainDate.from(trip.startDate).until(Temporal.PlainDate.from(source.date)).days : null; }
    catch { issues.push(`${source.name}: invalid trip or visit date; no updates proposed.`); return; }
    if (day !== null && (day < 0 || day >= trip.days)) { issues.push(`${source.name}: duplicate date is outside this trip; no updates proposed.`); return; }
    if (source.time && day === null) { issues.push(`${source.name}: a booked time needs its own date; no updates proposed.`); return; }
    const stop = matches[0] ? { ...matches[0] } : undefined;
    if (stop && !stopSchema.safeParse(stop).success) { issues.push(`${source.name}: fix the existing visit before merging details.`); return; }
    const existingDate = stop ? stop.day === null ? null : tripDate(trip, stop.day) : target?.date;
    const existingTime = stop ? stop.fixedTime : target?.time;
    if ((existingDate && source.date && existingDate !== source.date) || (existingTime && source.time && existingTime !== source.time)) {
      issues.push(`${source.name}: dates or booking times conflict; keep these as separate visits or edit them directly.`); return;
    }
    const details: string[] = [];
    const recipient = stop ?? target!;
    const evidence = [...new Set([recipient.source, source.source, recipient.sourceUrl && source.sourceUrl !== recipient.sourceUrl ? source.sourceUrl : ""].filter(Boolean))].join("\n");
    if (evidence.length > 1000) { issues.push(`${source.name}: combined source evidence is too long; edit the visit directly.`); return; }
    if (stop) {
      if (day !== null && stop.day === null) { stop.day = day; details.push(`day: unassigned -> ${source.date}`); }
      if (source.time && !stop.fixedTime && stop.day === day) {
        stop.fixedTime = source.time; details.push(`booking: none -> ${source.time}`);
        if (stop.optional) details.push("optional -> required");
        stop.optional = false;
      }
    } else if (target) {
      if (source.date && !target.date) { target.date = source.date; details.push(`date: none -> ${source.date}`); }
      if (source.time && !target.time) { target.time = source.time; details.push(`booking: none -> ${source.time}`); }
      if (source.duration && target.duration === null) { target.duration = source.duration; details.push(`duration: unspecified -> ${source.duration} min`); }
    }
    if (details.length) {
      recipient.source = evidence;
      if (!recipient.sourceUrl && source.sourceUrl) recipient.sourceUrl = source.sourceUrl;
      if (stop) Object.assign(matches[0], stopSchema.parse(stop));
      merged++; changes.push(`${source.name}: ${details.join("; ")}`);
    }
  });
  return { entries: nextEntries, stops: nextStops, merged, changes, issues };
}

export function manualCandidates(text: string): ImportCandidate[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 25).map((name) => ({ name: name.replace(/^[-*]\s+/, "").slice(0, 200), date: null, time: null, duration: null, source: name.slice(0, 1000), warning: "Confirm any dates or booked times manually." }));
}

export function candidatesToStops(candidates: ImportCandidate[], trip: Trip, options: { ideas?: boolean } = {}): Stop[] {
  // Alternative labels are only meaningful within one import batch; give each shared label a fresh identifier.
  const labels = new Map<string, string>();
  for (const label of candidates.map((candidate) => candidate.alternativeGroup).filter((label): label is string => Boolean(label))) {
    if (!labels.has(label) && candidates.filter((candidate) => candidate.alternativeGroup === label).length > 1) labels.set(label, crypto.randomUUID());
  }
  return candidates.map((candidate) => {
    const day = candidate.date ? Temporal.PlainDate.from(trip.startDate).until(Temporal.PlainDate.from(candidate.date)).days : null;
    if (day !== null && (day < 0 || day >= trip.days)) throw new Error(`${candidate.name} falls outside the trip dates.`);
    if (candidate.time && day === null) throw new Error(`Assign a date to ${candidate.name} before importing its booked time.`);
    const group = candidate.alternativeGroup ? labels.get(candidate.alternativeGroup) : undefined;
    return {
      ...newStop(candidate.name), day, fixedTime: candidate.time, duration: candidate.duration ?? 45, source: candidate.source, ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}), optional: Boolean(options.ideas && !candidate.time),
      ...(candidate.kind ? { kind: candidate.kind } : {}), ...(candidate.slot && !candidate.time ? { slot: candidate.slot } : {}),
      ...(candidate.plannedTime && !candidate.time ? { plannedTime: candidate.plannedTime } : {}), ...(group ? { alternativeGroup: group } : {}),
    };
  });
}

export function mapsQuery(url: URL): string | null {
  if (!["google.com", "www.google.com", "maps.google.com"].includes(url.hostname)) return null;
  if (!url.pathname.startsWith("/maps")) return null;
  if (url.pathname.includes("/placelists") || url.pathname.includes("/list")) throw new Error("Saved Google Maps lists are not supported. Paste the place names instead.");
  const query = url.searchParams.get("query") ?? url.searchParams.get("q");
  const destination = url.searchParams.get("destination");
  if (query) return query;
  if (destination) return [url.searchParams.get("origin"), ...((url.searchParams.get("waypoints") ?? "").split("|")), destination].filter(Boolean).join("\n");
  throw new Error("This Google Maps link does not expose place names. Paste the place names instead.");
}