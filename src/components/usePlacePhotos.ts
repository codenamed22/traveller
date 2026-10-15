"use client";

import { useEffect, useRef, useState } from "react";
import { placePhotoResponseSchema, type PlacePhoto } from "@/lib/place-photos";

type Session = { key: string; total?: number; frames: Partial<Record<number, PlacePhoto | null>>; loading: number[]; errors: number[] };

// Photos for one place at a time, fetched one by one as the carousel asks for them, starting with the first. `key`
// names the place in its trip; changing it cancels requests for the previous place.
export function usePlacePhotos(key: string | null, placeId: string | undefined, enabled: boolean) {
  const [session, setSession] = useState<Session | null>(null);
  const current = useRef<Session | null>(null);
  const active = useRef<string | null>(null);
  const requests = useRef(new Map<string, AbortController>());
  const update = (next: Session | null) => { current.current = next; setSession(next); };

  async function request(index: number, retry = false) {
    if (!enabled || !key || !placeId || active.current !== key) return;
    let state = current.current?.key === key ? current.current : { key, frames: {}, loading: [], errors: [] };
    if (state.total !== undefined && index >= state.total) return;
    if (retry && Object.hasOwn(state.frames, index)) {
      const frames = { ...state.frames };
      delete frames[index];
      state = { ...state, frames };
    }
    if (!retry && (state.frames[index] !== undefined || state.errors.includes(index))) return;
    const requestKey = `${key}:${index}`;
    if (requests.current.has(requestKey)) return;
    const controller = new AbortController();
    requests.current.set(requestKey, controller);
    update({ ...state, loading: [...new Set([...state.loading, index])], errors: state.errors.filter((entry) => entry !== index) });
    try {
      const response = await fetch("/api/place-photos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ placeId, index, operationId: crypto.randomUUID() }), signal: controller.signal });
      if (!response.ok) throw new Error("The photo request failed.");
      const photo = placePhotoResponseSchema.parse(await response.json());
      if (photo.placeId !== placeId || photo.index !== index) throw new Error("The photo response did not match this place.");
      const latest = current.current;
      if (active.current !== key || controller.signal.aborted || latest?.key !== key) return;
      update({ ...latest, total: photo.total, frames: { ...latest.frames, [index]: photo.photo }, loading: latest.loading.filter((entry) => entry !== index) });
    } catch {
      const latest = current.current;
      if (active.current !== key || controller.signal.aborted || latest?.key !== key) return;
      update({ ...latest, loading: latest.loading.filter((entry) => entry !== index), errors: [...new Set([...latest.errors, index])] });
    } finally {
      if (requests.current.get(requestKey) === controller) requests.current.delete(requestKey);
    }
  }

  useEffect(() => {
    active.current = key;
    for (const [requestKey, controller] of requests.current) {
      if (key && requestKey.startsWith(`${key}:`)) continue;
      controller.abort(); requests.current.delete(requestKey);
    }
    if (current.current?.key !== key) update(null);
    void request(0);
  }, [key, placeId, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { for (const controller of requests.current.values()) controller.abort(); }, []);

  const shown = session?.key === key ? session : null;
  return {
    total: shown?.total,
    frames: shown?.frames ?? {},
    loading: Object.fromEntries(shown?.loading.map((index) => [index, true]) ?? []) as Partial<Record<number, boolean>>,
    errors: Object.fromEntries(shown?.errors.map((index) => [index, true]) ?? []) as Partial<Record<number, boolean>>,
    disabledMessage: !placeId ? "Confirm this place to view photos" : !enabled ? "Photos are unavailable" : undefined,
    request: (index: number) => void request(index),
    retry: (index: number) => void request(index, true),
  };
}
