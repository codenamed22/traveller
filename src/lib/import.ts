import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { newStop, sourceUrlSchema, timeSchema, type Stop, type Trip } from "./trip";

export const candidateSchema = z.object({
  name: z.string().min(1).max(200),
  date: z.iso.date().nullable(),
  time: timeSchema.nullable(),
  duration: z.number().int().min(5).max(480).nullable(),
  source: z.string().max(1000),
  warning: z.string().max(500),
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
  const seen = new Set(stops.map((stop) => normalizeName(stop.name)));
  const duplicates = new Set<number>();
  candidates.forEach((candidate, index) => {
    const name = normalizeName(candidate.name);
    if (seen.has(name)) duplicates.add(index);
    seen.add(name);
  });
  return duplicates;
}

function normalizeName(name: string) {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

// Skipped duplicates fill in dates, times and durations that the matching stop or earlier candidate still has at defaults.
export function mergeDuplicateDetails(entries: { place: ImportCandidate; included: boolean }[], stops: Stop[], trip: Trip) {
  let merged = 0;
  const nextStops = stops.map((stop) => ({ ...stop }));
  const nextEntries = entries.map((entry) => ({ ...entry, place: { ...entry.place } }));
  nextEntries.forEach((entry, index) => {
    if (entry.included) return;
    const source = entry.place;
    const name = normalizeName(source.name);
    const day = source.date ? Temporal.PlainDate.from(trip.startDate).until(Temporal.PlainDate.from(source.date)).days : null;
    const validDay = day !== null && day >= 0 && day < trip.days ? day : null;
    const stop = nextStops.find((candidate) => normalizeName(candidate.name) === name);
    if (stop) {
      const before = JSON.stringify(stop);
      if (validDay !== null && stop.day === null) stop.day = validDay;
      if (source.time && !stop.fixedTime && stop.day !== null && (validDay === null || stop.day === validDay)) { stop.fixedTime = source.time; stop.optional = false; }
      if (source.duration && stop.duration === newStop().duration) stop.duration = source.duration;
      if (JSON.stringify(stop) !== before) merged++;
      return;
    }
    const target = nextEntries.find((other, otherIndex) => otherIndex < index && other.included && normalizeName(other.place.name) === name)?.place;
    if (!target) return;
    const before = JSON.stringify(target);
    if (source.date && !target.date) target.date = source.date;
    if (source.time && !target.time && target.date && target.date === source.date) target.time = source.time;
    if (source.duration && !target.duration) target.duration = source.duration;
    if (JSON.stringify(target) !== before) merged++;
  });
  return { entries: nextEntries, stops: nextStops, merged };
}

export function manualCandidates(text: string): ImportCandidate[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 25).map((name) => ({ name: name.replace(/^[-*]\s+/, "").slice(0, 200), date: null, time: null, duration: null, source: name.slice(0, 1000), warning: "Confirm any dates or booked times manually." }));
}

export function candidatesToStops(candidates: ImportCandidate[], trip: Trip, options: { ideas?: boolean } = {}): Stop[] {
  return candidates.map((candidate) => {
    const day = candidate.date ? Temporal.PlainDate.from(trip.startDate).until(Temporal.PlainDate.from(candidate.date)).days : null;
    if (day !== null && (day < 0 || day >= trip.days)) throw new Error(`${candidate.name} falls outside the trip dates.`);
    if (candidate.time && day === null) throw new Error(`Assign a date to ${candidate.name} before importing its booked time.`);
    return { ...newStop(candidate.name), day, fixedTime: candidate.time, duration: candidate.duration ?? 45, source: candidate.source, ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}), optional: Boolean(options.ideas && !candidate.time) };
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