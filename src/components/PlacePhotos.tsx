"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, LoaderCircle, RotateCw } from "lucide-react";
import type { PlacePhoto } from "@/lib/place-photos";

type Props = {
  placeName: string;
  variant: "popup" | "carousel";
  total?: number;
  frames: Partial<Record<number, PlacePhoto | null>>;
  loading: Partial<Record<number, boolean>>;
  errors: Partial<Record<number, boolean>>;
  disabledMessage?: string;
  onRequest: (index: number) => void;
  onRetry: (index: number) => void;
};

export function PlacePhotos({ placeName, variant, total = 0, frames, loading, errors, disabledMessage, onRequest, onRetry }: Props) {
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [brokenIndex, setBrokenIndex] = useState<number | null>(null);
  const [failedAvatarUris, setFailedAvatarUris] = useState<string[]>([]);
  const touchStart = useRef<number | null>(null);
  const photo = frames[index];
  const isLoading = Boolean(loading[index]);
  const hasError = Boolean(errors[index]) || brokenIndex === index;

  function move(next: number) {
    if (next < 0 || next >= total) return;
    setDirection(next > index ? 1 : -1);
    setIndex(next);
    onRequest(next);
  }

  return <section className={`place-photos ${variant === "popup" ? "place-photos-popup" : "place-photos-carousel"}`} aria-label={`Photos of ${placeName}`}>
    <div className="place-photo-frame" role="group" aria-label={`Photo ${index + 1} of ${total || 1}`} data-direction={direction} onPointerDown={(event) => { touchStart.current = event.clientX; }} onPointerUp={(event) => {
      if (touchStart.current === null) return;
      const delta = event.clientX - touchStart.current;
      touchStart.current = null;
      if (Math.abs(delta) > 45) move(index + (delta < 0 ? 1 : -1));
    }} onKeyDown={(event) => {
      if (event.key === "ArrowLeft") { event.preventDefault(); move(index - 1); }
      if (event.key === "ArrowRight") { event.preventDefault(); move(index + 1); }
    }} tabIndex={variant === "carousel" ? 0 : -1}>
      {photo?.uri && !hasError && <Image key={index} src={photo.uri} alt={placeName} width={960} height={720} unoptimized draggable={false} onError={() => setBrokenIndex(index)} />}
      {isLoading && <span className="place-photo-state" role="status"><LoaderCircle size={18} className="spin" />Loading photo</span>}
      {!isLoading && !hasError && !disabledMessage && total === 0 && <span className="place-photo-state">No photos available</span>}
      {!isLoading && disabledMessage && <span className="place-photo-state">{disabledMessage}</span>}
      {!isLoading && hasError && <span className="place-photo-state" role="alert">Photo unavailable</span>}
      {!isLoading && hasError && <button className="place-photo-retry" type="button" onClick={() => { setBrokenIndex(null); onRetry(index); }} aria-label="Retry photo" title="Retry photo"><RotateCw size={15} /></button>}
    </div>
    {photo && !hasError && <div className="place-photo-credit">
      {photo.authors.map((author, authorIndex) => <span className="place-photo-author" key={`${author.displayName}:${authorIndex}`}>
        {author.photoUri && !failedAvatarUris.includes(author.photoUri) && <Image src={author.photoUri} alt="" width={20} height={20} unoptimized onError={() => setFailedAvatarUris((current) => current.includes(author.photoUri!) ? current : [...current, author.photoUri!])} />}
        {author.uri ? <a href={author.uri} target="_blank" rel="noopener noreferrer">{author.displayName}</a> : <span>{author.displayName}</span>}
      </span>)}
      <a className="place-photo-source" href={photo.googleMapsUri} target="_blank" rel="noopener noreferrer"><span>Google Maps</span><ExternalLink size={12} /><span className="sr-only">View this photo</span></a>
      {photo.flagContentUri && <a className="place-photo-report" href={photo.flagContentUri} target="_blank" rel="noopener noreferrer">Report</a>}
    </div>}
    {variant === "carousel" && total > 0 && <div className="place-photo-controls">
      <button type="button" className="icon-button" aria-label="Previous photo" title="Previous photo" disabled={index === 0 || total < 2} onClick={() => move(index - 1)}><ArrowLeft size={16} /></button>
      <span aria-live="polite">{index + 1} / {total}</span>
      <button type="button" className="icon-button" aria-label="Next photo" title="Next photo" disabled={index >= total - 1 || total < 2} onClick={() => move(index + 1)}><ArrowRight size={16} /></button>
    </div>}
  </section>;
}