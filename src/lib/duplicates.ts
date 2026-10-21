import { stopSchema, type Stop } from "./trip";

function normalizeName(name: string) {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function aliasName(name: string) {
  return normalizeName(name).replace(/^the\s+/, "").replace(/\s+\([^()]+\)$/, "").replace(/(?:\s+(?:specialty|coffee|caf[e\u00e9]|shop|restaurant))+$/, "");
}

export function duplicateNames(first: string, second: string) {
  const normalizedFirst = normalizeName(first);
  const normalizedSecond = normalizeName(second);
  if (normalizedFirst === normalizedSecond) return true;
  const firstQualifier = normalizedFirst.match(/\(([^()]+)\)$/)?.[1];
  const secondQualifier = normalizedSecond.match(/\(([^()]+)\)$/)?.[1];
  if (firstQualifier && secondQualifier && firstQualifier !== secondQualifier) return false;
  const alias = aliasName(first);
  return alias.length >= 4 && alias === aliasName(second);
}

export function duplicateStopPairs(stops: Stop[]) {
  return stops.flatMap((first, index) => stops.slice(index + 1).flatMap((second) => {
    const samePlace = Boolean(first.placeId && first.placeId === second.placeId);
    const sameName = normalizeName(first.name) === normalizeName(second.name);
    const possibleAlias = duplicateNames(first.name, second.name);
    if (!samePlace && ((!sameName && !possibleAlias) || (first.placeId && second.placeId))) return [];
    return [{ first, second, match: samePlace ? "Same confirmed Google place" : sameName ? "Matching place name" : "Possible name alias; location needs review" }];
  }));
}

export function mergeReviewedDuplicate(stops: Stop[], keepId: string, removeId: string): Stop[] {
  const pair = duplicateStopPairs(stops).find(({ first, second }) => (first.id === keepId && second.id === removeId) || (first.id === removeId && second.id === keepId));
  if (!pair) throw new Error("These visits no longer match. Review the updated places list.");
  const kept = pair.first.id === keepId ? pair.first : pair.second;
  const removed = pair.first.id === removeId ? pair.first : pair.second;
  const sourceUrl = kept.sourceUrl ?? removed.sourceUrl;
  const evidence = [...new Set([kept.source, removed.source, removed.sourceUrl && removed.sourceUrl !== sourceUrl ? removed.sourceUrl : ""].filter(Boolean))].join("\n");
  if (evidence.length > 1000) throw new Error("The combined source notes exceed 1,000 characters. Shorten the notes before merging; neither visit was changed.");
  const note = [...new Set([kept.note?.trim(), removed.note?.trim()].filter(Boolean))].join("\n");
  if (note.length > 500) throw new Error("The combined notes exceed 500 characters. Shorten one before merging; neither visit was changed.");
  const merged = stopSchema.parse({
    ...kept, source: evidence, ...(note ? { note } : {}), ...(kept.about ?? removed.about ? { about: kept.about ?? removed.about } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(!kept.placeId && removed.placeId ? { placeId: removed.placeId, location: removed.location } : {}),
    ...(kept.placeId && !kept.location && kept.placeId === removed.placeId && removed.location ? { location: removed.location } : {}),
  });
  return stops.filter((stop) => stop.id !== removeId).map((stop) => stop.id === keepId ? merged : stop);
}

export function mergeDuplicateStops(stops: Stop[]): { stops: Stop[]; removed: string[] } {
  const kept: Stop[] = [];
  const removed: string[] = [];
  const fields = ["placeId", "duration", "day", "fixedTime", "buffer", "optional", "priority", "mode", "source", "sourceUrl"] as const;
  for (const stop of stops) {
    const duplicate = kept.some((other) => normalizeName(other.name) === normalizeName(stop.name)
      && fields.every((field) => other[field] === stop[field])
      && other.location?.lat === stop.location?.lat && other.location?.lng === stop.location?.lng);
    if (duplicate) removed.push(stop.name);
    else kept.push(stop);
  }
  return { stops: kept, removed };
}