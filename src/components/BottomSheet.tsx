"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export type Snap = "peek" | "half" | "full";
const order: Snap[] = ["peek", "half", "full"];

// A sheet over the map with three resting heights: its header alone, `half` and `full`. Drag the header up or down to
// resize, tap it to switch between the smallest and middle heights, or swipe it sideways (onSwipe: 1 next, -1 previous).
// onHeight reports the resting height, never mid-drag, so the map behind can keep its stops in view. A header taller than
// the full height (a chosen place with its photo and notes) stops there and scrolls, as it does past half the sheet once
// the day shows below it; the handle still drags.
export function BottomSheet({ snap, sizes, onSnap, onSwipe, onHeight, header, children, label }: { snap: Snap; sizes: { half: number; full: number }; onSnap: (snap: Snap) => void; onSwipe?: (direction: 1 | -1) => void; onHeight?: (height: number) => void; header: ReactNode; children: ReactNode; label: string }) {
  const [drag, setDrag] = useState<number | null>(null);
  const [natural, setNatural] = useState(180);
  const headerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const peek = Math.min(natural, sizes.full);
  const heights: Record<Snap, number> = { peek, half: Math.max(peek, sizes.half), full: Math.max(peek, sizes.full) };
  const headerMax = (snap === "peek" ? sizes.full : Math.round(sizes.full / 2)) - 6;
  useEffect(() => {
    const element = headerRef.current, content = contentRef.current;
    if (!element || !content || typeof ResizeObserver === "undefined") return;
    // The header's own height stops at its cap, so the content is watched for its natural height.
    const observer = new ResizeObserver(() => setNatural(Math.ceil(element.scrollHeight) + 6));
    observer.observe(element); observer.observe(content);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { onHeight?.(heights[snap]); }, [heights[snap]]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = useRef<{ x: number; y: number; height: number; time: number; axis?: "x" | "y" } | null>(null);

  function down(event: React.PointerEvent) {
    if ((event.target as HTMLElement).closest("a, button:not(.sheet-handle), input, select, summary")) return;
    start.current = { x: event.clientX, y: event.clientY, height: heights[snap], time: event.timeStamp };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function move(event: React.PointerEvent) {
    const origin = start.current;
    if (!origin) return;
    const dx = event.clientX - origin.x; const dy = event.clientY - origin.y;
    if (!origin.axis && Math.hypot(dx, dy) > 8) origin.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    if (origin.axis === "y") setDrag(Math.min(heights.full, Math.max(heights.peek - 40, origin.height - dy)));
  }
  function up(event: React.PointerEvent) {
    const origin = start.current;
    start.current = null; setDrag(null);
    if (!origin) return;
    const dx = event.clientX - origin.x; const dy = event.clientY - origin.y;
    if (!origin.axis) { onSnap(snap === "peek" ? "half" : "peek"); return; }
    if (origin.axis === "x") { if (Math.abs(dx) > 60) onSwipe?.(dx < 0 ? 1 : -1); return; }
    // A quick flick moves one step; otherwise rest at the nearest height.
    const velocity = dy / Math.max(1, event.timeStamp - origin.time);
    const index = order.indexOf(snap);
    if (Math.abs(velocity) > 0.5) { onSnap(order[Math.min(2, Math.max(0, index + (velocity < 0 ? 1 : -1)))]); return; }
    const height = origin.height - dy;
    onSnap(order.reduce((best, candidate) => Math.abs(heights[candidate] - height) < Math.abs(heights[best] - height) ? candidate : best, snap));
  }

  return <section className={`bottom-sheet ${drag !== null ? "dragging" : ""} snap-${snap}`} aria-label={label} style={{ height: drag ?? heights[snap] }}>
    <div className={`sheet-header ${natural - 6 > headerMax ? "scrolls" : ""}`} ref={headerRef} style={{ maxHeight: headerMax }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { start.current = null; setDrag(null); }}>
      <button type="button" className="sheet-handle" aria-label={snap === "peek" ? "Show the whole day" : "Show less"} onClick={(event) => { if (event.detail === 0) onSnap(snap === "peek" ? "half" : "peek"); }}><span /></button>
      <div ref={contentRef}>{header}</div>
    </div>
    <div className="sheet-body">{children}</div>
  </section>;
}
