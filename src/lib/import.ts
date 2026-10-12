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
  const normalize = (name: string) => name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  const seen = new Set(stops.map((stop) => normalize(stop.name)));
  const duplicates = new Set<number>();
  candidates.forEach((candidate, index) => {
    const name = normalize(candidate.name);
    if (seen.has(name)) duplicates.add(index);
    seen.add(name);
  });
  return duplicates;
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